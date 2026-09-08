import test from "node:test";
import assert from "node:assert/strict";
import { joinShadowWithEpisodes, parseJsonl, treatmentPairFromCandidate } from "../src/shadowDiagnostics.js";
import { validateMissionTreatment, EMPTY_PROCEDURE_SNAPSHOT_SHA256 } from "../src/missionComparisonProtocol.js";
import { digestResearchValue } from "../src/experimentProtocol.js";
import { readFileSync } from "node:fs";

const sha = (seed) => digestResearchValue({ seed });
const evidence = (stage, input) => ({ schema: "amos.swarm-input-evidence", version: 1, stage, compiledInputSha256: input, requestPayloadSha256: sha(`${stage}-payload`) });

// The request digest and request-payload digest a shadow record carries for a given attempt.
// The episode's signed attemptIdentity must reproduce these exactly for the join to verify.
const requestDigestFor = (missionId, plannerAttempt, completedAt) => sha(`request-${missionId}-${plannerAttempt}-${completedAt}`);
const requestPayloadDigest = sha("integrator-payload");

function shadowRecord({ missionId = null, plannerAttempt = null, tenantId = null, agreement = true, shadowError = null, primaryInput = sha("input-1"), shadowInput = sha("input-1"), completedAt = "2026-09-05T20:00:00.000Z" } = {}) {
  return {
    schema: "amos.swarm-turn-shadow", version: 1, completedAt, stage: "integrator",
    requestDigest: requestDigestFor(missionId, plannerAttempt, completedAt),
    mission: missionId ? { tenantId, missionId, contractId: "contract-1", plannerAttempt, planDecision: "tool", contractSatisfied: true } : null,
    textCaptured: tenantId === "tenant-consented",
    inputEvidence: primaryInput ? evidence("integrator", primaryInput) : null,
    primary: { model: "base", text: null, textDigest: sha("p"), textLength: 10 },
    shadow: shadowError ? { model: "adapter", text: null, textDigest: null, textLength: null, inputEvidence: evidence("shadow:integrator", shadowInput), error: shadowError } : { model: "adapter", text: null, textDigest: sha("s"), textLength: 10, inputEvidence: evidence("shadow:integrator", shadowInput), error: null },
    agreement: shadowError ? null : agreement,
    servedToMission: "primary"
  };
}

// A signed attempt identity in the episode's source.evidence that reproduces a shadow attempt's tuple.
function attemptIdentity({ missionId, plannerAttempt, completedAt = "2026-09-05T20:00:00.000Z", primaryInput = sha("input-1") }) {
  return {
    plannerAttempt, stepPosition: plannerAttempt * 3, kind: "checkpoint", failureClass: null,
    traceDigest: sha(`trace-${missionId}-${plannerAttempt}`),
    requestDigest: requestDigestFor(missionId, plannerAttempt, completedAt),
    compiledInputSha256: primaryInput,
    requestPayloadSha256: requestPayloadDigest,
    treatmentSha256: null
  };
}

const DEFAULT_TASK = { objectiveDigest: sha("obj"), completionConditionDigest: sha("cc"), contractDigest: sha("contract"), operationKeys: ["finance.read"] };

function episodeEvent(missionId, verified, { tenantId = null, contractId = "contract-1", attempts = [], task = DEFAULT_TASK } = {}) {
  return {
    id: `platform-episode:platform-mission:t:${missionId}:${verified ? "completed" : "failed"}:v1`,
    type: verified ? "platform.experience-verified" : "platform.experience-negative",
    missionId, authority: "host", hostReceiptId: `platform-attestation:${missionId}`,
    payload: {
      episodeId: `platform-mission:t:${missionId}:${verified ? "completed" : "failed"}:v1`,
      terminalStatus: verified ? "completed" : "failed",
      source: {
        tenantId, contractId, task,
        evidence: { schema: "amos.platform-mission-evidence", version: 1, attemptIdentities: attempts.map((a) => attemptIdentity({ missionId, ...a })) }
      }
    }
  };
}

