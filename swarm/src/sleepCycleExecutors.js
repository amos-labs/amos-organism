import { digestResearchValue } from "./experimentProtocol.js";
import { replayOrganismPolicyArtifacts } from "./swarmOrganismArtifactReplay.js";
import {
  nextOrganismLearningAction,
  recordOrganismLearningGate,
  validateOrganismLearningCandidate
} from "./swarmOrganismLearningCycle.js";
import { runOrganismQwenPhaseProbe } from "./swarmOrganismQwenPhaseProbe.js";
import {
  CANDIDATE_WORK_KINDS,
  STANDING_WORK_KINDS,
  createSleepWorkItem,
  createStandingSleepWorkItem
} from "./sleepCycle.js";
import { validateToolCatalog } from "./amosCurriculumGenerator.js";
import { compareCurriculumGrading, runCurriculumGrading, scenariosForGrading } from "./curriculumGrading.js";
import { harvestCurriculumGrading, harvestPhaseProbePairs, recordHarvestedPairs } from "./preferencePairHarvest.js";

export const PHASE_PROBE_PASS_RATE_FLOOR = 0.75;

/**
 * Turn learning candidates into sleep work. Candidates whose next gate cannot
 * run unattended (full missions, frozen holdouts, canaries) are deferred, not
 * silently dropped.
 */
export function sleepWorkFromCandidates(candidates, { kinds = CANDIDATE_WORK_KINDS } = {}) {
  const items = [];
  const deferred = [];
  for (const input of Array.isArray(candidates) ? candidates : []) {
    const candidate = validateOrganismLearningCandidate(input);
    const action = nextOrganismLearningAction(candidate);
    if (!action) {
      deferred.push({ candidateId: candidate.id, reason: `candidate is ${candidate.status}` });
      continue;
    }
    if (!kinds.includes(action.kind)) {
      deferred.push({
        candidateId: candidate.id,
        reason: `${action.kind} is not sleep-runnable`,
        gate: action.gate
      });
      continue;
    }
    items.push(createSleepWorkItem(action));
  }
  return { items, deferred };
}

/**
 * Candidate registry shared by executors so a cycle can advance one candidate
 * through consecutive gates without re-reading the queue file.
 */
export class SleepCandidateRegistry {
  #candidates = new Map();

  constructor(candidates = []) {
    for (const candidate of candidates) this.put(candidate);
  }

  put(input) {
    const candidate = validateOrganismLearningCandidate(input);
    this.#candidates.set(candidate.id, candidate);
    return candidate;
  }

  take(item) {
    const candidate = this.#candidates.get(item.candidateId);
    if (!candidate) throw new Error(`Unknown candidate ${item.candidateId}`);
    if (candidate.digest !== item.candidateDigest) {
      throw new Error(`Sleep work item ${item.id} references a stale candidate digest`);
    }
    if (candidate.nextGate !== item.gate) {
      throw new Error(`Candidate ${candidate.id} awaits ${candidate.nextGate}, not ${item.gate}`);
    }
    return candidate;
  }

