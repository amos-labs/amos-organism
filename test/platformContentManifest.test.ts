import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

import { canonicalJson, digest, isPlatformLearningContentManifestContract, MemoryEventStore, type PlatformLearningContentManifestContract, type PlatformMissionLearningEpisodeContract } from "../src/index.ts";
import { createPlatformEpisodeRequestListener, PlatformEpisodeReceiver } from "../src/platformEpisodeReceiver.ts";

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const KEY_ID = "arn:aws:kms:us-east-1:637423327454:key/test-organism";

function episode(): PlatformMissionLearningEpisodeContract {
  return JSON.parse(readFileSync(new URL("./fixtures/platform-mission-episode.producer.json", import.meta.url), "utf8"));
}
function manifest(overrides: Partial<PlatformLearningContentManifestContract> = {}): PlatformLearningContentManifestContract {
  const source = episode();
  const ref = (name: string) => `amos-content://${source.tenantId}/${digest({ name })}`;
  const body = {
    schema: "amos.platform-learning-content-manifest" as const,
    schemaVersion: 1 as const,
    manifestVersion: 1 as const,
    episodeId: source.episodeId,
    tenantId: source.tenantId,
    missionId: source.missionId,
    items: [
      { kind: "objective" as const, ref: ref("objective"), sha256: digest("objective bytes"), completeness: "complete" as const, redaction: [], stepPosition: null, plannerAttempt: null },
      { kind: "planner_input" as const, ref: ref("input-1"), sha256: digest("input bytes"), completeness: "complete" as const, redaction: ["secret"], stepPosition: 1, plannerAttempt: 1, compiledInputSha256: digest("compiled"), requestPayloadSha256: digest("payload") },
      { kind: "planner_output" as const, ref: ref("output-1"), sha256: digest("output bytes"), completeness: "complete" as const, redaction: [], stepPosition: 1, plannerAttempt: 1, disposition: "accepted" as const },
      { kind: "planner_output" as const, ref: ref("output-rejected"), sha256: digest("rejected bytes"), completeness: "complete" as const, redaction: [], stepPosition: null, plannerAttempt: 2, disposition: "rejected" as const },
      { kind: "tool_result" as const, ref: ref("tool-1"), sha256: digest("tool bytes"), completeness: "truncated" as const, redaction: ["pii-hash"], stepPosition: 2, plannerAttempt: 1 }
    ],
    omitted: [{ kind: "tool_result", stepPosition: 3, reason: "over 32 KiB" }],
    acceptedAttemptBindings: [{ plannerAttempt: 1, stepPosition: 1, receiptId: "9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d" }],
    evaluationExclusion: [ref("output-1")],
    redactionPolicyVersion: "redaction-v1",
    grantReceiptRef: "organism.consent.grant:amos-labs-training-content-1",
    rightsTags: ["amos-owned", "training_content"],
    ...overrides
  };
  const { contentSha256: _ignored, ...withoutDigest } = body as typeof body & { contentSha256?: string };
  return { ...withoutDigest, contentSha256: overrides.contentSha256 ?? digest(withoutDigest) } as PlatformLearningContentManifestContract;
}
function deliver(message: object, idempotencyKey: string, receiptId: string) {
  const raw = Buffer.from(canonicalJson(message), "utf8");
  return { raw, headers: { idempotencyKey, attestationReceiptId: receiptId, kmsKeyId: KEY_ID, signingAlgorithm: "ECDSA_SHA_256", signatureBase64: sign("sha256", raw, privateKey).toString("base64"), bearerToken: null } };
}

