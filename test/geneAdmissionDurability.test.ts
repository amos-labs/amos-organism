import test from "node:test";
import assert from "node:assert/strict";

import {
  MemoryEventStore,
  OrganismKernel,
  StrategyGeneArchive,
  TraceIntake,
  type StrategyGeneSpec,
} from "../src/index.ts";
import { AllowListHostGate, receipt } from "./helpers.ts";

function spec(name = "bounded-provider-recovery"): StrategyGeneSpec {
  return {
    name,
    preconditions: { phases: ["execute"], artifactClasses: [], failureModes: ["provider-error"], toolFamilies: [] },
    rolePolicy: {},
    retrievalRecipe: [],
    procedure: ["retry once with the same request", "switch provider on second failure"],
    stopConditions: ["two failures"],
    rightsTags: ["amos-owned"],
    contaminationTags: [],
  };
}

test("kernel-registered genes are written as gene.admitted and survive a restart", () => {
  const gate = new AllowListHostGate();
  const store = new MemoryEventStore();
  const kernel = new OrganismKernel({ hostGate: gate, eventStore: store });
  const approval = gate.allow(receipt("approval-1", "m1", "gene-approved"));
  const gene = kernel.genes.register(spec(), [], approval);

  const admitted = store.events().filter((event) => event.type === "gene.admitted");
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0]?.authority, "host");
  assert.equal(admitted[0]?.hostReceiptId, approval.id);
  assert.equal((admitted[0]?.payload.gene as { id: string }).id, gene.id);

  const restarted = new OrganismKernel({ hostGate: gate, eventStore: store });
  assert.deepEqual(restarted.genes.list().map((item) => item.id), [gene.id]);
  assert.equal(restarted.genes.require(gene.id).digest, gene.digest);
});

test("re-registering an identical gene does not append a second admission", () => {
  const gate = new AllowListHostGate();
  const store = new MemoryEventStore();
  const archive = new StrategyGeneArchive(gate, store);
  const approval = gate.allow(receipt("approval-2", "m2", "gene-approved"));
  const first = archive.register(spec(), [], approval);
  const second = archive.register(spec(), [], approval);
  assert.equal(first.id, second.id);
  assert.equal(store.events().length, 1);
});

test("trace intake admission through a store-backed archive emits exactly one gene.admitted event", () => {
  const gate = new AllowListHostGate();
  const store = new MemoryEventStore();
  const archive = new StrategyGeneArchive(gate, store);
  const intake = new TraceIntake(gate, store, archive);
  const imported = gate.allow(receipt("trace-1", "run-1", "trace-imported"));
  const result = intake.ingest({
    runId: "run-1",
    trialId: "trial-1",
    taskName: "task",
    taskFamily: "family",
    startedAt: "2026-08-24T00:00:00.000Z",
    finishedAt: "2026-08-24T00:01:00.000Z",
    outcome: { kind: "verified-success", score: 1 },
    trainingEligibility: { eligible: true, reasons: [] },
    verifier: { status: "pass", evidenceRefs: ["sha256:evidence"] },
    artifactReceiptIds: ["artifact-1"],
    procedure: {
      schema: "amos.strategy-gene-procedure",
      schemaVersion: 1,
      spec: spec("typed-tool-recovery"),
      parentIds: [],
      evidenceRefs: ["sha256:evidence"],
    },
    rightsTags: ["amos-owned"],
    contaminationTags: [],
  }, imported);
  assert.ok(result.geneCandidate);
  const approval = gate.allow(receipt("approval-3", "run-1", "gene-approved"));
  const gene = intake.admit(result.geneCandidate, approval);
  const admitted = store.events().filter((event) => event.type === "gene.admitted");
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0]?.id, `gene:admitted:${result.geneCandidate.id}`);
  assert.equal((admitted[0]?.payload.gene as { id: string }).id, gene.id);

  const restarted = new StrategyGeneArchive(gate);
  restarted.replay(store.events());
  assert.equal(restarted.list().length, 1);
});
