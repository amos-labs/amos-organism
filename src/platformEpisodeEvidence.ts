/**
 * Consumer-side validation of the additive Platform host-evidence block.
 *
 * Per the compatibility decision (Codex 20260907T174205Z): the Platform carries
 * mission host-evidence in a versioned block at `source.evidence` INSIDE the
 * unchanged, signed amos.platform-mission-learning-episode v1 envelope. The
 * outer schemaVersion stays 1 (contracts.ts rejects any other value), so this
 * validator sits below the signature/source-digest layer already enforced by
 * the receiver and intake, and adds structural validation of the nested block.
 *
 * Wire shape (Codex 20260907T183822Z reproducer):
 *  - recoveryEvidence coverage vocabulary is the comparator's complete|partial|
 *    unknown; counts are null unless coverage is complete, and complete requires
 *    non-empty host evidenceRefs (never invented ids or a zero from missing
 *    instrumentation).
 *  - acceptedAttemptBindings is the EXISTING get_mission/manifest list whose
 *    entries use snake_case planner_attempt/step_position/claim_id/receipt_id;
 *    checkpoint entries carry no status. Absent attempt/claim/receipt/status
 *    stay null; camelCase is tolerated and normalized.
 *  - attemptIdentities uses the camelCase envelope; plannerAttempt is nullable
 *    for uninstrumented legacy steps. The five identity digests are lowercase
 *    hex when present. This consumer never infers a treatment digest or any
 *    identity; absent fields stay null.
 *
 * A legacy episode with no `source.evidence` is valid (present:false, unknowns).
 * A present-but-malformed block is rejected, so Platform emission is gated on a
 * receiver that actually validates it.
 */

export const PLATFORM_MISSION_EVIDENCE_SCHEMA = "amos.platform-mission-evidence" as const;
export const PLATFORM_MISSION_EVIDENCE_VERSION = 1 as const;

export type RecoveryCoverage = "complete" | "partial" | "unknown";

/** Recovery evidence normalized to Codex's comparator v1 boundary. Counts are null unless coverage is complete. */
export interface RecoveryEvidenceV1 {
  readonly version: 1;
  readonly coverage: RecoveryCoverage;
  readonly unexpectedCorrections: number | null;
  readonly requiredRecoveries: number | null;
  readonly evidenceRefs: readonly string[];
}

/** One accepted attempt→step binding, keyed by (plannerAttempt, stepPosition). Unknown attempt/claim/receipt/status stay null. */
export interface AcceptedAttemptBinding {
  readonly kind: string;
  readonly plannerAttempt: number | null;
  readonly stepPosition: number;
  readonly claimId: string | null;
  readonly receiptId: string | null;
  readonly status: string | null;
}

/** One planner-step identity. plannerAttempt is null for uninstrumented steps; the five digests are copied verbatim from the retained gateway block, null when absent. */
export interface AttemptIdentity {
  readonly plannerAttempt: number | null;
  readonly stepPosition: number;
  readonly kind: string;
  readonly failureClass: string | null;
  readonly traceDigest: string | null;
  readonly requestDigest: string | null;
  readonly compiledInputSha256: string | null;
  readonly requestPayloadSha256: string | null;
  readonly treatmentSha256: string | null;
}

export interface NormalizedEpisodeEvidence {
  readonly present: boolean;
  readonly recoveryEvidence: RecoveryEvidenceV1 | null;
  readonly acceptedAttemptBindings: readonly AcceptedAttemptBinding[];
  readonly attemptIdentities: readonly AttemptIdentity[];
}

export class PlatformEpisodeEvidenceInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformEpisodeEvidenceInvalid";
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const HEX_64 = /^[0-9a-f]{64}$/;

function pick(raw: Record<string, unknown>, camel: string, snake: string): unknown {
  return raw[camel] !== undefined ? raw[camel] : raw[snake];
}

