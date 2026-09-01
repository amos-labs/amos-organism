import { digest, immutable } from "./digest.ts";
import type { OrganismEvent } from "./eventStore.ts";
import type { HostGate, HostReceipt } from "./host.ts";
import { requireHostReceipt } from "./host.ts";
import {
  GENE_EXPRESSION_SCHEMA,
  ORGANISM_CONTRACT_VERSION,
} from "./contracts.ts";

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
  readonly verifierOutcome: "pass" | "fail" | "uncredited";
  readonly receiptId: string;
}

export interface StrategySelectionContext {
  readonly missionId: string;
  readonly role: string;
  readonly phase: string;
  readonly artifactClasses: readonly string[];
  readonly failureModes: readonly string[];
  readonly toolFamilies: readonly string[];
}

export interface SelectedStrategyGene {
  readonly gene: StrategyGene;
  /**
   * Ordered lexicographically in field order. This is deliberately not collapsed
   * into a weighted score: verified quality cannot be traded away for volume.
   */
  readonly rank: Readonly<{
    evidenceClass: 0 | 1 | 2;
    meanVerifiedQuality: number;
    verifiedPasses: number;
    specificity: number;
    vestedFitness: number;
    verifiedFailures: number;
    uncreditedAttempts: number;
  }>;
  readonly matches: Readonly<{
    phase: boolean;
    artifactClasses: readonly string[];
    failureModes: readonly string[];
    toolFamilies: readonly string[];
    role: boolean;
  }>;
}

export interface GeneExpression {
  readonly schema: typeof GENE_EXPRESSION_SCHEMA;
  readonly schemaVersion: typeof ORGANISM_CONTRACT_VERSION;
  readonly id: string;
  readonly missionId: string;
  readonly context: StrategySelectionContext;
  readonly selections: readonly Readonly<{
    geneId: string;
    rank: SelectedStrategyGene["rank"];
    mode: "guide" | "avoid";
  }>[];
  readonly receiptId: string;
  readonly expressedAt: string;
}

