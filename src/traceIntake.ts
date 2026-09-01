import { digest, immutable } from "./digest.ts";
import type { EventStore, OrganismEvent, OrganismEventProposal } from "./eventStore.ts";
import type { HostGate, HostReceipt } from "./host.ts";
import { requireHostReceipt } from "./host.ts";
import {
  ORGANISM_CONTRACT_VERSION,
  STRATEGY_GENE_CANDIDATE_SCHEMA,
  type StrategyGeneCandidateContract,
} from "./contracts.ts";
import {
  StrategyGeneArchive,
  type StrategyGene,
  type StrategyGeneSpec,
} from "./strategyGenes.ts";

export interface TraceEligibility {
  readonly eligible: boolean;
  readonly reasons: readonly string[];
}

export interface TraceVerifierResult {
  readonly status: "pass" | "fail";
  readonly evidenceRefs: readonly string[];
}

export interface HostObservedProcedure {
  readonly spec: StrategyGeneSpec;
  readonly parentIds: readonly string[];
  readonly evidenceRefs: readonly string[];
}

export interface AmosAwsTrace {
  readonly runId: string;
  readonly trialId: string;
  readonly taskName: string;
  readonly taskFamily: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly outcome: {
    readonly kind:
      | "verified-success"
      | "verified-failure"
      | "execution-error"
      | "cancelled"
      | "unverified";
    readonly score: number | null;
  };
  readonly trainingEligibility: TraceEligibility;
  readonly verifier: TraceVerifierResult | null;
  readonly artifactReceiptIds: readonly string[];
  readonly expressedGeneIds?: readonly string[];
  readonly geneExpressionReceiptIds?: readonly string[];
  readonly procedure: HostObservedProcedure | null;
  readonly exception?: Readonly<{
    type: string;
    message: string;
  }>;
  readonly rightsTags: readonly string[];
  readonly contaminationTags: readonly string[];
  readonly sourceEpisodeDigest?: string;
}

export type GeneCandidate = StrategyGeneCandidateContract;

export interface TraceIntakeResult {
  readonly classification: "verified" | "negative";
  readonly geneCandidate: GeneCandidate | null;
  readonly events: readonly OrganismEvent[];
}

/** Converts AMOS/AWS traces into persistent experience without self-grading. */
export class TraceIntake {
  readonly #gate: HostGate;
  readonly #store: EventStore;
  readonly #genes: StrategyGeneArchive;

  constructor(gate: HostGate, store: EventStore, genes: StrategyGeneArchive) {
    this.#gate = gate;
    this.#store = store;
    this.#genes = genes;
  }

  ingest(trace: AmosAwsTrace, receipt: HostReceipt): TraceIntakeResult {
    requireHostReceipt(this.#gate, receipt, ["trace-imported"], trace.runId);
    const appended: OrganismEvent[] = [];
    const traceDigest = digest(trace);
    appended.push(appendIdempotent(this.#store, {
      id: `trace:${trace.runId}:${trace.trialId}`,
      type: "trace.imported",
      missionId: trace.runId,
      occurredAt: receipt.issuedAt,
      authority: "host",
      hostReceiptId: receipt.id,
      payload: { traceDigest, taskName: trace.taskName, taskFamily: trace.taskFamily },
    }));

    const reasons = negativeReasons(trace);
    if (reasons.length > 0) {
      appended.push(appendIdempotent(this.#store, {
        id: `experience:negative:${trace.runId}:${trace.trialId}`,
        type: "experience.negative",
        missionId: trace.runId,
        occurredAt: trace.finishedAt,
        authority: "host",
        hostReceiptId: receipt.id,
        payload: {
          traceDigest,
          outcome: trace.outcome.kind,
          reasons,
          exception: trace.exception ?? null,
          fitnessVested: 0,
          expressedGeneIds: [...new Set(trace.expressedGeneIds ?? [])].sort(),
          geneExpressionReceiptIds: [...new Set(trace.geneExpressionReceiptIds ?? [])].sort(),
          geneAdmissionAllowed: false,
        },
      }));
      return immutable({ classification: "negative", geneCandidate: null, events: appended });
    }

    appended.push(appendIdempotent(this.#store, {
      id: `experience:verified:${trace.runId}:${trace.trialId}`,
      type: "experience.verified",
      missionId: trace.runId,
      occurredAt: trace.finishedAt,
      authority: "host",
      hostReceiptId: receipt.id,
      payload: {
        traceDigest,
        score: trace.outcome.score,
        evidenceRefs: trace.verifier?.evidenceRefs ?? [],
        artifactReceiptIds: trace.artifactReceiptIds,
      },
    }));

    const geneCandidate: GeneCandidate | null = trace.procedure === null
      ? null
      : immutable({
          schema: STRATEGY_GENE_CANDIDATE_SCHEMA,
          schemaVersion: ORGANISM_CONTRACT_VERSION,
          id: `candidate_${digest({ traceDigest, procedure: trace.procedure }).slice(0, 24)}`,
          runId: trace.runId,
          trialId: trace.trialId,
          spec: trace.procedure.spec,
          parentIds: trace.procedure.parentIds,
          evidenceRefs: trace.procedure.evidenceRefs,
        });
    if (geneCandidate !== null) {
      appended.push(appendIdempotent(this.#store, {
        id: `gene:candidate:${geneCandidate.id}`,
        type: "gene.candidate-extracted",
        missionId: trace.runId,
        occurredAt: trace.finishedAt,
        authority: "host",
        hostReceiptId: receipt.id,
        payload: {
          candidate: geneCandidate,
          traceDigest,
          evidenceRefs: geneCandidate.evidenceRefs,
          geneAdmissionAllowed: false,
        },
      }));
    }
    return immutable({ classification: "verified", geneCandidate, events: appended });
  }

  admit(candidate: GeneCandidate, approval: HostReceipt): StrategyGene {
    requireHostReceipt(this.#gate, approval, ["gene-approved"], candidate.runId);
    const gene = this.#genes.register(candidate.spec, candidate.parentIds, approval);
    appendIdempotent(this.#store, {
      id: `gene:admitted:${candidate.id}`,
      type: "gene.admitted",
      missionId: candidate.runId,
      occurredAt: gene.createdAt,
      authority: "host",
      hostReceiptId: gene.approvedByReceiptId,
      payload: {
        geneId: gene.id,
        gene,
        candidateId: candidate.id,
        evidenceRefs: candidate.evidenceRefs,
      },
    });
    return gene;
  }
}

/**
 * Deterministic event IDs make intake naturally retry-safe. An identical logical
 * event is success; reusing the ID for different content is a hard conflict.
 */
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

function negativeReasons(trace: AmosAwsTrace): readonly string[] {
  const reasons = new Set<string>();
  if (trace.outcome.kind !== "verified-success") reasons.add(trace.outcome.kind);
  if (!trace.trainingEligibility.eligible) {
    for (const reason of trace.trainingEligibility.reasons) reasons.add(reason);
  }
  if (trace.verifier?.status !== "pass") reasons.add("independent-verifier-not-passed");
  if (trace.verifier?.evidenceRefs.length === 0) reasons.add("verifier-evidence-missing");
  if (trace.artifactReceiptIds.length === 0) reasons.add("artifact-receipt-missing");
  return Object.freeze([...reasons].sort());
}
