import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { FAMILY, generate, signatureFacts, project, expected, grade, createFixture, validateBody } from "../src/panelFamilyNumericReconciliation.js";
import { datasetDigest } from "../evals/desktopFixtures/_shared.js";

const SEED = "20260910";
// Real parent trajectory[0] from typed-exclusion-inventory.json (facts + identities).
const PARENT0 = {
  ledgerA: [{ id: "a1", amount: 2000 }, { id: "a2", amount: 700 }, { id: "a3", amount: 1900 }],
  ledgerB: [{ id: "b1", amount: 1600 }, { id: "b2", amount: 850 }, { id: "b3", amount: 1050 }],
  signature: "5e6e46c373f619c36925bbc605651b228217fe5a02dc8ae2d34d42562e0fe9dd",
  key: "1778583f",
};

test("generation is deterministic and produces 12 distinct case bodies", () => {
  assert.deepEqual(generate(SEED, 0), generate(SEED, 0));
  const sigs = new Set();
  for (let i = 0; i < 12; i++) sigs.add(createHash("sha256").update(JSON.stringify(generate(SEED, i).facts)).digest("hex"));
  assert.equal(sigs.size, 12);
  assert.throws(() => generate("2026-09", 0), /all-digit/);
});

test("validateBody enforces the panel domain (3-5 rows, unique ids, amounts 100..9999, positive)", () => {
  const ok = generate(SEED, 1);
  assert.equal(validateBody(ok), ok);
  const neg = structuredClone(ok); neg.facts.ledgerA[0].amount = -5;
  assert.throws(() => validateBody(neg), /amounts/);
  const big = structuredClone(ok); big.facts.ledgerA[0].amount = 10000;
  assert.throws(() => validateBody(big), /amounts/);
  const short = structuredClone(ok); short.facts.ledgerB = [{ id: "b1", amount: 100 }, { id: "b2", amount: 200 }];
  assert.throws(() => validateBody(short), /rows/);
  const dup = structuredClone(ok); dup.facts.ledgerA[1].id = dup.facts.ledgerA[0].id;
  assert.throws(() => validateBody(dup), /row ids/);
  const foreign = structuredClone(ok); foreign.family = "date-time";
  assert.throws(() => validateBody(foreign), /numeric panel body/);
});

test("expected() is the exact signed total(A)-total(B)", () => {
  const body = { family: FAMILY, index: 0, facts: {
    ledgerA: [{ id: "a1", amount: 100 }, { id: "a2", amount: 100 }, { id: "a3", amount: 200 }],
    ledgerB: [{ id: "b1", amount: 100 }, { id: "b2", amount: 300 }, { id: "b3", amount: 100 }],
  } };
  assert.equal(expected(body), (100 + 100 + 200) - (100 + 300 + 100));
});

test("grade is answer-only over a bare signed-integer string; pass/fail/malformed distinguished", () => {
  const body = generate(SEED, 3);
  const g = grade(body, String(expected(body)));
  assert.equal(g.outcome, "pass");
  assert.equal(g.verificationScope, "answer-only");
  assert.equal(g.nativeTaskPassed, false, "a pure answer grade never establishes the native tool task");
  assert.equal(grade(body, String(expected(body) + 1)).outcome, "fail");
  for (const bad of [null, 15236, "1.5", "", "  ", "not 75", "75 dollars", {}]) {
    assert.equal(grade(body, bad).outcome, "malformed", `answer ${JSON.stringify(bad)}`);
  }
  assert.match(g.evidenceSha256, /^[a-f0-9]{64}$/);
  assert.equal(g.caseId, `${FAMILY}:${createHash("sha256").update(JSON.stringify(sortBody(body))).digest("hex").slice(0,16)}`);
});

test("createFixture exposes the native read-both/answer contract; only real reads grant nativeTaskPassed", async () => {
  const body = generate(SEED, 4);
  const cf = createFixture(body);
  assert.deepEqual(Object.keys(cf).sort(), ["fixture", "tools", "verify"].sort());
  assert.equal(cf.tools.length, 2);
  // no reads -> native fail even with the correct answer
  assert.equal(cf.verify({ answer: String(expected(body)) }).nativeTaskPassed, false);
  // both reads + correct answer -> native pass
  const cf2 = createFixture(body);
  for (const t of cf2.tools) await t.handler({});
  const good = cf2.verify({ answer: String(expected(body)) });
  assert.equal(good.nativeTaskPassed, true);
  assert.equal(good.verificationScope, "native-tools-and-answer");
  // both reads + malformed answer -> malformed
  const cf3 = createFixture(body);
  for (const t of cf3.tools) await t.handler({});
  assert.equal(cf3.verify({ answer: "not-an-int" }).outcome, "malformed");
});

test("projection is COMPARABLE to the real excluded inventory: signature AND FNV-1a key", () => {
  const collidingBody = { family: FAMILY, index: 0, facts: { ledgerA: PARENT0.ledgerA, ledgerB: PARENT0.ledgerB } };
  const proj = project(collidingBody);
  assert.equal(proj.decisionSignatures[0], PARENT0.signature, "normalized signature reproduces the real parent");
  assert.equal(proj.decisionKeys[0], PARENT0.key, "exact FNV-1a historical key reproduces the real parent");
  assert.equal(proj.decisionKeys[0], datasetDigest({ family: FAMILY, ledgerA: PARENT0.ledgerA, ledgerB: PARENT0.ledgerB }));
  // reordered rows keep the same strong signature (still caught) but change the exact key
  const reordered = { family: FAMILY, index: 0, facts: { ledgerA: [...PARENT0.ledgerA].reverse(), ledgerB: [...PARENT0.ledgerB].reverse() } };
  const rp = project(reordered);
  assert.equal(rp.decisionSignatures[0], PARENT0.signature, "signature is order-independent -> reuse still caught");
  assert.notEqual(rp.decisionKeys[0], PARENT0.key, "exact key preserves row order");
  // a fresh generated case collides with neither
  const fresh = project(generate(SEED, 0));
  assert.notEqual(fresh.decisionSignatures[0], PARENT0.signature);
  assert.notEqual(fresh.decisionKeys[0], PARENT0.key);
});

function sortBody(v) {
  if (Array.isArray(v)) return v.map(sortBody);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortBody(v[k])]));
  return v;
}
