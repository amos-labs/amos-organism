import { canonicalJson, digest } from "./digest.ts";
import type { GeneOutcome, StrategyGene } from "./strategyGenes.ts";

/**
 * Learning selection snapshot: the one artifact the Organism publishes to the
 * Platform and the Swarm gateway describing which learned procedures may be
 * compiled into planner context, for which runtimes, under which permitted use.
 *
 * The Platform enforces tenant scope and applicability and caches by
 * (id, digest); it never becomes a second registry. The gateway attests which
 * procedure ids it actually compiled. `procedureSnapshotSha256` is the same
 * value a Mission treatment carries (comparison v2), so an experiment can name
 * the exact procedure state it ran under; with no procedures it is the shared
 * empty-snapshot sentinel.
 */
export const LEARNING_SELECTION_SNAPSHOT_SCHEMA = "amos.learning-selection-snapshot";
export const PROCEDURE_SNAPSHOT_SCHEMA = "amos.procedure-snapshot";
export const LEARNING_SELECTION_SNAPSHOT_VERSION = 1 as const;
export const EMPTY_PROCEDURE_SNAPSHOT_SHA256 = digest({ schema: "amos.empty-procedure-snapshot", version: 1 });

export type ProcedureGuidance = "guide" | "avoid";

export interface SnapshotProcedureApplicability {
  readonly phases: readonly string[];
  readonly artifactClasses: readonly string[];
  readonly failureModes: readonly string[];
  readonly toolFamilies: readonly string[];
  readonly roles: readonly string[];
  readonly tenantScope: "any" | "tenant";
  /** Required and non-empty when tenantScope is "tenant"; empty otherwise. The Platform enforces it. */
  readonly tenantIds: readonly string[];
}

export interface SnapshotProcedureEvidence {
  readonly verifiedPasses: number;
  readonly verifiedFailures: number;
  readonly uncreditedAttempts: number;
  readonly meanVerifiedQuality: number | null;
  readonly lastVerifiedAt: string | null;
}

export interface SnapshotProcedure {
  readonly id: string;
  readonly version: number;
  readonly digest: string;
  readonly guidance: ProcedureGuidance;
  readonly applicability: SnapshotProcedureApplicability;
  /** Bounded prose the Platform renders synchronously (resume_company must not fetch per procedure); cited as id@version. */
  readonly statement: string;
  readonly contentRef: string;
  readonly tokens: number;
  readonly evidence: SnapshotProcedureEvidence;
}

export interface CompatibleRuntime {
  readonly modelId: string;
  readonly adapterArtifactSha256: string | null;
  readonly runtimeRevision: string;
}

export interface LearningSelectionSnapshotInput {
  readonly id: string;
  readonly generatedAt: string | Date;
  /** Cache expiry for (id, digest); must be after generatedAt. */
  readonly validUntil: string | Date;
  readonly sourceChainDigest: string;
  readonly compatibleRuntimes: readonly CompatibleRuntime[];
  readonly permittedUseScope: readonly string[];
  readonly tokenBound: number;
  readonly procedures: readonly SnapshotProcedure[];
}

export interface LearningSelectionSnapshot extends LearningSelectionSnapshotInput {
  readonly schema: typeof LEARNING_SELECTION_SNAPSHOT_SCHEMA;
  readonly version: typeof LEARNING_SELECTION_SNAPSHOT_VERSION;
  readonly generatedAt: string;
  readonly validUntil: string;
  readonly procedureSnapshotSha256: string;
  readonly digest: string;
}

const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
export const PROCEDURE_STATEMENT_MAX_CHARS = 600;

/** Digest of the ordered procedure identities: the value a Mission treatment binds to. */
export function procedureSnapshotSha256(procedures: readonly SnapshotProcedure[]): string {
  if (procedures.length === 0) return EMPTY_PROCEDURE_SNAPSHOT_SHA256;
  return digest({
    schema: PROCEDURE_SNAPSHOT_SCHEMA,
    version: 1,
    procedures: [...procedures].sort(byId).map((procedure) => ({ id: procedure.id, version: procedure.version, digest: procedure.digest }))
  });
}

export function createLearningSelectionSnapshot(input: LearningSelectionSnapshotInput): LearningSelectionSnapshot {
  const procedures = [...input.procedures].sort(byId).map(normalizeProcedure);
  const body: Omit<LearningSelectionSnapshot, "digest"> = {
    schema: LEARNING_SELECTION_SNAPSHOT_SCHEMA,
    version: LEARNING_SELECTION_SNAPSHOT_VERSION,
    id: requireId(input.id, "snapshot.id"),
    generatedAt: isoDate(input.generatedAt, "snapshot.generatedAt"),
    validUntil: isoDate(input.validUntil, "snapshot.validUntil"),
    sourceChainDigest: requireSha(input.sourceChainDigest, "snapshot.sourceChainDigest"),
    procedureSnapshotSha256: procedureSnapshotSha256(procedures),
    compatibleRuntimes: normalizeRuntimes(input.compatibleRuntimes),
    permittedUseScope: uniqueSorted(input.permittedUseScope, "snapshot.permittedUseScope", 1),
    tokenBound: nonNegativeInteger(input.tokenBound, "snapshot.tokenBound"),
    procedures
  };
  if (new Date(body.validUntil).getTime() <= new Date(body.generatedAt).getTime()) throw new Error("snapshot.validUntil must be after generatedAt");
  const total = procedures.reduce((sum, procedure) => sum + procedure.tokens, 0);
  if (total > body.tokenBound) throw new Error(`snapshot procedures need ${total} tokens, above tokenBound ${body.tokenBound}`);
  return Object.freeze({ ...body, digest: digest(body) });
}

