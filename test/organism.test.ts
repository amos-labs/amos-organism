import assert from "node:assert/strict";
import test from "node:test";
import { MemoryEventStore } from "../src/eventStore.ts";
import { OrganismKernel } from "../src/organism.ts";
import type { StrategyGeneSpec } from "../src/strategyGenes.ts";
import { AllowListHostGate, receipt } from "./helpers.ts";

test("only causally consumed contributions vest across missions", () => {
  const gate = new AllowListHostGate();
  const kernel = new OrganismKernel({
    hostGate: gate,
    fitnessPolicy: { provisionalCredit: () => 10 },
  });
  const geneReceipt = gate.allow(receipt("gene-ok", "mission-1", "gene-approved"));
  const gene = kernel.genes.register(
    {
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
    [],
    geneReceipt,
  );

  const allocation = gate.allow(receipt("allocation", "mission-1", "mission-allocation"));
  kernel.energy.allocate("mission-1", "builder-1", 100, allocation);
  kernel.energy.reserve("lease-1", "mission-1", "builder-1", 80);
  kernel.energy.settleReservation("lease-1", 60);

  const context = { role: "builder", domain: "terminal", missionState: "construction" };
  const expressionReceipt = gate.allow(
    receipt("expression-r", "mission-1", "gene-expressed"),
  );
  const expression = kernel.expressGenes(
    {
      missionId: "mission-1",
      role: "builder",
      phase: "construction",
      artifactClasses: ["solver"],
      failureModes: ["unknown-interface"],
      toolFamilies: ["shell"],
    },
    expressionReceipt,
  );
  assert.deepEqual(expression.selections.map(({ geneId }) => geneId), [gene.id]);
  kernel.recordContribution({
    id: "used-contribution",
    escrowId: "used-credit",
    missionId: "mission-1",
    actorId: "builder-1",
    geneId: gene.id,
    expressionId: expression.id,
    createdAt: "2026-08-24T00:01:00Z",
    context,
  });
  kernel.recordContribution({
    id: "unused-contribution",
    escrowId: "unused-credit",
    missionId: "mission-1",
    actorId: "builder-1",
    geneId: gene.id,
    expressionId: expression.id,
    createdAt: "2026-08-24T00:02:00Z",
    context,
  });
  assert.equal(kernel.fitness.balance(gene.id), 0, "provisional work cannot buy survival");

  const artifactReceipt = gate.allow(receipt("artifact-r", "mission-1", "artifact-harvested"));
  kernel.harvestArtifact(
    {
      id: "artifact-1",
      missionId: "mission-1",
      createdAt: "2026-08-24T00:03:00Z",
      contributionIds: ["used-contribution"],
    },
    artifactReceipt,
  );
  const decisionReceipt = gate.allow(receipt("decision-r", "mission-1", "decision-recorded"));
  kernel.recordDecision(
    {
      id: "decision-1",
      missionId: "mission-1",
      createdAt: "2026-08-24T00:04:00Z",
      consumedNodeIds: ["artifact-1"],
    },
    decisionReceipt,
  );
  const verificationReceipt = gate.allow(
    receipt("verify-r", "mission-1", "official-verification"),
  );
  const settlement = kernel.settle(
    {
      id: "verifier-1",
      missionId: "mission-1",
      createdAt: "2026-08-24T00:05:00Z",
      outcome: "pass",
      citedNodeIds: ["decision-1"],
      verifiedQuality: 1,
    },
    verificationReceipt,
  );

  assert.deepEqual(settlement.eligibleContributionIds, ["used-contribution"]);
  assert.deepEqual(settlement.vestedEscrowIds, ["used-credit"]);
  assert.deepEqual(settlement.clawedBackEscrowIds, ["unused-credit"]);
  assert.equal(kernel.fitness.balance(gene.id), 10);
  assert.equal(kernel.energy.snapshot("mission-1", "builder-1").available, 0);
  assert.deepEqual(kernel.genes.outcomes(gene.id), [
    {
      geneId: gene.id,
      missionId: "mission-1",
      verifiedQuality: 1,
      fitnessVested: 10,
      verifierOutcome: "pass",
      receiptId: "verify-r",
    },
  ]);
  assert.deepEqual(kernel.fitness.reputation(context), {
    ...context,
    vestedFitness: 10,
    vestedContributions: 1,
    attemptedContributions: 2,
    reliability: 0.5,
  });
});

test("a model cannot claim credit for a gene the host did not express", () => {
  const gate = new AllowListHostGate();
  const kernel = new OrganismKernel({ hostGate: gate });
  const approved = gate.allow(receipt("gene", "mission-1", "gene-approved"));
  const gene = kernel.genes.register(
    {
      name: "bounded-repair",
      preconditions: {
        phases: ["repair"],
        artifactClasses: ["solver"],
        failureModes: ["failed-check"],
        toolFamilies: ["editor"],
      },
      rolePolicy: { builder: ["editor"] },
      retrievalRecipe: [],
      procedure: ["repair the cited gap"],
      stopConditions: ["verifier passes"],
      rightsTags: ["amos-owned"],
      contaminationTags: [],
    },
    [],
    approved,
  );

  assert.throws(() => kernel.recordContribution({
    id: "forged-contribution",
    escrowId: "forged-credit",
    missionId: "mission-1",
    actorId: "builder",
    geneId: gene.id,
    expressionId: "model-claimed-expression",
    createdAt: "2026-08-24T00:00:00Z",
    context: { role: "builder", domain: "terminal", missionState: "repair" },
  }), /Unknown gene expression/);
});

test("an untrusted verification cannot vest model-authored progress", () => {
  const gate = new AllowListHostGate();
  const kernel = new OrganismKernel({ hostGate: gate });
  const untrusted = receipt("fake", "mission-x", "official-verification");
  assert.throws(
    () => kernel.fitness.settleMission("mission-x", [], untrusted, "pass"),
    /Untrusted host receipt/,
  );
});

test("a passing mission that did not consume an expressed gene is uncredited, not failed", () => {
  const gate = new AllowListHostGate();
  const kernel = new OrganismKernel({ hostGate: gate });
  const gene = kernel.genes.register(
    testGeneSpec(),
    [],
    gate.allow(receipt("gene-uncredited", "seed", "gene-approved")),
  );
  const expression = kernel.expressGenes(
    selectionContext("mission-uncredited"),
    gate.allow(receipt("expression-uncredited", "mission-uncredited", "gene-expressed")),
  );
  kernel.recordContribution({
    id: "unused-contribution",
    escrowId: "unused-escrow",
    missionId: "mission-uncredited",
    actorId: "builder",
    geneId: gene.id,
    expressionId: expression.id,
    createdAt: "2026-08-24T00:01:00Z",
    context: { role: "builder", domain: "terminal", missionState: "construction" },
  });
  kernel.settle(
    {
      id: "verifier-uncredited",
      missionId: "mission-uncredited",
      createdAt: "2026-08-24T00:02:00Z",
      outcome: "pass",
      citedNodeIds: [],
      verifiedQuality: 1,
    },
    gate.allow(receipt("verify-uncredited", "mission-uncredited", "official-verification")),
  );

  assert.equal(kernel.genes.outcomes(gene.id)[0]?.verifierOutcome, "uncredited");
  const next = kernel.expressGenes(
    selectionContext("mission-next"),
    gate.allow(receipt("expression-next", "mission-next", "gene-expressed")),
  );
  assert.equal(next.selections[0]?.mode, "guide");
});

test("regression punishment and fitness balances survive a restart", () => {
  const gate = new AllowListHostGate();
  const store = new MemoryEventStore();
  const kernel = new OrganismKernel({
    hostGate: gate,
    eventStore: store,
    fitnessPolicy: { provisionalCredit: () => 10 },
  });
  const geneReceipt = gate.allow(receipt("durable-gene", "seed", "gene-approved"));
  const gene = kernel.genes.register(testGeneSpec(), [], geneReceipt);
  store.append({
    id: "durable-gene-admitted",
    type: "gene.admitted",
    missionId: "seed",
    occurredAt: gene.createdAt,
    authority: "host",
    hostReceiptId: geneReceipt.id,
    payload: { gene },
  });
  const expression = kernel.expressGenes(
    selectionContext("mission-original"),
    gate.allow(receipt("durable-expression", "mission-original", "gene-expressed")),
  );
  kernel.recordContribution({
    id: "durable-contribution",
    escrowId: "durable-escrow",
    missionId: "mission-original",
    actorId: "builder",
    geneId: gene.id,
    expressionId: expression.id,
    createdAt: "2026-08-24T00:01:00Z",
    context: { role: "builder", domain: "terminal", missionState: "construction" },
  });
  const artifactReceipt = gate.allow(
    receipt("durable-artifact-receipt", "mission-original", "artifact-harvested"),
  );
  kernel.harvestArtifact(
    {
      id: "durable-artifact",
      missionId: "mission-original",
      createdAt: "2026-08-24T00:02:00Z",
      contributionIds: ["durable-contribution"],
    },
    artifactReceipt,
  );
  kernel.settle(
    {
      id: "durable-verifier",
      missionId: "mission-original",
      createdAt: "2026-08-24T00:03:00Z",
      outcome: "pass",
      citedNodeIds: ["durable-artifact"],
      verifiedQuality: 0.9,
    },
    gate.allow(receipt("durable-verification", "mission-original", "official-verification")),
  );
  assert.equal(kernel.fitness.balance(gene.id), 10);

  const regression = kernel.recordRegression(
    ["durable-contribution"],
    gate.allow(receipt("durable-regression", "mission-regression", "regression-recorded")),
  );
  assert.deepEqual(regression.clawedBackEscrowIds, ["durable-escrow"]);
  assert.equal(kernel.fitness.balance(gene.id), 0);

  const restarted = new OrganismKernel({ hostGate: gate, replayEvents: store.events() });
  assert.equal(restarted.fitness.balance(gene.id), 0);
  assert.equal(restarted.fitness.entries()[0]?.status, "clawed-back");
  assert.equal(restarted.genes.outcomes(gene.id).at(-1)?.verifierOutcome, "fail");
});

function testGeneSpec(): StrategyGeneSpec {
  return {
    name: "inspect-then-build",
    preconditions: {
      phases: ["construction"],
      artifactClasses: ["solver"],
      failureModes: [],
      toolFamilies: ["shell"],
    },
    rolePolicy: { builder: ["shell"] },
    retrievalRecipe: ["retrieve exact evidence"],
    procedure: ["inspect", "build", "verify"],
    stopConditions: ["official verifier passes"],
    rightsTags: ["amos-owned"],
    contaminationTags: [],
  };
}

function selectionContext(missionId: string) {
  return {
    missionId,
    role: "builder",
    phase: "construction",
    artifactClasses: ["solver"],
    failureModes: [] as string[],
    toolFamilies: ["shell"],
  };
}
