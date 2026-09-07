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

// Shared cross-language wire fixture bound by both the Platform Rust producer (#861) and this
// consumer (#63). Case ids mirror coordination/artifacts/episode-producer-review-20260907/cases.json.
const WIRE = JSON.parse(readFileSync(new URL("./fixtures/platform-mission-evidence-block.producer.json", import.meta.url), "utf8"));
const wireCase = (id: string) => structuredClone(WIRE.cases[id]);
const producerBlock = () => wireCase("failure-then-correction");

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

// ---- cross-language wire alignment: every producer case is accepted --------------------------

test("all four shared wire cases validate with the agreed rules", () => {
  const correction = validateMissionEvidence({ evidence: wireCase("failure-then-correction") } as Record<string, unknown>);
  assert.equal(correction.recoveryEvidence?.coverage, "complete");
  assert.equal(correction.recoveryEvidence?.unexpectedCorrections, 1);
  assert.deepEqual([...correction.recoveryEvidence!.evidenceRefs], ["step:1", "step:3"]); // string host refs
  // Rejected attempt is NOT an accepted binding; only the accepted tool_call + checkpoint are.
  // Actual producer emits only the accepted checkpoint binding for this synthetic case.
  assert.deepEqual(correction.acceptedAttemptBindings.map(attemptBindingKey), ["2:3"]);
  assert.equal(correction.recoveryEvidence?.requiredRecoveries, 0);
  assert.equal(correction.acceptedAttemptBindings.some((b) => b.kind === "failure"), false);
  // The failure survives in attemptIdentities with its failureClass.
  assert.equal(correction.attemptIdentities[0]!.failureClass, "planner_input_rejected");

  const success = validateMissionEvidence({ evidence: wireCase("instrumented-first-attempt-success") } as Record<string, unknown>);
  assert.equal(success.recoveryEvidence?.coverage, "complete");
  assert.deepEqual([...success.recoveryEvidence!.evidenceRefs], ["step:1"]); // complete cites the instrumented checkpoint
  assert.equal(success.recoveryEvidence?.unexpectedCorrections, 0);

  const partial = validateMissionEvidence({ evidence: wireCase("partial-coverage") } as Record<string, unknown>);
  assert.equal(partial.recoveryEvidence?.coverage, "partial");
  assert.equal(partial.recoveryEvidence?.unexpectedCorrections, null); // null counts on partial

  const unknown = validateMissionEvidence({ evidence: wireCase("legacy-unknown-coverage") } as Record<string, unknown>);
  assert.equal(unknown.recoveryEvidence?.coverage, "unknown");
  assert.equal(unknown.recoveryEvidence?.unexpectedCorrections, null);
  assert.deepEqual([...unknown.recoveryEvidence!.evidenceRefs], []);
});

test("a tool_call binding with snake_case claim/receipt normalizes to camelCase (coverage preserved)", () => {
  const block = { ...wireCase("failure-then-correction"), acceptedAttemptBindings: [
    { kind: "tool_call", planner_attempt: 2, step_position: 2, claim_id: "claim-2", receipt_id: "receipt-2", status: "executed" },
    { kind: "checkpoint", planner_attempt: 2, step_position: 3 },
  ] };
  const ev = validateMissionEvidence({ evidence: block } as Record<string, unknown>);
  const toolCall = ev.acceptedAttemptBindings.find((b) => b.kind === "tool_call")!;
  assert.equal(toolCall.claimId, "claim-2");
  assert.equal(toolCall.receiptId, "receipt-2");
  assert.equal(toolCall.status, "executed");
  assert.equal(attemptBindingKey(toolCall), "2:2");
});

test("integer evidenceRefs and complete-without-refs (the two producer P1s) stay rejected", () => {
  const intRefs = { ...wireCase("failure-then-correction"), recoveryEvidence: { version: 1, coverage: "complete", unexpectedCorrections: 1, requiredRecoveries: 1, evidenceRefs: [1, 3] } };
  assert.throws(() => validateMissionEvidence({ evidence: intRefs } as Record<string, unknown>), /evidenceRefs must be an array of strings/);
  const emptyComplete = { ...wireCase("instrumented-first-attempt-success"), recoveryEvidence: { version: 1, coverage: "complete", unexpectedCorrections: 0, requiredRecoveries: 0, evidenceRefs: [] } };
  assert.throws(() => validateMissionEvidence({ evidence: emptyComplete } as Record<string, unknown>), /complete coverage requires non-empty evidenceRefs/);
});

