import type { HostGate, HostReceipt, HostReceiptKind } from "../src/host.ts";

export class AllowListHostGate implements HostGate {
  readonly #ids = new Set<string>();

  allow(receipt: HostReceipt): HostReceipt {
    this.#ids.add(receipt.id);
    return receipt;
  }

  verify(receipt: HostReceipt): boolean {
    return this.#ids.has(receipt.id);
  }
}

export function receipt(
  id: string,
  missionId: string,
  kind: HostReceiptKind,
): HostReceipt {
  return Object.freeze({
    id,
    missionId,
    kind,
    issuedAt: "2026-08-24T00:00:00.000Z",
    payloadDigest: `digest:${id}`,
    authority: "host",
  });
}
