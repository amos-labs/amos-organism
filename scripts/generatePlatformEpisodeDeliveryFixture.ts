#!/usr/bin/env node
// Regenerate the signed Platform-episode delivery fixture used as the shared
// compatibility fixture (coordination plan, M0). Every case is a recorded HTTP
// delivery: exact body bytes, the X-Amos headers, and the outcome the reference
// receiver must produce. Consumers replay the cases against their own receiver
// or producer; nothing here is invented beyond the producer fixture.
//
//   node scripts/generatePlatformEpisodeDeliveryFixture.ts
//
// Keys are fixture-only P-256 keys kept beside the fixture so regeneration is
// reproducible; they sign nothing outside tests.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { canonicalJson, digest, type PlatformMissionLearningEpisodeContract } from "../src/index.ts";
import { PlatformEpisodeReceiver, publicKeyFromKmsDer } from "../src/platformEpisodeReceiver.ts";
import { MemoryEventStore } from "../src/index.ts";

export const PLATFORM_EPISODE_DELIVERY_FIXTURE_SCHEMA = "amos.platform-episode-delivery-fixture";
export const PLATFORM_EPISODE_DELIVERY_FIXTURE_VERSION = 1;
const KEY_ID = "arn:aws:kms:us-east-1:000000000000:key/fixture-organism-episode-signing";
const ALGORITHM = "ECDSA_SHA_256";
const NOW = "2026-09-05T19:00:00.000Z";

const fixturesDir = new URL("../test/fixtures/", import.meta.url);
const keysPath = new URL("platform-episode-delivery.test-keys.json", fixturesDir);
const outPath = new URL("platform-episode-delivery.v1.json", fixturesDir);

interface DeliveryHeaders {
  idempotencyKey: string;
  attestationReceiptId: string;
  kmsKeyId: string;
  signingAlgorithm: string;
  signatureBase64: string;
}
interface Expectation {
  status: 200 | 400 | 401;
  bodyStatus: "accepted" | "duplicate" | "rejected";
  classification?: "verified" | "negative";
  reasonPattern?: string;
}
interface DeliveryCase {
  id: string;
  description: string;
  requiresPriorCase: string | null;
  rawBodyBase64: string;
  headers: DeliveryHeaders;
  expect: Expectation;
}

function loadOrCreateKeys(): { signer: KeyObject; impostor: KeyObject } {
  if (existsSync(keysPath)) {
    const pems = JSON.parse(readFileSync(keysPath, "utf8")) as { signer: string; impostor: string };
    return { signer: createPrivateKey(pems.signer), impostor: createPrivateKey(pems.impostor) };
  }
  const signer = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  const impostor = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  writeFileSync(keysPath, `${JSON.stringify({
    purpose: "FIXTURE-ONLY P-256 keys for test/fixtures/platform-episode-delivery.v1.json; they sign nothing outside tests",
    signer: signer.export({ type: "pkcs8", format: "pem" }),
    impostor: impostor.export({ type: "pkcs8", format: "pem" })
  }, null, 2)}\n`);
  return { signer, impostor };
}

function deliver(raw: Buffer, key: KeyObject, receiptId: string, overrides: Partial<DeliveryHeaders> = {}): DeliveryHeaders {
  const parsed = JSON.parse(raw.toString("utf8")) as { episodeId: string };
  return {
    idempotencyKey: parsed.episodeId,
    attestationReceiptId: receiptId,
    kmsKeyId: KEY_ID,
    signingAlgorithm: ALGORITHM,
    signatureBase64: sign("sha256", raw, key).toString("base64"),
    ...overrides
  };
}

const { signer, impostor } = loadOrCreateKeys();
const publicKeyDerBase64 = createPublicKey(signer).export({ type: "spki", format: "der" }).toString("base64");

const completed = JSON.parse(readFileSync(new URL("platform-mission-episode.producer.json", fixturesDir), "utf8")) as PlatformMissionLearningEpisodeContract;

// Typed failure: the Platform marks the Mission failed, the checker verdict is
// fail, and the status reason names the producer failure class. Same tenant,
// different Mission so both episodes coexist in one store.
const failedMissionId = "8c2f3d4e-5f6a-4b7c-9d0e-1f2a3b4c5d6f";
const failedEpisodeId = `platform-mission:${completed.tenantId}:${failedMissionId}:failed:v1`;
const completedSource = completed.source as Record<string, any>;
const failedSource = {
  ...structuredClone(completedSource),
  episodeId: failedEpisodeId,
  missionId: failedMissionId,
  terminalStatus: "failed",
  outcome: {
    ...completedSource.outcome,
    status: "failed",
    statusReasonDigest: digest("authority_rejection: finance.reconcile was refused by the Run Contract"),
    finishedAt: "2026-09-01T10:00:06Z"
  },
  verification: {
    ...completedSource.verification,
    first: [{ ...completedSource.verification.first[0], verdict: "fail", coverage: 0.98, resultDigest: digest({ verdict: "fail", requirementId: "ap-reconciled" }) }],
    passedCount: 0,
    failedCount: 1,
    allPassed: false
  }
};
const failed: PlatformMissionLearningEpisodeContract = {
  ...completed,
  episodeId: failedEpisodeId,
  missionId: failedMissionId,
  terminalStatus: "failed",
  sourceEpisodeDigest: digest(failedSource),
  source: failedSource
};

const completedRaw = Buffer.from(canonicalJson(completed), "utf8");
const failedRaw = Buffer.from(canonicalJson(failed), "utf8");
const tamperedRaw = Buffer.from(completedRaw.toString("utf8").replace('"coverage":0.98', '"coverage":1'), "utf8");
const prettyRaw = Buffer.from(JSON.stringify(completed, null, 2), "utf8");
const good = deliver(completedRaw, signer, "att-fixture-1");

