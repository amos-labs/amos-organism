import { CausalGraph, type CausalEdge, type CausalNode } from "./causalGraph.ts";
import { CandidateEvolutionArchive } from "./candidateEvolution.ts";
import { digest } from "./digest.ts";
import { EnergyLedger } from "./energyLedger.ts";
import type { EventStore, OrganismEvent } from "./eventStore.ts";
import { FitnessLedger, type FitnessContext } from "./fitnessLedger.ts";
import type { HostGate, HostReceipt } from "./host.ts";
import { PheromoneField } from "./pheromoneField.ts";
import {
  StrategyGeneArchive,
  type GeneExpression,
  type StrategySelectionContext,
} from "./strategyGenes.ts";
import { SharedWorldState } from "./worldState.ts";

export interface OrganismKernelOptions {
  readonly hostGate: HostGate;
  readonly fitnessPolicy?: HostFitnessPolicy;
  readonly eventStore?: EventStore;
  readonly replayEvents?: readonly OrganismEvent[];
}

export interface HostFitnessPolicy {
  provisionalCredit(proposal: ProposedContribution): number;
}

export interface ProposedContribution {
  readonly id: string;
  readonly escrowId: string;
  readonly missionId: string;
  readonly actorId: string;
  readonly geneId: string;
  readonly expressionId: string;
  readonly createdAt: string;
  readonly context: FitnessContext;
}

export interface HostArtifact {
  readonly id: string;
  readonly missionId: string;
  readonly createdAt: string;
  readonly contributionIds: readonly string[];
}

export interface HostDecision {
  readonly id: string;
  readonly missionId: string;
  readonly createdAt: string;
  readonly consumedNodeIds: readonly string[];
}

export interface HostVerification {
  readonly id: string;
  readonly missionId: string;
  readonly createdAt: string;
  readonly outcome: "pass" | "fail";
  readonly citedNodeIds: readonly string[];
  readonly verifiedQuality: number;
}

/**
 * Minimal organism kernel. The model may propose work; only the host can harvest,
 * consume, verify, vest fitness, or admit inherited procedure.
 */
export class OrganismKernel {
  readonly energy: EnergyLedger;
  readonly fitness: FitnessLedger;
  readonly causality: CausalGraph;
  readonly candidates: CandidateEvolutionArchive;
  readonly genes: StrategyGeneArchive;
  readonly pheromones: PheromoneField;
  readonly world: SharedWorldState;
  readonly #fitnessPolicy: HostFitnessPolicy;
  readonly #eventStore: EventStore | null;

  constructor(options: OrganismKernelOptions) {
    const replayEvents = options.replayEvents ?? options.eventStore?.events() ?? [];
    this.energy = new EnergyLedger(options.hostGate);
    this.fitness = new FitnessLedger(options.hostGate);
    this.causality = new CausalGraph(options.hostGate);
    this.candidates = new CandidateEvolutionArchive(
      options.hostGate,
      options.eventStore ?? null,
      replayEvents,
    );
    this.genes = new StrategyGeneArchive(options.hostGate, options.eventStore ?? null);
    this.pheromones = new PheromoneField(options.hostGate);
    this.world = new SharedWorldState(options.hostGate);
    this.#fitnessPolicy = options.fitnessPolicy ?? { provisionalCredit: () => 1 };
    this.#eventStore = options.eventStore ?? null;
    this.fitness.replay(replayEvents);
    this.genes.replay(replayEvents);
  }

