import test from "node:test";
import assert from "node:assert/strict";
import { digestResearchValue } from "../src/experimentProtocol.js";
import {
  createAdapterCandidate,
  holdoutGateFromComparison,
  nextAdapterAction,
  recordAdapterGate,
  recordHostAdapterGate,
  validateAdapterCandidate
} from "../src/adapterCandidates.js";

function candidate() {
  return createAdapterCandidate({
    id: "stage1-r3-implicit-r32-s20260905",
    contractId: "stage1-20260904-r3-implicit-r32-s20260905",
    contractDigest: "a".repeat(64),
    rank: 32,
    seed: 20260905,
    trainingResultDigest: "b".repeat(64),
    adapterUri: "s3://bucket/stage1/run/runs/contract/adapter",
    baseModel: "amos-qwen38-27b-fp8",
    trainingTreatments: ["amos-native-stage1-implicit-curriculum-v1"],
    createdAt: new Date("2026-09-05T00:00:00Z")
  });
}

function comparison(wins, losses, lift) {
  const base = {
    schema: "amos.curriculum-grading-comparison", version: 1,
    control: { modelId: "base-bf16", reportDigest: "c".repeat(64), passRate: 0.7 },
    scenarioCount: 48, pools: ["holdout"],
    candidates: [{ modelId: "implicit-r32-s3", reportDigest: "d".repeat(64), passRateLift: lift, firstAttemptPassRateLift: 0.2, pairedWins: wins, pairedLosses: losses, ties: 48 - wins - losses, perFamilyLift: {} }],
    interpretation: {}
  };
  return { ...base, digest: digestResearchValue(base) };
}

test("an adapter candidate advances through trained and both holdout gates and unlocks shadow only after the sealed holdout", () => {
  let c = candidate();
  assert.equal(c.nextGate, "trained");
  assert.equal(nextAdapterAction(c).kind, "adapter-training-result");
  c = recordAdapterGate(c, { id: "trained", status: "passed", evaluator: "disposable-trainer", receiptDigest: "b".repeat(64), metrics: { epochs: 3 } });
  c = recordAdapterGate(c, holdoutGateFromComparison({ gateId: "frozen-holdout", comparison: comparison(13, 0, 0.27), adapterModelId: "implicit-r32-s3" }));
  assert.equal(c.deployment.shadowAllowed, false);
  c = recordAdapterGate(c, holdoutGateFromComparison({ gateId: "sealed-holdout", comparison: comparison(9, 2, 0.1), adapterModelId: "implicit-r32-s3" }));
  assert.equal(c.deployment.shadowAllowed, true);
  assert.equal(c.nextGate, "shadow");
  assert.equal(validateAdapterCandidate(c).gates.length, 3);
});

test("a holdout comparison where the adapter loses more than it wins rejects the candidate", () => {
  let c = recordAdapterGate(candidate(), { id: "trained", status: "passed", evaluator: "disposable-trainer", receiptDigest: "b".repeat(64), metrics: {} });
  c = recordAdapterGate(c, holdoutGateFromComparison({ gateId: "frozen-holdout", comparison: comparison(1, 8, -0.15), adapterModelId: "implicit-r32-s3" }));
  assert.equal(c.status, "rejected");
  assert.ok(c.feedback.some(({ signal }) => signal === "adapter-loses-more-paired-scenarios-than-it-wins"));
  assert.throws(() => recordAdapterGate(c, { id: "sealed-holdout", status: "passed", evaluator: "amos-executable-contract-verifier", receiptDigest: "e".repeat(64) }), /already rejected/);
});

test("canary and promotion cannot be recorded without a host receipt that attests the gate", () => {
  let c = candidate();
  for (const gate of [
    { id: "trained", status: "passed", evaluator: "disposable-trainer", receiptDigest: "b".repeat(64) },
    holdoutGateFromComparison({ gateId: "frozen-holdout", comparison: comparison(10, 1, 0.2), adapterModelId: "implicit-r32-s3" }),
    holdoutGateFromComparison({ gateId: "sealed-holdout", comparison: comparison(10, 1, 0.2), adapterModelId: "implicit-r32-s3" }),
    { id: "shadow", status: "passed", evaluator: "mission-verifier", receiptDigest: "f".repeat(64), metrics: { turns: 200 } }
  ]) c = recordAdapterGate(c, gate);
  assert.equal(c.nextGate, "canary");
  assert.equal(c.deployment.canaryAllowed, true);
  const canaryGate = { id: "canary", status: "passed", evaluator: "canary-telemetry-verifier", receiptDigest: "1".repeat(64) };
  assert.throws(() => recordAdapterGate(c, canaryGate), /requires a host receipt/);
  assert.throws(() => recordHostAdapterGate(c, canaryGate, { id: "r", authority: "organism", payloadDigest: "1".repeat(64) }), /host receipt/);
  assert.throws(() => recordHostAdapterGate(c, canaryGate, { id: "r", authority: "host", payloadDigest: "2".repeat(64) }), /does not attest/);
  c = recordHostAdapterGate(c, canaryGate, { id: "canary-receipt-1", authority: "host", payloadDigest: "1".repeat(64) });
  assert.equal(c.nextGate, "promoted");
  assert.equal(c.deployment.productionAllowed, false);
  c = recordHostAdapterGate(c, { id: "promoted", status: "passed", evaluator: "host", receiptDigest: "3".repeat(64) }, { id: "promotion-receipt-1", authority: "host", payloadDigest: "3".repeat(64) });
  assert.equal(c.status, "promoted");
  assert.equal(c.deployment.productionAllowed, true);
  assert.equal(c.deployment.automaticallyDeployed, false);
});

test("a tampered candidate fails validation", () => {
  const c = candidate();
  assert.throws(() => validateAdapterCandidate({ ...c, deployment: { ...c.deployment, productionAllowed: true } }), /digest does not match/);
});
