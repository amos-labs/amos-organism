/**
 * Swarm-side view of the organism kernel contracts.
 *
 * The schema identifiers and contract version are owned by the kernel
 * (src/contracts.ts, mirrored by contracts/*.schema.json). The swarm re-exports
 * them so exported trace bundles and extracted procedures can never drift from
 * what scripts/importTraceBundle.ts accepts. Only the JavaScript convenience
 * guards live here.
 */
export {
  GENE_EXPRESSION_SCHEMA,
  ORGANISM_CONTRACT_VERSION,
  ORGANISM_TRACE_BUNDLE_SCHEMA,
  PLATFORM_MISSION_EPISODE_SCHEMA,
  STRATEGY_GENE_CANDIDATE_SCHEMA,
  STRATEGY_GENE_PROCEDURE_SCHEMA,
  isPlatformMissionLearningEpisodeContract,
  isStrategyGeneCandidateContract
} from "../../src/contracts.ts";
import {
  ORGANISM_CONTRACT_VERSION,
  STRATEGY_GENE_PROCEDURE_SCHEMA
} from "../../src/contracts.ts";

export function assertCanonicalProcedure(value) {
  if (
    !value
    || value.schema !== STRATEGY_GENE_PROCEDURE_SCHEMA
    || value.schemaVersion !== ORGANISM_CONTRACT_VERSION
    || !value.spec
    || !Array.isArray(value.parentIds)
    || !Array.isArray(value.evidenceRefs)
  ) {
    throw new Error("Invalid canonical organism strategy-gene procedure");
  }
  return value;
}
