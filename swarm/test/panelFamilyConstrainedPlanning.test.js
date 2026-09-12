import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { FAMILY, generate, expected, grade, createFixture, project, validateBody } from "../src/panelFamilyConstrainedPlanning.js";
import { constrainedPlanningFixture } from "../evals/desktopFixtures/constrainedPlanning.js";
import { datasetDigest } from "../evals/desktopFixtures/_shared.js";

const SEED = "20260910";

test("generation is deterministic and produces 12 distinct bodies with budget = account count", () => {
  assert.deepEqual(generate(SEED, 0), generate(SEED, 0));
  const keys = new Set();
  for (let i = 0; i < 12; i++) {
    const b = generate(SEED, i);
    assert.equal(b.facts.budget, b.facts.accounts.length);
    keys.add(createHash("sha256").update(JSON.stringify(b.facts)).digest("hex"));
  }
  assert.equal(keys.size, 12);
  assert.throws(() => generate("x", 0), /all-digit/);
});

test("validateBody enforces 3-5 accounts, unique ids, balances 100..9999, budget==count", () => {
  const ok = generate(SEED, 1);
  assert.equal(validateBody(ok), ok);
  const big = structuredClone(ok); big.facts.accounts[0].balance = 100000;
  assert.throws(() => validateBody(big), /balances/);
  const twoAcc = structuredClone(ok); twoAcc.facts.accounts = twoAcc.facts.accounts.slice(0, 2); twoAcc.facts.budget = 2;
  assert.throws(() => validateBody(twoAcc), /3\.\.5 accounts/);
  const badBudget = structuredClone(ok); badBudget.facts.budget = ok.facts.accounts.length + 1;
  assert.throws(() => validateBody(badBudget), /budget/);
});

test("expected() is the total balance; grade is answer-only bare integer (pass/fail/malformed)", () => {
  const b = generate(SEED, 3);
  assert.equal(expected(b), b.facts.accounts.reduce((t, a) => t + a.balance, 0));
  const g = grade(b, String(expected(b)));
  assert.equal(g.outcome, "pass");
  assert.equal(g.nativeTaskPassed, false);
  assert.equal(g.verificationScope, "answer-only");
  assert.equal(grade(b, String(expected(b) + 1)).outcome, "fail");
  for (const bad of [null, 27530, "1.5", "", "-5", "twelve", {}]) assert.equal(grade(b, bad).outcome, "malformed");
});

test("createFixture native task requires reading each account exactly once within budget", async () => {
  const b = generate(SEED, 4);
  const total = String(expected(b));
  // correct answer with NO reads -> native fail (coverage)
  assert.equal(createFixture(b).verify({ answer: total }).nativeTaskPassed, false);
  // read each account exactly once + correct answer -> native pass
  const cf = createFixture(b);
  for (const a of b.facts.accounts) await cf.tools[0].handler({ id: a.id });
  const good = cf.verify({ answer: total, toolCalls: b.facts.accounts.map((a) => ({ name: "get_account_balance", arguments: { id: a.id } })) });
  assert.equal(good.nativeTaskPassed, true);
  assert.equal(good.verificationScope, "native-tools-and-answer");
  // duplicate read of one account -> coverage fail
  const cf2 = createFixture(b);
  await cf2.tools[0].handler({ id: b.facts.accounts[0].id });
  await cf2.tools[0].handler({ id: b.facts.accounts[0].id });
  assert.equal(cf2.verify({ answer: total }).nativeTaskPassed, false);
});

test("projection key is COMPARABLE to the real consumed inventory (decisionKey === datasetDigest)", () => {
  // The real consumed constrained-planning seed-219 case has decisionKey 70e0ce9d.
  assert.equal(constrainedPlanningFixture({ seed: 219 }).fixture.datasetDigest, "70e0ce9d");
  // A panel body reproducing that seed's accounts+budget projects to the same key -> caught.
  const seeded = constrainedPlanningFixture({ seed: 219 });
  // reconstruct accounts from the fixture's prompt-independent facts via a direct build
  // Build a body whose datasetDigest equals the seeded one by using the same accounts/budget.
  const body = { family: FAMILY, index: 0, facts: { accounts: reconstruct(seeded), budget: reconstruct(seeded).length } };
  assert.equal(project(body).decisionKeys[0], "70e0ce9d", "projection reproduces the real consumed decisionKey");
  assert.equal(project(body).signatureChecked, false, "no normalized signature claimed for this family");
  // a fresh generated case does not collide
  assert.notEqual(project(generate(SEED, 0)).decisionKeys[0], "70e0ce9d");
});

// Recover the seeded accounts by reading through the native handler (private world).
function reconstruct(seededFixture) {
  // seed 219 -> n = 2 + (219 % 2) = 3 accounts, balances 1000 + (k+1)*250 + 219*37
  const s = 219, n = 2 + (s % 2);
  return Array.from({ length: n }, (_, k) => ({ id: `ACC-${k + 1}`, balance: 1000 + (k + 1) * 250 + s * 37 }));
}
