import { digestResearchValue } from "./experimentProtocol.js";

/**
 * Sleep cycle: the organism's idle-time metabolism.
 *
 * While the Qwen substrate has no live requests, the sleep cycle drains a queue
 * of research work items: artifact replays, verified phase probes, and later
 * synthetic curricula and adapter consolidation. Every cycle is recorded as an
 * immutable, digested research record.
 *
 * Boundary, learned from the first swarm: sleep produces candidates,
 * evaluations, and proposals. It never mints fitness, admits a gene, or
 * promotes an adapter. Those remain host/verifier decisions made elsewhere.
 */

export const SLEEP_CYCLE_POLICY_SCHEMA = "amos.swarm-sleep-cycle-policy";
export const SLEEP_CYCLE_RECORD_SCHEMA = "amos.swarm-sleep-cycle";
export const SLEEP_WORK_ITEM_SCHEMA = "amos.swarm-sleep-work-item";
export const SLEEP_LEDGER_SUMMARY_SCHEMA = "amos.swarm-sleep-ledger-summary";
export const SLEEP_CYCLE_VERSION = 1;

export const SLEEP_STATES = Object.freeze(["awake", "drowsy", "asleep"]);

export const SLEEP_WORK_KINDS = Object.freeze([
  "organism-artifact-replay",
  "organism-qwen-phase-probes",
  "curriculum-grading",
  "adapter-consolidation"
]);

/** Work kinds bound to a learning candidate's next gate. */
export const CANDIDATE_WORK_KINDS = Object.freeze([
  "organism-artifact-replay",
  "organism-qwen-phase-probes"
]);

/** Work kinds that run from a standing order rather than a candidate gate. */
export const STANDING_WORK_KINDS = Object.freeze([
  "curriculum-grading",
  "adapter-consolidation"
]);

export const SLEEP_CYCLE_END_REASONS = Object.freeze([
  "queue-drained",
  "woken",
  "load-unobservable",
  "budget-exhausted",
  "task-limit",
  "aborted"
]);

export const DEFAULT_SLEEP_POLICY = Object.freeze({
  quietMilliseconds: 5 * 60_000,
  pollMilliseconds: 15_000,
  maxCycleMilliseconds: 60 * 60_000,
  maxTasksPerCycle: 32,
  wakeRequestThreshold: 1
});

const POLICY_BOUNDS = Object.freeze({
  quietMilliseconds: [1_000, 24 * 60 * 60_000],
  pollMilliseconds: [100, 60 * 60_000],
  maxCycleMilliseconds: [1_000, 24 * 60 * 60_000],
  maxTasksPerCycle: [1, 10_000],
  wakeRequestThreshold: [1, 10_000]
});

const VLLM_REQUEST_GAUGE = /^vllm:num_requests_(running|waiting)(?:\{[^}]*\})?\s+([-+0-9.eE]+)\s*$/;

export function normalizeSleepPolicy(input = {}) {
  const source = objectValue(input, "sleep policy");
  if ("schema" in source && source.schema !== SLEEP_CYCLE_POLICY_SCHEMA) {
    throw new Error("Unsupported sleep policy schema");
  }
  if ("version" in source && source.version !== SLEEP_CYCLE_VERSION) {
    throw new Error("Unsupported sleep policy version");
  }
  for (const key of Object.keys(source)) {
    if (key === "schema" || key === "version") continue;
    if (!(key in DEFAULT_SLEEP_POLICY)) throw new Error(`sleep policy has unknown field ${key}`);
  }
  const policy = {};
  for (const [key, fallback] of Object.entries(DEFAULT_SLEEP_POLICY)) {
    const value = source[key] ?? fallback;
    const [minimum, maximum] = POLICY_BOUNDS[key];
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(`sleep policy ${key} must be an integer from ${minimum} to ${maximum}`);
    }
    policy[key] = value;
  }
  if (policy.pollMilliseconds > policy.quietMilliseconds) {
    throw new Error("sleep policy pollMilliseconds must not exceed quietMilliseconds");
  }
  return Object.freeze({
    schema: SLEEP_CYCLE_POLICY_SCHEMA,
    version: SLEEP_CYCLE_VERSION,
    ...policy
  });
}

