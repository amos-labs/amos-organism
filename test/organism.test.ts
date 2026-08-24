import assert from "node:assert/strict";
import test from "node:test";
import { OrganismKernel } from "../src/organism.ts";
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
  kernel.recordContribution({
    id: "used-contribution",
    escrowId: "used-credit",
    missionId: "mission-1",
    actorId: "builder-1",
    geneId: gene.id,
    createdAt: "2026-08-24T00:01:00Z",
    context,
  });
  kernel.recordContribution({
    id: "unused-contribution",
    escrowId: "unused-credit",
    missionId: "mission-1",
    actorId: "builder-1",
    geneId: gene.id,
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

test("an untrusted verification cannot vest model-authored progress", () => {
  const gate = new AllowListHostGate();
  const kernel = new OrganismKernel({ hostGate: gate });
  const untrusted = receipt("fake", "mission-x", "official-verification");
  assert.throws(
    () => kernel.fitness.settleMission("mission-x", [], untrusted, "pass"),
    /Untrusted host receipt/,
  );
});
