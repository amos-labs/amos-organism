import { digestResearchValue } from "./experimentProtocol.js";
import { replayOrganismPolicyArtifacts } from "./swarmOrganismArtifactReplay.js";
import {
  nextOrganismLearningAction,
  recordOrganismLearningGate,
  validateOrganismLearningCandidate
} from "./swarmOrganismLearningCycle.js";
import { runOrganismQwenPhaseProbe } from "./swarmOrganismQwenPhaseProbe.js";
import { SLEEP_WORK_KINDS, createSleepWorkItem } from "./sleepCycle.js";

export const PHASE_PROBE_PASS_RATE_FLOOR = 0.75;

/**
 * Turn learning candidates into sleep work. Candidates whose next gate cannot
 * run unattended (full missions, frozen holdouts, canaries) are deferred, not
 * silently dropped.
 */
export function sleepWorkFromCandidates(candidates, { kinds = SLEEP_WORK_KINDS } = {}) {
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
  now = () => new Date()
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
    return {
      status,
      receiptDigest: report.digest,
      evaluations: { hostContract: 0, verified: report.runs.length, modelCalls },
      candidate: updated,
      receipt: report
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
