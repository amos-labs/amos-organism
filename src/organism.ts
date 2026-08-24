import { CausalGraph, type CausalEdge, type CausalNode } from "./causalGraph.ts";
import { EnergyLedger } from "./energyLedger.ts";
import { FitnessLedger, type FitnessContext } from "./fitnessLedger.ts";
import type { HostGate, HostReceipt } from "./host.ts";
import { PheromoneField } from "./pheromoneField.ts";
import { StrategyGeneArchive } from "./strategyGenes.ts";
import { SharedWorldState } from "./worldState.ts";

export interface OrganismKernelOptions {
  readonly hostGate: HostGate;
  readonly fitnessPolicy?: HostFitnessPolicy;
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
  readonly genes: StrategyGeneArchive;
  readonly pheromones: PheromoneField;
  readonly world: SharedWorldState;
  readonly #fitnessPolicy: HostFitnessPolicy;

  constructor(options: OrganismKernelOptions) {
    this.energy = new EnergyLedger(options.hostGate);
    this.fitness = new FitnessLedger(options.hostGate);
    this.causality = new CausalGraph(options.hostGate);
    this.genes = new StrategyGeneArchive(options.hostGate);
    this.pheromones = new PheromoneField(options.hostGate);
    this.world = new SharedWorldState(options.hostGate);
    this.#fitnessPolicy = options.fitnessPolicy ?? { provisionalCredit: () => 1 };
  }

  recordContribution(proposal: ProposedContribution): void {
    this.genes.require(proposal.geneId);
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
    this.fitness.openEscrow({
      id: proposal.escrowId,
      missionId: proposal.missionId,
      contributionId: proposal.id,
      actorId: proposal.actorId,
      geneId: proposal.geneId,
      amount: provisionalFitness,
      context: proposal.context,
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

    const vestedIds = new Set(settlement.vested);
    const geneTotals = new Map<string, number>();
    for (const entry of this.fitness.entries()) {
      if (!vestedIds.has(entry.id)) continue;
      geneTotals.set(entry.geneId, (geneTotals.get(entry.geneId) ?? 0) + entry.amount);
    }
    for (const [geneId, fitnessVested] of geneTotals) {
      this.genes.recordOutcome(
        {
          geneId,
          missionId: verification.missionId,
          verifiedQuality: verification.verifiedQuality,
          fitnessVested,
        },
        receipt,
      );
    }
    this.energy.closeMission(verification.missionId);
    return Object.freeze({
      eligibleContributionIds,
      vestedEscrowIds: settlement.vested,
      clawedBackEscrowIds: settlement.clawedBack,
    });
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