test("shadow rows attribute only on a verified signed attempt identity and never become comparator evidence", () => {
  const records = [
    shadowRecord({ missionId: "m1", plannerAttempt: 1, tenantId: "tenant-consented", agreement: true }),
    shadowRecord({ missionId: "m1", plannerAttempt: 2, tenantId: "tenant-consented", agreement: false, completedAt: "2026-09-05T20:01:00.000Z" }),
    shadowRecord({ missionId: "m2", plannerAttempt: 1, tenantId: "tenant-other", shadowError: "shadow timed out" }),
    shadowRecord({ missionId: "m3", plannerAttempt: 1, tenantId: "tenant-other", agreement: true, shadowInput: sha("input-other") }),
    shadowRecord()
  ];
  const events = [
    episodeEvent("m1", true, {
      tenantId: "tenant-consented",
      attempts: [
        { plannerAttempt: 1, completedAt: "2026-09-05T20:00:00.000Z" },
        { plannerAttempt: 2, completedAt: "2026-09-05T20:01:00.000Z" }
      ]
    }),
    episodeEvent("m2", false, { tenantId: "tenant-other", attempts: [{ plannerAttempt: 1 }] })
    // m3 has no episode at all.
  ];
  const report = joinShadowWithEpisodes({ shadowRecords: records, episodeEvents: events, now: new Date("2026-09-05T21:00:00Z") });
  assert.equal(report.schema, "amos.shadow-diagnostics");
  assert.equal(report.counts.rows, 5);
  assert.equal(report.counts.noMission, 1);
  assert.equal(report.counts.missionWithoutEpisode, 1);
  assert.equal(report.counts.attributed, 3, "m1#1, m1#2 and m2#1 each match exactly one signed attempt identity");
  assert.equal(report.counts.agreementRate, 0.5, "only attributed rows with a known agreement count");
  assert.equal(report.counts.compiledInputParityRate, 0.8);
  assert.equal(report.counts.shadowErrors, 1);
  assert.equal(report.counts.textCapturedRows, 2);
  assert.equal(report.counts.comparatorEligiblePairs, 0);
  assert.ok(report.rows.every((row) => row.comparatorEligible === false && row.evidenceClass === "diagnostic-only"));
  assert.ok(report.rows.filter((row) => row.attribution === "mission-terminal-episode").every((row) => row.identityVerified === true && row.identityMatchCount === 1 && row.matchedAttempt));
  assert.deepEqual(report.agreementByTerminalStatus, { completed: { turns: 2, agree: 1, disagree: 1, shadowErrors: 0 }, failed: { turns: 1, agree: 0, disagree: 0, shadowErrors: 1 } });
  assert.equal(report.tasksObserved.length, 1, "identical task digests collapse to one observed task");
  assert.equal(report.rows.find((row) => row.missionId === "m3").attribution, "mission-without-episode");
  assert.equal(report.rows.find((row) => row.missionId === null).attribution, "no-mission");
  assert.equal(report.interpretation.unexecutedShadowAnswersAreEvidence, false);
  const again = joinShadowWithEpisodes({ shadowRecords: records, episodeEvents: events, now: new Date("2026-09-05T21:00:00Z") });
  assert.equal(again.digest, report.digest);
});

test("adversarial: mission-id alone never attributes; only the exact signed identity tuple does", () => {
  const missionId = "adv-mission";
  const completedAt = "2026-09-05T20:00:00.000Z";
  const events = [episodeEvent(missionId, true, { tenantId: "tenant-a", contractId: "contract-1", attempts: [{ plannerAttempt: 1, completedAt }] })];
  const base = () => shadowRecord({ missionId, plannerAttempt: 1, tenantId: "tenant-a", completedAt });
  // Each mutation flips exactly one identity field away from the single signed attempt.
  const wrongPlannerAttempt = shadowRecord({ missionId, plannerAttempt: 999, tenantId: "tenant-a", completedAt });
  const wrongRequestDigest = { ...base(), requestDigest: sha("some-other-request") };
  const wrongCompiledInput = shadowRecord({ missionId, plannerAttempt: 1, tenantId: "tenant-a", completedAt, primaryInput: sha("other-input") });
  const wrongRequestPayload = (() => { const r = base(); r.inputEvidence = { ...r.inputEvidence, requestPayloadSha256: sha("other-payload") }; return r; })();
  const wrongTenant = shadowRecord({ missionId, plannerAttempt: 1, tenantId: "tenant-b", completedAt });

  const attr = (record) => joinShadowWithEpisodes({ shadowRecords: [record], episodeEvents: events }).rows[0].attribution;
  assert.equal(attr(base()), "mission-terminal-episode", "the exact signed tuple attributes");
  for (const [label, record] of [
    ["wrong-planner-attempt", wrongPlannerAttempt],
    ["wrong-request-digest", wrongRequestDigest],
    ["wrong-compiled-input", wrongCompiledInput],
    ["wrong-request-payload", wrongRequestPayload],
    ["wrong-tenant", wrongTenant]
  ]) {
    const report = joinShadowWithEpisodes({ shadowRecords: [record], episodeEvents: events });
    const row = report.rows[0];
    assert.equal(row.attribution, "mission-unverified-attempt", `${label} must stay unqualified, not attributed`);
    assert.equal(row.identityVerified, false, `${label} is not identity-verified`);
    assert.equal(report.counts.attributed, 0, `${label} produces zero attributed rows`);
    assert.equal(report.counts.missionUnverifiedAttempt, 1);
    assert.equal(report.counts.comparatorEligiblePairs, 0);
  }
});

