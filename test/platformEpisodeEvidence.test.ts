import test from "node:test";
import assert from "node:assert/strict";

import {
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
import { AllowListHostGate, receipt } from "./helpers.ts";

const evidenceBlock = () => ({
  schema: PLATFORM_MISSION_EVIDENCE_SCHEMA,
  version: 1,
  recoveryEvidence: {
    version: 1,
    coverage: "complete",
    unexpectedCorrections: 1,
    requiredRecoveries: 1,
    evidenceRefs: ["step:2", "checkpoint:3"],
  },
  acceptedAttemptBindings: [
    { kind: "failure", plannerAttempt: 1, stepPosition: 1, claimId: null, receiptId: null, status: "planner_input_rejected" },
    { kind: "tool_call", plannerAttempt: 2, stepPosition: 2, claimId: "claim-2", receiptId: "receipt-2", status: "executed" },
  ],
  attemptIdentities: [
    // Gateway did not supply treatment/request/input identity today -> null, never inferred.
    { plannerAttempt: 1, stepPosition: 1, kind: "failure", failureClass: "planner_input_rejected", traceDigest: "t".repeat(64), requestDigest: null, compiledInputSha256: null, requestPayloadSha256: null, treatmentSha256: null },
    { plannerAttempt: 2, stepPosition: 2, kind: "checkpoint", failureClass: null, traceDigest: "u".repeat(64), requestDigest: null, compiledInputSha256: null, requestPayloadSha256: null, treatmentSha256: null },
  ],
});

function episode(withEvidence: boolean, status: "completed" | "failed" = "completed") {
  const source: Record<string, unknown> = {
    episodeId: `platform-mission:t:m:${status}:${withEvidence ? "ev" : "legacy"}:v1`,
    tenantId: "t",
    missionId: "m",
    contractId: "c",
    terminalStatus: status,
    task: {},
    trajectory: {},
    outcome: {},
    verification: {
      totalCount: 1, passedCount: 1, failedCount: 0, allPassed: true,
      fullTraceDigest: "a".repeat(64), first: [{ verdict: "pass" }], last: [],
    },
  };
  if (withEvidence) source.evidence = evidenceBlock();
  return {
    schema: PLATFORM_MISSION_EPISODE_SCHEMA,
    schemaVersion: 1,
    episodeId: source.episodeId as string,
    tenantId: "t",
    missionId: "m",
    terminalStatus: status,
    sourceEpisodeDigest: digest(source),
    rightsTags: ["amos-owned"],
    consentReceiptId: "consent",
    source,
  } satisfies PlatformMissionLearningEpisodeContract;
}

const attest = (gate: AllowListHostGate, value: PlatformMissionLearningEpisodeContract) =>
  gate.allow({ ...receipt("attested", "m", "platform-episode-attested"), payloadDigest: digest(value) });

test("signed new-evidence episode is accepted and evidence is normalized", () => {
  const gate = new AllowListHostGate();
  const store = new MemoryEventStore();
  const value = episode(true);
  const result = new PlatformEpisodeIntake(gate, store).ingest(value, attest(gate, value));
  assert.equal(result.classification, "verified");
  assert.equal(result.event.payload.evidencePresent, true);
  const ev = result.event.payload.evidence as ReturnType<typeof validateMissionEvidence>;
  assert.equal(ev.recoveryEvidence?.coverage, "complete");
  assert.equal(ev.recoveryEvidence?.unexpectedCorrections, 1);
  assert.equal(ev.acceptedAttemptBindings.length, 2);
  assert.equal(attemptBindingKey(ev.acceptedAttemptBindings[1]!), "2:2");
  // Identity absent at the gateway stays null; the consumer never manufactures a treatment digest.
  assert.equal(ev.attemptIdentities[0]!.treatmentSha256, null);
  assert.equal(ev.attemptIdentities[0]!.requestDigest, null);
});

test("legacy episode with no source.evidence is accepted with unknowns", () => {
  const gate = new AllowListHostGate();
  const store = new MemoryEventStore();
  const value = episode(false);
  const result = new PlatformEpisodeIntake(gate, store).ingest(value, attest(gate, value));
  assert.equal(result.classification, "verified");
  assert.equal(result.event.payload.evidencePresent, false);
  const ev = result.event.payload.evidence as ReturnType<typeof validateMissionEvidence>;
  assert.equal(ev.present, false);
  assert.equal(ev.recoveryEvidence, null);
  assert.equal(ev.acceptedAttemptBindings.length, 0);
  assert.equal(ev.attemptIdentities.length, 0);
});

test("a tampered source (mutated evidence block) is refused by the source digest", () => {
  const gate = new AllowListHostGate();
  const value = episode(true);
  const attested = attest(gate, value);
  // Mutating the evidence after the digest was taken breaks digest(source) === sourceEpisodeDigest.
  const tampered = { ...value, source: { ...value.source, evidence: { ...evidenceBlock(), version: 2 } } };
  assert.throws(
    () => new PlatformEpisodeIntake(gate, new MemoryEventStore()).ingest(tampered, attested),
    /bytes do not match|source digest mismatch/,
  );
});

test("a present-but-malformed evidence block is rejected (emission gate)", () => {
  // treatmentSha256 wrong type
  const badId = { ...evidenceBlock(), attemptIdentities: [{ ...evidenceBlock().attemptIdentities[0]!, treatmentSha256: 123 }] };
  assert.throws(() => validateMissionEvidence({ evidence: badId } as Record<string, unknown>), PlatformEpisodeEvidenceInvalid);
  // counts present while coverage is not complete
  const badRecovery = { ...evidenceBlock(), recoveryEvidence: { version: 1, coverage: "partial", unexpectedCorrections: 3, requiredRecoveries: 0, evidenceRefs: [] } };
  assert.throws(() => validateMissionEvidence({ evidence: badRecovery } as Record<string, unknown>), /counts must be null unless coverage is complete/);
  // wrong schema
  assert.throws(() => validateMissionEvidence({ evidence: { ...evidenceBlock(), schema: "nope" } } as Record<string, unknown>), /schema must be/);
});

test("validateMissionEvidence keys bindings by (plannerAttempt, stepPosition) with null for unknown attempts", () => {
  const ev = validateMissionEvidence({ evidence: evidenceBlock() } as Record<string, unknown>);
  assert.deepEqual(ev.acceptedAttemptBindings.map(attemptBindingKey), ["1:1", "2:2"]);
  const unknown = validateMissionEvidence({
    evidence: { ...evidenceBlock(), acceptedAttemptBindings: [{ kind: "tool_call", plannerAttempt: null, stepPosition: 5, claimId: null, receiptId: null, status: "ambiguous" }] },
  } as Record<string, unknown>);
  assert.equal(attemptBindingKey(unknown.acceptedAttemptBindings[0]!), "null:5");
});