  expressGenes(
    context: StrategySelectionContext,
    receipt: HostReceipt,
    limit = 8,
  ): GeneExpression {
    const expression = this.genes.express(context, receipt, limit);
    this.#eventStore?.append({
      id: `gene:expressed:${expression.id}`,
      type: "gene.expressed",
      missionId: context.missionId,
      occurredAt: receipt.issuedAt,
      authority: "host",
      hostReceiptId: receipt.id,
      payload: { expression, contextDigest: digest(context) },
    });
    return expression;
  }

  recordContribution(proposal: ProposedContribution): void {
    this.genes.require(proposal.geneId);
    this.genes.requireExpressed(
      proposal.expressionId,
      proposal.geneId,
      proposal.missionId,
    );
    const provisionalFitness = this.#fitnessPolicy.provisionalCredit(proposal);
    this.causality.addContribution({
      id: proposal.id,
      missionId: proposal.missionId,
      kind: "contribution",
      actorId: proposal.actorId,
      geneId: proposal.geneId,
      createdAt: proposal.createdAt,
      authority: "organism",
    });
    const escrow = this.fitness.openEscrow({
      id: proposal.escrowId,
      missionId: proposal.missionId,
      contributionId: proposal.id,
      actorId: proposal.actorId,
      geneId: proposal.geneId,
      amount: provisionalFitness,
      context: proposal.context,
    });
    this.#eventStore?.append({
      id: `fitness:escrow:${escrow.id}`,
      type: "fitness.escrow-opened",
      missionId: proposal.missionId,
      occurredAt: proposal.createdAt,
      authority: "organism",
      payload: { escrow },
    });
  }

  harvestArtifact(artifact: HostArtifact, receipt: HostReceipt): void {
    this.causality.addHostNode(hostNode(artifact, "artifact", receipt), receipt);
    for (const contributionId of artifact.contributionIds) {
      this.causality.addHostEdge(
        hostEdge(
          `produced:${contributionId}:${artifact.id}`,
          artifact.missionId,
          contributionId,
          artifact.id,
          "produced",
          receipt,
        ),
        receipt,
      );
    }
  }

  recordDecision(decision: HostDecision, receipt: HostReceipt): void {
    this.causality.addHostNode(hostNode(decision, "decision", receipt), receipt);
    for (const sourceId of decision.consumedNodeIds) {
      this.causality.addHostEdge(
        hostEdge(
          `consumed:${sourceId}:${decision.id}`,
          decision.missionId,
          sourceId,
          decision.id,
          "consumed",
          receipt,
        ),
        receipt,
      );
    }
  }

  settle(
    verification: HostVerification,
    receipt: HostReceipt,
  ): Readonly<{
    eligibleContributionIds: readonly string[];
    vestedEscrowIds: readonly string[];
    clawedBackEscrowIds: readonly string[];
  }> {
    if (verification.verifiedQuality < 0 || verification.verifiedQuality > 1) {
      throw new RangeError("Verified quality must be between zero and one");
    }
    const verifier: Extract<CausalNode, { kind: "verifier" }> = {
      id: verification.id,
      missionId: verification.missionId,
      kind: "verifier",
      receiptId: receipt.id,
      outcome: verification.outcome,
      createdAt: verification.createdAt,
      authority: "host",
    };
    this.causality.addHostNode(verifier, receipt);
    for (const sourceId of verification.citedNodeIds) {
      this.causality.addHostEdge(
        hostEdge(
          `cited:${sourceId}:${verification.id}`,
          verification.missionId,
          sourceId,
          verification.id,
          "cited",
          receipt,
        ),
        receipt,
      );
    }
    const eligibleContributionIds = this.causality.eligibleContributions(verification.id);
    const settlement = this.fitness.settleMission(
      verification.missionId,
      eligibleContributionIds,
      receipt,
      verification.outcome,
    );
    this.#eventStore?.append({
      id: `fitness:settlement:${verification.missionId}:${receipt.id}`,
      type: "fitness.mission-settled",
      missionId: verification.missionId,
      occurredAt: receipt.issuedAt,
      authority: "host",
      hostReceiptId: receipt.id,
      payload: {
        outcome: verification.outcome,
        vestedEscrowIds: settlement.vested,
        clawedBackEscrowIds: settlement.clawedBack,
      },
    });

    const vestedIds = new Set(settlement.vested);
    const geneTotals = new Map<string, number>();
    const attemptedGenes = new Set<string>();
    for (const entry of this.fitness.entries()) {
      if (entry.missionId !== verification.missionId || entry.settlementReceiptId !== receipt.id) {
        continue;
      }
      attemptedGenes.add(entry.geneId);
      if (vestedIds.has(entry.id)) {
        geneTotals.set(entry.geneId, (geneTotals.get(entry.geneId) ?? 0) + entry.amount);
      }
    }
    for (const geneId of attemptedGenes) {
      const fitnessVested = geneTotals.get(geneId) ?? 0;
      const credited = verification.outcome === "pass" && fitnessVested > 0;
      const verifierOutcome = verification.outcome === "fail"
        ? "fail" as const
        : credited
        ? "pass" as const
        : "uncredited" as const;
      const outcome = this.genes.recordOutcome(
        {
          geneId,
          missionId: verification.missionId,
          verifiedQuality: credited ? verification.verifiedQuality : 0,
          fitnessVested,
          verifierOutcome,
        },
        receipt,
      );
      this.#eventStore?.append({
        id: `gene:outcome:${verification.missionId}:${geneId}:${receipt.id}`,
        type: "gene.outcome-recorded",
        missionId: verification.missionId,
        occurredAt: receipt.issuedAt,
        authority: "host",
        hostReceiptId: receipt.id,
        payload: { outcome },
      });
    }
    this.energy.closeMission(verification.missionId);
    return Object.freeze({
      eligibleContributionIds,
      vestedEscrowIds: settlement.vested,
      clawedBackEscrowIds: settlement.clawedBack,
    });
  }

  /**
   * Apply a later host-observed regression and persist the punishment so a
   * restart cannot resurrect previously clawed-back fitness.
   */
  recordRegression(
    contributionIds: readonly string[],
    receipt: HostReceipt,
  ): Readonly<{ clawedBackEscrowIds: readonly string[]; affectedGeneIds: readonly string[] }> {
    const before = new Map(this.fitness.entries().map((entry) => [entry.id, entry]));
    const clawedBackEscrowIds = this.fitness.recordRegression(contributionIds, receipt);
    const clawbackByGene = new Map<string, number>();
    const affectedGeneIds = [...new Set(clawedBackEscrowIds.flatMap((id) => {
      const entry = before.get(id);
      if (entry !== undefined) {
        clawbackByGene.set(
          entry.geneId,
          (clawbackByGene.get(entry.geneId) ?? 0) + entry.amount,
        );
      }
      return entry === undefined ? [] : [entry.geneId];
    }))].sort();
    this.#eventStore?.append({
      id: `fitness:regression:${receipt.id}`,
      type: "fitness.regression-recorded",
      missionId: receipt.missionId,
      occurredAt: receipt.issuedAt,
      authority: "host",
      hostReceiptId: receipt.id,
      payload: {
        contributionIds: [...new Set(contributionIds)].sort(),
        clawedBackEscrowIds,
        affectedGeneIds,
      },
    });
    for (const geneId of affectedGeneIds) {
      const outcome = this.genes.recordOutcome(
        {
          geneId,
          missionId: receipt.missionId,
          verifiedQuality: 0,
          fitnessVested: -(clawbackByGene.get(geneId) ?? 0),
          verifierOutcome: "fail",
        },
        receipt,
      );
      this.#eventStore?.append({
        id: `gene:regression-outcome:${receipt.id}:${geneId}`,
        type: "gene.outcome-recorded",
        missionId: receipt.missionId,
        occurredAt: receipt.issuedAt,
        authority: "host",
        hostReceiptId: receipt.id,
        payload: { outcome, cause: "regression" },
      });
    }
    return Object.freeze({ clawedBackEscrowIds, affectedGeneIds });
  }
}

function hostNode(
  value: HostArtifact | HostDecision,
  kind: "artifact" | "decision",
  receipt: HostReceipt,
): Exclude<CausalNode, { kind: "contribution" | "verifier" }> {
  return {
    id: value.id,
    missionId: value.missionId,
    kind,
    receiptId: receipt.id,
    createdAt: value.createdAt,
    authority: "host",
  };
}

function hostEdge(
  id: string,
  missionId: string,
  sourceId: string,
  targetId: string,
  kind: CausalEdge["kind"],
  receipt: HostReceipt,
): CausalEdge {
  return {
    id,
    missionId,
    sourceId,
    targetId,
    kind,
    receiptId: receipt.id,
    authority: "host",
  };
}
