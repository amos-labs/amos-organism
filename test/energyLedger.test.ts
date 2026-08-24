import assert from "node:assert/strict";
import test from "node:test";
import { EnergyLedger } from "../src/energyLedger.ts";
import { AllowListHostGate, receipt } from "./helpers.ts";

test("energy resets at mission end and never carries into fitness", () => {
  const gate = new AllowListHostGate();
  const ledger = new EnergyLedger(gate);
  const allocation = gate.allow(receipt("allocation", "m", "mission-allocation"));
  ledger.allocate("m", "worker", 20, allocation);
  ledger.reserve("lease", "m", "worker", 15);
  ledger.settleReservation("lease", 10);
  assert.deepEqual(ledger.snapshot("m", "worker"), {
    missionId: "m",
    actorId: "worker",
    available: 10,
    reserved: 0,
    spent: 10,
  });
  assert.deepEqual(ledger.closeMission("m"), [{
    missionId: "m",
    actorId: "worker",
    available: 10,
    reserved: 0,
    spent: 10,
  }]);
  assert.equal(ledger.snapshot("m", "worker").available, 0);
});
