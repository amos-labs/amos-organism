import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { digestResearchValue } from "../src/experimentProtocol.js";
import { generateCurriculumScenarios } from "../src/amosCurriculumGenerator.js";
import {
  compareCurriculumGrading,
  gradingMessages,
  runCurriculumGrading,
  scenariosForGrading
} from "../src/curriculumGrading.js";
import {
  harvestCurriculumGrading,
  harvestPhaseProbePairs,
  recordHarvestedPairs
} from "../src/preferencePairHarvest.js";
import { compileAmosNativeTrainingDataset } from "../src/amosNativeTrainingDataset.js";
import { openSwarmLearningStore } from "../src/swarmLearningStore.js";
import { createStandingSleepWorkItem, runSleepCycle, validateSleepWorkItem } from "../src/sleepCycle.js";
import {
  createCurriculumGradingExecutor,
  lastStandingOrderRuns,
  sleepWorkFromStandingOrders
} from "../src/sleepCycleExecutors.js";

const swarmRoot = fileURLToPath(new URL("..", import.meta.url));
const catalog = JSON.parse(await readFile(join(swarmRoot, "benchmarks/amos-tool-catalog-v1.json"), "utf8"));
const plan = JSON.parse(await readFile(join(swarmRoot, "benchmarks/swarm-qwen-adapter-training-v1.json"), "utf8"));

/**
 * A fake substrate with a deterministic skill profile: `behavior(scenario)`
 * returns "pass", "recover" (fail first, pass on repair), or "fail".
 */
function fakeWorker({ model, scenariosById, behavior }) {
  return {
    model,
    controlId: `fake-${model}`,
    async runCase({ caseId, messages }) {
      const scenarioId = caseId.replace(/^curriculum-/, "").replace(/-attempt-\d+:.*$/, "").replace(/-attempt-\d+$/, "");
      const scenario = scenariosById.get(scenarioId);
      if (!scenario) throw new Error(`fake worker has no scenario for ${caseId}`);
      const repairing = messages.some((message) => typeof message.content === "string" && message.content.includes("verifier rejected"));
      const mode = behavior(scenario);
      const answer = mode === "pass" || (mode === "recover" && repairing)
        ? JSON.stringify(scenario.target)
        : `I think the answer is ${JSON.stringify(scenario.rejected)}`;
      return { message: { role: "assistant", content: answer }, metrics: { outputTokens: 40 } };
    }
  };
}

const trainingScenarios = generateCurriculumScenarios({ catalog, scenariosPerFamily: 2, seed: "grade", pool: "training" });
const byId = new Map(trainingScenarios.map((scenario) => [scenario.id, scenario]));

test("grading feeds back only verifier failures and separates first-attempt, recovered, and failed runs", async () => {
  const worker = fakeWorker({
    model: "fake-base",
    scenariosById: byId,
    behavior: (scenario) => ["pass", "recover", "fail"][scenario.index % 3] ?? "pass"
  });
  const report = await runCurriculumGrading({ worker, scenarios: trainingScenarios, now: () => new Date("2026-09-03T00:00:00Z") });
  assert.equal(report.scenarioCount, 16);
  assert.equal(report.interpretation.qualityClaimAllowed, false);
  const recovered = report.runs.filter(({ recovered: flag }) => flag);
  assert.ok(recovered.length > 0);
  assert.ok(recovered.every(({ calls }) => calls === 2));
  assert.ok(report.runs.filter(({ passed }) => !passed).every(({ calls }) => calls === 2));
  const messages = gradingMessages(trainingScenarios[0], { answerText: "x", failures: ["calls-is-array: calls must be an array"] });
  assert.equal(messages.length, 4);
  assert.ok(messages[3].content.includes("calls-is-array"));
  assert.ok(!messages[3].content.includes(JSON.stringify(trainingScenarios[0].target)));
});