const cases: DeliveryCase[] = [
  { id: "verified-completed", description: "Completed Mission, all checks passed, canonical bytes, valid signature: accepted as verified experience.", requiresPriorCase: null, rawBodyBase64: completedRaw.toString("base64"), headers: good, expect: { status: 200, bodyStatus: "accepted", classification: "verified" } },
  { id: "duplicate-delivery", description: "Same bytes redelivered under a new attestation receipt (Platform outbox retry): acknowledged as duplicate, no second event.", requiresPriorCase: "verified-completed", rawBodyBase64: completedRaw.toString("base64"), headers: { ...good, attestationReceiptId: "att-fixture-1-retry" }, expect: { status: 200, bodyStatus: "duplicate" } },
  { id: "typed-failure", description: "Failed Mission with a failing checker verdict and a typed status reason (authority_rejection): accepted as negative experience.", requiresPriorCase: null, rawBodyBase64: failedRaw.toString("base64"), headers: deliver(failedRaw, signer, "att-fixture-2"), expect: { status: 200, bodyStatus: "accepted", classification: "negative" } },
  { id: "tampered-body", description: "One byte of the verified body changed after signing: refused for signature, no receipt minted.", requiresPriorCase: null, rawBodyBase64: tamperedRaw.toString("base64"), headers: good, expect: { status: 401, bodyStatus: "rejected", reasonPattern: "signature" } },
  { id: "non-canonical-body", description: "Same episode, pretty-printed and correctly signed: refused because the body is not the canonical encoding.", requiresPriorCase: null, rawBodyBase64: prettyRaw.toString("base64"), headers: deliver(prettyRaw, signer, "att-fixture-3"), expect: { status: 400, bodyStatus: "rejected", reasonPattern: "canonical" } },
  { id: "forged-signature", description: "Canonical body signed by a key that is not the organism episode-signing key: refused.", requiresPriorCase: null, rawBodyBase64: completedRaw.toString("base64"), headers: deliver(completedRaw, impostor, "att-fixture-4"), expect: { status: 401, bodyStatus: "rejected", reasonPattern: "signature" } },
  { id: "wrong-key-id", description: "Valid signature but the X-Amos key id names another KMS key: refused before verification.", requiresPriorCase: null, rawBodyBase64: completedRaw.toString("base64"), headers: { ...good, kmsKeyId: "arn:aws:kms:us-east-1:000000000000:key/other" }, expect: { status: 401, bodyStatus: "rejected", reasonPattern: "key id" } },
  { id: "disallowed-algorithm", description: "Header claims RSASSA_PSS_SHA_256; only ECDSA_SHA_256 is allowed for this key.", requiresPriorCase: null, rawBodyBase64: completedRaw.toString("base64"), headers: { ...good, signingAlgorithm: "RSASSA_PSS_SHA_256" }, expect: { status: 401, bodyStatus: "rejected", reasonPattern: "algorithm" } },
  { id: "idempotency-mismatch", description: "Idempotency key does not match the episode id inside the signed body: refused.", requiresPriorCase: null, rawBodyBase64: completedRaw.toString("base64"), headers: { ...good, idempotencyKey: "someone-else" }, expect: { status: 400, bodyStatus: "rejected", reasonPattern: "idempotency" } }
];

// Prove every expectation against the reference receiver before writing.
const store = new MemoryEventStore();
const receiver = new PlatformEpisodeReceiver(store, { publicKey: publicKeyFromKmsDer(publicKeyDerBase64), expectedKeyId: KEY_ID, now: () => new Date(NOW) });
for (const item of cases) {
  const response = receiver.receive(Buffer.from(item.rawBodyBase64, "base64"), { ...item.headers, bearerToken: null } as any);
  const ok = response.status === item.expect.status
    && response.body.status === item.expect.bodyStatus
    && (item.expect.classification === undefined || response.body.classification === item.expect.classification)
    && (item.expect.reasonPattern === undefined || new RegExp(item.expect.reasonPattern, "i").test(String(response.body.reason)));
  if (!ok) throw new Error(`fixture case ${item.id} does not behave as expected: ${JSON.stringify(response)}`);
}
if (store.events().length !== 2) throw new Error(`expected exactly 2 ingested events, got ${store.events().length}`);

const fixture = {
  schema: PLATFORM_EPISODE_DELIVERY_FIXTURE_SCHEMA,
  version: PLATFORM_EPISODE_DELIVERY_FIXTURE_VERSION,
  generatedAt: NOW,
  description: "Recorded deliveries of Platform Mission learning episodes to the organism intake. Replay in order with one receiver; the receiver is configured with publicKeyDerBase64 (KMS GetPublicKey SPKI DER) and expectedKeyId. Bodies are exact bytes; headers map to X-Amos-Idempotency-Key, X-Amos-Attestation-Receipt-Id, X-Amos-Kms-Key-Id, X-Amos-Signing-Algorithm, X-Amos-Signature.",
  producerReference: "amos-managed-platform src/services/organism_learning.rs (build_episode_body), mirrored by test/fixtures/platform-mission-episode.producer.json",
  receiverReference: "amos-organism src/platformEpisodeReceiver.ts",
  keyId: KEY_ID,
  signingAlgorithm: ALGORITHM,
  publicKeyDerBase64,
  eventsAfterReplay: 2,
  cases
};
writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${outPath.pathname} (${cases.length} cases, digest ${digest(fixture).slice(0, 16)})`);
