import type { HostGate, HostReceipt } from "./host.ts";
import { requireHostReceipt } from "./host.ts";

interface EnergyAccount {
  available: number;
  reserved: number;
  spent: number;
}

interface Reservation {
  readonly id: string;
  readonly missionId: string;
  readonly actorId: string;
  readonly amount: number;
  status: "open" | "settled";
}

export interface EnergySnapshot {
  readonly missionId: string;
  readonly actorId: string;
  readonly available: number;
  readonly reserved: number;
  readonly spent: number;
}

function accountKey(missionId: string, actorId: string): string {
  return `${missionId}\u0000${actorId}`;
}

/** Mission-scoped compute rights. Energy never becomes cross-mission fitness. */
export class EnergyLedger {
  readonly #gate: HostGate;
  readonly #accounts = new Map<string, EnergyAccount>();
  readonly #reservations = new Map<string, Reservation>();

  constructor(gate: HostGate) {
    this.#gate = gate;
  }

  allocate(
    missionId: string,
    actorId: string,
    amount: number,
    receipt: HostReceipt,
  ): EnergySnapshot {
    requireHostReceipt(this.#gate, receipt, ["mission-allocation"], missionId);
    assertPositive(amount, "allocation");
    const key = accountKey(missionId, actorId);
    const account = this.#accounts.get(key) ?? { available: 0, reserved: 0, spent: 0 };
    account.available += amount;
    this.#accounts.set(key, account);
    return this.snapshot(missionId, actorId);
  }

  reserve(
    reservationId: string,
    missionId: string,
    actorId: string,
    amount: number,
  ): EnergySnapshot {
    assertPositive(amount, "reservation");
    if (this.#reservations.has(reservationId)) {
      throw new Error(`Duplicate reservation: ${reservationId}`);
    }
    const account = this.#requireAccount(missionId, actorId);
    if (account.available < amount) {
      throw new Error(`Insufficient energy for ${actorId}`);
    }
    account.available -= amount;
    account.reserved += amount;
    this.#reservations.set(reservationId, {
      id: reservationId,
      missionId,
      actorId,
      amount,
      status: "open",
    });
    return this.snapshot(missionId, actorId);
  }

  settleReservation(reservationId: string, spent: number): EnergySnapshot {
    const reservation = this.#reservations.get(reservationId);
    if (!reservation || reservation.status !== "open") {
      throw new Error(`Unknown or settled reservation: ${reservationId}`);
    }
    if (spent < 0 || spent > reservation.amount) {
      throw new RangeError("Spent energy must be within the reservation");
    }
    const account = this.#requireAccount(reservation.missionId, reservation.actorId);
    account.reserved -= reservation.amount;
    account.spent += spent;
    account.available += reservation.amount - spent;
    reservation.status = "settled";
    return this.snapshot(reservation.missionId, reservation.actorId);
  }

  snapshot(missionId: string, actorId: string): EnergySnapshot {
    const account = this.#accounts.get(accountKey(missionId, actorId)) ?? {
      available: 0,
      reserved: 0,
      spent: 0,
    };
    return Object.freeze({ missionId, actorId, ...account });
  }

  closeMission(missionId: string): readonly EnergySnapshot[] {
    const snapshots: EnergySnapshot[] = [];
    for (const reservation of this.#reservations.values()) {
      if (reservation.missionId === missionId && reservation.status === "open") {
        this.settleReservation(reservation.id, 0);
      }
    }
    for (const [key, account] of this.#accounts) {
      const [accountMissionId, actorId] = key.split("\u0000");
      if (accountMissionId === missionId && actorId !== undefined) {
        snapshots.push(Object.freeze({ missionId, actorId, ...account }));
        this.#accounts.delete(key);
      }
    }
    return Object.freeze(snapshots);
  }

  #requireAccount(missionId: string, actorId: string): EnergyAccount {
    const account = this.#accounts.get(accountKey(missionId, actorId));
    if (!account) {
      throw new Error(`No energy allocation for ${actorId} in ${missionId}`);
    }
    return account;
  }
}

function assertPositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number`);
  }
}
