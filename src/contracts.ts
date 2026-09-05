import type { StrategyGeneSpec } from "./strategyGenes.ts";

export const STRATEGY_GENE_CANDIDATE_SCHEMA = "amos.strategy-gene-candidate";
export const STRATEGY_GENE_PROCEDURE_SCHEMA = "amos.strategy-gene-procedure";
export const GENE_EXPRESSION_SCHEMA = "amos.gene-expression";
export const ORGANISM_TRACE_BUNDLE_SCHEMA = "amos.organism-trace-bundle";
export const PLATFORM_MISSION_EPISODE_SCHEMA = "amos.platform-mission-learning-episode";
export const PLATFORM_CONTENT_MANIFEST_SCHEMA = "amos.platform-learning-content-manifest";
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
    && !!episode.source
    && typeof episode.source === "object"
    && !Array.isArray(episode.source);
}

/**
 * Content manifest (Platform docs/LEARNING-CONTENT-EXPORT.md, revision 2): per
 * terminal Mission, ordered references to redacted exported content. Content
 * never rides in it; bytes are fetched through the Platform's export verb under
 * the tenant's live training_content grant. Signed and delivered like the
 * episode, as a second message type keyed by the same episode id.
 */
export type ContentManifestItemKind = "objective" | "planner_input" | "planner_output" | "decision" | "checker_result" | "tool_result";
export type ContentManifestCompleteness = "complete" | "truncated" | "redacted_context_lost";

export interface PlatformContentManifestItem {
  readonly kind: ContentManifestItemKind;
  readonly ref: string;
  readonly sha256: string;
  readonly completeness: ContentManifestCompleteness;
  readonly redaction: readonly string[];
  readonly stepPosition: number | null;
  readonly plannerAttempt: number | null;
  readonly disposition?: "proposed" | "rejected" | "corrected" | "accepted";
  readonly compiledInputSha256?: string | null;
  readonly requestPayloadSha256?: string | null;
}

export interface PlatformLearningContentManifestContract {
  readonly schema: typeof PLATFORM_CONTENT_MANIFEST_SCHEMA;
  readonly schemaVersion: typeof ORGANISM_CONTRACT_VERSION;
  readonly manifestVersion: 1;
  readonly episodeId: string;
  readonly tenantId: string;
  readonly missionId: string;
  readonly items: readonly PlatformContentManifestItem[];
  readonly omitted: readonly Readonly<Record<string, unknown>>[];
  readonly acceptedAttemptBindings: readonly Readonly<Record<string, unknown>>[];
  readonly evaluationExclusion: readonly string[];
  readonly redactionPolicyVersion: string;
  readonly grantReceiptRef: string;
  readonly rightsTags: readonly string[];
  readonly contentSha256: string;
}

const MANIFEST_ITEM_KINDS = new Set(["objective", "planner_input", "planner_output", "decision", "checker_result", "tool_result"]);
const MANIFEST_COMPLETENESS = new Set(["complete", "truncated", "redacted_context_lost"]);
const SHA256_HEX = /^[a-f0-9]{64}$/;

export function isPlatformLearningContentManifestContract(value: unknown): value is PlatformLearningContentManifestContract {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Partial<PlatformLearningContentManifestContract>;
  const text = (candidate: unknown): boolean => typeof candidate === "string" && candidate.length > 0;
  return manifest.schema === PLATFORM_CONTENT_MANIFEST_SCHEMA
    && manifest.schemaVersion === ORGANISM_CONTRACT_VERSION
    && manifest.manifestVersion === 1
    && text(manifest.episodeId) && text(manifest.tenantId) && text(manifest.missionId)
    && manifest.episodeId!.startsWith(`platform-mission:${manifest.tenantId}:${manifest.missionId}:`)
    && Array.isArray(manifest.items)
    && manifest.items.every((item) => !!item && typeof item === "object"
      && MANIFEST_ITEM_KINDS.has(item.kind)
      && text(item.ref) && item.ref.startsWith("amos-content://")
      && typeof item.sha256 === "string" && SHA256_HEX.test(item.sha256)
      && MANIFEST_COMPLETENESS.has(item.completeness)
      && Array.isArray(item.redaction)
      && (item.stepPosition === null || Number.isInteger(item.stepPosition))
      && (item.plannerAttempt === null || Number.isInteger(item.plannerAttempt))
      && (item.kind !== "planner_output" || ["proposed", "rejected", "corrected", "accepted"].includes(item.disposition ?? "")))
    && Array.isArray(manifest.omitted)
    && Array.isArray(manifest.acceptedAttemptBindings)
    && Array.isArray(manifest.evaluationExclusion)
    && text(manifest.redactionPolicyVersion) && text(manifest.grantReceiptRef)
    && Array.isArray(manifest.rightsTags) && manifest.rightsTags.length > 0
    && typeof manifest.contentSha256 === "string" && SHA256_HEX.test(manifest.contentSha256);
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
