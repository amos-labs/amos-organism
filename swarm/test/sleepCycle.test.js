import test from "node:test";
import assert from "node:assert/strict";
import { digestResearchValue } from "../src/experimentProtocol.js";
import {
  createOrganismLearningCandidate,
  recordOrganismLearningGate
} from "../src/swarmOrganismLearningCycle.js";
import { DEFAULT_ORGANISM_POLICY } from "../src/swarmOrganismSimulator.js";
import {
  SLEEP_CYCLE_RECORD_SCHEMA,
  createSleepWorkItem,
  decideSleepState,
  normalizeSleepPolicy,
  parseVllmMetrics,
  runSleepCycle,
  summarizeSleepLedger,
  validateSleepCycleRecord
} from "../src/sleepCycle.js";
import {
  SleepCandidateRegistry,
  candidatesFromSourceQueue,
  createArtifactReplayExecutor,
  createQwenPhaseProbeExecutor,
  createSleepQueue,
  sleepWorkFromCandidates
} from "../src/sleepCycleExecutors.js";

const POLICY = { quietMilliseconds: 60_000, pollMilliseconds: 10_000, maxCycleMilliseconds: 600_000 };
const T0 = Date.parse("2026-09-03T02:00:00.000Z");
const at = (offsetMs) => new Date(T0 + offsetMs);
const sample = (offsetMs, running, waiting = 0) => ({
  observedAt: at(offsetMs),
  runningRequests: running,
  waitingRequests: waiting
});
const idle = async () => sample(0, 0);

function simulationPassedCandidate(id, policy = DEFAULT_ORGANISM_POLICY) {
  const created = createOrganismLearningCandidate({
    id,
    policy,
    optimizedParameters: ["bid.repetitionPenalty", "retry.challengerExploration"],
    policySearchDigest: digestResearchValue(`search-${id}`),
    transitionModelDigest: digestResearchValue(`model-${id}`),
    rank: 1
  });
  return recordOrganismLearningGate(created, {
    id: "simulation",
    status: "passed",
    evaluator: "organism-simulator",
    receiptDigest: digestResearchValue(`simulation-${id}`),
    metrics: { simulatedPassRate: 1 },
    feedbackSignals: []
  });
}

const CHALLENGER_POLICY = {
  ...DEFAULT_ORGANISM_POLICY,
  "bid.repetitionPenalty": 4,
  "retry.challengerExploration": 1
};
const LOOPING_POLICY = {
  ...DEFAULT_ORGANISM_POLICY,
  "bid.repetitionPenalty": 0,
  "energy.partialProgressReward": 1,
  "retry.challengerExploration": 0
};

const episodes = ["episode-a", "episode-b", "episode-c"].map((id) => ({
  id,
  digest: digestResearchValue(id),
  task: { name: "accounts-payable-process" }
}));

test("vLLM request gauges are summed across label sets and fail closed when missing", () => {
  const text = [
    "# HELP vllm:num_requests_running Number of requests currently running on GPU.",
    "# TYPE vllm:num_requests_running gauge",
    'vllm:num_requests_running{model_name="amos-qwen38-27b-fp8"} 2.0',
    'vllm:num_requests_running{model_name="adapter-a"} 1.0',
    'vllm:num_requests_waiting{model_name="amos-qwen38-27b-fp8"} 3.0',
    "vllm:gpu_cache_usage_perc 0.12"
  ].join("\n");
  assert.deepEqual(parseVllmMetrics(text), { runningRequests: 3, waitingRequests: 3 });
  assert.throws(() => parseVllmMetrics("vllm:gpu_cache_usage_perc 0.1"), /num_requests_running/);
});

test("sleep policy rejects unknown fields and out-of-bounds values", () => {
  assert.throws(() => normalizeSleepPolicy({ nap: true }), /unknown field/);
  assert.throws(() => normalizeSleepPolicy({ quietMilliseconds: 10 }), /quietMilliseconds/);
  assert.throws(
    () => normalizeSleepPolicy({ quietMilliseconds: 5_000, pollMilliseconds: 6_000 }),
    /must not exceed/
  );
  assert.equal(normalizeSleepPolicy().quietMilliseconds, 300_000);
  const normalized = normalizeSleepPolicy(POLICY);
  assert.deepEqual(normalizeSleepPolicy(normalized), normalized);
  assert.throws(() => normalizeSleepPolicy({ ...normalized, schema: "amos.other" }), /Unsupported sleep policy schema/);
});