function requireIntOrNull(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new PlatformEpisodeEvidenceInvalid(`${field} must be a non-negative integer or null`);
  }
  return value;
}

function requireInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new PlatformEpisodeEvidenceInvalid(`${field} must be a non-negative integer`);
  }
  return value;
}

function requireStringOrNull(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new PlatformEpisodeEvidenceInvalid(`${field} must be a string or null`);
  return value;
}

function requireHexOrNull(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !HEX_64.test(value)) {
    throw new PlatformEpisodeEvidenceInvalid(`${field} must be a lowercase 64-char hex sha-256 or null`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PlatformEpisodeEvidenceInvalid(`${field} must be a non-empty string`);
  }
  return value;
}

function normalizeRecovery(raw: unknown): RecoveryEvidenceV1 {
  if (!isObject(raw)) throw new PlatformEpisodeEvidenceInvalid("recoveryEvidence must be an object");
  if (raw.version !== PLATFORM_MISSION_EVIDENCE_VERSION) {
    throw new PlatformEpisodeEvidenceInvalid("recoveryEvidence.version must be 1");
  }
  const coverage = raw.coverage;
  if (coverage !== "complete" && coverage !== "partial" && coverage !== "unknown") {
    throw new PlatformEpisodeEvidenceInvalid("recoveryEvidence.coverage must be complete|partial|unknown");
  }
  if (!Array.isArray(raw.evidenceRefs) || raw.evidenceRefs.some((r) => typeof r !== "string")) {
    throw new PlatformEpisodeEvidenceInvalid("recoveryEvidence.evidenceRefs must be an array of strings");
  }
  const unexpectedCorrections = requireIntOrNull(raw.unexpectedCorrections, "recoveryEvidence.unexpectedCorrections");
  const requiredRecoveries = requireIntOrNull(raw.requiredRecoveries, "recoveryEvidence.requiredRecoveries");
  const refs = raw.evidenceRefs as string[];
  if (coverage === "complete") {
    // Complete must carry actual host references and real counts, matching the comparator.
    if (refs.length === 0) throw new PlatformEpisodeEvidenceInvalid("complete coverage requires non-empty evidenceRefs");
    if (unexpectedCorrections === null || requiredRecoveries === null) {
      throw new PlatformEpisodeEvidenceInvalid("complete coverage requires non-null recovery counts");
    }
  } else if (unexpectedCorrections !== null || requiredRecoveries !== null) {
    // partial|unknown: counts are not trusted and must be null.
    throw new PlatformEpisodeEvidenceInvalid("recovery counts must be null unless coverage is complete");
  }
  return Object.freeze({
    version: PLATFORM_MISSION_EVIDENCE_VERSION,
    coverage,
    unexpectedCorrections,
    requiredRecoveries,
    evidenceRefs: Object.freeze([...refs]),
  });
}

function normalizeBinding(raw: unknown, i: number): AcceptedAttemptBinding {
  if (!isObject(raw)) throw new PlatformEpisodeEvidenceInvalid(`acceptedAttemptBindings[${i}] must be an object`);
  return Object.freeze({
    kind: requireString(raw.kind, `acceptedAttemptBindings[${i}].kind`),
    plannerAttempt: requireIntOrNull(pick(raw, "plannerAttempt", "planner_attempt"), `acceptedAttemptBindings[${i}].planner_attempt`),
    stepPosition: requireInt(pick(raw, "stepPosition", "step_position"), `acceptedAttemptBindings[${i}].step_position`),
    claimId: requireStringOrNull(pick(raw, "claimId", "claim_id"), `acceptedAttemptBindings[${i}].claim_id`),
    receiptId: requireStringOrNull(pick(raw, "receiptId", "receipt_id"), `acceptedAttemptBindings[${i}].receipt_id`),
    status: requireStringOrNull(raw.status, `acceptedAttemptBindings[${i}].status`),
  });
}

