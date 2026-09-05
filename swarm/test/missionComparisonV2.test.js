import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestResearchValue } from "../src/experimentProtocol.js";
import { compareVerifiedMissions, validateVerifiedMissionComparison } from "../src/missionComparison.js";
import { createMissionTreatment, validateMissionTreatment, createMissionComparisonProtocol, EMPTY_PROCEDURE_SNAPSHOT_SHA256 } from "../src/missionComparisonProtocol.js";
import { shadowGateFromMissionComparison } from "../src/adapterCandidates.js";
import { missionComparisonInput, resignMeasurement } from "./fixtures/missionComparisonFixtures.js";
import { missionComparisonV2Input, refreshProtocol, setMissionPassed } from "./fixtures/missionComparisonV2Fixtures.js";

test("v1 replay and its recorded first-attempt meaning remain byte-identical", () => {
  const report = compareVerifiedMissions(missionComparisonInput());
  assert.equal(report.digest, "e4ffb83d88fb4f773c22696960d5fb7d724d762af684facbf9f47ba281940ea0");
  assert.equal(validateVerifiedMissionComparison(report).digest, report.digest);
  assert.equal(shadowGateFromMissionComparison(report).status, "passed");
});

test("the published JSON fixture is a replayable, insufficient compatibility sample", async () => {
  const input = JSON.parse(await readFile(new URL("./fixtures/mission-comparison.v2.json", import.meta.url), "utf8"));
  assert.deepEqual(input, missionComparisonV2Input(2));
  const report = compareVerifiedMissions(input);
  assert.equal(report.version, 2);
  assert.equal(report.metrics.pairs, 2);
  assert.equal(report.checks.completeCheckerCoverage, true);
  assert.equal(report.checks.enoughIndependentMissions, false);
  assert.equal(report.passed, false);
  assert.equal(validateVerifiedMissionComparison(report).digest, report.digest);
});

test("v2 weights, procedures and runtime comparisons share one replayable evaluator", () => {
  for (const dimension of ["weights", "procedures", "runtime"]) {
    const input = missionComparisonV2Input(200, { dimension });
    const report = compareVerifiedMissions(input);
    assert.equal(report.passed, true, JSON.stringify(report.checks));
    assert.equal(report.baseline.model.modelId, report.candidate.model.modelId);
    assert.equal(report.metrics.primary.pairedWins, 40);
    assert.equal(report.metrics.primary.lift, 0.2);
    assert.ok(report.metrics.primary.confidenceInterval.lower > 0);
    assert.equal(validateVerifiedMissionComparison(report).digest, report.digest);
    assert.equal(report.interpretation.automaticPromotion, false);
    assert.throws(() => shadowGateFromMissionComparison(report), /separately reviewed integration/);
  }
});

test("a single win over 200 pairs cannot establish primary improvement", () => {
  const report = compareVerifiedMissions(missionComparisonV2Input(200, { wins: 1 }));
  assert.equal(report.checks.verifiedCompletionImproves, true);
  assert.equal(report.checks.primaryImprovesWithConfidence, false);
  assert.equal(report.passed, false);
});

test("first-attempt primary evidence does not relax the final-completion guard", () => {
  const input = missionComparisonV2Input();
  for (const pair of input.pairs.slice(0, 40)) {
    setMissionPassed(pair.baseline, true);
    pair.baseline.measurement.recoveryEvidence.unexpectedCorrections = 1;
    resignMeasurement(pair.baseline);
  }
  const report = compareVerifiedMissions(input);
  assert.equal(report.checks.primaryImprovesWithConfidence, true);
  assert.equal(report.checks.verifiedCompletionImproves, false);
  assert.equal(report.passed, false);
});

test("missing or partial recovery is unknown, never an implicit first-attempt pass", () => {
  for (const change of [m => { delete m.recoveryEvidence; }, m => { m.recoveryEvidence = null; }, m => { m.recoveryEvidence.coverage = "partial"; }, m => { m.recoveryEvidence = { version: 1, coverage: "unknown", unexpectedCorrections: null, requiredRecoveries: null, evidenceRefs: [] }; }]) {
    const input = missionComparisonV2Input();
    change(input.pairs[0].candidate.measurement); resignMeasurement(input.pairs[0].candidate);
    const report = compareVerifiedMissions(input);
    assert.equal(report.metrics.candidate.firstAttemptUnknown, 1);
    assert.equal(report.metrics.candidate.firstAttemptPasses, 199);
    assert.equal(report.metrics.candidate.recoveries, null);
    assert.equal(report.metrics.primary.unknownPairs, 1);
    assert.equal(report.metrics.primary.lift, null);
    assert.equal(report.metrics.primary.confidenceInterval, null);
    assert.equal(report.checks.completeRecoveryCoverage, false);
    assert.equal(report.passed, false);
  }
});

