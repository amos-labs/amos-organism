import { digestResearchValue } from "./experimentProtocol.js";
import { createQwenAdapterStageOneContract } from "./qwenAdapterTrainingContract.js";

/**
 * Adapter consolidation: the organism's slow-learning step.
 *
 * When the dataset compiler reports a qualified stage-one dataset, this plans
 * one disposable training job per (rank, seed) pair, each bound to an immutable
 * contract. Execution is a separate, explicitly enabled step that talks to AWS.
 * Nothing here selects a winner: adapters are graded afterwards by the
 * executable verifier on the holdout pool, base model included as the control.
 */

export const ADAPTER_CONSOLIDATION_PLAN_SCHEMA = "amos.adapter-consolidation-plan";
export const ADAPTER_CONSOLIDATION_LEDGER_SCHEMA = "amos.adapter-consolidation-ledger-entry";
export const ADAPTER_CONSOLIDATION_VERSION = 1;

export function consolidationReadiness({ dataset }) {
  const reasons = [];
  if (!dataset || dataset.ready !== true) reasons.push("dataset-not-ready");
  for (const blocker of dataset?.manifest?.blockers ?? []) reasons.push(`blocker:${blocker}`);
  if (dataset?.manifest?.status && dataset.manifest.status !== "qualified") reasons.push(`status:${dataset.manifest.status}`);
  return { ready: reasons.length === 0, reasons, counts: dataset?.manifest?.counts ?? null, manifestDigest: dataset?.manifest?.digest ?? null };
}

export function planAdapterConsolidation({
  idPrefix,
  plan,
  checkpoint,
  datasetManifest,
  trainerImageUri,
  datasetUri,
  outputPrefix,
  contractPrefix,
  sourceRevision,
  ranks = [32],
  seeds = [20260903, 20260904, 20260905],
  epochs = 3,
  learningRate = 0.0001,
  maximumSequenceTokens = 4096,
  generatedAt = new Date()
}) {
  const prefix = requiredId(idPrefix, "idPrefix");
  if (!Array.isArray(ranks) || ranks.length === 0 || !Array.isArray(seeds) || seeds.length === 0) {
    throw new Error("Consolidation needs at least one rank and one seed");
  }
  if (ranks.length * seeds.length > 12) throw new Error("Consolidation is capped at twelve jobs per plan");
  const jobs = [];
  for (const rank of ranks) {
    for (const seed of seeds) {
      const id = `${prefix}-r${rank}-s${seed}`;
      const outputUri = `${trimSlash(outputPrefix)}/${id}`;
      const contract = createQwenAdapterStageOneContract({
        id,
        plan,
        datasetManifest,
        checkpoint,
        trainerImageUri,
        datasetUri,
        outputUri,
        sourceRevision,
        seed,
        rank,
        epochs,
        learningRate,
        maximumSequenceTokens
      });
      jobs.push({
        contractId: id,
        rank,
        seed,
        contractUri: `${trimSlash(contractPrefix)}/${id}.json`,
        outputUri,
        contractDigest: contract.digest,
        contract
      });
    }
  }
  const base = {
    schema: ADAPTER_CONSOLIDATION_PLAN_SCHEMA,
    version: ADAPTER_CONSOLIDATION_VERSION,
    id: prefix,
    generatedAt: new Date(generatedAt).toISOString(),
    datasetUri: trimSlash(datasetUri),
    datasetManifestDigest: datasetManifest.digest,
    trainerImageUri,
    sourceRevision,
    ranks: [...ranks],
    seeds: [...seeds],
    jobs: jobs.map(({ contract, ...job }) => job),
    selection: {
      by: "curriculum-grading-on-holdout-pool",
      controlModel: plan.base.model,
      requireThreeSeedReplication: plan.promotion?.requireThreeSeedReplication === true,
      qualityClaimAllowed: false,
      promotionAllowed: false
    }
  };
  return { plan: { ...base, digest: digestResearchValue(base) }, contracts: jobs.map(({ contract }) => contract) };
}

export function nextConsolidationJob(planDocument, ledgerEntries) {
  const finished = new Set(
    (ledgerEntries || [])
      .filter((entry) => entry?.schema === ADAPTER_CONSOLIDATION_LEDGER_SCHEMA && ["completed", "failed"].includes(entry.status))
      .map((entry) => entry.contractId)
  );
  return planDocument.jobs.find((job) => !finished.has(job.contractId)) ?? null;
}

export function createConsolidationLedgerEntry({ planDigest, job, status, startedAt, finishedAt, instanceId, resultDigest = null, error = null }) {
  if (!["submitted", "running", "completed", "failed"].includes(status)) throw new Error(`Unsupported ledger status ${status}`);
  const base = {
    schema: ADAPTER_CONSOLIDATION_LEDGER_SCHEMA,
    version: ADAPTER_CONSOLIDATION_VERSION,
    planDigest,
    contractId: job.contractId,
    contractDigest: job.contractDigest,
    rank: job.rank,
    seed: job.seed,
    outputUri: job.outputUri,
    instanceId,
    status,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: finishedAt ? new Date(finishedAt).toISOString() : null,
    resultDigest,
    error: error ? String(error).slice(0, 1_000) : null,
    qualityClaimAllowed: false
  };
  return { ...base, digest: digestResearchValue(base) };
}

function trimSlash(value) {
  const text = String(value ?? "").trim();
  if (!/^s3:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\//.test(text)) throw new Error(`Expected an s3:// prefix, received ${text}`);
  return text.replace(/\/+$/, "");
}

function requiredId(value, label) {
  const text = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(text)) throw new Error(`${label} is invalid`);
  return text;
}
