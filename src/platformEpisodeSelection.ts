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
