import {
  isPlatformMissionLearningEpisodeContract,
  type PlatformMissionLearningEpisodeContract,
} from "./contracts.ts";
import { digest, immutable } from "./digest.ts";
import type { EventStore, OrganismEvent, OrganismEventProposal } from "./eventStore.ts";
import type { HostGate, HostReceipt } from "./host.ts";
import { requireHostReceipt } from "./host.ts";

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
      },
    });
    return immutable({ classification, event });
  }
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