test("snake_case checkpoint binding (no status) and null-attempt identity are accepted", () => {
  const ev = validateMissionEvidence({ evidence: wireCase("failure-then-correction") } as Record<string, unknown>);
  const checkpoint = ev.acceptedAttemptBindings.find((b) => b.kind === "checkpoint")!;
  assert.equal(checkpoint.status, null);
  assert.equal(checkpoint.claimId, null);
  const nullAttempt = validateMissionEvidence({ evidence: { ...wireCase("legacy-unknown-coverage"), attemptIdentities: [{ kind: "failure", plannerAttempt: null, stepPosition: 1 }] } } as Record<string, unknown>);
  assert.equal(nullAttempt.attemptIdentities[0]!.plannerAttempt, null);
});

test("non-hex identity digest and unknown-vocabulary coverage are rejected", () => {
  const badHex = { ...wireCase("failure-then-correction"), attemptIdentities: [{ kind: "failure", plannerAttempt: 1, stepPosition: 1, traceDigest: "t".repeat(64) }] };
  assert.throws(() => validateMissionEvidence({ evidence: badHex } as Record<string, unknown>), /lowercase 64-char hex/);
  const badCoverage = { ...wireCase("legacy-unknown-coverage"), recoveryEvidence: { version: 1, coverage: "none", unexpectedCorrections: null, requiredRecoveries: null, evidenceRefs: [] } };
  assert.throws(() => validateMissionEvidence({ evidence: badCoverage } as Record<string, unknown>), PlatformEpisodeEvidenceInvalid);
  assert.throws(() => validateMissionEvidence({ evidence: { ...wireCase("legacy-unknown-coverage"), schema: "nope" } } as Record<string, unknown>), /schema must be/);
});

// ---- intake compatibility ----------------------------------------------------------------

test("intake: signed new-evidence episode accepted; evidence normalized in the payload", () => {
  const gate = new AllowListHostGate();
  const store = new MemoryEventStore();
  const value = envelope(makeSource(true));
  const result = new PlatformEpisodeIntake(gate, store).ingest(value, attest(gate, value));
  assert.equal(result.classification, "verified");
  assert.equal(result.event.payload.evidencePresent, true);
  const ev = result.event.payload.evidence as ReturnType<typeof validateMissionEvidence>;
  assert.equal(ev.acceptedAttemptBindings.length, 1);
});

test("intake: legacy no-evidence episode keeps the exact pre-upgrade payload shape", () => {
  const gate = new AllowListHostGate();
  const store = new MemoryEventStore();
  const value = envelope(makeSource(false));
  const result = new PlatformEpisodeIntake(gate, store).ingest(value, attest(gate, value));
  assert.equal("evidencePresent" in result.event.payload, false);
  assert.equal("evidence" in result.event.payload, false);
});

test("intake: a legacy event stored BEFORE the upgrade re-ingests without a conflict", () => {
  const gate = new AllowListHostGate();
  const store = new MemoryEventStore();
  const value = envelope(makeSource(false));
  const attested = attest(gate, value);
  store.append({
    id: `platform-episode:${value.episodeId}`, type: "platform.experience-verified", missionId: "m",
    occurredAt: attested.issuedAt, authority: "host", hostReceiptId: attested.id,
    payload: { episodeId: value.episodeId, terminalStatus: value.terminalStatus, sourceEpisodeDigest: value.sourceEpisodeDigest, rightsTags: [...value.rightsTags].sort(), consentReceiptId: value.consentReceiptId, source: value.source, geneAdmissionAllowed: false },
  });
  const result = new PlatformEpisodeIntake(gate, store).ingest(value, attested);
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

test("signed receiver accepts new-evidence + legacy episodes and rejects a tampered evidence block", () => {
  const receiver = new PlatformEpisodeReceiver(new MemoryEventStore(), { publicKey, expectedKeyId: KEY_ID, now: () => new Date("2026-09-07T00:00:00Z") });
  const withEv = deliver(envelope(makeSource(true)));
  assert.equal(receiver.receive(withEv.raw, withEv.headers).status, 200);
  const legacyReceiver = new PlatformEpisodeReceiver(new MemoryEventStore(), { publicKey, expectedKeyId: KEY_ID });
  const legacy = deliver(envelope(makeSource(false)));
  assert.equal(legacyReceiver.receive(legacy.raw, legacy.headers).status, 200);
  const tamperedBytes = Buffer.from(withEv.raw.toString("utf8").replace("planner_input_rejected", "executed"), "utf8");
  assert.equal(new PlatformEpisodeReceiver(new MemoryEventStore(), { publicKey, expectedKeyId: KEY_ID }).receive(tamperedBytes, withEv.headers).status, 401);
});

test("signed receiver is idempotent on a re-delivered evidence episode", () => {
  const receiver = new PlatformEpisodeReceiver(new MemoryEventStore(), { publicKey, expectedKeyId: KEY_ID });
  const d = deliver(envelope(makeSource(true)));
  assert.equal(receiver.receive(d.raw, d.headers).body.status, "accepted");
  assert.equal(receiver.receive(d.raw, { ...d.headers, attestationReceiptId: "att-ev-retry" }).body.status, "duplicate");
});