/** Re-derive every digest; a snapshot whose digests do not match its content is refused. */
export function validateLearningSelectionSnapshot(value: unknown): LearningSelectionSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("snapshot must be an object");
  const candidate = value as LearningSelectionSnapshot;
  if (candidate.schema !== LEARNING_SELECTION_SNAPSHOT_SCHEMA) throw new Error("snapshot.schema is not amos.learning-selection-snapshot");
  if (candidate.version !== LEARNING_SELECTION_SNAPSHOT_VERSION) throw new Error("snapshot.version is unsupported");
  const rebuilt = createLearningSelectionSnapshot(candidate);
  if (rebuilt.procedureSnapshotSha256 !== candidate.procedureSnapshotSha256) throw new Error("snapshot.procedureSnapshotSha256 does not match its procedures");
  if (rebuilt.digest !== candidate.digest) throw new Error("snapshot.digest does not match its content");
  return rebuilt;
}

/** Empty snapshot: the valid "no procedures available" response. */
export function emptyLearningSelectionSnapshot(fields: Omit<LearningSelectionSnapshotInput, "procedures" | "tokenBound"> & { tokenBound?: number }): LearningSelectionSnapshot {
  return createLearningSelectionSnapshot({ ...fields, tokenBound: fields.tokenBound ?? 0, procedures: [] });
}

/**
 * Map a kernel strategy gene and its verified outcomes to a snapshot procedure.
 * Guidance is "avoid" only when every observed outcome was a verified failure;
 * genes with no verified outcome are not published (nothing to guide by).
 */
export function procedureFromStrategyGene(gene: StrategyGene, outcomes: readonly GeneOutcome[], { tenantScope = "any" as "any" | "tenant", tenantIds = [] as readonly string[], version = 1 } = {}): SnapshotProcedure | null {
  const verified = outcomes.filter((outcome) => outcome.verifierOutcome !== "uncredited");
  if (verified.length === 0) return null;
  const passes = verified.filter((outcome) => outcome.verifierOutcome === "pass");
  const failures = verified.filter((outcome) => outcome.verifierOutcome === "fail");
  const guidance: ProcedureGuidance = passes.length === 0 ? "avoid" : "guide";
  const content = { name: gene.name, procedure: gene.procedure, retrievalRecipe: gene.retrievalRecipe, stopConditions: gene.stopConditions, rolePolicy: gene.rolePolicy };
  const statement = boundedStatement(`${guidance === "avoid" ? "Avoid" : "Follow"} ${gene.name}: ${gene.procedure.join("; ")}${gene.stopConditions.length ? ` Stop when ${gene.stopConditions.join("; ")}.` : ""}`);
  return normalizeProcedure({
    id: gene.id,
    version,
    digest: gene.digest,
    guidance,
    applicability: {
      phases: gene.preconditions.phases,
      artifactClasses: gene.preconditions.artifactClasses,
      failureModes: gene.preconditions.failureModes,
      toolFamilies: gene.preconditions.toolFamilies,
      roles: Object.keys(gene.rolePolicy),
      tenantScope,
      tenantIds
    },
    statement,
    contentRef: `gene:${gene.id}@${gene.digest}`,
    tokens: Math.ceil((canonicalJson(content).length + statement.length) / 4),
    evidence: {
      verifiedPasses: passes.length,
      verifiedFailures: failures.length,
      uncreditedAttempts: outcomes.length - verified.length,
      meanVerifiedQuality: passes.length === 0 ? null : round(passes.reduce((sum, outcome) => sum + outcome.verifiedQuality, 0) / passes.length),
      lastVerifiedAt: null
    }
  });
}

