import { createHash, createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isPlatformMissionLearningEpisodeContract, type PlatformMissionLearningEpisodeContract } from "./contracts.ts";
import { digest } from "./digest.ts";
import type { EventStore } from "./eventStore.ts";
import type { HostGate, HostReceipt } from "./host.ts";
import { PlatformEpisodeIntake } from "./platformEpisodeIntake.ts";

/**
 * Transport boundary for Platform Mission learning episodes.
 *
 * The Platform's delivery worker POSTs the canonical episode body and carries
 * the KMS signature of that body's SHA-256 digest in X-Amos headers. This
 * receiver recomputes the digest from the raw bytes, verifies the signature
 * against the configured KMS public key, and only then mints the host receipt
 * the kernel intake requires. Nothing downstream of this file can attest an
 * episode, and this file cannot attest one without a valid signature.
 */

export const PLATFORM_EPISODE_MAX_BODY_BYTES = 512 * 1024;

export const KMS_SIGNING_ALGORITHMS = Object.freeze({
  ECDSA_SHA_256: { hash: "sha256", keyType: "ec", padding: null },
  ECDSA_SHA_384: { hash: "sha384", keyType: "ec", padding: null },
  RSASSA_PKCS1_V1_5_SHA_256: { hash: "sha256", keyType: "rsa", padding: "pkcs1" },
  RSASSA_PSS_SHA_256: { hash: "sha256", keyType: "rsa", padding: "pss" },
} as const);

export type KmsSigningAlgorithm = keyof typeof KMS_SIGNING_ALGORITHMS;

export interface PlatformEpisodeHeaders {
  readonly idempotencyKey: string;
  readonly attestationReceiptId: string;
  readonly kmsKeyId: string;
  readonly signingAlgorithm: string;
  readonly signatureBase64: string;
  readonly bearerToken: string | null;
}

export interface PlatformEpisodeReceiverOptions {
  readonly publicKey: string | Buffer | KeyObject;
  readonly expectedKeyId: string;
  readonly allowedAlgorithms?: readonly KmsSigningAlgorithm[];
  readonly bearerToken?: string | null;
  readonly now?: () => Date;
}

export interface PlatformEpisodeResponse {
  readonly status: 200 | 400 | 401 | 409 | 413;
  readonly body: Readonly<Record<string, unknown>>;
}

export class PlatformEpisodeRejected extends Error {
  readonly status: 400 | 401 | 409 | 413;

  constructor(status: 400 | 401 | 409 | 413, message: string) {
    super(message);
    this.name = "PlatformEpisodeRejected";
    this.status = status;
  }
}

/** Host gate that trusts only receipts this process minted after signature verification. */
export class MintedReceiptGate implements HostGate {
  readonly #minted = new Map<string, string>();

  mint(receipt: HostReceipt): HostReceipt {
    this.#minted.set(receipt.id, receipt.payloadDigest);
    return receipt;
  }

  verify(receipt: HostReceipt): boolean {
    return this.#minted.get(receipt.id) === receipt.payloadDigest && receipt.authority === "host";
  }
}

export function parsePlatformEpisodeHeaders(headers: Readonly<Record<string, string | string[] | undefined>>): PlatformEpisodeHeaders {
  const read = (name: string): string => {
    const value = headers[name];
    const text = Array.isArray(value) ? value[0] : value;
    if (!text || !text.trim()) throw new PlatformEpisodeRejected(400, `missing ${name} header`);
    return text.trim();
  };
  const authorization = headers.authorization;
  const bearer = typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : null;
  return {
    idempotencyKey: read("idempotency-key"),
    attestationReceiptId: read("x-amos-attestation-receipt"),
    kmsKeyId: read("x-amos-kms-key-id"),
    signingAlgorithm: read("x-amos-kms-signing-algorithm"),
    signatureBase64: read("x-amos-kms-signature"),
    bearerToken: bearer,
  };
}

export class PlatformEpisodeReceiver {
  readonly #publicKey: KeyObject;
  readonly #expectedKeyId: string;
  readonly #allowedAlgorithms: ReadonlySet<string>;
  readonly #bearerToken: string | null;
  readonly #now: () => Date;
  readonly #gate = new MintedReceiptGate();
  readonly #intake: PlatformEpisodeIntake;
  readonly #store: EventStore;

  constructor(store: EventStore, options: PlatformEpisodeReceiverOptions) {
    this.#store = store;
    this.#publicKey = typeof options.publicKey === "string" || Buffer.isBuffer(options.publicKey)
      ? createPublicKey(options.publicKey)
      : options.publicKey;
    if (!options.expectedKeyId?.trim()) throw new TypeError("expectedKeyId is required");
    this.#expectedKeyId = options.expectedKeyId.trim();
    this.#allowedAlgorithms = new Set(options.allowedAlgorithms ?? ["ECDSA_SHA_256"]);
    for (const algorithm of this.#allowedAlgorithms) {
      if (!(algorithm in KMS_SIGNING_ALGORITHMS)) throw new TypeError(`Unsupported KMS signing algorithm ${algorithm}`);
    }
    this.#bearerToken = options.bearerToken ?? null;
    this.#now = options.now ?? (() => new Date());
    this.#intake = new PlatformEpisodeIntake(this.#gate, store);
  }

