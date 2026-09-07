import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  canonicalJson,
  digest,
  MemoryEventStore,
  PlatformEpisodeIntake,
  PLATFORM_MISSION_EPISODE_SCHEMA,
  PLATFORM_MISSION_EVIDENCE_SCHEMA,
  validateMissionEvidence,
  attemptBindingKey,
  PlatformEpisodeEvidenceInvalid,
  type PlatformMissionLearningEpisodeContract,
} from "../src/index.ts";
import { PlatformEpisodeReceiver } from "../src/platformEpisodeReceiver.ts";
import { AllowListHostGate, receipt } from "./helpers.ts";

// Canonical producer-shaped evidence block shared with Platform
// (coordination/artifacts/episode-evidence-producer-fixture-v1.json): snake_case bindings,
// camelCase identities, unknown-coverage recovery, lowercase-hex digests.
const producerBlock = () =>
  JSON.parse(readFileSync(new URL("./fixtures/platform-mission-evidence-block.producer.json", import.meta.url), "utf8"));

function makeSource(withEvidence: boolean, status: "completed" | "failed" = "completed", evidence?: unknown) {
  const source: Record<string, unknown> = {
    episodeId: `platform-mission:t:m:${status}:${withEvidence ? "ev" : "legacy"}:v1`,
    tenantId: "t", missionId: "m", contractId: "c", terminalStatus: status,
    task: {}, trajectory: {}, outcome: {},
    verification: { totalCount: 1, passedCount: 1, failedCount: 0, allPassed: true, fullTraceDigest: "a".repeat(64), first: [{ verdict: "pass" }], last: [] },
  };
  if (withEvidence) source.evidence = evidence ?? producerBlock();
  return source;
}

function envelope(source: Record<string, unknown>): PlatformMissionLearningEpisodeContract {
  return {
    schema: PLATFORM_MISSION_EPISODE_SCHEMA, schemaVersion: 1,
    episodeId: source.episodeId as string, tenantId: "t", missionId: "m",
    terminalStatus: source.terminalStatus as "completed" | "failed",
    sourceEpisodeDigest: digest(source), rightsTags: ["amos-owned"], consentReceiptId: "consent", source,
  } satisfies PlatformMissionLearningEpisodeContract;
}

const attest = (gate: AllowListHostGate, value: PlatformMissionLearningEpisodeContract) =>
  gate.allow({ ...receipt("attested", "m", "platform-episode-attested"), payloadDigest: digest(value) });

// ---- validator unit + Codex 183822Z reproducer cases -------------------------------------

test("producer-shaped evidence normalizes: unknown coverage, snake_case bindings, nullable identity", () => {
  const ev = validateMissionEvidence({ evidence: producerBlock() } as Record<string, unknown>);
  assert.equal(ev.present, true);
  assert.equal(ev.recoveryEvidence?.coverage, "unknown");
  assert.equal(ev.recoveryEvidence?.unexpectedCorrections, null);
  assert.deepEqual(ev.acceptedAttemptBindings.map(attemptBindingKey), ["1:1", "2:2", "2:3"]);
  const checkpoint = ev.acceptedAttemptBindings[2]!; // no status/claim/receipt on the wire
  assert.equal(checkpoint.status, null);
  assert.equal(checkpoint.claimId, null);
  assert.equal(checkpoint.receiptId, null);
  assert.equal(ev.attemptIdentities[0]!.treatmentSha256, null); // never inferred
});

test("canonical unknown coverage is accepted (comparator vocabulary complete|partial|unknown)", () => {
  const block = { ...producerBlock(), recoveryEvidence: { version: 1, coverage: "unknown", unexpectedCorrections: null, requiredRecoveries: null, evidenceRefs: [] } };
  const ev = validateMissionEvidence({ evidence: block } as Record<string, unknown>);
  assert.equal(ev.recoveryEvidence?.coverage, "unknown");
});

test("complete coverage without host evidenceRefs is rejected", () => {
  const block = { ...producerBlock(), recoveryEvidence: { version: 1, coverage: "complete", unexpectedCorrections: 0, requiredRecoveries: 0, evidenceRefs: [] } };
  assert.throws(() => validateMissionEvidence({ evidence: block } as Record<string, unknown>), /complete coverage requires non-empty evidenceRefs/);
});

test("complete coverage with host refs and counts is accepted", () => {
  const block = { ...producerBlock(), recoveryEvidence: { version: 1, coverage: "complete", unexpectedCorrections: 1, requiredRecoveries: 1, evidenceRefs: ["step:2", "checkpoint:3"] } };
  const ev = validateMissionEvidence({ evidence: block } as Record<string, unknown>);
  assert.equal(ev.recoveryEvidence?.unexpectedCorrections, 1);
});

test("actual get_mission checkpoint binding (snake_case, no status) is accepted", () => {
  const block = { ...producerBlock(), recoveryEvidence: null, acceptedAttemptBindings: [{ kind: "checkpoint", planner_attempt: 2, step_position: 5 }], attemptIdentities: [] };
  const ev = validateMissionEvidence({ evidence: block } as Record<string, unknown>);
  assert.equal(attemptBindingKey(ev.acceptedAttemptBindings[0]!), "2:5");
  assert.equal(ev.acceptedAttemptBindings[0]!.status, null);
});

test("unknown-attempt planner step (plannerAttempt null) is accepted, not invented", () => {
  const block = { ...producerBlock(), recoveryEvidence: null, acceptedAttemptBindings: [], attemptIdentities: [{ kind: "failure", plannerAttempt: null, stepPosition: 1 }] };
  const ev = validateMissionEvidence({ evidence: block } as Record<string, unknown>);
  assert.equal(ev.attemptIdentities[0]!.plannerAttempt, null);
  assert.equal(ev.attemptIdentities[0]!.traceDigest, null);
});

