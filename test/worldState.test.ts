import assert from "node:assert/strict";
import test from "node:test";
import { SharedWorldState } from "../src/worldState.ts";
import { AllowListHostGate, receipt } from "./helpers.ts";

test("HRR attention and transition predictions cannot become evidence", () => {
  const gate = new AllowListHostGate();
  const world = new SharedWorldState(gate);
  world.rememberAttention({
    key: "possible-schema",
    similarity: 0.91,
    channel: "semantic",
    authority: "none",
  });
  world.predictTransition({
    id: "prediction",
    actionClass: "compile",
    target: "criterion-pass",
    predictedValue: true,
    confidence: 0.7,
    modelVersion: "tabular-v1",
    authority: "none",
  });
  assert.equal(world.exact("possible-schema"), undefined);

  const observed = gate.allow(receipt("observed", "m", "transition-observed"));
  world.observeExact("criterion:solver", "pass", observed);
  assert.equal(world.exact("criterion:solver")?.authority, "host");
  assert.equal(world.snapshot().attention[0]?.authority, "none");
  assert.equal(world.snapshot().predictions[0]?.authority, "none");
});
