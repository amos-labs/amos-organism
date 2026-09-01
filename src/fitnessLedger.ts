import type { HostGate, HostReceipt } from "./host.ts";
import { requireHostReceipt } from "./host.ts";
import { immutable } from "./digest.ts";
import type { OrganismEvent } from "./eventStore.ts";

export interface FitnessContext {
  readonly role: string;
  readonly domain: string;
  readonly missionState: string;
}

export interface CreditEscrow {
  readonly id: string;
  readonly missionId: string;
  readonly contributionId: string;
  readonly actorId: string;
  readonly geneId: string;
  readonly amount: number;
  readonly context: FitnessContext;
  status: "provisional" | "vested" | "clawed-back";
  settlementReceiptId?: string;
}

export interface ReputationView extends FitnessContext {
  readonly vestedFitness: number;
  readonly vestedContributions: number;
  readonly attemptedContributions: number;
  readonly reliability: number;
}

/** Cross-mission selection credit. Only host-verified causal use can vest it. */
export class FitnessLedger {
  readonly #gate: HostGate;
  readonly #escrows = new Map<string, CreditEscrow>();
  readonly #balances = new Map<string, number>();

  constructor(gate: HostGate) {
    this.#gate = gate;
  }

  openEscrow(entry: Omit<CreditEscrow, "status" | "settlementReceiptId">): CreditEscrow {
    if (this.#escrows.has(entry.id)) throw new Error(`Duplicate escrow: ${entry.id}`);
    if ([...this.#escrows.values()].some((item) => item.contributionId === entry.contributionId)) {
      throw new Error(`Contribution already has an escrow: ${entry.contributionId}`);
    }
    if (!Number.isFinite(entry.amount) || entry.amount <= 0) {
      throw new RangeError("Provisional fitness must be positive and finite");
    }
    const escrow: CreditEscrow = { ...immutable(entry), status: "provisional" };
    this.#escrows.set(entry.id, escrow);
    return immutable(escrow) as CreditEscrow;
  }

  settleMission(
    missionId: string,
    eligibleContributionIds: readonly string[],
    verificationReceipt: HostReceipt,
    outcome: "pass" | "fail",
  ): Readonly<{ vested: readonly string[]; clawedBack: readonly string[] }> {
    requireHostReceipt(
      this.#gate,
      verificationReceipt,
      ["official-verification"],
      missionId,
    );
    const eligible = new Set(eligibleContributionIds);
    const vested: string[] = [];
    const clawedBack: string[] = [];
    for (const escrow of this.#escrows.values()) {
      if (escrow.missionId !== missionId || escrow.status !== "provisional") continue;
      escrow.settlementReceiptId = verificationReceipt.id;
      if (outcome === "pass" && eligible.has(escrow.contributionId)) {
        escrow.status = "vested";
        this.#balances.set(escrow.geneId, this.balance(escrow.geneId) + escrow.amount);
        vested.push(escrow.id);
      } else {
        escrow.status = "clawed-back";
        clawedBack.push(escrow.id);
      }
    }
    return immutable({ vested: vested.sort(), clawedBack: clawedBack.sort() });
  }

  recordRegression(
    contributionIds: readonly string[],
    receipt: HostReceipt,
  ): readonly string[] {
    requireHostReceipt(this.#gate, receipt, ["regression-recorded"], receipt.missionId);
    const targets = new Set(contributionIds);
    const clawedBack: string[] = [];
    for (const escrow of this.#escrows.values()) {
      if (escrow.status !== "vested" || !targets.has(escrow.contributionId)) continue;
      escrow.status = "clawed-back";
      escrow.settlementReceiptId = receipt.id;
      this.#balances.set(
        escrow.geneId,
        Math.max(0, this.balance(escrow.geneId) - escrow.amount),
      );
      clawedBack.push(escrow.id);
    }
    return Object.freeze(clawedBack.sort());
  }

  balance(geneId: string): number {
    return this.#balances.get(geneId) ?? 0;
  }

  reputation(context: FitnessContext): ReputationView {
    const records = [...this.#escrows.values()].filter((entry) =>
      entry.context.role === context.role &&
      entry.context.domain === context.domain &&
      entry.context.missionState === context.missionState
    );
    const vested = records.filter((entry) => entry.status === "vested");
    const vestedFitness = vested.reduce((sum, entry) => sum + entry.amount, 0);
    return Object.freeze({
      ...context,
      vestedFitness,
      vestedContributions: vested.length,
      attemptedContributions: records.length,
      reliability: records.length === 0 ? 0 : vested.length / records.length,
    });
  }

  entries(): readonly Readonly<CreditEscrow>[] {
    return immutable([...this.#escrows.values()]);
  }

  /** Restore reward and punishment from the host-authored append-only projection. */
  replay(events: readonly OrganismEvent[]): void {
    this.#escrows.clear();
    this.#balances.clear();
    for (const event of events) {
      if (event.type === "fitness.escrow-opened") {
        if (event.authority !== "organism") continue;
        const escrow = event.payload.escrow;
        if (!isCreditEscrow(escrow)) continue;
        this.#escrows.set(escrow.id, { ...escrow, status: "provisional" });
      } else if (event.type === "fitness.mission-settled") {
        if (event.authority !== "host") continue;
        this.#replaySettlement(event);
      } else if (event.type === "fitness.regression-recorded") {
        if (event.authority !== "host") continue;
        this.#replayRegression(event);
      }
    }
  }

  #replaySettlement(event: OrganismEvent): void {
    const vested = stringArray(event.payload.vestedEscrowIds);
    const clawedBack = stringArray(event.payload.clawedBackEscrowIds);
    const receiptId = event.hostReceiptId;
    if (receiptId === undefined) return;
    for (const id of vested) {
      const escrow = this.#escrows.get(id);
      if (!escrow || escrow.status !== "provisional") continue;
      escrow.status = "vested";
      escrow.settlementReceiptId = receiptId;
      this.#balances.set(escrow.geneId, this.balance(escrow.geneId) + escrow.amount);
    }
    for (const id of clawedBack) {
      const escrow = this.#escrows.get(id);
      if (!escrow || escrow.status !== "provisional") continue;
      escrow.status = "clawed-back";
      escrow.settlementReceiptId = receiptId;
    }
  }

  #replayRegression(event: OrganismEvent): void {
    const receiptId = event.hostReceiptId;
    if (receiptId === undefined) return;
    for (const id of stringArray(event.payload.clawedBackEscrowIds)) {
      const escrow = this.#escrows.get(id);
      if (!escrow || escrow.status !== "vested") continue;
      escrow.status = "clawed-back";
      escrow.settlementReceiptId = receiptId;
      this.#balances.set(
        escrow.geneId,
        Math.max(0, this.balance(escrow.geneId) - escrow.amount),
      );
    }
  }
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function isCreditEscrow(value: unknown): value is CreditEscrow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const escrow = value as Partial<CreditEscrow>;
  return typeof escrow.id === "string"
    && typeof escrow.missionId === "string"
    && typeof escrow.contributionId === "string"
    && typeof escrow.actorId === "string"
    && typeof escrow.geneId === "string"
    && typeof escrow.amount === "number"
    && typeof escrow.context === "object";
}