test("required recovery challenges do not become unexpected corrections", () => {
  const input = missionComparisonV2Input();
  for (const pair of input.pairs) for (const arm of ["baseline", "candidate"]) {
    pair[arm].measurement.recoveryEvidence.requiredRecoveries = 1;
    resignMeasurement(pair[arm]);
  }
  let report = compareVerifiedMissions(input);
  assert.equal(report.metrics.candidate.firstAttemptPasses, 200);
  assert.equal(report.metrics.candidate.requiredRecoveries, 200);
  assert.equal(report.passed, true);
  input.pairs[0].candidate.measurement.recoveryEvidence.unexpectedCorrections = 1;
  resignMeasurement(input.pairs[0].candidate);
  report = compareVerifiedMissions(input);
  assert.equal(report.metrics.candidate.firstAttemptPasses, 199);
  assert.equal(report.checks.noAdditionalRecovery, false);
  assert.equal(report.checks.noAdditionalUnexpectedCorrection, false);
});

test("incomplete checker coverage remains unknown and blocks the comparison", () => {
  for (const change of [r => { r.mission.verification = []; }, r => { r.mission.verification[0].authority = "worker_self_check"; }, r => { r.mission.verification[0].coverage = 0.5; }, r => { r.mission.verification[0].unknown_requirements = ["missing"]; }]) {
    const input = missionComparisonV2Input(2);
    change(input.pairs[0].candidate); resignMeasurement(input.pairs[0].candidate);
    const report = compareVerifiedMissions(input);
    assert.equal(report.checks.completeCheckerCoverage, false);
    assert.equal(report.metrics.primary.confidenceInterval, null);
    assert.equal(report.passed, false);
  }
});

test("legacy counters, unsupported coverage and invented complete recovery are rejected", () => {
  for (const change of [m => { m.recoveries = 0; }, m => { m.recoveryEvidence.coverage = "inferred"; }, m => { m.recoveryEvidence.unexpectedCorrections = null; }, m => { m.recoveryEvidence.evidenceRefs = []; }, m => { m.recoveryEvidence.coverage = "unknown"; }]) {
    const input = missionComparisonV2Input(2);
    change(input.pairs[0].candidate.measurement); resignMeasurement(input.pairs[0].candidate);
    assert.throws(() => compareVerifiedMissions(input), /recovery|Corrections/);
  }
});

test("changed business memory, seed, tools, authority and budgets cannot hide in an ablation", () => {
  for (const change of [r => { r.measurement.context.memorySnapshotSha256 = "f".repeat(64); }, r => { r.measurement.context.runSeed++; }, r => { r.measurement.context.toolCatalogSha256 = "f".repeat(64); }, r => { r.mission.contract.allowed_operations.push("inventory.write"); }, r => { r.mission.contract.budgets.max_tool_calls++; }, r => { r.mission.contract.decision_policy.authority = "candidate"; }, r => { r.mission.contract.verification_policy.requirements[0].checker_version = "2"; }]) {
    const input = missionComparisonV2Input(2, { dimension: "procedures" });
    change(input.pairs[0].candidate); resignMeasurement(input.pairs[0].candidate);
    assert.throws(() => compareVerifiedMissions(input), /conditions changed/);
  }
});

test("treatment, protocol, mission and exact compiled input must bind to the executed arm", () => {
  for (const field of ["treatmentSha256", "protocolSha256", "compiledInputSha256"]) {
    const input = missionComparisonV2Input(2);
    input.pairs[0].candidate.measurement[field] = "f".repeat(64); resignMeasurement(input.pairs[0].candidate);
    assert.throws(() => compareVerifiedMissions(input), /bind|identical compiled/);
  }
  const input = missionComparisonV2Input(2);
  input.pairs[0].candidate.mission.objective = "An easier replacement task";
  resignMeasurement(input.pairs[0].candidate);
  assert.throws(() => compareVerifiedMissions(input), /conditions changed/);
});

test("undeclared treatment changes and fake serving aliases cannot establish a contrast", () => {
  const input = missionComparisonV2Input(2);
  input.candidate = createMissionTreatment({ ...input.candidate, schedulerPolicySha256: "f".repeat(64) });
  input.protocol.candidateTreatmentSha256 = input.candidate.digest; refreshProtocol(input);
  assert.throws(() => compareVerifiedMissions(input), /preregistered contrast/);
  const aliases = missionComparisonV2Input(2, { dimension: "procedures" });
  aliases.candidate = createMissionTreatment({ ...aliases.candidate, model: { ...aliases.candidate.model, modelId: "invented-better-model" } });
  aliases.protocol.candidateTreatmentSha256 = aliases.candidate.digest; refreshProtocol(aliases);
  assert.throws(() => compareVerifiedMissions(aliases), /aliases or metadata/);
});