test("a signed content manifest is accepted before or after its episode, stored as references only, and idempotent", () => {
  const store = new MemoryEventStore();
  const receiver = new PlatformEpisodeReceiver(store, { publicKey, expectedKeyId: KEY_ID, now: () => new Date("2026-09-06T00:00:00Z") });
  const m = manifest();
  assert.equal(isPlatformLearningContentManifestContract(m), true);
  const first = receiver.receive(...Object.values(deliver(m, `content-manifest:${m.episodeId}`, "att-m1")) as [Buffer, never]);
  assert.equal(first.status, 200);
  assert.equal(first.body.status, "accepted");
  assert.equal(first.body.messageType, "content-manifest");
  assert.equal(first.body.episodeKnown, false, "delivery order is not guaranteed; the manifest may land first");
  assert.equal(first.body.items, 5);
  assert.equal(first.body.completeItems, 4);
  assert.equal(first.body.holdoutItems, 1);
  const event = store.get(`platform-content-manifest:${m.episodeId}`)!;
  assert.equal(event.type, "platform.content-manifest-received");
  assert.equal(JSON.stringify(event.payload).includes("objective bytes"), false, "no content, only digests and refs");
  assert.equal((event.payload.items as Array<{ holdout: boolean }>)[2]!.holdout, true);
  assert.equal(event.payload.trainingEligibilityDecided, false);

  const again = receiver.receive(...Object.values(deliver(m, `content-manifest:${m.episodeId}`, "att-m1-retry")) as [Buffer, never]);
  assert.equal(again.body.status, "duplicate");
  assert.equal(store.events().length, 1);

  const e = episode();
  const episodeResult = receiver.receive(...Object.values(deliver(e, e.episodeId, "att-e1")) as [Buffer, never]);
  assert.equal(episodeResult.body.status, "accepted");
  assert.equal(store.events().length, 2, "episode and manifest coexist under the same episode id");
});

test("manifests with the wrong idempotency key, a bad contentSha256, or an invalid item are refused before any receipt", () => {
  const store = new MemoryEventStore();
  const receiver = new PlatformEpisodeReceiver(store, { publicKey, expectedKeyId: KEY_ID });
  const m = manifest();
  const wrongKey = receiver.receive(...Object.values(deliver(m, m.episodeId, "att-1")) as [Buffer, never]);
  assert.equal(wrongKey.status, 400);
  assert.match(String(wrongKey.body.reason), /content-manifest:<episodeId>/);
  const badDigest = manifest({ contentSha256: digest("not the body") });
  const badDigestResult = receiver.receive(...Object.values(deliver(badDigest, `content-manifest:${badDigest.episodeId}`, "att-2")) as [Buffer, never]);
  assert.equal(badDigestResult.status, 400);
  assert.match(String(badDigestResult.body.reason), /contentSha256/);
  const badItem = { ...m, items: [{ ...m.items[0]!, ref: "https://not-a-content-ref" }] };
  const badItemResult = receiver.receive(...Object.values(deliver(badItem, `content-manifest:${m.episodeId}`, "att-3")) as [Buffer, never]);
  assert.equal(badItemResult.status, 400);
  assert.match(String(badItemResult.body.reason), /neither/);
  assert.equal(store.events().length, 0);
});

test("the HTTP listener accepts manifests on the episode path and on the content-manifests alias", async () => {
  const store = new MemoryEventStore();
  const receiver = new PlatformEpisodeReceiver(store, { publicKey, expectedKeyId: KEY_ID });
  const server = createServer(createPlatformEpisodeRequestListener(receiver));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const m = manifest();
    const { raw, headers } = deliver(m, `content-manifest:${m.episodeId}`, "att-http");
    const post = async (path: string) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", body: raw, headers: { "content-type": "application/json", "idempotency-key": headers.idempotencyKey, "x-amos-attestation-receipt": headers.attestationReceiptId, "x-amos-kms-key-id": headers.kmsKeyId, "x-amos-kms-signing-algorithm": headers.signingAlgorithm, "x-amos-kms-signature": headers.signatureBase64 } });
    const viaAlias = await post("/v1/platform/content-manifests");
    assert.equal(viaAlias.status, 200);
    assert.equal(((await viaAlias.json()) as { status: string }).status, "accepted");
    const viaEpisodes = await post("/v1/platform/episodes");
    assert.equal(((await viaEpisodes.json()) as { status: string }).status, "duplicate");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
