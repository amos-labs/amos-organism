import { digest, immutable } from "./digest.ts";
import type { EventStore, OrganismEvent } from "./eventStore.ts";
import type { HostGate, HostReceipt } from "./host.ts";
import { requireHostReceipt } from "./host.ts";

export interface ObjectiveCandidateEvidence {
  readonly qualityVector: readonly number[];
  readonly protectedMilestones: Readonly<Record<string, boolean>>;
  readonly failureBoundaryPresent: boolean;
  readonly failedCheckCount: number;
  readonly failedCheckIds: readonly string[];
  readonly artifactReceiptIds: readonly string[];
  readonly testReceiptIds: readonly string[];
}

export interface MutationTransportReceipt {
  readonly sourceDigest: string;
  readonly resultDigest: string;
  readonly bounded: boolean;
  readonly atomic: boolean;
  readonly syntaxValid: boolean;
  readonly interfaceValid: boolean;
}

export interface CandidateVersion {
  readonly id: string;
  readonly missionId: string;
  readonly candidateDigest: string;
  readonly parentId: string | null;
  readonly evidence: ObjectiveCandidateEvidence;
  readonly transport: MutationTransportReceipt | null;
  readonly evaluatedByReceiptId: string;
  readonly createdAt: string;
}

export interface CandidateSelection {
  readonly id: string;
  readonly missionId: string;
  readonly incumbentBeforeId: string;
  readonly mutationId: string;
  readonly incumbentAfterId: string;
  readonly promoted: boolean;
  readonly reason:
    | "objective-evidence-improved"
    | "objective-evidence-regression"
    | "no-objective-evidence-improvement"
    | "invalid-mutation-transport";
  readonly receiptId: string;
}

function normalizeEvidence(source: ObjectiveCandidateEvidence): ObjectiveCandidateEvidence {
  if (source.qualityVector.length === 0 || !source.qualityVector.every(Number.isFinite)) {
    throw new Error("Candidate evidence requires a finite, non-empty quality vector");
  }
  if (!Number.isInteger(source.failedCheckCount) || source.failedCheckCount < 0) {
    throw new Error("Candidate failed-check count must be a non-negative integer");
  }
  return immutable({
    qualityVector: [...source.qualityVector],
    protectedMilestones: Object.fromEntries(
      Object.entries(source.protectedMilestones)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => [name, value === true]),
    ),
    failureBoundaryPresent: source.failureBoundaryPresent === true,
    failedCheckCount: source.failedCheckCount,
    failedCheckIds: [...new Set(source.failedCheckIds)].sort(),
    artifactReceiptIds: [...new Set(source.artifactReceiptIds)].sort(),
    testReceiptIds: [...new Set(source.testReceiptIds)].sort(),
  });
}

/**
 * Host-selected candidate lineage. Model workers may propose mutations, but a
 * failed or weaker branch can never replace the current incumbent.
 */
export class CandidateEvolutionArchive {
  readonly #gate: HostGate;
  readonly #versions = new Map<string, CandidateVersion>();
  readonly #selections: CandidateSelection[] = [];
  readonly #incumbentByMission = new Map<string, string>();
  readonly #eventStore: EventStore | null;

  constructor(
    gate: HostGate,
    eventStore: EventStore | null = null,
    replayEvents: readonly OrganismEvent[] = [],
  ) {
    this.#gate = gate;
    this.#eventStore = eventStore;
    this.replay(replayEvents);
  }