export interface StrategyVariation {
  readonly id: string;
  readonly kind: "diagnose-before-mutate" | "stop-repeated-no-op" | "recombine";
  readonly parentIds: readonly string[];
  readonly spec: StrategyGeneSpec;
  readonly researchOnly: true;
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
  readonly #expressions = new Map<string, GeneExpression>();

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
    requireHostReceipt(
      this.#gate,
      receipt,
      ["official-verification", "regression-recorded"],
      outcome.missionId,
    );
    this.require(outcome.geneId);
    if (outcome.verifiedQuality < 0 || outcome.verifiedQuality > 1) {
      throw new RangeError("Verified quality must be between zero and one");
    }
    const record = immutable({ ...outcome, receiptId: receipt.id });
    this.#outcomes.push(record);
    return record;
  }

  /** Select procedures whose declared preconditions intersect the current mission state. */
  select(context: StrategySelectionContext, limit = 8): readonly SelectedStrategyGene[] {
    if (!Number.isInteger(limit) || limit < 0 || limit > 128) {
      throw new RangeError("Strategy selection limit must be an integer from zero to 128");
    }
    const selected = [...this.#genes.values()].flatMap((gene) => {
      const match = selectionMatch(gene, context);
      if (match === null) return [];
      const outcomes = this.#outcomes.filter((outcome) => outcome.geneId === gene.id);
      const passes = outcomes.filter((outcome) => outcome.verifierOutcome === "pass");
      const failures = outcomes.filter((outcome) => outcome.verifierOutcome === "fail");
      const uncredited = outcomes.filter((outcome) => outcome.verifierOutcome === "uncredited");
      const quality = passes.length === 0
        ? 0
        : passes.reduce((sum, outcome) => sum + outcome.verifiedQuality, 0) / passes.length;
      const vested = Math.max(
        0,
        outcomes.reduce((sum, outcome) => sum + outcome.fitnessVested, 0),
      );
      const specificity = Number(match.phase)
        + match.artifactClasses.length
        + match.failureModes.length
        + match.toolFamilies.length
        + Number(match.role);
      const evidenceClass = passes.length > 0 ? 2 : failures.length > 0 ? 0 : 1;
      const rank: SelectedStrategyGene["rank"] = immutable({
        evidenceClass,
        meanVerifiedQuality: quality,
        verifiedPasses: passes.length,
        specificity,
        vestedFitness: vested,
        verifiedFailures: failures.length,
        uncreditedAttempts: uncredited.length,
      });
      return [{ gene, rank, matches: match }];
    });
    return immutable(selected.sort(compareSelections).slice(0, limit));
  }

  /** Host-attest which selected genes were actually compiled into a worker. */
  express(
    context: StrategySelectionContext,
    receipt: HostReceipt,
    limit = 8,
  ): GeneExpression {
    requireHostReceipt(this.#gate, receipt, ["gene-expressed"], context.missionId);
    const selections = this.select(context, limit).map(({ gene, rank }) => ({
      geneId: gene.id,
      rank,
      mode: hasVerifiedFailureOnly(this.#outcomes, gene.id) ? "avoid" as const : "guide" as const,
    }));
    const body: Omit<GeneExpression, "id"> = {
      schema: GENE_EXPRESSION_SCHEMA,
      schemaVersion: ORGANISM_CONTRACT_VERSION,
      missionId: context.missionId,
      context,
      selections,
      receiptId: receipt.id,
      expressedAt: receipt.issuedAt,
    };
    const expression = immutable({ id: `expression_${digest(body).slice(0, 24)}`, ...body });
    this.#expressions.set(expression.id, expression);
    return expression;
  }

  requireExpressed(expressionId: string, geneId: string, missionId: string): GeneExpression {
    const expression = this.#expressions.get(expressionId);
    if (!expression) throw new Error(`Unknown gene expression: ${expressionId}`);
    if (expression.missionId !== missionId) {
      throw new Error(`Gene expression ${expressionId} belongs to a different mission`);
    }
    if (!expression.selections.some((selection) => selection.geneId === geneId)) {
      throw new Error(`Gene ${geneId} was not host-attested in expression ${expressionId}`);
    }
    return expression;
  }

  expressions(missionId?: string): readonly GeneExpression[] {
    return immutable([...this.#expressions.values()].filter(
      (expression) => missionId === undefined || expression.missionId === missionId,
    ));
  }

  /**
   * Cheap research-only variation. Proposals need no approval; admission still
   * uses register() and a gene-approved receipt after independent evidence.
   */
  generateVariations(
    context: StrategySelectionContext,
    limit = 8,
  ): readonly StrategyVariation[] {
    const parents = this.select(context, Math.max(2, limit));
    const variations: StrategyVariation[] = [];
    for (const { gene } of parents) {
      for (const template of [
        {
          kind: "diagnose-before-mutate" as const,
          step: "write an evidence-bound hypothesis before changing the candidate",
        },
        {
          kind: "stop-repeated-no-op" as const,
          step: "stop and choose a new hypothesis after a repeated no-op mutation",
        },
      ]) {
        if (variations.length >= limit) break;
        if (gene.procedure.includes(template.step)) continue;
        const spec = normalize({
          ...geneSpec(gene),
          name: `${gene.name}:${template.kind}`,
          procedure: [...gene.procedure, template.step],
        });
        const body = { kind: template.kind, parentIds: [gene.id], spec, researchOnly: true as const };
        variations.push(immutable({ id: `variation_${digest(body).slice(0, 24)}`, ...body }));
      }
    }
    if (variations.length < limit && parents.length >= 2) {
      const left = parents[0]!.gene;
      const right = parents[1]!.gene;
      const spec = normalize({
        ...geneSpec(left),
        name: `${left.name}+${right.name}`,
        procedure: [...new Set([...left.procedure, ...right.procedure])],
        stopConditions: [...new Set([...left.stopConditions, ...right.stopConditions])],
      });
      const body = {
        kind: "recombine" as const,
        parentIds: [left.id, right.id].sort(),
        spec,
        researchOnly: true as const,
      };
      variations.push(immutable({ id: `variation_${digest(body).slice(0, 24)}`, ...body }));
    }
    return immutable(variations.slice(0, limit));
  }

  /** Rehydrate learned state from the verified append-only event projection. */
  replay(events: readonly OrganismEvent[]): void {
    for (const event of events) {
      if (event.authority !== "host") continue;
      if (event.type === "gene.admitted") {
        const gene = event.payload.gene;
        if (isStrategyGene(gene)) this.#restoreGene(gene);
      } else if (event.type === "gene.expressed") {
        const expression = event.payload.expression;
        if (isGeneExpression(expression)) this.#expressions.set(expression.id, immutable(expression));
      } else if (event.type === "gene.outcome-recorded") {
        const outcome = event.payload.outcome;
        if (isGeneOutcome(outcome) && this.#genes.has(outcome.geneId)) {
          this.#outcomes.push(immutable(outcome));
        }
      }
    }
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

  #restoreGene(gene: StrategyGene): void {
    const normalized = normalize(geneSpec(gene));
    const expectedDigest = digest({ normalized, parentIds: [...gene.parentIds].sort() });
    if (gene.digest !== expectedDigest || gene.id !== `gene_${expectedDigest.slice(0, 24)}`) {
      throw new Error(`Invalid replayed strategy gene: ${gene.id}`);
    }
    for (const parentId of gene.parentIds) this.require(parentId);
    this.#genes.set(gene.id, immutable(gene));
  }
}

function geneSpec(gene: StrategyGene): StrategyGeneSpec {
  return {
    name: gene.name,
    preconditions: gene.preconditions,
    rolePolicy: gene.rolePolicy,
    retrievalRecipe: gene.retrievalRecipe,
    procedure: gene.procedure,
    stopConditions: gene.stopConditions,
    rightsTags: gene.rightsTags,
    contaminationTags: gene.contaminationTags,
  };
}

function selectionMatch(
  gene: StrategyGene,
  context: StrategySelectionContext,
): SelectedStrategyGene["matches"] | null {
  const phase = gene.preconditions.phases.length === 0
    || gene.preconditions.phases.includes(context.phase);
  const artifactClasses = intersection(gene.preconditions.artifactClasses, context.artifactClasses);
  const failureModes = intersection(gene.preconditions.failureModes, context.failureModes);
  const toolFamilies = intersection(gene.preconditions.toolFamilies, context.toolFamilies);
  const role = Object.keys(gene.rolePolicy).length === 0
    || Object.hasOwn(gene.rolePolicy, context.role);
  if (!phase || !role) return null;
  if (gene.preconditions.artifactClasses.length > 0 && artifactClasses.length === 0) return null;
  if (gene.preconditions.failureModes.length > 0 && failureModes.length === 0) return null;
  if (gene.preconditions.toolFamilies.length > 0 && toolFamilies.length === 0) return null;
  return immutable({ phase, artifactClasses, failureModes, toolFamilies, role });
}

function intersection(left: readonly string[], right: readonly string[]): string[] {
  const values = new Set(right);
  return [...new Set(left.filter((value) => values.has(value)))].sort();
}

function hasVerifiedFailureOnly(outcomes: readonly GeneOutcome[], geneId: string): boolean {
  const observed = outcomes.filter((outcome) =>
    outcome.geneId === geneId && outcome.verifierOutcome !== "uncredited"
  );
  return observed.length > 0 && observed.every((outcome) => outcome.verifierOutcome === "fail");
}

function compareSelections(left: SelectedStrategyGene, right: SelectedStrategyGene): number {
  return right.rank.evidenceClass - left.rank.evidenceClass
    || right.rank.meanVerifiedQuality - left.rank.meanVerifiedQuality
    || right.rank.verifiedPasses - left.rank.verifiedPasses
    || right.rank.specificity - left.rank.specificity
    || right.rank.vestedFitness - left.rank.vestedFitness
    || left.rank.verifiedFailures - right.rank.verifiedFailures
    || left.rank.uncreditedAttempts - right.rank.uncreditedAttempts
    || left.gene.id.localeCompare(right.gene.id);
}

function isStrategyGene(value: unknown): value is StrategyGene {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const gene = value as Partial<StrategyGene>;
  return typeof gene.id === "string"
    && typeof gene.digest === "string"
    && Array.isArray(gene.parentIds)
    && typeof gene.name === "string"
    && typeof gene.preconditions === "object"
    && Array.isArray(gene.procedure);
}

function isGeneExpression(value: unknown): value is GeneExpression {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const expression = value as Partial<GeneExpression>;
  return expression.schema === GENE_EXPRESSION_SCHEMA
    && expression.schemaVersion === ORGANISM_CONTRACT_VERSION
    && typeof expression.id === "string"
    && typeof expression.missionId === "string"
    && Array.isArray(expression.selections)
    && typeof expression.receiptId === "string";
}

function isGeneOutcome(value: unknown): value is GeneOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const outcome = value as Partial<GeneOutcome>;
  return typeof outcome.geneId === "string"
    && typeof outcome.missionId === "string"
    && typeof outcome.verifiedQuality === "number"
    && typeof outcome.fitnessVested === "number"
    && ["pass", "fail", "uncredited"].includes(outcome.verifierOutcome ?? "")
    && typeof outcome.receiptId === "string";
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