test("sleep state fails closed without fresh observations and stays drowsy until the quiet window is covered", () => {
  assert.equal(decideSleepState({ samples: [], policy: POLICY, now: at(0) }).state, "awake");
  const stale = decideSleepState({ samples: [sample(-30_000, 0)], policy: POLICY, now: at(0) });
  assert.equal(stale.state, "awake");
  assert.equal(stale.reason, "stale-load-observation");

  const busy = decideSleepState({ samples: [sample(-5_000, 1)], policy: POLICY, now: at(0) });
  assert.equal(busy.state, "awake");
  assert.equal(busy.reason, "live-requests");

  const recent = decideSleepState({
    samples: [sample(-70_000, 0), sample(-40_000, 2), sample(-30_000, 0), sample(-5_000, 0)],
    policy: POLICY,
    now: at(0)
  });
  assert.equal(recent.state, "drowsy");
  assert.equal(recent.reason, "recent-requests-inside-quiet-window");

  const partial = decideSleepState({
    samples: [sample(-30_000, 0), sample(-5_000, 0)],
    policy: POLICY,
    now: at(0)
  });
  assert.equal(partial.state, "drowsy");
  assert.equal(partial.reason, "quiet-window-not-yet-covered");

  const asleep = decideSleepState({
    samples: [sample(-90_000, 4), sample(-65_000, 0), sample(-35_000, 0), sample(-5_000, 0)],
    policy: POLICY,
    now: at(0)
  });
  assert.equal(asleep.state, "asleep");
  assert.ok(asleep.quietMilliseconds >= 60_000);
});

test("candidates become sleep work only at unattended gates", () => {
  const replayReady = simulationPassedCandidate("candidate-replay-ready");
  const fresh = createOrganismLearningCandidate({
    id: "candidate-fresh",
    policy: DEFAULT_ORGANISM_POLICY,
    optimizedParameters: ["bid.repetitionPenalty"],
    policySearchDigest: digestResearchValue("s"),
    transitionModelDigest: digestResearchValue("m"),
    rank: 2
  });
  const { items, deferred } = sleepWorkFromCandidates([replayReady, fresh]);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "organism-artifact-replay");
  assert.equal(items[0].candidateId, "candidate-replay-ready");
  assert.deepEqual(deferred, [
    { candidateId: "candidate-fresh", reason: "organism-simulation is not sleep-runnable", gate: "simulation" }
  ]);
});

test("a sleep cycle drains artifact replays, advances candidates, and claims no authority", async () => {
  const registry = new SleepCandidateRegistry([
    simulationPassedCandidate("candidate-good", CHALLENGER_POLICY),
    simulationPassedCandidate("candidate-loop", LOOPING_POLICY)
  ]);
  const { items } = sleepWorkFromCandidates(registry.list());
  let tick = 0;
  const { record, results } = await runSleepCycle({
    id: "sleep-test-001",
    policy: POLICY,
    items,
    executors: { "organism-artifact-replay": createArtifactReplayExecutor({ registry, episodes }) },
    observeLoad: idle,
    now: () => at(tick++ * 1_000),
    monotonicNow: () => tick * 1_000
  });

  assert.equal(record.schema, SLEEP_CYCLE_RECORD_SCHEMA);
  assert.equal(record.reason, "queue-drained");
  assert.equal(record.totals.tasksRun, 2);
  assert.equal(record.totals.passed, 1);
  assert.equal(record.totals.failed, 1);
  assert.equal(record.totals.hostContractReplays, 6);
  assert.equal(record.totals.verifiedEvaluations, 0);
  assert.equal(record.totals.modelCalls, 0);
  assert.equal(record.authority, "research");
  assert.deepEqual(
    [record.vesting.fitness, record.vesting.geneAdmission, record.vesting.adapterPromotion],
    [false, false, false]
  );
  assert.deepEqual(record.remainingItems, []);
  assert.equal(validateSleepCycleRecord(record).id, "sleep-test-001");

  const good = registry.list().find(({ id }) => id === "candidate-good");
  const loop = registry.list().find(({ id }) => id === "candidate-loop");
  assert.equal(good.nextGate, "real-qwen-phase-probes");
  assert.equal(loop.status, "rejected");
  assert.ok(loop.feedback.some(({ signal }) => signal === "repeated-agent-loop"));
  assert.equal(results.length, 2);
  assert.equal(good.deployment.canaryAllowed, false);
});