test("ambiguous match (two signed attempts satisfy the same tuple) stays unqualified", () => {
  const missionId = "amb-mission";
  const completedAt = "2026-09-05T20:00:00.000Z";
  const event = episodeEvent(missionId, true, { tenantId: "tenant-a", attempts: [{ plannerAttempt: 1, completedAt }] });
  // Duplicate the single attempt so exactly the same tuple matches twice.
  event.payload.source.evidence.attemptIdentities.push({ ...event.payload.source.evidence.attemptIdentities[0] });
  const report = joinShadowWithEpisodes({ shadowRecords: [shadowRecord({ missionId, plannerAttempt: 1, tenantId: "tenant-a", completedAt })], episodeEvents: [event] });
  assert.equal(report.rows[0].identityMatchCount, 2);
  assert.equal(report.rows[0].identityVerified, false);
  assert.equal(report.rows[0].attribution, "mission-unverified-attempt");
});

test("transport-validation episodes are excluded from the shadow join and attribution", () => {
  const SYNTH_MISSION = "a10c9080-71f9-48e3-96b9-f6e2185332a0";
  const SYNTH_ID = "platform-mission:7f80fdb1-a26d-41e8-95ac-451aeaa54e32:a10c9080-71f9-48e3-96b9-f6e2185332a0:completed:v1";
  const syntheticEpisode = {
    id: `platform-episode:${SYNTH_ID}`, type: "platform.experience-negative", missionId: SYNTH_MISSION,
    authority: "host", hostReceiptId: "platform-attestation:synthetic",
    payload: { episodeId: SYNTH_ID, terminalStatus: "completed", source: { tenantId: "t", contractId: "contract-1", task: DEFAULT_TASK, evidence: { schema: "amos.platform-mission-evidence", version: 1, attemptIdentities: [attemptIdentity({ missionId: SYNTH_MISSION, plannerAttempt: 1 })] } } },
  };
  const records = [
    shadowRecord({ missionId: SYNTH_MISSION, plannerAttempt: 1, tenantId: "t" }),
    shadowRecord({ missionId: "m1", plannerAttempt: 1, tenantId: "t", completedAt: "2026-09-05T20:02:00.000Z" }),
  ];
  const events = [syntheticEpisode, episodeEvent("m1", true, { tenantId: "t", attempts: [{ plannerAttempt: 1, completedAt: "2026-09-05T20:02:00.000Z" }] })];
  const report = joinShadowWithEpisodes({ shadowRecords: records, episodeEvents: events, now: new Date("2026-09-05T21:00:00Z") });
  // The synthetic transport-validation episode is filtered out even though its own attempt identity matches -> its mission has no episode.
  const synthRow = report.rows.find((r) => r.missionId === SYNTH_MISSION);
  assert.equal(synthRow.attribution, "mission-without-episode");
  assert.equal(report.counts.attributed, 1, "only the real m1 episode attributes");
  assert.equal(report.counts.missionWithoutEpisode, 1);
  assert.ok(report.tasksObserved.every((t) => JSON.stringify(t).indexOf(SYNTH_ID) === -1));
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
