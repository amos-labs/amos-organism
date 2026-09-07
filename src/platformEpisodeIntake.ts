import {
  isPlatformMissionLearningEpisodeContract,
  type PlatformMissionLearningEpisodeContract,
  isPlatformLearningContentManifestContract,
  type PlatformLearningContentManifestContract,
} from "./contracts.ts";
import { digest, immutable } from "./digest.ts";
import type { EventStore, OrganismEvent, OrganismEventProposal } from "./eventStore.ts";
import type { HostGate, HostReceipt } from "./host.ts";
import { requireHostReceipt } from "./host.ts";
import { validateMissionEvidence } from "./platformEpisodeEvidence.ts";

export interface PlatformEpisodeIntakeResult {
  readonly classification: "verified" | "negative";
  readonly event: OrganismEvent;
}

/**
 * Canonical intake after the transport layer has verified the Platform KMS
 * signature and minted a host receipt. Transport authentication is necessary
 * but not sufficient: this boundary also verifies the source digest, outer/
 * inner identity, consent/rights contract, and deterministic event identity.
 */
export class PlatformEpisodeIntake {
  readonly #gate: HostGate;
  readonly #store: EventStore;

  constructor(gate: HostGate, store: EventStore) {
    this.#gate = gate;
    this.#store = store;
  }

  ingest(
    episode: PlatformMissionLearningEpisodeContract,
    receipt: HostReceipt,
  ): PlatformEpisodeIntakeResult {
    if (!isPlatformMissionLearningEpisodeContract(episode)) {
      throw new TypeError("Invalid Platform Mission learning episode contract");
    }
    requireHostReceipt(
      this.#gate,
      receipt,
      ["platform-episode-attested"],
      episode.missionId,
    );
    if (receipt.payloadDigest !== digest(episode)) {
      throw new Error("Platform episode bytes do not match the host receipt");
    }
    if (digest(episode.source) !== episode.sourceEpisodeDigest) {
      throw new Error("Platform episode source digest mismatch");
    }
    requireMatchingSourceIdentity(episode);

    // Consumer-side validation of the additive host-evidence block. A present-but-malformed
    // block is rejected here, so Platform emission is gated on a receiver that validates it;
    // a legacy episode with no source.evidence yields present:false and is accepted unchanged.
    const evidence = validateMissionEvidence(episode.source);

    const classification = episode.terminalStatus === "completed" && allChecksPassed(episode.source)
      ? "verified" as const
      : "negative" as const;
    const event = appendIdempotent(this.#store, {
      id: `platform-episode:${episode.episodeId}`,
      type: classification === "verified"
        ? "platform.experience-verified"
        : "platform.experience-negative",
      missionId: episode.missionId,
      occurredAt: receipt.issuedAt,
      authority: "host",
      hostReceiptId: receipt.id,
      payload: {
        episodeId: episode.episodeId,
        terminalStatus: episode.terminalStatus,
        sourceEpisodeDigest: episode.sourceEpisodeDigest,
        rightsTags: [...episode.rightsTags].sort(),
        consentReceiptId: episode.consentReceiptId,
        source: episode.source,
        geneAdmissionAllowed: false,
        evidencePresent: evidence.present,
        evidence,
      },
    });
    return immutable({ classification, event });
  }
}

export interface PlatformContentManifestIntakeResult {
  readonly event: OrganismEvent;
  readonly episodeKnown: boolean;
  readonly items: number;
  readonly completeItems: number;
  readonly holdoutItems: number;
}

/**
 * Record a signed content manifest as a host event keyed by its episode id.
 * Only references and digests are stored; no content. The episode may arrive
 * after the manifest (delivery order is not guaranteed), so episodeKnown is a
 * fact about this store at receipt time, not a precondition. Eligibility for
 * training is decided later by the dataset compiler, never here.
 */