test("a live request ends the cycle at the next task boundary and leaves work queued", async () => {
  const registry = new SleepCandidateRegistry([
    simulationPassedCandidate("candidate-one", CHALLENGER_POLICY),
    simulationPassedCandidate("candidate-two", CHALLENGER_POLICY)
  ]);
  const { items } = sleepWorkFromCandidates(registry.list());
  const loads = [sample(0, 0), sample(1_000, 1)];
  const { record } = await runSleepCycle({
    id: "sleep-test-woken",
    policy: POLICY,
    items,
    executors: { "organism-artifact-replay": createArtifactReplayExecutor({ registry, episodes }) },
    observeLoad: async () => loads.shift()
  });
  assert.equal(record.reason, "woken");
  assert.equal(record.totals.tasksRun, 1);
  assert.deepEqual(record.remainingItems, ["organism-artifact-replay:candidate-two"]);
  assert.equal(record.wakeSample.totalRequests, 1);
  assert.equal(registry.list().find(({ id }) => id === "candidate-two").nextGate, "immutable-artifact-replay");
});

test("an executor failure is recorded as errored and does not stop the cycle", async () => {
  const registry = new SleepCandidateRegistry([
    simulationPassedCandidate("candidate-a", CHALLENGER_POLICY),
    simulationPassedCandidate("candidate-b", CHALLENGER_POLICY)
  ]);
  const { items } = sleepWorkFromCandidates(registry.list());
  const real = createArtifactReplayExecutor({ registry, episodes });
  const { record } = await runSleepCycle({
    id: "sleep-test-errored",
    policy: POLICY,
    items,
    executors: {
      "organism-artifact-replay": async (item, context) => {
        if (item.candidateId === "candidate-a") throw new Error("replay store unavailable");
        return real(item, context);
      }
    },
    observeLoad: idle
  });
  assert.equal(record.reason, "queue-drained");
  assert.equal(record.totals.errored, 1);
  assert.equal(record.totals.passed, 1);
  assert.equal(record.tasks[0].error, "replay store unavailable");
  assert.equal(registry.list().find(({ id }) => id === "candidate-a").nextGate, "immutable-artifact-replay");
});

test("an aborted cycle and an unobservable load both stop without claiming completion", async () => {
  const registry = new SleepCandidateRegistry([simulationPassedCandidate("candidate-x", CHALLENGER_POLICY)]);
  const { items } = sleepWorkFromCandidates(registry.list());
  const controller = new AbortController();
  controller.abort();
  const aborted = await runSleepCycle({
    id: "sleep-test-aborted",
    policy: POLICY,
    items,
    executors: { "organism-artifact-replay": createArtifactReplayExecutor({ registry, episodes }) },
    observeLoad: idle,
    signal: controller.signal
  });
  assert.equal(aborted.record.reason, "aborted");
  assert.equal(aborted.record.totals.tasksRun, 0);

  const unobservable = await runSleepCycle({
    id: "sleep-test-blind",
    policy: POLICY,
    items,
    executors: { "organism-artifact-replay": createArtifactReplayExecutor({ registry, episodes }) },
    observeLoad: async () => { throw new Error("metrics endpoint refused"); }
  });
  assert.equal(unobservable.record.reason, "load-unobservable");
  assert.equal(unobservable.record.wakeSample.error, "metrics endpoint refused");
});

test("phase probes count every verifier-graded run as a verified evaluation and record the gate", async () => {
  const candidate = recordOrganismLearningGate(simulationPassedCandidate("candidate-probe", CHALLENGER_POLICY), {
    id: "immutable-artifact-replay",
    status: "passed",
    evaluator: "artifact-replay-verifier",
    receiptDigest: digestResearchValue("replay"),
    metrics: {},
    feedbackSignals: []
  });
  const registry = new SleepCandidateRegistry([candidate]);
  const { items } = sleepWorkFromCandidates(registry.list());
  assert.equal(items[0].kind, "organism-qwen-phase-probes");

  const worker = {
    async runCase() {
      return {
        message: { content: "Use 18% as current. The approved CFO memo controls; 12% is a superseded draft." },
        metrics: { outputTokens: 20 }
      };
    }
  };
  const mission = {
    id: "authority-case",
    objective: "Resolve the current target.",
    context: "The CFO memo says 18%; an older draft says 12%.",
    successCriteria: ["Use 18%.", "Cite the CFO memo.", "Mark 12% superseded."]
  };
  const verifier = {
    id: "authority-case-verifier",
    missionId: mission.id,
    family: "authority",
    criteria: [
      { id: "target", requiredConcepts: [["18%"]] },
      { id: "source", requiredConcepts: [["CFO"], ["memo"]] },
      { id: "superseded", requiredConcepts: [["12%"], ["superseded"]] }
    ],
    prohibitedConcepts: ["12% is current"]
  };
  const { record } = await runSleepCycle({
    id: "sleep-test-probe",
    policy: POLICY,
    items,
    executors: {
      "organism-qwen-phase-probes": createQwenPhaseProbeExecutor({
        registry,
        worker,
        missions: [mission],
        verifiers: [verifier],
        now: () => at(0)
      })
    },
    observeLoad: idle
  });
  assert.equal(record.totals.verifiedEvaluations, 2);
  assert.equal(record.totals.modelCalls, 2);
  assert.equal(record.totals.passed, 1);
  const advanced = registry.list()[0];
  assert.equal(advanced.nextGate, "full-real-qwen-mission");
  assert.equal(advanced.gates.at(-1).evaluator, "qwen-execution-verifier");
  assert.equal(advanced.gates.at(-1).metrics.verifier, "candidate-independent-amos-owned-concept-verifier");
  assert.equal(advanced.deployment.canaryAllowed, false);
});

