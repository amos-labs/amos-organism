import test from "node:test";
import assert from "node:assert/strict";
import { joinShadowWithEpisodes, parseJsonl, treatmentPairFromCandidate } from "../src/shadowDiagnostics.js";
import { validateMissionTreatment, EMPTY_PROCEDURE_SNAPSHOT_SHA256 } from "../src/missionComparisonProtocol.js";
import { digestResearchValue } from "../src/experimentProtocol.js";
import { readFileSync } from "node:fs";

const sha = (seed) => digestResearchValue({ seed });
const evidence = (stage, input) => ({ schema: "amos.swarm-input-evidence", version: 1, stage, compiledInputSha256: input, requestPayloadSha256: sha(`${stage}-payload`) });

function shadowRecord({ missionId = null, plannerAttempt = null, tenantId = null, agreement = true, shadowError = null, primaryInput = sha("input-1"), shadowInput = sha("input-1"), completedAt = "2026-09-05T20:00:00.000Z" } = {}) {
  return {
    schema: "amos.swarm-turn-shadow", version: 1, completedAt, stage: "integrator",
    requestDigest: sha(`request-${missionId}-${plannerAttempt}-${completedAt}`),
    mission: missionId ? { tenantId, missionId, contractId: "contract-1", plannerAttempt, planDecision: "tool", contractSatisfied: true } : null,
    textCaptured: tenantId === "tenant-consented",
    primary: { model: "base", text: null, textDigest: sha("p"), textLength: 10, inputEvidence: primaryInput ? evidence("integrator", primaryInput) : null },
    shadow: shadowError ? { model: "adapter", text: null, textDigest: null, textLength: null, inputEvidence: evidence("shadow:integrator", shadowInput), error: shadowError } : { model: "adapter", text: null, textDigest: sha("s"), textLength: 10, inputEvidence: evidence("shadow:integrator", shadowInput), error: null },
    agreement: shadowError ? null : agreement,
    servedToMission: "primary"
  };
}
function episodeEvent(missionId, verified, task = { objectiveDigest: sha("obj"), completionConditionDigest: sha("cc"), contractDigest: sha("contract"), operationKeys: ["finance.read"] }) {
  return {
    id: `platform-episode:platform-mission:t:${missionId}:${verified ? "completed" : "failed"}:v1`,
    type: verified ? "platform.experience-verified" : "platform.experience-negative",
    missionId, authority: "host", hostReceiptId: `platform-attestation:${missionId}`,
    payload: { episodeId: `platform-mission:t:${missionId}:${verified ? "completed" : "failed"}:v1`, terminalStatus: verified ? "completed" : "failed", source: { task } }
  };
}

test("shadow rows join to Mission episodes by missionId and never become comparator evidence", () => {
  const records = [
    shadowRecord({ missionId: "m1", plannerAttempt: 1, tenantId: "tenant-consented", agreement: true }),
    shadowRecord({ missionId: "m1", plannerAttempt: 2, tenantId: "tenant-consented", agreement: false, completedAt: "2026-09-05T20:01:00.000Z" }),
    shadowRecord({ missionId: "m2", plannerAttempt: 1, tenantId: "tenant-other", shadowError: "shadow timed out" }),
    shadowRecord({ missionId: "m3", plannerAttempt: 1, tenantId: "tenant-other", agreement: true, shadowInput: sha("input-other") }),
    shadowRecord()
  ];
  const events = [episodeEvent("m1", true), episodeEvent("m2", false)];
  const report = joinShadowWithEpisodes({ shadowRecords: records, episodeEvents: events, now: new Date("2026-09-05T21:00:00Z") });
  assert.equal(report.schema, "amos.shadow-diagnostics");
  assert.equal(report.counts.rows, 5);
  assert.equal(report.counts.noMission, 1);
  assert.equal(report.counts.missionWithoutEpisode, 1);
  assert.equal(report.counts.attributed, 3);
  assert.equal(report.counts.agreementRate, 0.5, "only attributed rows with a known agreement count");
  assert.equal(report.counts.compiledInputParityRate, 0.8);
  assert.equal(report.counts.shadowErrors, 1);
  assert.equal(report.counts.textCapturedRows, 2);
  assert.equal(report.counts.comparatorEligiblePairs, 0);
  assert.ok(report.rows.every((row) => row.comparatorEligible === false && row.evidenceClass === "diagnostic-only"));
  assert.deepEqual(report.agreementByTerminalStatus, { completed: { turns: 2, agree: 1, disagree: 1, shadowErrors: 0 }, failed: { turns: 1, agree: 0, disagree: 0, shadowErrors: 1 } });
  assert.equal(report.tasksObserved.length, 1, "identical task digests collapse to one observed task");
  assert.equal(report.rows.find((row) => row.missionId === "m3").attribution, "mission-without-episode");
  assert.equal(report.rows.find((row) => row.missionId === null).attribution, "no-mission");
  assert.equal(report.interpretation.unexecutedShadowAnswersAreEvidence, false);
  const again = joinShadowWithEpisodes({ shadowRecords: records, episodeEvents: events, now: new Date("2026-09-05T21:00:00Z") });
  assert.equal(again.digest, report.digest);
});

test("duplicate shadow lines collapse and non-shadow lines are ignored", () => {
  const record = shadowRecord({ missionId: "m1", plannerAttempt: 1, tenantId: "t" });
  const report = joinShadowWithEpisodes({ shadowRecords: [record, structuredClone(record), { schema: "amos.swarm-turn-gateway" }] });
  assert.equal(report.counts.rows, 1);
  assert.equal(parseJsonl('{"a":1}\n\n{"b":2}\n').length, 2);
  assert.throws(() => parseJsonl("{oops"), /line 1/);
});

test("the treatment pair for a ledger candidate validates under Codex's comparison-v2 rules and changes only weights", () => {
  const candidate = JSON.parse(readFileSync(new URL("../benchmarks/results/adapter-candidate-stage1-implicit-r32-s3.json", import.meta.url), "utf8"));
  const pair = treatmentPairFromCandidate({
    candidate,
    baseModelId: "amos-qwen38-27b-fp8",
    baseArtifactSha256: sha("base-fp8"),
    adapterArtifactSha256: sha("adapter-s3"),
    runtimeRevision: "e31eb568681d3a718b7aaa5ce646b6711494b186",
    promptCompilerSha256: sha("compiler"),
    schedulerPolicySha256: sha("scheduler"),
    inferenceConfigSha256: sha("inference")
  });
  validateMissionTreatment(pair.baseline);
  validateMissionTreatment(pair.candidate);
  assert.equal(pair.baseline.model.adapter, null);
  assert.equal(pair.candidate.model.adapter.uri, candidate.adapterUri);
  assert.equal(pair.candidate.model.adapter.trainingContractSha256, candidate.training.contractDigest);
  assert.equal(pair.baseline.procedureSnapshotSha256, EMPTY_PROCEDURE_SNAPSHOT_SHA256);
  assert.notEqual(pair.baseline.digest, pair.candidate.digest);
  assert.deepEqual(pair.changedDimensions, ["weights"]);
  assert.throws(() => treatmentPairFromCandidate({ candidate: { schema: "other" } }), /ledger record/);
});