test("non-hex identity digest is rejected", () => {
  const block = { ...producerBlock(), attemptIdentities: [{ kind: "failure", plannerAttempt: 1, stepPosition: 1, traceDigest: "t".repeat(64) }] };
  assert.throws(() => validateMissionEvidence({ evidence: block } as Record<string, unknown>), /lowercase 64-char hex/);
});

test("wrong schema / unknown-vocabulary coverage / bad recovery are rejected", () => {
  assert.throws(() => validateMissionEvidence({ evidence: { ...producerBlock(), schema: "nope" } } as Record<string, unknown>), /schema must be/);
  const badCoverage = { ...producerBlock(), recoveryEvidence: { version: 1, coverage: "none", unexpectedCorrections: null, requiredRecoveries: null, evidenceRefs: [] } };
  assert.throws(() => validateMissionEvidence({ evidence: badCoverage } as Record<string, unknown>), PlatformEpisodeEvidenceInvalid);
});

// ---- intake compatibility ----------------------------------------------------------------

test("intake: signed new-evidence episode is accepted and evidence is normalized in the payload", () => {
  const gate = new AllowListHostGate();
  const store = new MemoryEventStore();
  const value = envelope(makeSource(true));
  const result = new PlatformEpisodeIntake(gate, store).ingest(value, attest(gate, value));
  assert.equal(result.classification, "verified");
  assert.equal(result.event.payload.evidencePresent, true);
  const ev = result.event.payload.evidence as ReturnType<typeof validateMissionEvidence>;
  assert.equal(ev.acceptedAttemptBindings.length, 3);
});

test("intake: legacy no-evidence episode keeps the exact pre-upgrade payload shape (no evidence fields)", () => {
  const gate = new AllowListHostGate();
  const store = new MemoryEventStore();
  const value = envelope(makeSource(false));
  const result = new PlatformEpisodeIntake(gate, store).ingest(value, attest(gate, value));
  assert.equal(result.classification, "verified");
  assert.equal("evidencePresent" in result.event.payload, false);
  assert.equal("evidence" in result.event.payload, false);
});

test("intake: a legacy event stored BEFORE the upgrade re-ingests without a conflict (upgrade retry P1)", () => {
  const gate = new AllowListHostGate();
  const store = new MemoryEventStore();
  const value = envelope(makeSource(false));
  const attested = attest(gate, value);
  // Exact pre-upgrade event payload shape emitted by the previous intake.
  store.append({
    id: `platform-episode:${value.episodeId}`, type: "platform.experience-verified", missionId: "m",
    occurredAt: attested.issuedAt, authority: "host", hostReceiptId: attested.id,
    payload: { episodeId: value.episodeId, terminalStatus: value.terminalStatus, sourceEpisodeDigest: value.sourceEpisodeDigest, rightsTags: [...value.rightsTags].sort(), consentReceiptId: value.consentReceiptId, source: value.source, geneAdmissionAllowed: false },
  });
  const result = new PlatformEpisodeIntake(gate, store).ingest(value, attested); // must not throw
  assert.equal(result.event.id, `platform-episode:${value.episodeId}`);
  assert.equal(store.events().length, 1);
});

// ---- actual signed receiver: new + legacy + tamper + retry -------------------------------

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const KEY_ID = "arn:aws:kms:us-east-1:637423327454:key/test-organism-evidence";
function deliver(value: PlatformMissionLearningEpisodeContract, raw?: Buffer) {
  const body = raw ?? Buffer.from(canonicalJson(value), "utf8");
  return { raw: body, headers: { idempotencyKey: value.episodeId, attestationReceiptId: "att-ev", kmsKeyId: KEY_ID, signingAlgorithm: "ECDSA_SHA_256", signatureBase64: sign("sha256", body, privateKey).toString("base64"), bearerToken: null } };
}

test("signed receiver accepts a new-evidence episode and a legacy episode, and rejects a tampered evidence block", () => {
  const receiver = new PlatformEpisodeReceiver(new MemoryEventStore(), { publicKey, expectedKeyId: KEY_ID, now: () => new Date("2026-09-07T00:00:00Z") });
  const withEv = deliver(envelope(makeSource(true)));
  assert.equal(receiver.receive(withEv.raw, withEv.headers).status, 200);

  const legacyReceiver = new PlatformEpisodeReceiver(new MemoryEventStore(), { publicKey, expectedKeyId: KEY_ID });
  const legacy = deliver(envelope(makeSource(false)));
  assert.equal(legacyReceiver.receive(legacy.raw, legacy.headers).status, 200);

  // Tamper the evidence bytes after signing -> signature fails (401), no receipt minted.
  const tamperedBytes = Buffer.from(withEv.raw.toString("utf8").replace("planner_input_rejected", "executed"), "utf8");
  const tampered = new PlatformEpisodeReceiver(new MemoryEventStore(), { publicKey, expectedKeyId: KEY_ID }).receive(tamperedBytes, withEv.headers);
  assert.equal(tampered.status, 401);
});

test("signed receiver is idempotent on a re-delivered evidence episode", () => {
  const receiver = new PlatformEpisodeReceiver(new MemoryEventStore(), { publicKey, expectedKeyId: KEY_ID });
  const d = deliver(envelope(makeSource(true)));
  assert.equal(receiver.receive(d.raw, d.headers).body.status, "accepted");
  assert.equal(receiver.receive(d.raw, { ...d.headers, attestationReceiptId: "att-ev-retry" }).body.status, "duplicate");
});