test("stale work items cannot advance a candidate that already moved", () => {
  const registry = new SleepCandidateRegistry([simulationPassedCandidate("candidate-stale", CHALLENGER_POLICY)]);
  const [item] = sleepWorkFromCandidates(registry.list()).items;
  registry.put(recordOrganismLearningGate(registry.list()[0], {
    id: "immutable-artifact-replay",
    status: "passed",
    evaluator: "artifact-replay-verifier",
    receiptDigest: digestResearchValue("replay"),
    metrics: {},
    feedbackSignals: []
  }));
  assert.throws(() => registry.take(item), /stale candidate digest/);
  assert.throws(
    () => createSleepWorkItem({ kind: "organism-canary", candidateId: "x", candidateDigest: digestResearchValue("a"), policyDigest: digestResearchValue("b"), gate: "canary" }),
    /Unsupported sleep work kind/
  );
});

test("the ledger summary reports verified evaluations per day and rejects tampered records", async () => {
  const registry = new SleepCandidateRegistry([simulationPassedCandidate("candidate-ledger", CHALLENGER_POLICY)]);
  const { items } = sleepWorkFromCandidates(registry.list());
  const { record } = await runSleepCycle({
    id: "sleep-test-ledger",
    policy: POLICY,
    items,
    executors: { "organism-artifact-replay": createArtifactReplayExecutor({ registry, episodes }) },
    observeLoad: idle,
    now: () => at(0)
  });
  const verifiedRecord = {
    ...record,
    totals: { ...record.totals, verifiedEvaluations: 12 }
  };
  const { digest: _ignored, ...withoutDigest } = verifiedRecord;
  const rebuilt = { ...withoutDigest, digest: digestResearchValue(withoutDigest) };

  const summary = summarizeSleepLedger([record, rebuilt], {
    now: at(6 * 60 * 60_000),
    windowMilliseconds: 12 * 60 * 60_000
  });
  assert.equal(summary.cycles, 2);
  assert.equal(summary.verifiedEvaluations, 12);
  assert.equal(summary.verifiedEvaluationsPerDay, 24);
  assert.equal(summary.hostContractReplays, 6);
  assert.equal(summary.reasons["queue-drained"], 2);

  assert.throws(() => summarizeSleepLedger([verifiedRecord]), /digest does not match/);
  assert.throws(
    () => validateSleepCycleRecord({ ...withoutDigest, authority: "host", digest: digestResearchValue({ ...withoutDigest, authority: "host" }) }),
    /claims authority/
  );
});

test("sleep queues round-trip through the accepted source schemas", () => {
  const registry = new SleepCandidateRegistry([simulationPassedCandidate("candidate-queue", CHALLENGER_POLICY)]);
  const queue = createSleepQueue({
    registry,
    sourceQueueDigest: digestResearchValue("source"),
    deferred: [],
    cycleRecordDigest: digestResearchValue("cycle"),
    generatedAt: at(0)
  });
  assert.equal(queue.automaticallyPromoted, false);
  assert.equal(candidatesFromSourceQueue(queue).length, 1);
  assert.equal(queue.nextActions[0].kind, "organism-artifact-replay");
  assert.throws(() => candidatesFromSourceQueue({ ...queue, automaticallyPromoted: true }), /pre-promoted/);
  assert.throws(() => candidatesFromSourceQueue({ schema: "amos.other", version: 1 }), /Unsupported/);
});
