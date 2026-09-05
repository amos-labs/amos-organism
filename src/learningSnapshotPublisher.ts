import { digest } from "./digest.ts";
import type { OrganismEvent } from "./eventStore.ts";
import type { HostGate, HostReceipt } from "./host.ts";
import {
  createLearningSelectionSnapshot,
  type CompatibleRuntime,
  type LearningSelectionSnapshot,
  procedureFromStrategyGene,
  type SnapshotProcedure
} from "./learningSelectionSnapshot.ts";
import { StrategyGeneArchive } from "./strategyGenes.ts";

/**
 * Derive the learning selection snapshot from an organism event chain. Replay
 * is read-only: host-authored gene admissions, expressions and outcomes are
 * restored exactly as recorded, nothing is admitted, and the snapshot's
 * sourceChainDigest is the chain head so a consumer can tell which evidence
 * produced it. An empty or gene-less chain yields the empty snapshot.
 */
export interface DeriveSnapshotOptions {
  readonly events: readonly OrganismEvent[];
  readonly id: string;
  readonly compatibleRuntimes: readonly CompatibleRuntime[];
  readonly permittedUseScope?: readonly string[];
  readonly tokenBound?: number;
  readonly validForMs?: number;
  readonly now?: Date;
  readonly tenantScope?: "any" | "tenant";
  readonly tenantIds?: readonly string[];
}

export interface DerivedSnapshot {
  readonly snapshot: LearningSelectionSnapshot;
  readonly chain: { readonly events: number; readonly headDigest: string | null; readonly genes: number; readonly published: number; readonly withheld: number };
}

/** Replay never mints or verifies receipts; anything asked of the gate is refused. */
class ReplayOnlyGate implements HostGate {
  verify(_receipt: HostReceipt): boolean { return false; }
}

export function deriveLearningSelectionSnapshot(options: DeriveSnapshotOptions): DerivedSnapshot {
  const now = options.now ?? new Date();
  const archive = new StrategyGeneArchive(new ReplayOnlyGate(), null);
  archive.replay(options.events);
  const genes = archive.list();
  const procedures: SnapshotProcedure[] = [];
  let withheld = 0;
  for (const gene of genes) {
    const procedure = procedureFromStrategyGene(gene, archive.outcomes(gene.id), { tenantScope: options.tenantScope ?? "any", tenantIds: options.tenantIds ?? [] });
    if (procedure) procedures.push(procedure); else withheld += 1;
  }
  const head = options.events.at(-1)?.digest ?? null;
  const tokenBound = options.tokenBound ?? Math.max(0, procedures.reduce((sum, procedure) => sum + procedure.tokens, 0));
  const snapshot = createLearningSelectionSnapshot({
    id: options.id,
    generatedAt: now,
    validUntil: new Date(now.getTime() + (options.validForMs ?? 6 * 60 * 60 * 1000)),
    sourceChainDigest: head ?? digest({ schema: "amos.empty-event-chain", version: 1 }),
    compatibleRuntimes: options.compatibleRuntimes,
    permittedUseScope: options.permittedUseScope ?? ["strategy_learning"],
    tokenBound,
    procedures
  });
  return { snapshot, chain: { events: options.events.length, headDigest: head, genes: genes.length, published: procedures.length, withheld } };
}

/** Parse `modelId@runtimeRevision[:adapterArtifactSha256]` runtime pins from a CLI. */
export function parseRuntimePin(text: string): CompatibleRuntime {
  const match = /^([^@\s]+)@([a-f0-9]{7,64})(?::([a-f0-9]{64}))?$/.exec(text.trim());
  if (!match) throw new Error(`runtime pin must look like modelId@revision[:adapterSha256], got ${text}`);
  return { modelId: match[1]!, runtimeRevision: match[2]!, adapterArtifactSha256: match[3] ?? null };
}
