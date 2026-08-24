import { immutable } from "./digest.ts";
import type { HostGate, HostReceipt } from "./host.ts";
import { requireHostReceipt } from "./host.ts";

export interface PheromoneContext {
  readonly phase: string;
  readonly artifactClass: string;
  readonly failureMode: string;
  readonly toolFamily: string;
}

export type PheromoneKind =
  | "attraction"
  | "inhibition"
  | "uncertainty"
  | "artifact-ready";

export interface PheromoneDeposit {
  readonly id: string;
  readonly missionId: string;
  readonly kind: PheromoneKind;
  readonly context: PheromoneContext;
  readonly intensity: number;
  readonly confidence: number;
  readonly depositedAtMs: number;
  readonly halfLifeMs: number;
  readonly ttlMs: number;
  readonly receiptId: string;
  readonly authority: "host";
}

export interface SensedPheromone extends PheromoneDeposit {
  readonly currentIntensity: number;
}

/** A keyed signaling field. Signals remain typed and are never collapsed to one net score. */
export class PheromoneField {
  readonly #gate: HostGate;
  readonly #deposits = new Map<string, PheromoneDeposit>();

  constructor(gate: HostGate) {
    this.#gate = gate;
  }

  deposit(signal: PheromoneDeposit, receipt: HostReceipt): PheromoneDeposit {
    requireHostReceipt(
      this.#gate,
      receipt,
      ["artifact-harvested", "decision-recorded", "official-verification"],
      signal.missionId,
    );
    if (signal.authority !== "host" || signal.receiptId !== receipt.id) {
      throw new Error("Pheromone does not match its host receipt");
    }
    if (this.#deposits.has(signal.id)) throw new Error(`Duplicate pheromone: ${signal.id}`);
    if (signal.intensity <= 0 || signal.intensity > 1) {
      throw new RangeError("Pheromone intensity must be in (0, 1]");
    }
    if (signal.confidence < 0 || signal.confidence > 1) {
      throw new RangeError("Pheromone confidence must be in [0, 1]");
    }
    if (signal.halfLifeMs <= 0 || signal.ttlMs <= 0) {
      throw new RangeError("Pheromone decay windows must be positive");
    }
    const frozen = immutable(signal);
    this.#deposits.set(signal.id, frozen);
    return frozen;
  }

  sense(context: PheromoneContext, atMs: number): readonly SensedPheromone[] {
    const result: SensedPheromone[] = [];
    for (const deposit of this.#deposits.values()) {
      if (!sameContext(deposit.context, context)) continue;
      const age = Math.max(0, atMs - deposit.depositedAtMs);
      if (age > deposit.ttlMs) continue;
      result.push({
        ...deposit,
        currentIntensity: deposit.intensity * deposit.confidence * (0.5 ** (age / deposit.halfLifeMs)),
      });
    }
    return immutable(result.sort((left, right) => right.currentIntensity - left.currentIntensity));
  }
}

function sameContext(left: PheromoneContext, right: PheromoneContext): boolean {
  return left.phase === right.phase &&
    left.artifactClass === right.artifactClass &&
    left.failureMode === right.failureMode &&
    left.toolFamily === right.toolFamily;
}