/**
 * Parse vLLM's Prometheus text exposition for the request gauges. Gauges are
 * summed across label sets so multi-model servers report total load.
 */
export function parseVllmMetrics(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  let runningRequests = null;
  let waitingRequests = null;
  for (const line of lines) {
    const match = VLLM_REQUEST_GAUGE.exec(line.trim());
    if (!match) continue;
    const value = Number(match[2]);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`vLLM gauge ${match[1]} has an invalid value: ${match[2]}`);
    }
    if (match[1] === "running") runningRequests = (runningRequests ?? 0) + value;
    else waitingRequests = (waitingRequests ?? 0) + value;
  }
  if (runningRequests === null) {
    throw new Error("vLLM metrics did not include vllm:num_requests_running");
  }
  return {
    runningRequests: Math.round(runningRequests),
    waitingRequests: Math.round(waitingRequests ?? 0)
  };
}

export function normalizeLoadSample(input) {
  const source = objectValue(input, "load sample");
  const observedAt = validDate(source.observedAt, "load sample observedAt");
  const runningRequests = nonNegativeInteger(source.runningRequests, "load sample runningRequests");
  const waitingRequests = nonNegativeInteger(source.waitingRequests ?? 0, "load sample waitingRequests");
  return Object.freeze({
    observedAt: observedAt.toISOString(),
    runningRequests,
    waitingRequests,
    totalRequests: runningRequests + waitingRequests
  });
}

/**
 * Decide whether the substrate may sleep. Fails closed: missing or stale
 * observations keep the organism awake, and any request inside the quiet
 * window keeps it drowsy.
 */
export function decideSleepState({ samples, policy: policyInput, now = new Date() }) {
  const policy = normalizeSleepPolicy(policyInput);
  const current = validDate(now, "now").getTime();
  if (!Array.isArray(samples) || samples.length === 0) {
    return sleepDecision("awake", "no-load-observations", policy, null);
  }
  const ordered = samples
    .map(normalizeLoadSample)
    .sort((left, right) => left.observedAt.localeCompare(right.observedAt));
  const latest = ordered.at(-1);
  const latestAge = current - Date.parse(latest.observedAt);
  if (latestAge < 0) return sleepDecision("awake", "observation-from-the-future", policy, latest);
  if (latestAge > policy.pollMilliseconds * 2) {
    return sleepDecision("awake", "stale-load-observation", policy, latest);
  }
  if (latest.totalRequests >= policy.wakeRequestThreshold) {
    return sleepDecision("awake", "live-requests", policy, latest);
  }
  const windowStart = current - policy.quietMilliseconds;
  const inWindow = ordered.filter((sample) => Date.parse(sample.observedAt) >= windowStart);
  if (inWindow.some((sample) => sample.totalRequests >= policy.wakeRequestThreshold)) {
    return sleepDecision("drowsy", "recent-requests-inside-quiet-window", policy, latest);
  }
  const earliestQuiet = ordered.find((sample) => sample.totalRequests < policy.wakeRequestThreshold &&
    ordered.slice(ordered.indexOf(sample)).every((later) => later.totalRequests < policy.wakeRequestThreshold));
  const quietSince = earliestQuiet ? Date.parse(earliestQuiet.observedAt) : current;
  if (quietSince > windowStart) {
    return sleepDecision("drowsy", "quiet-window-not-yet-covered", policy, latest, current - quietSince);
  }
  return sleepDecision("asleep", "quiet-window-covered", policy, latest, current - quietSince);
}

function sleepDecision(state, reason, policy, latestSample, quietMilliseconds = 0) {
  return Object.freeze({
    state,
    reason,
    quietMilliseconds: Math.max(0, Math.round(quietMilliseconds)),
    requiredQuietMilliseconds: policy.quietMilliseconds,
    latestSample
  });
}

