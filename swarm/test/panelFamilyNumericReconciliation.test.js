import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { FAMILY, generate, signatureFacts, project, expected, grade } from "../src/panelFamilyNumericReconciliation.js";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const SEED = "20260910";

test("generation is deterministic and produces distinct cases per index", () => {
  const a = generate(SEED, 0), b = generate(SEED, 0);
  assert.deepEqual(a, b, "same (seed,index) is reproducible");
  const sigs = new Set();
  for (let i = 0; i < 12; i++) sigs.add(sha256(JSON.stringify(generate(SEED, i).facts)));
  assert.equal(sigs.size, 12, "12 indices yield 12 distinct bodies");
  assert.throws(() => generate("2026-09", 0), /all-digit/);
});

test("expected() computes the multiset difference A\\B and net difference, handling duplicates", () => {
  const body = { family: FAMILY, index: 0, facts: {
    ledgerA: [{ id: "a1", amount: 100 }, { id: "a2", amount: 100 }, { id: "a3", amount: 200 }],
    ledgerB: [{ id: "b1", amount: 100 }, { id: "b2", amount: 300 }],
  } };
  const exp = expected(body);
  assert.deepEqual(exp.unmatchedFromA, [100, 200], "one 100 is matched, the other 100 + 200 remain");
  assert.equal(exp.netDifference, (100 + 100 + 200) - (100 + 300));
});

test("grade distinguishes pass / fail / malformed", () => {
  const body = generate(SEED, 3);
  assert.equal(grade(body, expected(body)).outcome, "pass");
  assert.equal(grade(body, { unmatchedFromA: [1], netDifference: 0 }).outcome, "fail");
  for (const bad of [null, {}, { unmatchedFromA: "x", netDifference: 0 }, { unmatchedFromA: [1.5], netDifference: 0 }, { unmatchedFromA: [1], netDifference: 1.5 }]) {
    assert.equal(grade(body, bad).outcome, "malformed");
  }
  // order-independent answer accepted
  const body2 = generate(SEED, 4), exp2 = expected(body2);
  assert.equal(grade(body2, { unmatchedFromA: [...exp2.unmatchedFromA].reverse(), netDifference: exp2.netDifference }).outcome, "pass");
});

test("evidenceSha256 is a stable 64-hex digest over body+answer+verdict", () => {
  const body = generate(SEED, 5);
  const g = grade(body, expected(body));
  assert.match(g.evidenceSha256, /^[a-f0-9]{64}$/);
  assert.equal(grade(body, expected(body)).evidenceSha256, g.evidenceSha256);
});

test("decision projection is COMPARABLE to the real excluded inventory (signature algorithm match)", () => {
  // A real parent trajectory's signatureFacts + its decisionSignature from
  // typed-exclusion-inventory.json (developmentTrajectories[0]).
  const realParentSignature = "5e6e46c373f619c36925bbc605651b228217fe5a02dc8ae2d34d42562e0fe9dd";
  // A panel body whose reconciliation facts reproduce that parent's normalized facts
  // (a:[700,1900,2000], b:[850,1050,1600]) must project to the SAME signature -> caught.
  const collidingBody = { family: FAMILY, index: 0, facts: {
    ledgerA: [{ id: "a1", amount: 2000 }, { id: "a2", amount: 700 }, { id: "a3", amount: 1900 }],
    ledgerB: [{ id: "b1", amount: 1600 }, { id: "b2", amount: 850 }, { id: "b3", amount: 1050 }],
  } };
  assert.deepEqual(signatureFacts(collidingBody), { family: FAMILY, a: [700, 1900, 2000], b: [850, 1050, 1600] });
  assert.equal(project(collidingBody).decisionSignatures[0], realParentSignature, "projection reproduces the real parent decisionSignature");
  // A fresh generated case does NOT collide with that parent
  assert.notEqual(project(generate(SEED, 0)).decisionSignatures[0], realParentSignature);
});