export function ingestPlatformContentManifest(
  gate: HostGate,
  store: EventStore,
  manifest: PlatformLearningContentManifestContract,
  receipt: HostReceipt,
): PlatformContentManifestIntakeResult {
  if (!isPlatformLearningContentManifestContract(manifest)) {
    throw new TypeError("Invalid Platform learning content manifest contract");
  }
  requireHostReceipt(gate, receipt, ["platform-content-manifest-attested"], manifest.missionId);
  if (receipt.payloadDigest !== digest(manifest)) {
    throw new Error("Platform content manifest bytes do not match the host receipt");
  }
  const { contentSha256: _declared, ...body } = manifest;
  if (digest(body) !== manifest.contentSha256) {
    throw new Error("Platform content manifest contentSha256 does not match its body");
  }
  const episodeKnown = store.get(`platform-episode:${manifest.episodeId}`) !== undefined;
  const holdout = new Set(manifest.evaluationExclusion);
  const event = appendIdempotent(store, {
    id: `platform-content-manifest:${manifest.episodeId}`,
    type: "platform.content-manifest-received",
    missionId: manifest.missionId,
    occurredAt: receipt.issuedAt,
    authority: "host",
    hostReceiptId: receipt.id,
    payload: {
      episodeId: manifest.episodeId,
      tenantId: manifest.tenantId,
      manifestVersion: manifest.manifestVersion,
      contentSha256: manifest.contentSha256,
      redactionPolicyVersion: manifest.redactionPolicyVersion,
      grantReceiptRef: manifest.grantReceiptRef,
      rightsTags: [...manifest.rightsTags].sort(),
      items: manifest.items.map((item) => ({ ...item, holdout: holdout.has(item.ref) })),
      omitted: manifest.omitted,
      acceptedAttemptBindings: manifest.acceptedAttemptBindings,
      evaluationExclusion: [...manifest.evaluationExclusion].sort(),
      episodeKnownAtReceipt: episodeKnown,
      trainingEligibilityDecided: false,
    },
  });
  return immutable({
    event,
    episodeKnown,
    items: manifest.items.length,
    completeItems: manifest.items.filter((item) => item.completeness === "complete").length,
    holdoutItems: manifest.items.filter((item) => holdout.has(item.ref)).length,
  });
}

function requireMatchingSourceIdentity(episode: PlatformMissionLearningEpisodeContract): void {
  const source = episode.source;
  if (
    source.episodeId !== episode.episodeId
    || source.tenantId !== episode.tenantId
    || source.missionId !== episode.missionId
    || source.terminalStatus !== episode.terminalStatus
  ) {
    throw new Error("Platform episode source identity does not match its envelope");
  }
}

function allChecksPassed(source: Readonly<Record<string, unknown>>): boolean {
  if (Array.isArray(source.verification)) {
    return source.verification.length > 0 && source.verification.every((result) => (
      !!result
      && typeof result === "object"
      && !Array.isArray(result)
      && (result as Record<string, unknown>).verdict === "pass"
    ));
  }
  if (!source.verification || typeof source.verification !== "object") return false;
  const summary = source.verification as Record<string, unknown>;
  const totalCount = Number(summary.totalCount ?? 0);
  const passedCount = Number(summary.passedCount ?? 0);
  const failedCount = Number(summary.failedCount ?? 0);
  return Number.isSafeInteger(totalCount)
    && totalCount > 0
    && passedCount === totalCount
    && failedCount === 0
    && summary.allPassed === true
    && typeof summary.fullTraceDigest === "string";
}

function appendIdempotent(store: EventStore, proposal: OrganismEventProposal): OrganismEvent {
  const existing = store.get(proposal.id);
  if (existing === undefined) return store.append(proposal);
  if (
    existing.type !== proposal.type
    || existing.missionId !== proposal.missionId
    || existing.authority !== proposal.authority
    || digest(existing.payload) !== digest(proposal.payload)
  ) {
    throw new Error(`Conflicting organism event retry: ${proposal.id}`);
  }
  return existing;
}