function normalizeProcedure(procedure: SnapshotProcedure): SnapshotProcedure {
  if (!["guide", "avoid"].includes(procedure.guidance)) throw new Error(`procedure ${procedure.id} guidance must be guide or avoid`);
  if (!["any", "tenant"].includes(procedure.applicability?.tenantScope)) throw new Error(`procedure ${procedure.id} tenantScope must be any or tenant`);
  const tenantIds = uniqueSorted(procedure.applicability.tenantIds ?? [], "applicability.tenantIds", 0);
  if (procedure.applicability.tenantScope === "tenant" && tenantIds.length === 0) throw new Error(`procedure ${procedure.id} tenantScope "tenant" needs tenantIds`);
  if (procedure.applicability.tenantScope === "any" && tenantIds.length > 0) throw new Error(`procedure ${procedure.id} tenantScope "any" must not list tenantIds`);
  const statement = requireText(procedure.statement, "procedure.statement");
  if (statement.length > PROCEDURE_STATEMENT_MAX_CHARS) throw new Error(`procedure ${procedure.id} statement exceeds ${PROCEDURE_STATEMENT_MAX_CHARS} characters`);
  const evidence = procedure.evidence;
  return Object.freeze({
    id: requireId(procedure.id, "procedure.id"),
    version: positiveInteger(procedure.version, "procedure.version"),
    digest: requireSha(procedure.digest, "procedure.digest"),
    guidance: procedure.guidance,
    applicability: Object.freeze({
      phases: uniqueSorted(procedure.applicability.phases, "applicability.phases", 0),
      artifactClasses: uniqueSorted(procedure.applicability.artifactClasses, "applicability.artifactClasses", 0),
      failureModes: uniqueSorted(procedure.applicability.failureModes, "applicability.failureModes", 0),
      toolFamilies: uniqueSorted(procedure.applicability.toolFamilies, "applicability.toolFamilies", 0),
      roles: uniqueSorted(procedure.applicability.roles, "applicability.roles", 0),
      tenantScope: procedure.applicability.tenantScope,
      tenantIds
    }),
    statement,
    contentRef: requireText(procedure.contentRef, "procedure.contentRef"),
    tokens: nonNegativeInteger(procedure.tokens, "procedure.tokens"),
    evidence: Object.freeze({
      verifiedPasses: nonNegativeInteger(evidence?.verifiedPasses, "evidence.verifiedPasses"),
      verifiedFailures: nonNegativeInteger(evidence?.verifiedFailures, "evidence.verifiedFailures"),
      uncreditedAttempts: nonNegativeInteger(evidence?.uncreditedAttempts, "evidence.uncreditedAttempts"),
      meanVerifiedQuality: evidence?.meanVerifiedQuality === null ? null : unitInterval(evidence?.meanVerifiedQuality, "evidence.meanVerifiedQuality"),
      lastVerifiedAt: evidence?.lastVerifiedAt === null || evidence?.lastVerifiedAt === undefined ? null : isoDate(evidence.lastVerifiedAt, "evidence.lastVerifiedAt")
    })
  });
}

function normalizeRuntimes(runtimes: readonly CompatibleRuntime[]): readonly CompatibleRuntime[] {
  if (!Array.isArray(runtimes) || runtimes.length === 0) throw new Error("snapshot.compatibleRuntimes must list at least one runtime");
  return Object.freeze(runtimes.map((runtime) => Object.freeze({
    modelId: requireText(runtime.modelId, "runtime.modelId"),
    adapterArtifactSha256: runtime.adapterArtifactSha256 === null ? null : requireSha(runtime.adapterArtifactSha256, "runtime.adapterArtifactSha256"),
    runtimeRevision: requireText(runtime.runtimeRevision, "runtime.runtimeRevision")
  })).sort((left, right) => `${left.modelId}|${left.adapterArtifactSha256 ?? ""}`.localeCompare(`${right.modelId}|${right.adapterArtifactSha256 ?? ""}`)));
}

function boundedStatement(text: string): string { return text.length <= PROCEDURE_STATEMENT_MAX_CHARS ? text : `${text.slice(0, PROCEDURE_STATEMENT_MAX_CHARS - 1)}…`; }
function byId(left: SnapshotProcedure, right: SnapshotProcedure): number { return left.id < right.id ? -1 : left.id > right.id ? 1 : 0; }
function round(value: number): number { return Math.round(value * 1e6) / 1e6; }
function requireText(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`); return value.trim(); }
function requireId(value: unknown, label: string): string { const text = requireText(value, label); if (!ID.test(text)) throw new Error(`${label} is not a valid id`); return text; }
function requireSha(value: unknown, label: string): string { if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a SHA-256 hex digest`); return value; }
function isoDate(value: unknown, label: string): string { const date = value instanceof Date ? value : new Date(String(value)); if (Number.isNaN(date.getTime())) throw new Error(`${label} is not a valid date`); return date.toISOString(); }
function nonNegativeInteger(value: unknown, label: string): number { if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`); return value as number; }
function positiveInteger(value: unknown, label: string): number { if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive integer`); return value as number; }
function unitInterval(value: unknown, label: string): number { if (typeof value !== "number" || !(value >= 0 && value <= 1)) throw new Error(`${label} must be within 0..1`); return value; }
function uniqueSorted(values: unknown, label: string, minimum: number): readonly string[] {
  if (!Array.isArray(values) || values.length < minimum) throw new Error(`${label} must list at least ${minimum} item(s)`);
  return Object.freeze([...new Set(values.map((value) => requireText(value, label)))].sort());
}