export function createSleepWorkItem({ kind, candidateId, candidateDigest, policyDigest, gate }) {
  if (!CANDIDATE_WORK_KINDS.includes(kind)) throw new Error(`Unsupported sleep work kind ${kind}`);
  const item = {
    schema: SLEEP_WORK_ITEM_SCHEMA,
    version: SLEEP_CYCLE_VERSION,
    id: `${kind}:${requiredId(candidateId, "work item candidateId")}`,
    kind,
    candidateId: requiredId(candidateId, "work item candidateId"),
    candidateDigest: requiredDigest(candidateDigest, "work item candidateDigest"),
    policyDigest: requiredDigest(policyDigest, "work item policyDigest"),
    gate: requiredId(gate, "work item gate")
  };
  return Object.freeze({ ...item, digest: digestResearchValue(item) });
}

/**
 * A standing order is research work that recurs without a candidate: grading
 * served models on curriculum scenarios, or consolidating verified data into an
 * adapter training job. The payload is opaque to the cycle and owned by the
 * executor; the cycle only guarantees it runs during sleep and is recorded.
 */
export function createStandingSleepWorkItem({ kind, orderId, payload, occurrence = 1 }) {
  if (!STANDING_WORK_KINDS.includes(kind)) throw new Error(`Unsupported standing sleep work kind ${kind}`);
  const normalizedPayload = structuredClone(objectValue(payload, "standing order payload"));
  const item = {
    schema: SLEEP_WORK_ITEM_SCHEMA,
    version: SLEEP_CYCLE_VERSION,
    id: `${kind}:${requiredId(orderId, "standing order id")}:${nonNegativeInteger(occurrence, "occurrence")}`,
    kind,
    orderId: requiredId(orderId, "standing order id"),
    occurrence: nonNegativeInteger(occurrence, "occurrence"),
    payload: normalizedPayload,
    payloadDigest: digestResearchValue(normalizedPayload)
  };
  return Object.freeze({ ...item, digest: digestResearchValue(item) });
}

export function validateSleepWorkItem(input) {
  const source = structuredClone(objectValue(input, "work item"));
  if (source.schema !== SLEEP_WORK_ITEM_SCHEMA || source.version !== SLEEP_CYCLE_VERSION) {
    throw new Error("Unsupported sleep work item");
  }
  const { digest, ...rest } = source;
  const rebuilt = CANDIDATE_WORK_KINDS.includes(rest.kind)
    ? createSleepWorkItem(rest)
    : createStandingSleepWorkItem(rest);
  if (rebuilt.digest !== digest) throw new Error(`Sleep work item ${rest.id} digest does not match`);
  return rebuilt;
}

/**
 * Run one sleep cycle. Executors receive a work item and return
 * `{ status, receiptDigest, evaluations, candidate?, receipt? }`. Load is
 * re-observed before every task; the first live request ends the cycle at the
 * next task boundary.
 */
