import type { HostGate, HostReceipt } from "./host.ts";
import { requireHostReceipt } from "./host.ts";
import { immutable } from "./digest.ts";

export type CausalNode =
  | {
      readonly id: string;
      readonly missionId: string;
      readonly kind: "contribution";
      readonly actorId: string;
      readonly geneId: string;
      readonly createdAt: string;
      readonly authority: "organism";
    }
  | {
      readonly id: string;
      readonly missionId: string;
      readonly kind: "artifact" | "decision";
      readonly receiptId: string;
      readonly createdAt: string;
      readonly authority: "host";
    }
  | {
      readonly id: string;
      readonly missionId: string;
      readonly kind: "verifier";
      readonly receiptId: string;
      readonly outcome: "pass" | "fail";
      readonly createdAt: string;
      readonly authority: "host";
    };

export type CausalEdgeKind =
  | "produced"
  | "consumed"
  | "cited"
  | "advanced-criterion"
  | "invalidated"
  | "duplicate-of";

export interface CausalEdge {
  readonly id: string;
  readonly missionId: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly kind: CausalEdgeKind;
  readonly receiptId: string;
  readonly authority: "host";
}

const CREDIT_PATH = new Set<CausalEdgeKind>([
  "produced",
  "consumed",
  "cited",
  "advanced-criterion",
]);

/** Host-attested consumption graph used for conservative v1 credit assignment. */
export class CausalGraph {
  readonly #gate: HostGate;
  readonly #nodes = new Map<string, CausalNode>();
  readonly #edges = new Map<string, CausalEdge>();

  constructor(gate: HostGate) {
    this.#gate = gate;
  }

  addContribution(node: Extract<CausalNode, { kind: "contribution" }>): CausalNode {
    if (node.authority !== "organism") {
      throw new Error("Contributions must be organism-authored proposals");
    }
    return this.#addNode(node);
  }

  addHostNode(
    node: Exclude<CausalNode, { kind: "contribution" }>,
    receipt: HostReceipt,
  ): CausalNode {
    const allowed = node.kind === "artifact"
      ? ["artifact-harvested"] as const
      : node.kind === "decision"
        ? ["decision-recorded"] as const
        : ["official-verification"] as const;
    requireHostReceipt(this.#gate, receipt, allowed, node.missionId);
    if (node.authority !== "host" || node.receiptId !== receipt.id) {
      throw new Error("Host node does not match its receipt");
    }
    return this.#addNode(node);
  }

  addHostEdge(edge: CausalEdge, receipt: HostReceipt): CausalEdge {
    requireHostReceipt(
      this.#gate,
      receipt,
      ["artifact-harvested", "decision-recorded", "official-verification"],
      edge.missionId,
    );
    if (edge.authority !== "host" || edge.receiptId !== receipt.id) {
      throw new Error("Causal edge does not match its receipt");
    }
    if (this.#edges.has(edge.id)) {
      throw new Error(`Duplicate causal edge: ${edge.id}`);
    }
    const source = this.#requireNode(edge.sourceId);
    const target = this.#requireNode(edge.targetId);
    if (source.missionId !== edge.missionId || target.missionId !== edge.missionId) {
      throw new Error("Causal edges cannot cross missions");
    }
    if (this.#hasPath(edge.targetId, edge.sourceId)) {
      throw new Error(`Causal edge ${edge.id} would create a cycle`);
    }
    const frozen = immutable(edge);
    this.#edges.set(edge.id, frozen);
    return frozen;
  }

  eligibleContributions(verifierId: string): readonly string[] {
    const verifier = this.#requireNode(verifierId);
    if (verifier.kind !== "verifier" || verifier.authority !== "host") {
      throw new Error("Settlement requires a host verifier node");
    }
    if (verifier.outcome !== "pass") {
      return Object.freeze([]);
    }

    const excluded = new Set<string>();
    for (const edge of this.#edges.values()) {
      if (edge.kind === "invalidated" || edge.kind === "duplicate-of") {
        excluded.add(edge.sourceId);
      }
    }

    const visited = new Set<string>([verifierId]);
    const queue = [verifierId];
    const eligible = new Set<string>();
    while (queue.length > 0) {
      const targetId = queue.shift();
      if (targetId === undefined) break;
      for (const edge of this.#edges.values()) {
        if (edge.targetId !== targetId || !CREDIT_PATH.has(edge.kind)) continue;
        if (excluded.has(edge.sourceId) || visited.has(edge.sourceId)) continue;
        visited.add(edge.sourceId);
        queue.push(edge.sourceId);
        const source = this.#requireNode(edge.sourceId);
        if (source.kind === "contribution") eligible.add(source.id);
      }
    }
    return Object.freeze([...eligible].sort());
  }

  snapshot(): Readonly<{ nodes: readonly CausalNode[]; edges: readonly CausalEdge[] }> {
    return immutable({ nodes: [...this.#nodes.values()], edges: [...this.#edges.values()] });
  }

  #addNode(node: CausalNode): CausalNode {
    if (this.#nodes.has(node.id)) throw new Error(`Duplicate causal node: ${node.id}`);
    const frozen = immutable(node);
    this.#nodes.set(node.id, frozen);
    return frozen;
  }

  #requireNode(id: string): CausalNode {
    const node = this.#nodes.get(id);
    if (!node) throw new Error(`Unknown causal node: ${id}`);
    return node;
  }

  #hasPath(sourceId: string, targetId: string): boolean {
    const visited = new Set<string>();
    const queue = [sourceId];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      if (current === targetId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const edge of this.#edges.values()) {
        if (edge.sourceId === current) queue.push(edge.targetId);
      }
    }
    return false;
  }
}
