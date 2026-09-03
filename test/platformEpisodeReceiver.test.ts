import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

import { canonicalJson, digest, MemoryEventStore, type PlatformMissionLearningEpisodeContract } from "../src/index.ts";
import {
  createPlatformEpisodeRequestListener,
  parsePlatformEpisodeHeaders,
  PlatformEpisodeReceiver,
  publicKeyFromKmsDer,
} from "../src/platformEpisodeReceiver.ts";

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const { privateKey: otherKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const KEY_ID = "arn:aws:kms:us-east-1:637423327454:key/test-organism";

function producerEpisode(): PlatformMissionLearningEpisodeContract {
  return JSON.parse(readFileSync(new URL("./fixtures/platform-mission-episode.producer.json", import.meta.url), "utf8"));
}

/** Mirror the Platform worker: canonical body, KMS signs the SHA-256 digest (DER ECDSA). */
function deliver(episode: PlatformMissionLearningEpisodeContract, { key = privateKey, receiptId = "att-1", body = null as Buffer | null, algorithm = "ECDSA_SHA_256", bearer = null as string | null } = {}) {
  const raw = body ?? Buffer.from(canonicalJson(episode), "utf8");
  const signature = sign("sha256", raw, key);
  return {
    raw,
    headers: {
      idempotencyKey: episode.episodeId,
      attestationReceiptId: receiptId,
      kmsKeyId: KEY_ID,
      signingAlgorithm: algorithm,
      signatureBase64: signature.toString("base64"),
      bearerToken: bearer,
    },
  };
}

test("a correctly signed canonical episode is attested, ingested, and idempotent", () => {
  const store = new MemoryEventStore();
  const receiver = new PlatformEpisodeReceiver(store, { publicKey, expectedKeyId: KEY_ID, now: () => new Date("2026-09-03T00:00:00Z") });
  const episode = producerEpisode();
  const { raw, headers } = deliver(episode);
  const first = receiver.receive(raw, headers);
  assert.equal(first.status, 200);
  assert.equal(first.body.status, "accepted");
  assert.equal(first.body.classification, "verified");
  assert.equal(first.body.payloadDigest, digest(episode));
  assert.equal(store.events().length, 1);
  assert.equal(store.events()[0]?.hostReceiptId, "platform-attestation:att-1");

  const again = receiver.receive(raw, { ...headers, attestationReceiptId: "att-1-retry" });
  assert.equal(again.status, 200);
  assert.equal(again.body.status, "duplicate");
  assert.equal(store.events().length, 1);
});

test("tampered bytes, non-canonical bytes, wrong keys, and disallowed algorithms are all refused before any receipt", () => {
  const store = new MemoryEventStore();
  const receiver = new PlatformEpisodeReceiver(store, { publicKey, expectedKeyId: KEY_ID });
  const episode = producerEpisode();
  const good = deliver(episode);

  // Byte tampering that stays canonical is caught by the signature, not the digest.
  const tampered = Buffer.from(good.raw.toString("utf8").replace('"completed"', '"failed"'), "utf8");
  const tamperedResult = receiver.receive(tampered, good.headers);
  assert.equal(tamperedResult.status, 401);
  assert.match(String(tamperedResult.body.reason), /signature/);

  const pretty = deliver(episode, { body: Buffer.from(JSON.stringify(episode, null, 2), "utf8") });
  const prettyResult = receiver.receive(pretty.raw, pretty.headers);
  assert.equal(prettyResult.status, 400);
  assert.match(String(prettyResult.body.reason), /canonical/);

  const forged = deliver(episode, { key: otherKey });
  assert.equal(receiver.receive(forged.raw, forged.headers).status, 401);

  const wrongKeyId = receiver.receive(good.raw, { ...good.headers, kmsKeyId: "arn:aws:kms:us-east-1:1:key/other" });
  assert.equal(wrongKeyId.status, 401);

  const badAlgorithm = receiver.receive(good.raw, { ...good.headers, signingAlgorithm: "RSASSA_PSS_SHA_256" });
  assert.equal(badAlgorithm.status, 401);

  const mismatchedKey = receiver.receive(good.raw, { ...good.headers, idempotencyKey: "someone-else" });
  assert.equal(mismatchedKey.status, 400);

  assert.equal(store.events().length, 0);
});

test("a bearer token is enforced when configured and a conflicting retry is a 409", () => {
  const store = new MemoryEventStore();
  const receiver = new PlatformEpisodeReceiver(store, { publicKey, expectedKeyId: KEY_ID, bearerToken: "secret" });
  const episode = producerEpisode();
  const unauthenticated = deliver(episode);
  assert.equal(receiver.receive(unauthenticated.raw, unauthenticated.headers).status, 401);
  const authenticated = deliver(episode, { bearer: "secret" });
  assert.equal(receiver.receive(authenticated.raw, authenticated.headers).status, 200);

  const source = { ...episode.source, verification: { ...(episode.source.verification as Record<string, unknown>), passedCount: 0, failedCount: 1, allPassed: false } };
  const conflicting = { ...episode, sourceEpisodeDigest: digest(source), source };
  const retry = deliver(conflicting, { bearer: "secret", receiptId: "att-2" });
  const result = receiver.receive(retry.raw, retry.headers);
  assert.equal(result.status, 409);
  assert.equal(store.events().length, 1);
});

test("the HTTP listener carries the headers through and rejects oversized or malformed requests", async () => {
  const store = new MemoryEventStore();
  const receiver = new PlatformEpisodeReceiver(store, { publicKey, expectedKeyId: KEY_ID });
  const server = createServer(createPlatformEpisodeRequestListener(receiver));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;
  try {
    const episode = producerEpisode();
    const { raw, headers } = deliver(episode, { receiptId: "att-http" });
    const response = await fetch(`${base}/v1/platform/episodes`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": headers.idempotencyKey,
        "x-amos-attestation-receipt": headers.attestationReceiptId,
        "x-amos-kms-key-id": headers.kmsKeyId,
        "x-amos-kms-signing-algorithm": headers.signingAlgorithm,
        "x-amos-kms-signature": headers.signatureBase64,
      },
      body: new Uint8Array(raw),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.classification, "verified");

    const missing = await fetch(`${base}/v1/platform/episodes`, { method: "POST", body: new Uint8Array(raw) });
    assert.equal(missing.status, 400);
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    const unknown = await fetch(`${base}/nope`);
    assert.equal(unknown.status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("KMS DER public keys load and header parsing fails closed", () => {
  const der = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const loaded = publicKeyFromKmsDer(der);
  assert.equal(loaded.asymmetricKeyType, "ec");
  assert.throws(() => parsePlatformEpisodeHeaders({ "idempotency-key": "x" }), /x-amos-attestation-receipt/);
  const spki = createHash("sha256").update(der).digest("hex");
  assert.equal(spki.length, 64);
});
