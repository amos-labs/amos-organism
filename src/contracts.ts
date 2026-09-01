import type { StrategyGeneSpec } from "./strategyGenes.ts";

export const STRATEGY_GENE_CANDIDATE_SCHEMA = "amos.strategy-gene-candidate";
export const STRATEGY_GENE_PROCEDURE_SCHEMA = "amos.strategy-gene-procedure";
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

export interface StrategyGeneProcedureContract {
  readonly schema: typeof STRATEGY_GENE_PROCEDURE_SCHEMA;
  readonly schemaVersion: typeof ORGANISM_CONTRACT_VERSION;
  readonly spec: StrategyGeneSpec;
  readonly parentIds: readonly string[];
  readonly evidenceRefs: readonly string[];
}

export interface PlatformMissionLearningEpisodeContract {
  readonly schema: typeof PLATFORM_MISSION_EPISODE_SCHEMA;
  readonly schemaVersion: typeof ORGANISM_CONTRACT_VERSION;
  readonly episodeId: string;
  readonly tenantId: string;
  readonly missionId: string;
  readonly terminalStatus: "completed" | "failed" | "cancelled" | "expired";
  readonly sourceEpisodeDigest: string;
  readonly rightsTags: readonly string[];
  readonly consentReceiptId: string;
  readonly attestationReceiptId: string;
  readonly source: Readonly<Record<string, unknown>>;
}

export function isPlatformMissionLearningEpisodeContract(
  value: unknown,
): value is PlatformMissionLearningEpisodeContract {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const episode = value as Partial<PlatformMissionLearningEpisodeContract>;
  return episode.schema === PLATFORM_MISSION_EPISODE_SCHEMA
    && episode.schemaVersion === ORGANISM_CONTRACT_VERSION
    && typeof episode.episodeId === "string"
    && typeof episode.tenantId === "string"
    && typeof episode.missionId === "string"
    && ["completed", "failed", "cancelled", "expired"].includes(
      episode.terminalStatus ?? "",
    )
    && typeof episode.sourceEpisodeDigest === "string"
    && Array.isArray(episode.rightsTags)
    && episode.rightsTags.length > 0
    && typeof episode.consentReceiptId === "string"
    && typeof episode.attestationReceiptId === "string"
    && !!episode.source
    && typeof episode.source === "object"
    && !Array.isArray(episode.source);
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
