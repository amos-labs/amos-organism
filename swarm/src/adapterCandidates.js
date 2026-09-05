import { digestResearchValue } from "./experimentProtocol.js";
import { validateVerifiedMissionComparison } from "./missionComparison.js";

/**
 * Adapter candidate ledger: the governed path for a trained adapter to change
 * production behavior. An adapter is a candidate, not a promotion. It advances
 * through gates in a fixed order, each recorded with the digest of the receipt
 * that decided it, and the ledger never promotes on its own: canary and
 * production remain host decisions carried by their own receipts.
 *
 * Gates mirror the plan: trained -> frozen holdout (paired against the base) ->
 * sealed holdout -> shadow (real Mission turns, base and adapter side by side)
 * -> canary -> promoted.
 */

export const ADAPTER_CANDIDATE_SCHEMA = "amos.adapter-candidate";
export const ADAPTER_CANDIDATE_GATE_SCHEMA = "amos.adapter-candidate-gate";
export const ADAPTER_CANDIDATE_VERSION = 1;

export const ADAPTER_CANDIDATE_GATES = Object.freeze([
  "trained",
  "frozen-holdout",
  "sealed-holdout",
  "shadow",
  "canary",
  "promoted"
]);

const GATE_EVALUATORS = Object.freeze({
  trained: "disposable-trainer",
  "frozen-holdout": "amos-executable-contract-verifier",
  "sealed-holdout": "amos-executable-contract-verifier",
  shadow: "mission-verifier",
  canary: "canary-telemetry-verifier",
  promoted: "host"
});

/** Gates a research process may record. Canary and promotion need a host receipt. */
export const RESEARCH_RECORDABLE_GATES = Object.freeze(["trained", "frozen-holdout", "sealed-holdout", "shadow"]);

export function createAdapterCandidate({
  id,
  contractId,
  contractDigest,
  rank,
  seed,
  trainingResultDigest,
  adapterUri,
  baseModel,
  trainingTreatments,
  createdAt = new Date()
}) {
  const candidate = {
    schema: ADAPTER_CANDIDATE_SCHEMA,
    version: ADAPTER_CANDIDATE_VERSION,
    id: requiredId(id, "candidate.id"),
    createdAt: validDate(createdAt, "candidate.createdAt").toISOString(),
    training: {
      contractId: requiredId(contractId, "candidate.contractId"),
      contractDigest: requiredDigest(contractDigest, "candidate.contractDigest"),
      rank: boundedInteger(rank, 1, 1024, "candidate.rank"),
      seed: boundedInteger(seed, 0, 2 ** 31 - 1, "candidate.seed"),
      resultDigest: requiredDigest(trainingResultDigest, "candidate.trainingResultDigest"),
      treatments: uniqueTexts(trainingTreatments, "candidate.trainingTreatments")
    },
    adapterUri: s3Uri(adapterUri, "candidate.adapterUri"),
    baseModel: requiredText(baseModel, "candidate.baseModel"),
    status: "qualifying",
    nextGate: ADAPTER_CANDIDATE_GATES[0],
    gates: [],
    feedback: [],
    deployment: { shadowAllowed: false, canaryAllowed: false, productionAllowed: false, automaticallyDeployed: false }
  };
  return withDigest(candidate);
}

/**
 * Record a gate. Holdout gates require a paired comparison receipt whose
 * candidate row names this adapter; the gate passes only if the adapter did not
 * lose more paired scenarios than it won and its pass rate did not fall below
 * the base. Shadow requires a replayable comparison of independently executed
 * Missions. Canary and promotion
 * require a host receipt and cannot be recorded through this function.
 */
