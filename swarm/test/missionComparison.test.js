import test from "node:test";
import assert from "node:assert/strict";
import { digestResearchValue } from "../src/experimentProtocol.js";
import { compareVerifiedMissions, validateVerifiedMissionComparison } from "../src/missionComparison.js";
import { missionComparisonInput, resignMeasurement } from "./fixtures/missionComparisonFixtures.js";

test("paired independently checked missions produce a replayable comparison", () => {
  const report = compareVerifiedMissions(missionComparisonInput());
  assert.equal(report.passed, true);
  assert.equal(report.metrics.baseline.verifiedPasses, 199);
  assert.equal(report.metrics.candidate.verifiedPasses, 200);
  assert.equal(report.metrics.pairedWins, 1);
  assert.equal(validateVerifiedMissionComparison(report).digest, report.digest);
  assert.equal(report.interpretation.automaticPromotion, false);
});

test("rehashed invented aggregate results fail evidence replay", () => {
  const report = compareVerifiedMissions(missionComparisonInput());
  report.metrics.pairedWins = 100;
  const { digest, ...body } = report; report.digest = digestResearchValue(body);
  assert.throws(() => validateVerifiedMissionComparison(report), /does not match its execution evidence/);
});

test("turn counts and matching shadow answers are not mission comparison evidence", () => {
  assert.throws(() => validateVerifiedMissionComparison({ turns: 200, agreement: 1 }), /Expected a verified mission comparison/);
});

test("missing and self-judged verification cannot pass the gate", () => {
  for (const mutate of [r => { r.mission.verification = []; }, r => { r.mission.verification[0].authority = "worker_self_check"; }, r => { r.mission.verification[0].coverage = 0.5; }, r => { r.mission.verification[0].unknown_requirements = ["unknown"]; }]) {
    const input = missionComparisonInput(); mutate(input.pairs[0].candidate); resignMeasurement(input.pairs[0].candidate);
    const report = compareVerifiedMissions(input);
    assert.equal(report.passed, false); assert.equal(report.checks.completeCheckerCoverage, false);
  }
});

test("changed tools, memory, authority and budgets invalidate paired conditions", () => {
  for (const mutate of [r => { r.mission.contract.allowed_operations.push("inventory.write"); }, r => { r.mission.contract.budgets.max_tool_calls++; }, r => { r.measurement.context.memorySnapshotSha256 = "f".repeat(64); }, r => { r.mission.contract.decision_policy.authority = "swarm"; }]) {
    const input = missionComparisonInput(2); mutate(input.pairs[0].candidate); resignMeasurement(input.pairs[0].candidate);
    assert.throws(() => compareVerifiedMissions(input), /conditions changed/);
  }
});

test("duplicate tasks and reused mission executions cannot inflate sample size", () => {
  const input = missionComparisonInput(2);
  input.pairs[1] = { ...input.pairs[0], id: "another-case" };
  assert.throws(() => compareVerifiedMissions(input), /Repeated tasks/);
  const reused = missionComparisonInput(2);
  reused.pairs[0].candidate.mission.mission_id = reused.pairs[0].baseline.mission.mission_id;
  resignMeasurement(reused.pairs[0].candidate);
  assert.throws(() => compareVerifiedMissions(reused), /cannot be reused/);
});

test("small samples remain insufficient even when every candidate mission passes", () => {
  const report = compareVerifiedMissions(missionComparisonInput(4));
  assert.equal(report.passed, false); assert.equal(report.checks.enoughIndependentMissions, false);
});

test("cost, latency, recovery and effects regressions block advancement", () => {
  for (const [field, value, check] of [["costMicrousd", 100000, "withinCostLimit"], ["recoveries", 1, "noAdditionalRecovery"], ["unauthorizedEffects", 1, "noUnauthorizedOrDuplicateEffects"], ["duplicateEffects", 1, "noUnauthorizedOrDuplicateEffects"], ["budgetExceeded", true, "noBudgetViolations"]]) {
    const input = missionComparisonInput(); input.pairs[0].candidate.measurement[field] = value; resignMeasurement(input.pairs[0].candidate);
    const report = compareVerifiedMissions(input); assert.equal(report.passed, false); assert.equal(report.checks[check], false);
  }
  const slow = missionComparisonInput();
  for (const p of slow.pairs) { p.candidate.mission.finished_at = "2026-09-05T10:02:00Z"; p.candidate.measurement.wallTimeMs = 120000; resignMeasurement(p.candidate); }
  assert.equal(compareVerifiedMissions(slow).checks.withinLatencyLimit, false);
});

test("missing accounting and mismatched artifact provenance are rejected", () => {
  for (const change of [r => { delete r.measurement.accountingComplete; }, r => { r.measurement.artifactSha256 = "e".repeat(64); }, r => { r.measurement.wallTimeMs = 1; }, r => { r.mission.verification[0].created_at = "2025-01-01T00:00:00Z"; }]) {
    const input = missionComparisonInput(2); change(input.pairs[0].candidate); resignMeasurement(input.pairs[0].candidate);
    assert.throws(() => compareVerifiedMissions(input));
  }
});

test("exported budget counters override an incorrectly reported clean budget flag", () => {
  const input = missionComparisonInput();
  const run = input.pairs[0].candidate;
  run.mission.contract.budgets.used_tool_calls = 6;
  resignMeasurement(run);
  const report = compareVerifiedMissions(input);
  assert.equal(report.checks.noBudgetViolations, false);
  assert.equal(report.passed, false);
});

test("ambiguous checker chronology cannot choose whichever verdict passes", () => {
  const input = missionComparisonInput(2);
  const run = input.pairs[0].candidate;
  run.mission.verification.push({ ...run.mission.verification[0], checker_run_id: "another-run", verdict: "fail" });
  resignMeasurement(run);
  assert.throws(() => compareVerifiedMissions(input), /Ambiguous latest checker result/);
});