  initialize(
    missionId: string,
    candidateDigest: string,
    evidenceInput: ObjectiveCandidateEvidence,
    receipt: HostReceipt,
  ): CandidateVersion {
    requireHostReceipt(this.#gate, receipt, ["candidate-evaluated"], missionId);
    if (this.#incumbentByMission.has(missionId)) {
      throw new Error(`Mission ${missionId} already has an incumbent`);
    }
    const evidence = normalizeEvidence(evidenceInput);
    const version = this.#version({
      missionId,
      candidateDigest,
      parentId: null,
      evidence,
      transport: null,
      receipt,
    });
    this.#incumbentByMission.set(missionId, version.id);
    this.#eventStore?.append({
      id: `candidate:initialized:${version.id}`,
      type: "candidate.initialized",
      missionId,
      occurredAt: receipt.issuedAt,
      authority: "host",
      hostReceiptId: receipt.id,
      payload: { version, incumbentId: version.id },
    });
    return version;
  }

  consider(
    missionId: string,
    candidateDigest: string,
    evidenceInput: ObjectiveCandidateEvidence,
    transport: MutationTransportReceipt,
    receipt: HostReceipt,
  ): CandidateSelection {
    requireHostReceipt(this.#gate, receipt, ["candidate-evaluated"], missionId);
    const incumbent = this.incumbent(missionId);
    const evidence = normalizeEvidence(evidenceInput);
    const mutation = this.#version({
      missionId,
      candidateDigest,
      parentId: incumbent.id,
      evidence,
      transport,
      receipt,
    });
    let promoted = false;
    let reason: CandidateSelection["reason"];
    if (!validTransport(transport, incumbent.candidateDigest, candidateDigest)) {
      reason = "invalid-mutation-transport";
    } else if (regressed(incumbent.evidence, evidence)) {
      reason = "objective-evidence-regression";
    } else if (compareVector(evidence.qualityVector, incumbent.evidence.qualityVector) > 0) {
      promoted = true;
      reason = "objective-evidence-improved";
      this.#incumbentByMission.set(missionId, mutation.id);
    } else {
      reason = "no-objective-evidence-improvement";
    }
    const body = {
      missionId,
      incumbentBeforeId: incumbent.id,
      mutationId: mutation.id,
      incumbentAfterId: promoted ? mutation.id : incumbent.id,
      promoted,
      reason,
      receiptId: receipt.id,
    };
    const selection = immutable({ id: `selection_${digest(body).slice(0, 24)}`, ...body });
    this.#selections.push(selection);
    this.#eventStore?.append({
      id: `candidate:evaluated:${selection.id}`,
      type: "candidate.evaluated",
      missionId,
      occurredAt: receipt.issuedAt,
      authority: "host",
      hostReceiptId: receipt.id,
      payload: { mutation, selection },
    });
    return selection;
  }

  incumbent(missionId: string): CandidateVersion {
    const id = this.#incumbentByMission.get(missionId);
    if (!id) throw new Error(`Mission ${missionId} has no incumbent`);
    const version = this.#versions.get(id);
    if (!version) throw new Error(`Missing incumbent candidate ${id}`);
    return version;
  }

  versions(missionId?: string): readonly CandidateVersion[] {
    return immutable([...this.#versions.values()].filter(
      (version) => missionId === undefined || version.missionId === missionId,
    ));
  }

  selections(missionId?: string): readonly CandidateSelection[] {
    return immutable(this.#selections.filter(
      (selection) => missionId === undefined || selection.missionId === missionId,
    ));
  }

  replay(events: readonly OrganismEvent[]): void {
    this.#versions.clear();
    this.#selections.length = 0;
    this.#incumbentByMission.clear();
    for (const event of events) {
      if (event.authority !== "host") continue;
      if (event.type === "candidate.initialized") {
        const version = event.payload.version;
        if (!isCandidateVersion(version) || version.parentId !== null) continue;
        this.#restoreVersion(version);
        this.#incumbentByMission.set(version.missionId, version.id);
      } else if (event.type === "candidate.evaluated") {
        const mutation = event.payload.mutation;
        const selection = event.payload.selection;
        if (!isCandidateVersion(mutation) || !isCandidateSelection(selection)) continue;
        this.#restoreVersion(mutation);
        this.#restoreSelection(selection, mutation);
      }
    }
  }

  #version(input: {
    missionId: string;
    candidateDigest: string;
    parentId: string | null;
    evidence: ObjectiveCandidateEvidence;
    transport: MutationTransportReceipt | null;
    receipt: HostReceipt;
  }): CandidateVersion {
    if (!/^[a-f0-9]{64}$/.test(input.candidateDigest)) {
      throw new Error("Candidate digest must be a lowercase SHA-256");
    }
    const body = {
      missionId: input.missionId,
      candidateDigest: input.candidateDigest,
      parentId: input.parentId,
      evidence: input.evidence,
      transport: input.transport,
      evaluatedByReceiptId: input.receipt.id,
      createdAt: input.receipt.issuedAt,
    };
    const version = immutable({ id: `candidate_${digest(body).slice(0, 24)}`, ...body });
    this.#versions.set(version.id, version);
    return version;
  }

  #restoreVersion(version: CandidateVersion): void {
    const { id: _id, ...body } = version;
    const expectedId = `candidate_${digest(body).slice(0, 24)}`;
    if (version.id !== expectedId) {
      throw new Error(`Invalid replayed candidate version: ${version.id}`);
    }
    if (version.parentId !== null && !this.#versions.has(version.parentId)) {
      throw new Error(`Missing replayed candidate parent: ${version.parentId}`);
    }
    this.#versions.set(version.id, immutable(version));
  }

  #restoreSelection(selection: CandidateSelection, mutation: CandidateVersion): void {
    const { id: _id, ...body } = selection;
    const expectedId = `selection_${digest(body).slice(0, 24)}`;
    if (
      selection.id !== expectedId
      || selection.mutationId !== mutation.id
      || selection.missionId !== mutation.missionId
      || !this.#versions.has(selection.incumbentBeforeId)
      || !this.#versions.has(selection.incumbentAfterId)
    ) {
      throw new Error(`Invalid replayed candidate selection: ${selection.id}`);
    }
    this.#selections.push(immutable(selection));
    this.#incumbentByMission.set(selection.missionId, selection.incumbentAfterId);
  }
}