export async function runSleepCycle({
  id,
  policy: policyInput,
  items,
  executors,
  observeLoad,
  now = () => new Date(),
  monotonicNow = () => performance.now(),
  signal = null
}) {
  const policy = normalizeSleepPolicy(policyInput);
  const cycleId = requiredId(id, "cycle id");
  if (typeof observeLoad !== "function") throw new Error("runSleepCycle requires observeLoad()");
  const queue = (Array.isArray(items) ? items : []).map(validateSleepWorkItem);
  const seen = new Set();
  for (const item of queue) {
    if (seen.has(item.id)) throw new Error(`Duplicate sleep work item ${item.id}`);
    seen.add(item.id);
    if (typeof executors?.[item.kind] !== "function") {
      throw new Error(`No sleep executor registered for ${item.kind}`);
    }
  }

  const startedAt = validDate(now(), "cycle startedAt").toISOString();
  const startedMonotonic = monotonicNow();
  const tasks = [];
  const results = [];
  let reason = "queue-drained";
  let wakeSample = null;
  let index = 0;

  for (; index < queue.length; index += 1) {
    if (signal?.aborted) { reason = "aborted"; break; }
    if (tasks.length >= policy.maxTasksPerCycle) { reason = "task-limit"; break; }
    if (monotonicNow() - startedMonotonic >= policy.maxCycleMilliseconds) {
      reason = "budget-exhausted";
      break;
    }
    let load;
    try {
      load = normalizeLoadSample(await observeLoad());
    } catch (error) {
      reason = "load-unobservable";
      wakeSample = { error: errorMessage(error) };
      break;
    }
    if (load.totalRequests >= policy.wakeRequestThreshold) {
      reason = "woken";
      wakeSample = load;
      break;
    }

    const item = queue[index];
    const taskStartedAt = validDate(now(), "task startedAt").toISOString();
    const taskStarted = monotonicNow();
    let task;
    try {
      const outcome = normalizeExecutorResult(await executors[item.kind](item, { signal, now }), item);
      results.push({ item, ...outcome });
      task = {
        item,
        status: outcome.status,
        receiptDigest: outcome.receiptDigest,
        evaluations: outcome.evaluations,
        candidate: outcome.candidateSummary
      };
    } catch (error) {
      task = {
        item,
        status: "errored",
        receiptDigest: null,
        evaluations: { hostContract: 0, verified: 0, modelCalls: 0 },
        candidate: null,
        error: errorMessage(error)
      };
    }
    tasks.push({
      ...task,
      startedAt: taskStartedAt,
      durationMilliseconds: Math.max(0, Math.round(monotonicNow() - taskStarted)),
      preemptedAfterCompletion: signal?.aborted === true
    });
  }
  if (index >= queue.length && reason === "queue-drained" && signal?.aborted) reason = "aborted";

  const remainingItems = queue.slice(index).map(({ id: itemId }) => itemId);
  const endedAt = validDate(now(), "cycle endedAt").toISOString();
  const totals = {
    tasksRun: tasks.length,
    passed: tasks.filter(({ status }) => status === "passed").length,
    failed: tasks.filter(({ status }) => status === "failed").length,
    errored: tasks.filter(({ status }) => status === "errored").length,
    hostContractReplays: sum(tasks.map(({ evaluations }) => evaluations.hostContract)),
    verifiedEvaluations: sum(tasks.map(({ evaluations }) => evaluations.verified)),
    modelCalls: sum(tasks.map(({ evaluations }) => evaluations.modelCalls)),
    candidateGatesAdvanced: tasks.filter(({ status }) => status === "passed").length
  };
  const recordBase = {
    schema: SLEEP_CYCLE_RECORD_SCHEMA,
    version: SLEEP_CYCLE_VERSION,
    id: cycleId,
    startedAt,
    endedAt,
    durationMilliseconds: Math.max(0, Math.round(monotonicNow() - startedMonotonic)),
    policy,
    policyDigest: digestResearchValue(policy),
    reason,
    wakeSample,
    queuedItems: queue.length,
    remainingItems,
    tasks,
    totals,
    authority: "research",
    vesting: {
      fitness: false,
      geneAdmission: false,
      adapterPromotion: false,
      note: "Sleep-cycle work advances research gates only; credit requires host receipts."
    }
  };
  const record = { ...recordBase, digest: digestResearchValue(recordBase) };
  return { record, results };
}

export function validateSleepCycleRecord(input) {
  const source = structuredClone(objectValue(input, "sleep cycle record"));
  if (source.schema !== SLEEP_CYCLE_RECORD_SCHEMA || source.version !== SLEEP_CYCLE_VERSION) {
    throw new Error("Unsupported sleep cycle record");
  }
  const { digest, ...rest } = source;
  if (digestResearchValue(rest) !== digest) {
    throw new Error(`Sleep cycle record ${rest.id} digest does not match its contents`);
  }
  if (!SLEEP_CYCLE_END_REASONS.includes(rest.reason)) {
    throw new Error(`Sleep cycle record ${rest.id} has unknown reason ${rest.reason}`);
  }
  if (rest.authority !== "research" || rest.vesting?.fitness !== false) {
    throw new Error(`Sleep cycle record ${rest.id} claims authority it cannot hold`);
  }
  return source;
}