test("parallel grading keeps scenario order and matches sequential results", async () => {
  const worker = fakeWorker({ model: "fake-parallel", scenariosById: byId, behavior: (scenario) => ["pass", "recover", "fail"][scenario.index % 3] ?? "pass" });
  const sequential = await runCurriculumGrading({ worker, scenarios: trainingScenarios, now: () => new Date("2026-09-04T00:00:00Z") });
  const parallel = await runCurriculumGrading({ worker, scenarios: trainingScenarios, concurrency: 5, now: () => new Date("2026-09-04T00:00:00Z") });
  assert.deepEqual(parallel.runs.map(({ scenarioId }) => scenarioId), sequential.runs.map(({ scenarioId }) => scenarioId));
  assert.equal(parallel.passRate, sequential.passRate);
  assert.equal(parallel.firstAttemptPassRate, sequential.firstAttemptPassRate);
  assert.equal(parallel.protocolConcurrency, 5);
  await assert.rejects(runCurriculumGrading({ worker, scenarios: trainingScenarios, concurrency: 0 }), /concurrency/);
});

test("comparison pairs candidates against the control on identical scenarios", async () => {
  const base = fakeWorker({ model: "base", scenariosById: byId, behavior: (scenario) => (scenario.index === 1 ? "pass" : "fail") });
  const adapter = fakeWorker({ model: "adapter", scenariosById: byId, behavior: () => "pass" });
  const baseReport = await runCurriculumGrading({ worker: base, scenarios: trainingScenarios });
  const adapterReport = await runCurriculumGrading({ worker: adapter, scenarios: trainingScenarios });
  const comparison = compareCurriculumGrading([baseReport, adapterReport]);
  assert.equal(comparison.control.modelId, "base");
  assert.equal(comparison.candidates[0].pairedLosses, 0);
  assert.equal(comparison.candidates[0].pairedWins, 8);
  assert.equal(comparison.candidates[0].passRateLift, 0.5);
  const partial = await runCurriculumGrading({ worker: adapter, scenarios: trainingScenarios.slice(0, 4) });
  assert.throws(() => compareCurriculumGrading([baseReport, partial]), /not graded on the control/);
});

test("harvest keeps recovered pairs and verified answers from the training pool only", async () => {
  const worker = fakeWorker({ model: "fake", scenariosById: byId, behavior: (scenario) => (scenario.index === 1 ? "recover" : "pass") });
  const report = await runCurriculumGrading({ worker, scenarios: trainingScenarios });
  const { pairs, verifiedAnswers } = harvestCurriculumGrading({ report, scenariosById: byId });
  assert.equal(pairs.length, 8);
  assert.equal(verifiedAnswers.length, 8);
  assert.ok(pairs.every(({ rejected }) => rejected.failures.length > 0 && rejected.text !== undefined));

  const holdout = scenariosForGrading({ catalog, pool: "holdout", scenariosPerFamily: 1, seed: "grade" });
  const holdoutById = new Map(holdout.map((scenario) => [scenario.id, scenario]));
  const holdoutReport = await runCurriculumGrading({ worker: fakeWorker({ model: "fake", scenariosById: holdoutById, behavior: () => "pass" }), scenarios: holdout });
  const none = harvestCurriculumGrading({ report: holdoutReport, scenariosById: holdoutById });
  assert.equal(none.pairs.length + none.verifiedAnswers.length, 0);
});

test("harvested items become training-eligible episodes with preference pairs and never duplicate", async () => {
  const root = await mkdtemp(join(tmpdir(), "amos-harvest-"));
  const store = await openSwarmLearningStore(root);
  const worker = fakeWorker({ model: "fake", scenariosById: byId, behavior: (scenario) => (scenario.index === 1 ? "recover" : "pass") });
  const report = await runCurriculumGrading({ worker, scenarios: trainingScenarios });
  const { pairs, verifiedAnswers } = harvestCurriculumGrading({ report, scenariosById: byId });
  const manifest = await recordHarvestedPairs({ store, items: [...pairs, ...verifiedAnswers] });
  assert.equal(manifest.recorded, 16);
  const again = await recordHarvestedPairs({ store, items: [...pairs, ...verifiedAnswers] });
  assert.equal(again.recorded, 0);
  assert.equal(again.skippedDuplicates, 16);
  const episodes = await store.listEpisodes();
  assert.ok(episodes.every(({ trainingEligibility }) => trainingEligibility.eligible));
  const dataset = await compileAmosNativeTrainingDataset({ store, plan, minimums: { trainingExamples: 1, validationExamples: 1, holdoutExamples: 1, taskFamilies: 3 } });
  assert.equal(dataset.manifest.counts.examples, 16);
  assert.equal(dataset.manifest.counts.preferencePairs, 8);
});