function normalizeIdentity(raw: unknown, i: number): AttemptIdentity {
  if (!isObject(raw)) throw new PlatformEpisodeEvidenceInvalid(`attemptIdentities[${i}] must be an object`);
  return Object.freeze({
    plannerAttempt: requireIntOrNull(pick(raw, "plannerAttempt", "planner_attempt"), `attemptIdentities[${i}].plannerAttempt`),
    stepPosition: requireInt(pick(raw, "stepPosition", "step_position"), `attemptIdentities[${i}].stepPosition`),
    kind: requireString(raw.kind, `attemptIdentities[${i}].kind`),
    failureClass: requireStringOrNull(raw.failureClass, `attemptIdentities[${i}].failureClass`),
    traceDigest: requireHexOrNull(raw.traceDigest, `attemptIdentities[${i}].traceDigest`),
    requestDigest: requireHexOrNull(raw.requestDigest, `attemptIdentities[${i}].requestDigest`),
    compiledInputSha256: requireHexOrNull(raw.compiledInputSha256, `attemptIdentities[${i}].compiledInputSha256`),
    requestPayloadSha256: requireHexOrNull(raw.requestPayloadSha256, `attemptIdentities[${i}].requestPayloadSha256`),
    treatmentSha256: requireHexOrNull(raw.treatmentSha256, `attemptIdentities[${i}].treatmentSha256`),
  });
}

const ABSENT: NormalizedEpisodeEvidence = Object.freeze({
  present: false,
  recoveryEvidence: null,
  acceptedAttemptBindings: Object.freeze([]),
  attemptIdentities: Object.freeze([]),
});

/** Stable join key for the shadow-gate adapter: (plannerAttempt, stepPosition); unknown attempt renders as "null". */
export function attemptBindingKey(b: Pick<AcceptedAttemptBinding, "plannerAttempt" | "stepPosition">): string {
  return `${b.plannerAttempt === null ? "null" : b.plannerAttempt}:${b.stepPosition}`;
}

/**
 * Validate and normalize `source.evidence`. Returns the legacy-absent view when
 * the block is missing; throws PlatformEpisodeEvidenceInvalid when a present
 * block is malformed. Never infers identity — absent fields are reported null.
 */
export function validateMissionEvidence(source: Readonly<Record<string, unknown>>): NormalizedEpisodeEvidence {
  const raw = source.evidence;
  if (raw === undefined || raw === null) return ABSENT;
  if (!isObject(raw)) throw new PlatformEpisodeEvidenceInvalid("source.evidence must be an object when present");
  if (raw.schema !== PLATFORM_MISSION_EVIDENCE_SCHEMA) {
    throw new PlatformEpisodeEvidenceInvalid(`source.evidence.schema must be ${PLATFORM_MISSION_EVIDENCE_SCHEMA}`);
  }
  if (raw.version !== PLATFORM_MISSION_EVIDENCE_VERSION) {
    throw new PlatformEpisodeEvidenceInvalid("source.evidence.version must be 1");
  }
  const recoveryEvidence = raw.recoveryEvidence === undefined || raw.recoveryEvidence === null
    ? null
    : normalizeRecovery(raw.recoveryEvidence);
  const bindingsRaw = raw.acceptedAttemptBindings ?? [];
  if (!Array.isArray(bindingsRaw)) throw new PlatformEpisodeEvidenceInvalid("acceptedAttemptBindings must be an array");
  const identitiesRaw = raw.attemptIdentities ?? [];
  if (!Array.isArray(identitiesRaw)) throw new PlatformEpisodeEvidenceInvalid("attemptIdentities must be an array");
  return Object.freeze({
    present: true,
    recoveryEvidence,
    acceptedAttemptBindings: Object.freeze(bindingsRaw.map(normalizeBinding)),
    attemptIdentities: Object.freeze(identitiesRaw.map(normalizeIdentity)),
  });
}
