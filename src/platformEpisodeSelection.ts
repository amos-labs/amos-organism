import type { OrganismEvent } from "./eventStore.ts";

/**
 * Runtime enforcement of the transport-validation episode exclusion.
 *
 * Some episode ids exist in the durable, append-only intake hash chain but must
 * NEVER count as real Platform Mission experience: receiver/transport validation
 * events (e.g. the on-host signed deployed-receiver proof). Per the coordination
 * decision (Codex 20260907T220353Z / 224803Z; Platform 20260907T500000Z) the
 * append-only entry is preserved and never purged, and every consumer excludes
 * these ids from real-Mission success counts, promotion evidence and training
 * exports. This module is the single source of that exclusion; the shadow-gate
 * ingestion adapter, consolidation and any export path filter through it.
 *
 * Source of truth for the id list: coordination/artifacts/transport-validation-episode-ids.json.
 */
export const TRANSPORT_VALIDATION_EPISODE_IDS: ReadonlySet<string> = new Set([
  // Deployed-receiver signed-transport proof, 2026-09-07 (synthetic test-consent fixture from
  // the aeae0d0 producer; classification negative, geneAdmissionAllowed false). Receipt:
  // coordination/artifacts/organism-deployed-receiver-proof-20260907.json.
  "platform-mission:7f80fdb1-a26d-41e8-95ac-451aeaa54e32:a10c9080-71f9-48e3-96b9-f6e2185332a0:completed:v1",
]);

export const PLATFORM_EXPERIENCE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "platform.experience-verified",
  "platform.experience-negative",
]);

/** True for an episode id registered as transport/receiver validation only. */
export function isTransportValidationEpisodeId(episodeId: string): boolean {
  return TRANSPORT_VALIDATION_EPISODE_IDS.has(episodeId);
}

function episodeIdOf(event: OrganismEvent): string | null {
  const id = (event.payload as { episodeId?: unknown } | undefined)?.episodeId;
  return typeof id === "string" ? id : null;
}

/**
 * True when the event is a real Platform Mission experience eligible for learning,
 * counts and export: it is a platform.experience-* event whose episode id is not on
 * the transport-validation exclusion list. Non-platform events are not eligible here.
 */
export function isLearningEligiblePlatformEpisode(event: OrganismEvent): boolean {
  if (!PLATFORM_EXPERIENCE_EVENT_TYPES.has(event.type)) return false;
  const episodeId = episodeIdOf(event);
  return episodeId !== null && !isTransportValidationEpisodeId(episodeId);
}

/**
 * Filter an event chain to the real Platform Mission experiences, excluding
 * transport-validation ids. Consumers (shadow-gate join, consolidation, export)
 * enumerate platform episodes through this so the exclusion is enforced in one place.
 */
export function realPlatformEpisodes(events: readonly OrganismEvent[]): OrganismEvent[] {
  return events.filter(isLearningEligiblePlatformEpisode);
}

/**
 * Credit classification of a real Platform Mission episode.
 *
 * - `creditable`   — a positive, learnable terminal outcome.
 * - `failed`       — a genuine terminal failure (a negative outcome).
 * - `unqualified`  — not usable as a credit signal in either direction.
 */
export type EpisodeCredit = "creditable" | "failed" | "unqualified";

/** The pinned schema of the signed terminal verification assessment (Platform PR #877). */
export const TERMINAL_ASSESSMENT_SCHEMA = "amos.platform-mission-terminal-assessment";
export const TERMINAL_ASSESSMENT_VERSION = 1;

interface TerminalAssessmentCounts {
  readonly fail?: unknown;
  readonly unknown?: unknown;
  readonly noEvidence?: unknown;
  readonly disqualified?: unknown;
}
interface TerminalAssessmentView {
  readonly schema?: unknown;
  readonly version?: unknown;
  readonly status?: unknown;
  readonly missionId?: unknown;
  readonly contractId?: unknown;
  readonly counts?: TerminalAssessmentCounts | undefined;
}
interface EpisodeSourceView {
  readonly missionId?: unknown;
  readonly contractId?: unknown;
  readonly verification?: { readonly terminalAssessment?: unknown } | undefined;
}