  list() {
    return [...this.#candidates.values()].sort((left, right) => left.id.localeCompare(right.id));
  }
}

/**
 * Artifact replay: host-contract evidence only. Counts as hostContract
 * evaluations, never as verified evaluations, because no verifier grades
 * quality here.
 */
export function createArtifactReplayExecutor({ registry, episodes }) {
  if (!(registry instanceof SleepCandidateRegistry)) {
    throw new Error("Artifact replay executor requires a SleepCandidateRegistry");
  }
  if (!Array.isArray(episodes) || episodes.length === 0) {
    throw new Error("Artifact replay executor requires immutable learning episodes");
  }
  return async function executeArtifactReplay(item) {
    const candidate = registry.take(item);
    const { receipt, candidate: updated } = replayOrganismPolicyArtifacts({ candidate, episodes });
    registry.put(updated);
    return {
      status: receipt.status,
      receiptDigest: receipt.digest,
      evaluations: { hostContract: receipt.metrics.replayCount, verified: 0, modelCalls: 0 },
      candidate: updated,
      receipt
    };
  };
}

/**
 * Real-Qwen phase probes: the substrate answers AMOS-owned missions and a
 * candidate-independent verifier grades every attempt. Each graded run is one
 * verified evaluation. The gate decision is recorded on the candidate with the
 * report digest as its receipt.
 */
export function createQwenPhaseProbeExecutor({
  registry,
  worker,
  missions,
  verifiers,
  maxOutputTokens = 800,
  now = () => new Date(),
  harvestStore = null
}) {
  if (!(registry instanceof SleepCandidateRegistry)) {
    throw new Error("Phase probe executor requires a SleepCandidateRegistry");
  }
  if (!worker || typeof worker.runCase !== "function") {
    throw new Error("Phase probe executor requires a research worker");
  }
  return async function executeQwenPhaseProbes(item) {
    const candidate = registry.take(item);
    const report = await runOrganismQwenPhaseProbe({
      worker,
      missions,
      verifiers,
      candidatePolicy: candidate.policy,
      candidateId: candidate.id,
      maxOutputTokens,
      now
    });
    const feedbackSignals = phaseProbeFeedbackSignals(report);
    const status = report.gate.passed && feedbackSignals.length === 0 ? "passed" : "failed";
    const modelCalls = report.runs.reduce((total, run) => total + run.calls, 0);
    const updated = recordOrganismLearningGate(candidate, {
      id: "real-qwen-phase-probes",
      status,
      evaluator: report.gate.evaluator,
      receiptDigest: report.digest,
      metrics: {
        missionCount: report.protocol.missionCount,
        baselinePassRate: report.baseline.passRate,
        candidatePassRate: report.candidate.passRate,
        passRateLift: report.lift.passRate,
        meanPassedCriterionRateLift: report.lift.meanPassedCriterionRate,
        verifiedRuns: report.runs.length,
        modelCalls,
        verifier: report.protocol.verifier
      },
      feedbackSignals,
      evaluatedAt: now()
    });
    registry.put(updated);
    let harvest = null;
    if (harvestStore) {
      const { pairs } = harvestPhaseProbePairs({ report, missionsById: new Map(missions.map((mission) => [mission.id, mission])) });
      harvest = pairs.length > 0 ? await recordHarvestedPairs({ store: harvestStore, items: pairs, generatedAt: now() }) : { recorded: 0, pairs: 0 };
    }
    return {
      status,
      receiptDigest: report.digest,
      evaluations: { hostContract: 0, verified: report.runs.length, modelCalls },
      candidate: updated,
      receipt: { ...report, harvest }
    };
  };
}

// ---------------------------------------------------------------------------
// Standing orders

export const STANDING_ORDERS_SCHEMA = "amos.swarm-sleep-standing-orders";

/**
 * Standing orders are read from a JSON file the operator owns. Each order names
 * a kind, an id, a payload, and a minimum interval; the daemon issues one work
 * item per due order per cycle. `lastRunAt` comes from the ledger, never from
 * the order file, so an operator cannot mark work done by editing it.
 */
export function sleepWorkFromStandingOrders(ordersInput, { now = new Date(), lastRunAt = new Map(), kinds = STANDING_WORK_KINDS } = {}) {
  const orders = validateStandingOrders(ordersInput);
  const items = [];
  const deferred = [];
  const current = new Date(now).getTime();
  for (const order of orders.orders) {
    if (!kinds.includes(order.kind)) {
      deferred.push({ orderId: order.id, reason: `${order.kind} is not enabled` });
      continue;
    }
    const previous = lastRunAt.get(order.id);
    const dueAt = previous ? Date.parse(previous) + order.minimumIntervalHours * 3_600_000 : 0;
    if (current < dueAt) {
      deferred.push({ orderId: order.id, reason: `not due until ${new Date(dueAt).toISOString()}` });
      continue;
    }
    const occurrence = previous ? Math.floor(current / 60_000) : 1;
    items.push(createStandingSleepWorkItem({ kind: order.kind, orderId: order.id, payload: order.payload, occurrence }));
  }
  return { items, deferred };
}

export function validateStandingOrders(input) {
  const source = structuredClone(input);
  if (source?.schema !== STANDING_ORDERS_SCHEMA || source?.version !== 1) throw new Error("Unsupported standing orders file");
  if (!Array.isArray(source.orders)) throw new Error("Standing orders require an orders array");
  const ids = new Set();
  const orders = source.orders.map((order, index) => {
    const id = String(order?.id ?? "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id)) throw new Error(`orders[${index}].id is invalid`);
    if (ids.has(id)) throw new Error(`Duplicate standing order ${id}`);
    ids.add(id);
    if (!STANDING_WORK_KINDS.includes(order.kind)) throw new Error(`orders[${index}].kind is unsupported`);
    const hours = Number(order.minimumIntervalHours ?? 24);
    if (!Number.isFinite(hours) || hours < 0 || hours > 24 * 30) throw new Error(`orders[${index}].minimumIntervalHours is invalid`);
    if (!order.payload || typeof order.payload !== "object") throw new Error(`orders[${index}].payload must be an object`);
    return { id, kind: order.kind, minimumIntervalHours: hours, payload: order.payload };
  });
  return { ...source, orders };
}

/** Derive each standing order's last successful run from the cycle ledger. */
export function lastStandingOrderRuns(records) {
  const last = new Map();
  for (const record of records) {
    for (const task of record.tasks || []) {
      if (!task.item?.orderId || task.status === "errored") continue;
      const previous = last.get(task.item.orderId);
      if (!previous || task.startedAt > previous) last.set(task.item.orderId, task.startedAt);
    }
  }
  return last;
}

/**
 * Curriculum grading: grade every configured served model ID on the same
 * generated scenarios, compare them, and harvest verified pairs from the
 * training pool. Payload: { modelIds, pool, scenariosPerFamily, seed, families?, repairAttempts? }.
 */
export function createCurriculumGradingExecutor({
  workers,
  catalog: catalogInput,
  harvestStore = null,
  maxOutputTokens = 1_200,
  now = () => new Date(),
  onReport = null
}) {
  const catalog = validateToolCatalog(catalogInput);
  if (!(workers instanceof Map) || workers.size === 0) throw new Error("Curriculum grading needs a Map of modelId to worker");
  return async function executeCurriculumGrading(item, { signal = null } = {}) {
    const payload = item.payload;
    const modelIds = Array.isArray(payload.modelIds) && payload.modelIds.length > 0 ? payload.modelIds : [...workers.keys()];
    for (const modelId of modelIds) {
      if (!workers.has(modelId)) throw new Error(`No worker is configured for model ${modelId}`);
    }
    const pool = payload.pool ?? "holdout";
    const scenarios = scenariosForGrading({
      catalog,
      pool,
      scenariosPerFamily: payload.scenariosPerFamily ?? 4,
      seed: payload.seed ?? `${item.orderId}:${item.occurrence}`,
      families: payload.families,
      rulebook: payload.rulebook ?? "explicit"
    });
    const scenariosById = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
    const reports = [];
    const harvests = [];
    for (const modelId of modelIds) {
      if (signal?.aborted) break;
      const report = await runCurriculumGrading({
        worker: workers.get(modelId),
        scenarios,
        maxOutputTokens,
        repairAttempts: payload.repairAttempts ?? 1,
        now,
        signal
      });
      reports.push(report);
      if (typeof onReport === "function") await onReport(report, item);
      if (harvestStore && pool === "training") {
        const { pairs, verifiedAnswers } = harvestCurriculumGrading({ report, scenariosById });
        const items = [...pairs, ...verifiedAnswers];
        harvests.push(items.length > 0
          ? await recordHarvestedPairs({ store: harvestStore, items, generatedAt: now() })
          : { modelId, recorded: 0, pairs: 0, verifiedAnswers: 0 });
      }
    }
    const comparison = reports.length >= 2 ? compareCurriculumGrading(reports) : null;
    const receipt = {
      schema: "amos.curriculum-grading-cycle-receipt",
      version: 1,
      orderId: item.orderId,
      pool,
      scenarioCount: scenarios.length,
      reports: reports.map(({ modelId, digest, passRate, firstAttemptPassRate, recoveryRate }) => ({ modelId, digest, passRate, firstAttemptPassRate, recoveryRate })),
      comparison,
      harvests,
      aborted: signal?.aborted === true
    };
    const receiptDigest = digestResearchValue(receipt);
    return {
      status: reports.length === modelIds.length ? "passed" : "failed",
      receiptDigest,
      evaluations: {
        hostContract: 0,
        verified: reports.reduce((total, report) => total + report.interpretation.verifiedEvaluations, 0),
        modelCalls: reports.reduce((total, report) => total + report.interpretation.verifiedEvaluations, 0)
      },
      receipt: { ...receipt, digest: receiptDigest, fullReports: reports }
    };
  };
}

export function phaseProbeFeedbackSignals(report) {
  const signals = [];
  if (report.candidate.passRate < PHASE_PROBE_PASS_RATE_FLOOR) signals.push("phase-probe-pass-rate-below-floor");
  if (report.candidate.passRate < report.baseline.passRate) signals.push("phase-probe-regressed-versus-baseline");
  if (report.candidate.receiptGatedCredit !== true) signals.push("unreceipted-credit");
  if (report.candidate.exactPolicyConsumed !== true) signals.push("policy-digest-drift");
  return signals;
}

/**
 * Persisted queue written after every cycle so the next cycle (or a human)
 * resumes from advanced candidates rather than replaying finished gates.
 */
export const SLEEP_QUEUE_SCHEMA = "amos.swarm-sleep-queue";
export const SLEEP_QUEUE_VERSION = 1;

export const ACCEPTED_SOURCE_QUEUES = Object.freeze([
  "amos.swarm-organism-promotion-queue",
  "amos.swarm-organism-artifact-replay-queue",
  SLEEP_QUEUE_SCHEMA
]);

export function candidatesFromSourceQueue(queue) {
  if (!ACCEPTED_SOURCE_QUEUES.includes(queue?.schema) || queue?.version !== 1) {
    throw new Error("Unsupported candidate queue for the sleep cycle");
  }
  if (queue.automaticallyPromoted !== false) {
    throw new Error("A candidate queue cannot arrive pre-promoted");
  }
  if (!Array.isArray(queue.candidates)) throw new Error("Candidate queue has no candidates");
  return queue.candidates.map(validateOrganismLearningCandidate);
}

export function createSleepQueue({ registry, sourceQueueDigest, deferred, cycleRecordDigest, generatedAt = new Date() }) {
  const candidates = registry.list();
  const base = {
    schema: SLEEP_QUEUE_SCHEMA,
    version: SLEEP_QUEUE_VERSION,
    generatedAt: new Date(generatedAt).toISOString(),
    sourceQueueDigest,
    cycleRecordDigest,
    automaticallyPromoted: false,
    candidates,
    deferred,
    nextActions: candidates.map(nextOrganismLearningAction).filter(Boolean)
  };
  return { ...base, digest: digestResearchValue(base) };
}
