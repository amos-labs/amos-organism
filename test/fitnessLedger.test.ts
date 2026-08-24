import assert from "node:assert/strict";
import test from "node:test";
import { FitnessLedger } from "../src/fitnessLedger.ts";
import { AllowListHostGate, receipt } from "./helpers.ts";

test("a later host-observed regression claws back vested fitness", () => {
  const gate = new AllowListHostGate();
  const ledger = new FitnessLedger(gate);
  ledger.openEscrow({
    id: "credit-1",
    missionId: "m1",
    contributionId: "c1",
    actorId: "builder",
    geneId: "gene-1",
    amount: 7,
    context: { role: "builder", domain: "code", missionState: "repair" },
  });
  const verification = gate.allow(receipt("verify", "m1", "official-verification"));
  ledger.settleMission("m1", ["c1"], verification, "pass");
  assert.equal(ledger.balance("gene-1"), 7);

  const regression = gate.allow(receipt("regression", "m2", "regression-recorded"));
  assert.deepEqual(ledger.recordRegression(["c1"], regression), ["credit-1"]);
  assert.equal(ledger.balance("gene-1"), 0);
});

test("a failed mission claws back every provisional credit", () => {
  const gate = new AllowListHostGate();
  const ledger = new FitnessLedger(gate);
  ledger.openEscrow({
    id: "credit",
    missionId: "m",
    contributionId: "c",
    actorId: "worker",
    geneId: "gene",
    amount: 100,
    context: { role: "builder", domain: "ops", missionState: "construction" },
  });
  const verification = gate.allow(receipt("verify-fail", "m", "official-verification"));
  const result = ledger.settleMission("m", ["c"], verification, "fail");
  assert.deepEqual(result.vested, []);
  assert.deepEqual(result.clawedBack, ["credit"]);
  assert.equal(ledger.balance("gene"), 0);
});

test("one contribution cannot mint multiple escrows", () => {
  const gate = new AllowListHostGate();
  const ledger = new FitnessLedger(gate);
  const entry = {
    missionId: "m",
    contributionId: "c",
    actorId: "worker",
    geneId: "gene",
    amount: 1,
    context: { role: "builder", domain: "ops", missionState: "construction" },
  };
  ledger.openEscrow({ ...entry, id: "first" });
  assert.throws(
    () => ledger.openEscrow({ ...entry, id: "second" }),
    /already has an escrow/,
  );
});
