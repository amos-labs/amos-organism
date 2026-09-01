import assert from "node:assert/strict";
import test from "node:test";
import { MemoryEventStore } from "../src/eventStore.ts";
import { StrategyGeneArchive } from "../src/strategyGenes.ts";
import { TraceIntake, type AmosAwsTrace } from "../src/traceIntake.ts";
import { AllowListHostGate, receipt } from "./helpers.ts";

const runId = "recursive-organism-active-hrr-energy-production-planning-20260824-r1";

test("both AWS execution failures become non-vesting negative experience", () => {
  const gate = new AllowListHostGate();
  const store = new MemoryEventStore();
  const genes = new StrategyGeneArchive(gate);
  const intake = new TraceIntake(gate, store, genes);
  const failures: AmosAwsTrace[] = [
    failedTrace(
      "cda902a0-782e-4df9-9a63-cb71021c5938",
      "Task swarm exhausted construction cycles; task board phase is 'construction-checkpoint-2'",
    ),
    failedTrace(
      "4a3b0a1c-671c-4065-8f27-19db75ec3eca",
      "Verifier did not create /tmp/amos_swarm/preflight_verdict.json",
    ),
  ];

  for (const [index, trace] of failures.entries()) {
    const imported = gate.allow(
      receipt(`trace-import-${index + 1}`, runId, "trace-imported"),
    );
    const result = intake.ingest(trace, imported);
    assert.equal(result.classification, "negative");
    assert.equal(result.geneCandidate, null);
  }

  assert.equal(genes.list().length, 0);
  const negative = store.events().filter((event) => event.type === "experience.negative");
  assert.equal(negative.length, 2);
  assert.ok(negative.every((event) => event.payload.fitnessVested === 0));
  assert.ok(negative.every((event) => event.payload.geneAdmissionAllowed === false));
});

test("a verified trace yields a candidate but needs separate host admission", () => {
  const gate = new AllowListHostGate();
  const store = new MemoryEventStore();
  const genes = new StrategyGeneArchive(gate);
  const intake = new TraceIntake(gate, store, genes);
  const trace: AmosAwsTrace = {
    runId: "verified-run",
    trialId: "verified-trial",
    taskName: "terminal-bench/example",
    taskFamily: "terminal",
    startedAt: "2026-08-24T00:00:00Z",
    finishedAt: "2026-08-24T00:10:00Z",
    outcome: { kind: "verified-success", score: 1 },
    trainingEligibility: { eligible: true, reasons: [] },
    verifier: { status: "pass", evidenceRefs: ["verifier-receipt"] },
    artifactReceiptIds: ["artifact-receipt"],
    procedure: {
      spec: {
        name: "inspect-then-compile",
        preconditions: {
          phases: ["construction"],
          artifactClasses: ["solver"],
          failureModes: ["unknown-interface"],
          toolFamilies: ["shell"],
        },
        rolePolicy: { builder: ["shell", "editor"] },
        retrievalRecipe: ["retrieve exact interface observations"],
        procedure: ["inspect interface", "compile smallest valid artifact"],
        stopConditions: ["official verifier passes"],
        rightsTags: ["amos-owned"],
        contaminationTags: [],
      },
      parentIds: [],
      evidenceRefs: ["artifact-receipt", "verifier-receipt"],
    },
    rightsTags: ["amos-owned"],
    contaminationTags: [],
  };
  const imported = gate.allow(receipt("trace-import", trace.runId, "trace-imported"));
  const result = intake.ingest(trace, imported);
  assert.equal(result.classification, "verified");
  assert.notEqual(result.geneCandidate, null);
  assert.equal(genes.list().length, 0, "intake must not self-admit a procedure");

  const approval = gate.allow(receipt("gene-approval", trace.runId, "gene-approved"));
  const gene = intake.admit(result.geneCandidate!, approval);
  assert.equal(genes.list()[0]?.id, gene.id);
  assert.equal(store.events().at(-1)?.type, "gene.admitted");

  const eventCount = store.events().length;
  const retried = intake.ingest(
    trace,
    gate.allow(receipt("trace-import-retry", trace.runId, "trace-imported")),
  );
  assert.equal(retried.geneCandidate?.id, result.geneCandidate?.id);
  assert.equal(store.events().length, eventCount, "identical intake is idempotent");
  assert.equal(intake.admit(result.geneCandidate!, approval).id, gene.id);
  assert.equal(store.events().length, eventCount, "identical admission is idempotent");
});

function failedTrace(trialId: string, message: string): AmosAwsTrace {
  return {
    runId,
    trialId,
    taskName: "terminal-bench/production-planning",
    taskFamily: "terminal",
    startedAt: "2026-08-24T13:52:00Z",
    finishedAt: "2026-08-24T14:44:00Z",
    outcome: { kind: "execution-error", score: null },
    trainingEligibility: {
      eligible: false,
      reasons: [
        "execution-not-completed",
        "independent-verifier-not-run",
        "verifier-evidence-missing",
        "artifact-receipt-missing",
      ],
    },
    verifier: null,
    artifactReceiptIds: [],
    procedure: null,
    exception: { type: "RuntimeError", message },
    rightsTags: ["amos-owned"],
    contaminationTags: ["development-visible-benchmark"],
  };
}