function sourceOf(event: OrganismEvent): EpisodeSourceView | null {
  const source = (event.payload as { source?: unknown } | undefined)?.source;
  return source !== null && typeof source === "object" ? (source as EpisodeSourceView) : null;
}

/** A nonempty string equal across all supplied values. */
function sameNonEmptyString(...values: unknown[]): boolean {
  const [first, ...rest] = values;
  if (typeof first !== "string" || first.length === 0) return false;
  return rest.every((value) => value === first);
}

/** A `complete` assessment is creditable only with a clean count profile (no residual non-pass). */
function isCleanComplete(counts: TerminalAssessmentCounts | undefined): boolean {
  if (counts === null || typeof counts !== "object") return false;
  for (const value of [counts.fail, counts.unknown, counts.noEvidence, counts.disqualified]) {
    if (!Number.isInteger(value) || (value as number) !== 0) return false;
  }
  return true;
}

/**
 * Bind learning credit to the signed terminal verification assessment
 * (`source.verification.terminalAssessment`, schema amos.platform-mission-terminal-assessment v1),
 * NOT to the episode's terminalStatus or event type. Per the producer/consumer contract in
 * docs/ORGANISM-LEARNING-HANDOFF.md and the shared fixture terminal-assessment-cases (Platform #877):
 *
 * - `creditable` ONLY when `status === "complete"` AND the count profile is clean (fail, unknown,
 *   noEvidence and disqualified are all 0 — extraneous results are allowed);
 * - `failed` ONLY when `status === "failed"` AND `counts.fail` is a positive integer (a qualifying
 *   policy fail; extraneous/disqualified never count);
 * - every other status (`pending`, `invalid_policy`, `unqualified`) and a MISSING assessment (legacy
 *   events, incl. the two delivered episodes) stay `unqualified`.
 *
 * Upstream intake validates the OUTER source identity but NOT the nested assessment ids, so this
 * enforces them here: the assessment must carry the pinned schema/version and its missionId/contractId
 * must be nonempty and equal to the event's and source's mission/contract. Contradictions are never a
 * model-negative: a `complete` with residual non-pass counts, a `failed` without a qualifying fail, a
 * malformed count, or a mismatched id all resolve to `unqualified` (fail safe, never spurious blame).
 * This function derives credit and never mutates the event.
 */
export function classifyEpisodeCredit(event: OrganismEvent): EpisodeCredit {
  if (!isLearningEligiblePlatformEpisode(event)) return "unqualified";
  const source = sourceOf(event);
  const assessment = source?.verification?.terminalAssessment;
  if (assessment === null || typeof assessment !== "object") return "unqualified";
  const view = assessment as TerminalAssessmentView;
  // The assessment must carry the pinned schema/version (a real signed episode always does).
  if (view.schema !== TERMINAL_ASSESSMENT_SCHEMA || view.version !== TERMINAL_ASSESSMENT_VERSION) return "unqualified";
  // The nested mission/contract must be nonempty and match the event's and source's outer identity.
  if (!sameNonEmptyString(view.missionId, event.missionId, source?.missionId)) return "unqualified";
  if (!sameNonEmptyString(view.contractId, source?.contractId)) return "unqualified";
  if (view.status === "complete") return isCleanComplete(view.counts) ? "creditable" : "unqualified";
  if (view.status === "failed") {
    const fail = view.counts?.fail;
    return Number.isInteger(fail) && (fail as number) > 0 ? "failed" : "unqualified";
  }
  return "unqualified";
}

/** The real episodes whose terminal assessment binds a positive, creditable learning signal. */
export function creditableEpisodes(events: readonly OrganismEvent[]): OrganismEvent[] {
  return events.filter((event) => classifyEpisodeCredit(event) === "creditable");
}
