import assert from "node:assert/strict";
import test from "node:test";
import { PheromoneField } from "../src/pheromoneField.ts";
import { AllowListHostGate, receipt } from "./helpers.ts";

test("pheromones are contextual, typed, and decay without becoming authority", () => {
  const gate = new AllowListHostGate();
  const field = new PheromoneField(gate);
  const hostReceipt = gate.allow(receipt("signal-r", "m", "artifact-harvested"));
  const context = {
    phase: "construction",
    artifactClass: "solver",
    failureMode: "schema-incomplete",
    toolFamily: "python",
  };
  field.deposit(
    {
      id: "signal",
      missionId: "m",
      kind: "inhibition",
      context,
      intensity: 1,
      confidence: 0.8,
      depositedAtMs: 1_000,
      halfLifeMs: 1_000,
      ttlMs: 10_000,
      receiptId: hostReceipt.id,
      authority: "host",
    },
    hostReceipt,
  );

  assert.equal(field.sense(context, 2_000)[0]?.currentIntensity, 0.4);
  assert.deepEqual(
    field.sense({ ...context, failureMode: "dependency-missing" }, 2_000),
    [],
    "a local Python failure must not repel Python globally",
  );
});