export function recordAdapterGate(candidateInput, gateInput) {
  const candidate = validateAdapterCandidate(candidateInput);
  if (candidate.status !== "qualifying") throw new Error(`Adapter candidate ${candidate.id} is already ${candidate.status}`);
  const gate = normalizeGate(gateInput);
  if (gate.id !== candidate.nextGate) throw new Error(`Expected gate ${candidate.nextGate}, received ${gate.id}`);
  if (!RESEARCH_RECORDABLE_GATES.includes(gate.id)) {
    throw new Error(`Gate ${gate.id} requires a host receipt; use recordHostAdapterGate`);
  }
  if (gate.id === "shadow") {
    const comparison = validateVerifiedMissionComparison(gateInput.missionComparison);
    if (comparison.candidate.adapterUri !== candidate.adapterUri || comparison.baseline.modelId !== candidate.baseModel) throw new Error("Mission comparison does not evaluate this adapter against its base");
    const derived = normalizeGate(shadowGateFromMissionComparison(comparison));
    for (const key of ["status", "receiptDigest", "metrics", "feedbackSignals"]) {
      if (digestResearchValue(gate[key]) !== digestResearchValue(derived[key])) throw new Error("Shadow gate does not match verified mission results");
    }
  }
  return applyGate(candidate, gate);
}

/** Build shadow evidence from paired executions, never unexecuted shadow prose. */
export function shadowGateFromMissionComparison(input) {
  const comparison = validateVerifiedMissionComparison(input);
  if (!comparison.checks.enoughIndependentMissions || !comparison.checks.completeCheckerCoverage) {
    throw new Error("Mission comparison is not ready: collect enough independently checked missions before recording a gate");
  }
  return {
    id: "shadow", status: comparison.passed ? "passed" : "failed", evaluator: "mission-verifier",
    receiptDigest: comparison.digest, metrics: comparison.metrics,
    feedbackSignals: Object.entries(comparison.checks).filter(([, pass]) => !pass).map(([key]) => `mission-check-failed:${key}`),
    missionComparison: comparison
  };
}

export function recordHostAdapterGate(candidateInput, gateInput, hostReceipt) {
  const candidate = validateAdapterCandidate(candidateInput);
  const gate = normalizeGate(gateInput);
  if (!["canary", "promoted"].includes(gate.id)) throw new Error("recordHostAdapterGate is for canary and promotion only");
  if (gate.id !== candidate.nextGate) throw new Error(`Expected gate ${candidate.nextGate}, received ${gate.id}`);
  if (hostReceipt?.authority !== "host" || !requiredDigest(hostReceipt?.payloadDigest, "hostReceipt.payloadDigest")) {
    throw new Error("Canary and promotion gates require a host receipt");
  }
  if (hostReceipt.payloadDigest !== gate.receiptDigest) throw new Error("Host receipt does not attest the gate receipt");
  return applyGate(candidate, { ...gate, hostReceiptId: requiredId(hostReceipt.id, "hostReceipt.id") });
}

/** Derive a frozen/sealed-holdout gate from a grading comparison. */
export function holdoutGateFromComparison({ gateId, comparison, adapterModelId, minimumPairedMargin = 0 }) {
  if (!["frozen-holdout", "sealed-holdout"].includes(gateId)) throw new Error("holdout gates only");
  if (comparison?.schema !== "amos.curriculum-grading-comparison") throw new Error("Expected a curriculum grading comparison");
  const row = (comparison.candidates || []).find((entry) => entry.modelId === adapterModelId);
  if (!row) throw new Error(`Comparison has no row for ${adapterModelId}`);
  const feedbackSignals = [];
  if (row.pairedLosses > row.pairedWins) feedbackSignals.push("adapter-loses-more-paired-scenarios-than-it-wins");
  if (row.passRateLift < 0) feedbackSignals.push("adapter-pass-rate-below-base");
  if (row.pairedWins - row.pairedLosses < minimumPairedMargin) feedbackSignals.push("paired-margin-below-minimum");
  return {
    id: gateId,
    status: feedbackSignals.length === 0 ? "passed" : "failed",
    evaluator: GATE_EVALUATORS[gateId],
    receiptDigest: comparison.digest,
    metrics: {
      controlModel: comparison.control.modelId,
      controlPassRate: comparison.control.passRate,
      scenarioCount: comparison.scenarioCount,
      passRateLift: row.passRateLift,
      firstAttemptPassRateLift: row.firstAttemptPassRateLift,
      pairedWins: row.pairedWins,
      pairedLosses: row.pairedLosses,
      ties: row.ties
    },
    feedbackSignals
  };
}

