import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { digest } from "../src/digest.ts";
import { FileEventStore } from "../src/eventStore.ts";
import type { HostGate, HostReceipt } from "../src/host.ts";
import { StrategyGeneArchive } from "../src/strategyGenes.ts";
import { TraceIntake, type AmosAwsTrace } from "../src/traceIntake.ts";

interface TraceBundle {
  readonly schema: "amos.organism-trace-bundle";
  readonly version: 1;
  readonly source: Readonly<Record<string, unknown>>;
  readonly entries: readonly {
    readonly receipt: HostReceipt;
    readonly trace: AmosAwsTrace;
  }[];
  readonly approvals?: readonly {
    readonly trialId: string;
    readonly receipt: HostReceipt;
  }[];
}

class BundleGate implements HostGate {
  readonly #receipts: ReadonlyMap<string, HostReceipt>;

  constructor(receipts: readonly HostReceipt[]) {
    this.#receipts = new Map(receipts.map((receipt) => [receipt.id, receipt]));
  }

  verify(receipt: HostReceipt): boolean {
    return JSON.stringify(this.#receipts.get(receipt.id)) === JSON.stringify(receipt);
  }
}

const [inputArgument, outputArgument] = process.argv.slice(2);
if (!inputArgument || !outputArgument) {
  throw new Error("Usage: node scripts/importTraceBundle.ts INPUT.json OUTPUT.jsonl");
}
const input = resolve(inputArgument);
const output = resolve(outputArgument);
if (existsSync(output)) throw new Error(`Refusing to overwrite existing event ledger: ${output}`);
const bundle = JSON.parse(readFileSync(input, "utf8")) as TraceBundle;
if (bundle.schema !== "amos.organism-trace-bundle" || bundle.version !== 1) {
  throw new Error("Unsupported trace bundle");
}
for (const entry of bundle.entries) {
  if (entry.receipt.kind !== "trace-imported" || entry.receipt.payloadDigest !== digest(entry.trace)) {
    throw new Error(`Trace bundle digest mismatch for ${entry.trace.trialId}`);
  }
}

const gate = new BundleGate([
  ...bundle.entries.map((entry) => entry.receipt),
  ...(bundle.approvals ?? []).map((approval) => approval.receipt),
]);
const store = new FileEventStore(output);
const genes = new StrategyGeneArchive(gate);
const intake = new TraceIntake(gate, store, genes);
const results = bundle.entries.map((entry) => intake.ingest(entry.trace, entry.receipt));
for (const [index, result] of results.entries()) {
  if (result.geneCandidate === null) continue;
  const trialId = bundle.entries[index]?.trace.trialId;
  const approval = bundle.approvals?.find((item) => item.trialId === trialId);
  if (!approval) continue;
  const expectedApprovalDigest = digest({
    candidateId: result.geneCandidate.id,
    evidenceRefs: result.geneCandidate.evidenceRefs,
  });
  if (
    approval.receipt.kind !== "gene-approved" ||
    approval.receipt.payloadDigest !== expectedApprovalDigest
  ) {
    throw new Error(`Gene approval digest mismatch for ${trialId}`);
  }
  intake.admit(result.geneCandidate, approval.receipt);
}
process.stdout.write(`${JSON.stringify({
  output,
  imported: results.length,
  verified: results.filter((result) => result.classification === "verified").length,
  negative: results.filter((result) => result.classification === "negative").length,
  geneCandidates: results.filter((result) => result.geneCandidate !== null).length,
  admittedGenes: genes.list().length,
  events: store.events().length,
}, null, 2)}\n`);
