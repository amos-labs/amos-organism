import assert from "node:assert/strict";
import test from "node:test";
import { valueOfComputation } from "../src/valueOfComputation.ts";

const baseline = {
  basis: "vested" as const,
  currentVerifiedQuality: 0.5,
  requiredQualityFloor: 0.9,
  expectedVestedQualityGain: 0.1,
  expectedUncertaintyReduction: 0.1,
  tokenCost: 0.2,
  delayCost: 0.2,
  regressionRisk: 0.05,
  remainingEnergy: 100,
  stalledWindows: 0,
  pendingHostVerification: false,
  authorityConstraintsSatisfied: true,
};

test("quality is lexicographic: slow expected progress below the floor continues", () => {
  const decision = valueOfComputation(baseline);
  assert.equal(decision.action, "continue");
  assert.ok(decision.netValue < 0, "efficiency may be negative without defeating the quality floor");
});

test("fast but non-improving work is challenged rather than rewarded", () => {
  const decision = valueOfComputation({
    ...baseline,
    currentVerifiedQuality: 0.95,
    expectedVestedQualityGain: 0,
    tokenCost: 0.001,
    delayCost: 0.001,
    stalledWindows: 2,
  });
  assert.equal(decision.action, "challenge");
});

test("host authority constraints fail closed", () => {
  assert.equal(
    valueOfComputation({ ...baseline, authorityConstraintsSatisfied: false }).action,
    "stop",
  );
});

test("negative cost cannot be used to manufacture computation value", () => {
  assert.throws(
    () => valueOfComputation({ ...baseline, tokenCost: -1 }),
    /tokenCost must be a non-negative/,
  );
});