  receive(rawBody: Buffer, headers: PlatformEpisodeHeaders): PlatformEpisodeResponse {
    try {
      return this.#receive(rawBody, headers);
    } catch (error) {
      if (error instanceof PlatformEpisodeRejected) {
        return { status: error.status, body: { status: "rejected", reason: error.message } };
      }
      const message = error instanceof Error ? error.message : String(error);
      if (/Conflicting organism event retry/.test(message)) {
        return { status: 409, body: { status: "conflict", reason: message } };
      }
      return { status: 400, body: { status: "rejected", reason: message } };
    }
  }

  #receive(rawBody: Buffer, headers: PlatformEpisodeHeaders): PlatformEpisodeResponse {
    if (this.#bearerToken !== null && headers.bearerToken !== this.#bearerToken) {
      throw new PlatformEpisodeRejected(401, "bearer token mismatch");
    }
    if (rawBody.byteLength > PLATFORM_EPISODE_MAX_BODY_BYTES) {
      throw new PlatformEpisodeRejected(413, `body exceeds ${PLATFORM_EPISODE_MAX_BODY_BYTES} bytes`);
    }
    if (headers.kmsKeyId !== this.#expectedKeyId) {
      throw new PlatformEpisodeRejected(401, "unexpected KMS key id");
    }
    if (!this.#allowedAlgorithms.has(headers.signingAlgorithm)) {
      throw new PlatformEpisodeRejected(401, `signing algorithm ${headers.signingAlgorithm} is not allowed`);
    }
    const algorithm = KMS_SIGNING_ALGORITHMS[headers.signingAlgorithm as KmsSigningAlgorithm];
    if (this.#publicKey.asymmetricKeyType !== algorithm.keyType) {
      throw new PlatformEpisodeRejected(401, "signing algorithm does not match the configured public key");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new PlatformEpisodeRejected(400, "body is not JSON");
    }
    if (!isPlatformMissionLearningEpisodeContract(parsed)) {
      throw new PlatformEpisodeRejected(400, "body is not a Platform Mission learning episode contract");
    }
    const episode = parsed as PlatformMissionLearningEpisodeContract;
    if (episode.episodeId !== headers.idempotencyKey) {
      throw new PlatformEpisodeRejected(400, "idempotency key does not match the episode id");
    }
    const rawDigest = createHash("sha256").update(rawBody).digest("hex");
    const canonicalDigest = digest(episode);
    if (rawDigest !== canonicalDigest) {
      throw new PlatformEpisodeRejected(400, "body bytes are not the canonical episode encoding");
    }

    const signature = Buffer.from(headers.signatureBase64, "base64");
    if (signature.byteLength === 0) throw new PlatformEpisodeRejected(401, "signature is empty");
    const verified = verifySignature(
      algorithm.hash,
      rawBody,
      algorithm.padding === "pss"
        ? { key: this.#publicKey, padding: 6 /* RSA_PKCS1_PSS_PADDING */ }
        : this.#publicKey,
      signature,
    );
    if (!verified) throw new PlatformEpisodeRejected(401, "KMS signature does not verify");

    const receipt = this.#gate.mint({
      id: `platform-attestation:${headers.attestationReceiptId}`,
      missionId: episode.missionId,
      kind: "platform-episode-attested",
      issuedAt: this.#now().toISOString(),
      payloadDigest: canonicalDigest,
      authority: "host",
    });
    const existing = this.#store.get(`platform-episode:${episode.episodeId}`);
    const result = this.#intake.ingest(episode, receipt);
    return {
      status: 200,
      body: {
        status: existing ? "duplicate" : "accepted",
        classification: result.classification,
        eventId: result.event.id,
        eventDigest: result.event.digest,
        attestationReceiptId: headers.attestationReceiptId,
        payloadDigest: canonicalDigest,
      },
    };
  }
}

/** Node HTTP listener: POST /v1/platform/episodes, GET /healthz. */
export function createPlatformEpisodeRequestListener(receiver: PlatformEpisodeReceiver, path = "/v1/platform/episodes") {
  return (request: IncomingMessage, response: ServerResponse): void => {
    if (request.method === "GET" && request.url === "/healthz") {
      respond(response, 200, { status: "ok" });
      return;
    }
    if (request.method !== "POST" || request.url !== path) {
      respond(response, 404, { status: "not-found" });
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let overflow = false;
    request.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > PLATFORM_EPISODE_MAX_BODY_BYTES) {
        overflow = true;
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("close", () => {
      if (overflow) respond(response, 413, { status: "rejected", reason: "body too large" });
    });
    request.on("end", () => {
      if (overflow) return;
      let headers: PlatformEpisodeHeaders;
      try {
        headers = parsePlatformEpisodeHeaders(request.headers);
      } catch (error) {
        const status = error instanceof PlatformEpisodeRejected ? error.status : 400;
        respond(response, status, { status: "rejected", reason: error instanceof Error ? error.message : String(error) });
        return;
      }
      const result = receiver.receive(Buffer.concat(chunks), headers);
      respond(response, result.status, result.body);
    });
  };
}

function respond(response: ServerResponse, status: number, body: Readonly<Record<string, unknown>>): void {
  if (response.headersSent || response.writableEnded) return;
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  response.end(payload);
}

/** Convert a KMS GetPublicKey DER (SPKI, base64) into a KeyObject. */
export function publicKeyFromKmsDer(base64Der: string): KeyObject {
  return createPublicKey({ key: Buffer.from(base64Der.trim(), "base64"), format: "der", type: "spki" });
}
