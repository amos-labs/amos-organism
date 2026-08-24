import { digest, immutable } from "./digest.ts";
import type { HostGate, HostReceipt } from "./host.ts";
import { requireHostReceipt } from "./host.ts";

export interface StrategyPreconditions {
  readonly phases: readonly string[];
  readonly artifactClasses: readonly string[];
  readonly failureModes: readonly string[];
  readonly toolFamilies: readonly string[];
}

export interface StrategyGeneSpec {
  readonly name: string;
  readonly preconditions: StrategyPreconditions;
  readonly rolePolicy: Readonly<Record<string, readonly string[]>>;
  readonly retrievalRecipe: readonly string[];
  readonly procedure: readonly string[];
  readonly stopConditions: readonly string[];
  readonly rightsTags: readonly string[];
  readonly contaminationTags: readonly string[];
}

export interface StrategyGene extends StrategyGeneSpec {
  readonly id: string;
  readonly digest: string;
  readonly parentIds: readonly string[];
  readonly approvedByReceiptId: string;
  readonly createdAt: string;
}

export interface GeneOutcome {
  readonly geneId: string;
  readonly missionId: string;
  readonly verifiedQuality: number;
  readonly fitnessVested: number;
  readonly receiptId: string;
}

function normalize(spec: StrategyGeneSpec): StrategyGeneSpec {
  return {
    ...spec,
    preconditions: {
      phases: [...spec.preconditions.phases].sort(),
      artifactClasses: [...spec.preconditions.artifactClasses].sort(),
      failureModes: [...spec.preconditions.failureModes].sort(),
      toolFamilies: [...spec.preconditions.toolFamilies].sort(),
    },
    rolePolicy: Object.fromEntries(
      Object.entries(spec.rolePolicy)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([role, tools]) => [role, [...tools].sort()]),
    ),
    retrievalRecipe: [...spec.retrievalRecipe],
    procedure: [...spec.procedure],
    stopConditions: [...spec.stopConditions],
    rightsTags: [...spec.rightsTags].sort(),
    contaminationTags: [...spec.contaminationTags].sort(),
  };
}

/** Immutable, content-addressed procedural inheritance with host-controlled admission. */
export class StrategyGeneArchive {
  readonly #gate: HostGate;
  readonly #genes = new Map<string, StrategyGene>();
  readonly #outcomes: GeneOutcome[] = [];

  constructor(gate: HostGate) {
    this.#gate = gate;
  }

  register(
    spec: StrategyGeneSpec,
    parentIds: readonly string[],
    receipt: HostReceipt,
  ): StrategyGene {
    requireHostReceipt(this.#gate, receipt, ["gene-approved", "official-verification"]);
    for (const parentId of parentIds) this.require(parentId);
    const normalized = normalize(spec);
    const contentDigest = digest({ normalized, parentIds: [...parentIds].sort() });
    const id = `gene_${contentDigest.slice(0, 24)}`;
    const existing = this.#genes.get(id);
    if (existing) return existing;
    const gene = immutable({
      ...normalized,
      id,
      digest: contentDigest,
      parentIds: [...parentIds].sort(),
      approvedByReceiptId: receipt.id,
      createdAt: receipt.issuedAt,
    });
    this.#genes.set(id, gene);
    return gene;
  }

  recordOutcome(outcome: Omit<GeneOutcome, "receiptId">, receipt: HostReceipt): GeneOutcome {
    requireHostReceipt(this.#gate, receipt, ["official-verification"], outcome.missionId);
    this.require(outcome.geneId);
    if (outcome.verifiedQuality < 0 || outcome.verifiedQuality > 1) {
      throw new RangeError("Verified quality must be between zero and one");
    }
    const record = immutable({ ...outcome, receiptId: receipt.id });
    this.#outcomes.push(record);
    return record;
  }

  require(geneId: string): StrategyGene {
    const gene = this.#genes.get(geneId);
    if (!gene) throw new Error(`Unknown strategy gene: ${geneId}`);
    return gene;
  }

  outcomes(geneId: string): readonly GeneOutcome[] {
    return immutable(this.#outcomes.filter((outcome) => outcome.geneId === geneId));
  }

  /**
   * Fitness chooses the main population. Novelty only protects a small archive slot;
   * it never grants energy or improves a gene's fitness score.
   */
  retentionSet(
    fitnessByGene: Readonly<Record<string, number>>,
    liveSlots: number,
    noveltySlots: number,
  ): readonly string[] {
    if (liveSlots < 1 || noveltySlots < 0 || noveltySlots > liveSlots) {
      throw new RangeError("Invalid retention slot configuration");
    }
    const genes = [...this.#genes.values()];
    const fitnessSlots = liveSlots - noveltySlots;
    const selected = genes
      .sort((left, right) =>
        (fitnessByGene[right.id] ?? 0) - (fitnessByGene[left.id] ?? 0) ||
        left.id.localeCompare(right.id)
      )
      .slice(0, fitnessSlots);

    while (selected.length < liveSlots) {
      const candidates = genes.filter((gene) => !selected.some((item) => item.id === gene.id));
      if (candidates.length === 0) break;
      candidates.sort((left, right) =>
        minimumDistance(right, selected) - minimumDistance(left, selected) ||
        left.id.localeCompare(right.id)
      );
      const next = candidates[0];
      if (next === undefined) break;
      selected.push(next);
    }
    return Object.freeze(selected.map((gene) => gene.id));
  }

  list(): readonly StrategyGene[] {
    return immutable([...this.#genes.values()]);
  }
}

function minimumDistance(candidate: StrategyGene, selected: readonly StrategyGene[]): number {
  if (selected.length === 0) return 1;
  return Math.min(...selected.map((gene) => procedureDistance(candidate, gene)));
}

function procedureDistance(left: StrategyGene, right: StrategyGene): number {
  const leftSteps = new Set(left.procedure.map(normalizeStep));
  const rightSteps = new Set(right.procedure.map(normalizeStep));
  const union = new Set([...leftSteps, ...rightSteps]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const step of leftSteps) if (rightSteps.has(step)) intersection += 1;
  return 1 - intersection / union.size;
}

function normalizeStep(step: string): string {
  return step.trim().toLowerCase().replace(/\s+/g, " ");
}
