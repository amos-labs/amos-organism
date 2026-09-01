import type { StrategyGeneSpec } from "./strategyGenes.ts";

export const STRATEGY_GENE_CANDIDATE_SCHEMA = "amos.strategy-gene-candidate";
export const GENE_EXPRESSION_SCHEMA = "amos.gene-expression";
export const ORGANISM_TRACE_BUNDLE_SCHEMA = "amos.organism-trace-bundle";
export const PLATFORM_MISSION_EPISODE_SCHEMA = "amos.platform-mission-learning-episode";
export const ORGANISM_CONTRACT_VERSION = 1 as const;

export interface StrategyGeneCandidateContract {
  readonly schema: typeof STRATEGY_GENE_CANDIDATE_SCHEMA;
  readonly schemaVersion: typeof ORGANISM_CONTRACT_VERSION;
  readonly id: string;
  readonly runId: string;
  readonly trialId: string;
  readonly spec: StrategyGeneSpec;
  readonly parentIds: readonly string[];
  readonly evidenceRefs: readonly string[];
}

export interface PlatformMissionLearningEpisodeContract {
  readonly schema: typeof PLATFORM_MISSION_EPISODE_SCHEMA;
  readonly schemaVersion: typeof ORGANISM_CONTRACT_VERSION;
  readonly tenantId: string;
  readonly missionId: string;
  readonly terminalStatus: "completed" | "failed" | "cancelled" | "expired";
  readonly sourceEpisodeDigest: string;
  readonly rightsTags: readonly string[];
  readonly consentReceiptId: string;
  readonly attestationReceiptId: string;
}

export function isStrategyGeneCandidateContract(
  value: unknown,
): value is StrategyGeneCandidateContract {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<StrategyGeneCandidateContract>;
  return candidate.schema === STRATEGY_GENE_CANDIDATE_SCHEMA
    && candidate.schemaVersion === ORGANISM_CONTRACT_VERSION
    && typeof candidate.id === "string"
    && typeof candidate.runId === "string"
    && typeof candidate.trialId === "string"
    && typeof candidate.spec === "object"
    && Array.isArray(candidate.parentIds)
    && Array.isArray(candidate.evidenceRefs);
}
