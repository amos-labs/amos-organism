export type HostReceiptKind =
  | "mission-allocation"
  | "artifact-harvested"
  | "decision-recorded"
  | "official-verification"
  | "regression-recorded"
  | "gene-approved"
  | "trace-imported"
  | "transition-observed"
  | "gene-expressed"
  | "candidate-evaluated";

export interface HostReceipt {
  readonly id: string;
  readonly missionId: string;
  readonly kind: HostReceiptKind;
  readonly issuedAt: string;
  readonly payloadDigest: string;
  readonly authority: "host";
}

export interface HostGate {
  verify(receipt: HostReceipt): boolean;
}

export function requireHostReceipt(
  gate: HostGate,
  receipt: HostReceipt,
  allowedKinds: readonly HostReceiptKind[],
  missionId?: string,
): void {
  if (receipt.authority !== "host" || !gate.verify(receipt)) {
    throw new Error(`Untrusted host receipt: ${receipt.id}`);
  }
  if (!allowedKinds.includes(receipt.kind)) {
    throw new Error(`Receipt ${receipt.id} has disallowed kind ${receipt.kind}`);
  }
  if (missionId !== undefined && receipt.missionId !== missionId) {
    throw new Error(`Receipt ${receipt.id} belongs to a different mission`);
  }
}