export function nextAdapterAction(candidateInput) {
  const candidate = validateAdapterCandidate(candidateInput);
  if (candidate.nextGate === null) return null;
  const jobs = {
    trained: "adapter-training-result",
    "frozen-holdout": "curriculum-grading:frozen",
    "sealed-holdout": "curriculum-grading:sealed",
    shadow: "mission-shadow-comparison",
    canary: "host-canary-decision",
    promoted: "host-promotion-decision"
  };
  return { kind: jobs[candidate.nextGate], candidateId: candidate.id, candidateDigest: candidate.digest, gate: candidate.nextGate, adapterUri: candidate.adapterUri };
}

export function validateAdapterCandidate(input) {
  const source = structuredClone(input);
  if (source?.schema !== ADAPTER_CANDIDATE_SCHEMA || source?.version !== ADAPTER_CANDIDATE_VERSION) throw new Error("Unsupported adapter candidate");
  const { digest, ...rest } = source;
  if (digestResearchValue(rest) !== digest) throw new Error("Adapter candidate digest does not match its contents");
  if (source.deployment?.automaticallyDeployed !== false) throw new Error("An adapter candidate cannot be auto-deployed");
  return source;
}

function applyGate(candidate, gate) {
  const next = structuredClone(candidate);
  delete next.digest;
  next.gates.push(gate);
  if (gate.status === "failed") {
    next.status = "rejected";
    next.nextGate = null;
    next.feedback.push(...gate.feedbackSignals.map((signal) => ({ gate: gate.id, signal, receiptDigest: gate.receiptDigest })));
  } else {
    const index = ADAPTER_CANDIDATE_GATES.indexOf(gate.id) + 1;
    next.nextGate = ADAPTER_CANDIDATE_GATES[index] ?? null;
    if (gate.id === "sealed-holdout") next.deployment.shadowAllowed = true;
    if (gate.id === "shadow") next.deployment.canaryAllowed = true;
    if (gate.id === "promoted") { next.status = "promoted"; next.deployment.productionAllowed = true; }
  }
  return withDigest(next);
}

function normalizeGate(input) {
  const source = structuredClone(input);
  const id = requiredId(source?.id, "gate.id");
  if (!ADAPTER_CANDIDATE_GATES.includes(id)) throw new Error(`Unsupported adapter gate ${id}`);
  if (!["passed", "failed"].includes(source.status)) throw new Error("gate.status must be passed or failed");
  if (source.evaluator !== GATE_EVALUATORS[id]) throw new Error(`Gate ${id} requires evaluator ${GATE_EVALUATORS[id]}`);
  const feedbackSignals = uniqueTexts(source.feedbackSignals || [], "gate.feedbackSignals", 0);
  if (source.status === "failed" && feedbackSignals.length === 0) throw new Error("A failed gate requires feedback signals");
  return {
    schema: ADAPTER_CANDIDATE_GATE_SCHEMA,
    version: ADAPTER_CANDIDATE_VERSION,
    id,
    status: source.status,
    evaluator: source.evaluator,
    receiptDigest: requiredDigest(source.receiptDigest, "gate.receiptDigest"),
    metrics: structuredClone(source.metrics || {}),
    feedbackSignals,
    evaluatedAt: validDate(source.evaluatedAt || new Date(), "gate.evaluatedAt").toISOString()
  };
}

function withDigest(value) { return { ...value, digest: digestResearchValue(value) }; }
function requiredId(value, label) { const t = String(value ?? "").trim(); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(t)) throw new Error(`${label} is invalid`); return t; }
function requiredText(value, label) { const t = String(value ?? "").trim(); if (!t) throw new Error(`${label} is required`); return t; }
function requiredDigest(value, label) { const d = String(value ?? "").trim(); if (!/^[a-f0-9]{64}$/.test(d)) throw new Error(`${label} must be a SHA-256 digest`); return d; }
function boundedInteger(value, minimum, maximum, label) { if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`); return value; }
function validDate(value, label) { const d = value instanceof Date ? value : new Date(value); if (Number.isNaN(d.getTime())) throw new Error(`${label} is invalid`); return d; }
function s3Uri(value, label) { const t = String(value ?? "").trim(); if (!/^s3:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/\S+$/.test(t)) throw new Error(`${label} must be an s3:// URI`); return t; }
function uniqueTexts(values, label, minimum = 1) { if (!Array.isArray(values) || values.length < minimum) throw new Error(`${label} must list at least ${minimum} item(s)`); return [...new Set(values.map((v) => requiredText(v, label)))]; }