test("procedures and encoder absence require explicit identities", () => {
  assert.equal(EMPTY_PROCEDURE_SNAPSHOT_SHA256, "3729e785172fb2d92b3a51f2d2f0efc409540291fd0497a569aaa2baefeadde3");
  const original = missionComparisonV2Input(2).baseline;
  for (const field of ["procedureSnapshotSha256", "encoderSha256", "model"]) {
    const t = structuredClone(original); delete t[field];
    assert.throws(() => createMissionTreatment(t), /fields/);
  }
  assert.throws(() => validateMissionTreatment({ ...original, procedureSnapshotSha256: "f".repeat(64) }), /digest mismatch/);
});

test("a sealed protocol cannot be registered after execution or change its primary rule", () => {
  const input = missionComparisonV2Input(2);
  input.protocol.registeredAt = input.pairs[0].baseline.mission.started_at; refreshProtocol(input);
  assert.throws(() => compareVerifiedMissions(input), /before either Mission/);
  for (const change of [p => { p.primaryMetric = "best-looking-score"; }, p => { p.confidenceLevel = 0.9; }, p => { p.limits.minimumPairs = 12; }, p => { p.limits.maximumCostRatio = 1.2; }, p => { p.limits.maximumLatencyRatio = 1.3; }]) {
    const p = missionComparisonV2Input(2).protocol; change(p);
    assert.throws(() => createMissionComparisonProtocol(p), /Unsupported|Invalid|relax/);
  }
});

test("the entire registered batch is required and repeated executions do not add evidence", () => {
  const input = missionComparisonV2Input(201);
  input.pairs.pop();
  const report = compareVerifiedMissions(input);
  assert.equal(report.checks.enoughIndependentMissions, true);
  assert.equal(report.checks.completePreregisteredBatch, false);
  assert.equal(report.passed, false);
  const reused = missionComparisonV2Input(2);
  reused.pairs[0].candidate.mission.mission_id = reused.pairs[0].baseline.mission.mission_id;
  resignMeasurement(reused.pairs[0].candidate);
  assert.throws(() => compareVerifiedMissions(reused), /cannot be reused/);
  const duplicate = missionComparisonV2Input(2); duplicate.pairs[1] = duplicate.pairs[0];
  assert.throws(() => compareVerifiedMissions(duplicate), /Repeated tasks/);
  const relabel = missionComparisonV2Input(2); relabel.pairs[0].family = "easier-family";
  assert.throws(() => compareVerifiedMissions(relabel), /preregistered task/);
});

test("v2 resource and effect guards are still enforced even with a strong primary result", () => {
  for (const [field, value, check] of [["costMicrousd", 100000, "withinCostLimit"], ["unauthorizedEffects", 1, "noUnauthorizedOrDuplicateEffects"], ["duplicateEffects", 1, "noUnauthorizedOrDuplicateEffects"], ["budgetExceeded", true, "noBudgetViolations"]]) {
    const input = missionComparisonV2Input();
    input.pairs[0].candidate.measurement[field] = value; resignMeasurement(input.pairs[0].candidate);
    const report = compareVerifiedMissions(input);
    assert.equal(report.checks.primaryImprovesWithConfidence, true);
    assert.equal(report.checks[check], false);
    assert.equal(report.passed, false);
  }
});

test("rewriting and rehashing derived v2 results still fails replay", () => {
  const report = compareVerifiedMissions(missionComparisonV2Input());
  report.metrics.primary.confidenceInterval.lower = 0.9;
  const { digest, ...body } = report; report.digest = digestResearchValue(body);
  assert.throws(() => validateVerifiedMissionComparison(report), /does not match its execution evidence/);
  assert.throws(() => compareVerifiedMissions({ version: 3 }), /Unsupported/);
});

test("the CLI preserves explicit v2 and immutable output on retries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amos-comparison-v2-"));
  try {
    const input = join(directory, "executions.json"), output = join(directory, "comparison.json");
    await writeFile(input, JSON.stringify(missionComparisonV2Input(12)));
    const run = () => execFileSync(process.execPath, [new URL("../scripts/compareVerifiedMissions.js", import.meta.url).pathname, input, output], { encoding: "utf8", stdio: "pipe" });
    const result = JSON.parse(run());
    assert.equal(result.version, 2);
    assert.equal(result.passed, false);
    const bytes = await readFile(output, "utf8");
    assert.equal(JSON.parse(bytes).version, 2);
    run(); assert.equal(await readFile(output, "utf8"), bytes);
    await writeFile(input, JSON.stringify(missionComparisonV2Input(12, { wins: 1 })));
    assert.throws(run, /EEXIST/);
    assert.equal(await readFile(output, "utf8"), bytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