/**
 * Summarize a ledger of cycle records over a trailing window. The headline
 * number is verified evaluations per day: evaluations graded by a
 * candidate-independent verifier, not invariant replays and not model
 * self-assessment.
 */
export function summarizeSleepLedger(records, { now = new Date(), windowMilliseconds = 86_400_000 } = {}) {
  const current = validDate(now, "now").getTime();
  if (!Number.isInteger(windowMilliseconds) || windowMilliseconds < 1_000) {
    throw new Error("windowMilliseconds must be an integer of at least 1000");
  }
  const validated = (Array.isArray(records) ? records : []).map(validateSleepCycleRecord);
  const windowStart = current - windowMilliseconds;
  const inWindow = validated.filter((record) => Date.parse(record.endedAt) >= windowStart &&
    Date.parse(record.endedAt) <= current);
  const reasons = {};
  for (const reason of SLEEP_CYCLE_END_REASONS) reasons[reason] = 0;
  for (const record of inWindow) reasons[record.reason] += 1;
  const verified = sum(inWindow.map(({ totals }) => totals.verifiedEvaluations));
  const perDayScale = 86_400_000 / windowMilliseconds;
  const summaryBase = {
    schema: SLEEP_LEDGER_SUMMARY_SCHEMA,
    version: SLEEP_CYCLE_VERSION,
    generatedAt: new Date(current).toISOString(),
    windowMilliseconds,
    cycles: inWindow.length,
    cyclesAllTime: validated.length,
    tasksRun: sum(inWindow.map(({ totals }) => totals.tasksRun)),
    hostContractReplays: sum(inWindow.map(({ totals }) => totals.hostContractReplays)),
    verifiedEvaluations: verified,
    verifiedEvaluationsPerDay: roundTo(verified * perDayScale, 2),
    modelCalls: sum(inWindow.map(({ totals }) => totals.modelCalls)),
    candidateGatesAdvanced: sum(inWindow.map(({ totals }) => totals.candidateGatesAdvanced)),
    errored: sum(inWindow.map(({ totals }) => totals.errored)),
    sleepMilliseconds: sum(inWindow.map(({ durationMilliseconds }) => durationMilliseconds)),
    reasons,
    latestCycleDigest: validated.at(-1)?.digest ?? null
  };
  return { ...summaryBase, digest: digestResearchValue(summaryBase) };
}

function normalizeExecutorResult(input, item) {
  const source = objectValue(input, `executor result for ${item.id}`);
  if (!["passed", "failed"].includes(source.status)) {
    throw new Error(`executor result for ${item.id} must have status passed or failed`);
  }
  const evaluations = objectValue(source.evaluations ?? {}, `executor evaluations for ${item.id}`);
  return {
    status: source.status,
    receiptDigest: requiredDigest(source.receiptDigest, `executor receiptDigest for ${item.id}`),
    evaluations: Object.freeze({
      hostContract: nonNegativeInteger(evaluations.hostContract ?? 0, "evaluations.hostContract"),
      verified: nonNegativeInteger(evaluations.verified ?? 0, "evaluations.verified"),
      modelCalls: nonNegativeInteger(evaluations.modelCalls ?? 0, "evaluations.modelCalls")
    }),
    candidateSummary: source.candidate
      ? {
          id: String(source.candidate.id),
          status: String(source.candidate.status),
          nextGate: source.candidate.nextGate ?? null,
          digest: String(source.candidate.digest)
        }
      : null,
    candidate: source.candidate ?? null,
    receipt: source.receipt ?? null
  };
}

function objectValue(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requiredId(value, label) {
  const text = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(text)) throw new Error(`${label} is invalid`);
  return text;
}

function requiredDigest(value, label) {
  const digest = String(value ?? "").trim();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${label} must be a SHA-256 digest`);
  return digest;
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function validDate(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} is invalid`);
  return date;
}

function errorMessage(error) {
  return String(error?.message ?? error ?? "unknown error").slice(0, 1_000);
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function roundTo(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