function isCandidateVersion(value: unknown): value is CandidateVersion {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const version = value as Partial<CandidateVersion>;
  return typeof version.id === "string"
    && typeof version.missionId === "string"
    && typeof version.candidateDigest === "string"
    && (version.parentId === null || typeof version.parentId === "string")
    && typeof version.evidence === "object"
    && typeof version.evaluatedByReceiptId === "string"
    && typeof version.createdAt === "string";
}

function isCandidateSelection(value: unknown): value is CandidateSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const selection = value as Partial<CandidateSelection>;
  return typeof selection.id === "string"
    && typeof selection.missionId === "string"
    && typeof selection.incumbentBeforeId === "string"
    && typeof selection.mutationId === "string"
    && typeof selection.incumbentAfterId === "string"
    && typeof selection.promoted === "boolean"
    && typeof selection.reason === "string"
    && typeof selection.receiptId === "string";
}

function validTransport(
  receipt: MutationTransportReceipt,
  sourceDigest: string,
  resultDigest: string,
): boolean {
  return receipt.sourceDigest === sourceDigest
    && receipt.resultDigest === resultDigest
    && receipt.bounded
    && receipt.atomic
    && receipt.syntaxValid
    && receipt.interfaceValid;
}

function regressed(
  incumbent: ObjectiveCandidateEvidence,
  mutation: ObjectiveCandidateEvidence,
): boolean {
  for (const [name, attained] of Object.entries(incumbent.protectedMilestones)) {
    if (attained && mutation.protectedMilestones[name] !== true) return true;
  }
  return incumbent.failureBoundaryPresent
    && mutation.failureBoundaryPresent
    && mutation.failedCheckCount > incumbent.failedCheckCount;
}

function compareVector(left: readonly number[], right: readonly number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? Number.NEGATIVE_INFINITY)
      - (right[index] ?? Number.NEGATIVE_INFINITY);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}