test("phase-probe reports yield pairs only where a failed attempt was repaired", () => {
  const mission = { id: "authority-case", objective: "Resolve the target.", context: "CFO memo says 18%.", successCriteria: ["Use 18%."] };
  const receipt = (passed) => ({ digest: digestResearchValue({ passed, at: Math.random() }), passed, failedCriterionIds: passed ? [] : ["target"] });
  const report = {
    digest: digestResearchValue("probe"),
    candidateId: "cand",
    runs: [
      { regimeId: "baseline", missionId: mission.id, attempts: [{ answer: "12%", verifierReceipt: receipt(false) }, { answer: "18% per CFO memo", verifierReceipt: receipt(true) }] },
      { regimeId: "cand", missionId: mission.id, attempts: [{ answer: "18% per CFO memo", verifierReceipt: receipt(true) }] },
      { regimeId: "cand", missionId: mission.id, attempts: [{ answer: "12%", verifierReceipt: receipt(false) }, { answer: "still 12%", verifierReceipt: receipt(false) }] }
    ]
  };
  const { pairs } = harvestPhaseProbePairs({ report, missionsById: new Map([[mission.id, mission]]) });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].chosen.text, "18% per CFO memo");
  assert.ok(pairs[0].prompt.user.includes("Use 18%."));
});

test("standing orders become sleep work when due and are tracked through the ledger", async () => {
  const orders = {
    schema: "amos.swarm-sleep-standing-orders",
    version: 1,
    orders: [
      { id: "nightly-holdout", kind: "curriculum-grading", minimumIntervalHours: 24, payload: { modelIds: ["base", "adapter"], pool: "holdout", scenariosPerFamily: 1 } },
      { id: "consolidate", kind: "adapter-consolidation", minimumIntervalHours: 24, payload: {} }
    ]
  };
  const first = sleepWorkFromStandingOrders(orders, { now: new Date("2026-09-03T02:00:00Z"), kinds: ["curriculum-grading"] });
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].kind, "curriculum-grading");
  assert.deepEqual(first.deferred, [{ orderId: "consolidate", reason: "adapter-consolidation is not enabled" }]);
  assert.equal(validateSleepWorkItem(first.items[0]).orderId, "nightly-holdout");

  const workers = new Map([
    ["base", fakeWorker({ model: "base", scenariosById: new Map(), behavior: () => "fail" })],
    ["adapter", fakeWorker({ model: "adapter", scenariosById: new Map(), behavior: () => "pass" })]
  ]);
  // The executor generates its own scenarios from the order id and occurrence; mirror that seed for the fakes.
  const scenarios = scenariosForGrading({ catalog, pool: "holdout", scenariosPerFamily: 1, seed: "nightly-holdout:1" });
  const lookup = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  workers.set("base", fakeWorker({ model: "base", scenariosById: lookup, behavior: () => "fail" }));
  workers.set("adapter", fakeWorker({ model: "adapter", scenariosById: lookup, behavior: () => "pass" }));

  const executor = createCurriculumGradingExecutor({ workers, catalog, now: () => new Date("2026-09-03T02:00:00Z") });
  const { record, results } = await runSleepCycle({
    id: "sleep-standing",
    policy: { quietMilliseconds: 60_000, pollMilliseconds: 10_000 },
    items: first.items,
    executors: { "curriculum-grading": executor },
    observeLoad: async () => ({ observedAt: new Date(), runningRequests: 0 }),
    now: () => new Date("2026-09-03T02:00:00Z")
  });
  assert.equal(record.reason, "queue-drained");
  assert.equal(record.totals.verifiedEvaluations, 8 * 2 + 8 * 1);
  assert.equal(results[0].receipt.comparison.candidates[0].pairedWins, 8);

  const last = lastStandingOrderRuns([record]);
  assert.ok(last.has("nightly-holdout"));
  const second = sleepWorkFromStandingOrders(orders, { now: new Date("2026-09-03T03:00:00Z"), lastRunAt: last, kinds: ["curriculum-grading"] });
  assert.equal(second.items.length, 0);
  assert.ok(second.deferred.some(({ reason }) => reason.startsWith("not due")));
  const third = sleepWorkFromStandingOrders(orders, { now: new Date("2026-09-04T03:00:00Z"), lastRunAt: last, kinds: ["curriculum-grading"] });
  assert.equal(third.items.length, 1);
  assert.throws(() => createStandingSleepWorkItem({ kind: "organism-artifact-replay", orderId: "x", payload: {} }), /Unsupported standing/);
});
