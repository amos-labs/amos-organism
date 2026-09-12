import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { FAMILY, generate, expected, grade, createFixture, project, validateBody } from "../src/panelFamilyAsyncCode.js";
import { asyncCodeFixture } from "../evals/desktopFixtures/asyncCode.js";

const SEED = "20260910";

test("generation is deterministic; 12 distinct bodies, 3-5 durations, unique maximum", () => {
  assert.deepEqual(generate(SEED, 0), generate(SEED, 0));
  const keys = new Set();
  for (let i = 0; i < 12; i++) {
    const b = generate(SEED, i);
    assert.ok(b.facts.durations.length >= 3 && b.facts.durations.length <= 5);
    const max = Math.max(...b.facts.durations);
    assert.equal(b.facts.durations.filter((d) => d === max).length, 1, "unique max");
    keys.add(createHash("sha256").update(JSON.stringify(b.facts)).digest("hex"));
  }
  assert.equal(keys.size, 12);
  assert.throws(() => generate("x", 0), /all-digit/);
});

test("validateBody enforces 3-5 durations 40..9999 with a unique maximum", () => {
  const ok = generate(SEED, 1);
  assert.equal(validateBody(ok), ok);
  const tooFew = structuredClone(ok); tooFew.facts.durations = [100, 200];
  assert.throws(() => validateBody(tooFew), /3\.\.5 durations/);
  const tied = structuredClone(ok); tied.facts.durations = [500, 500, 300];
  assert.throws(() => validateBody(tied), /unique maximum/);
  const oob = structuredClone(ok); oob.facts.durations = [10, 20, 30];
  assert.throws(() => validateBody(oob), /40\.\.9999/);
});

test("expected() is the concurrent max; grade answer-only; sequential sum fails (not malformed)", () => {
  const b = generate(SEED, 3);
  assert.equal(expected(b), Math.max(...b.facts.durations));
  assert.equal(grade(b, String(expected(b))).outcome, "pass");
  assert.equal(grade(b, String(expected(b))).nativeTaskPassed, false);
  assert.equal(grade(b, String(b.facts.durations.reduce((a, c) => a + c, 0))).outcome, "fail", "sequential sum is a wrong answer, not malformed");
  for (const bad of [null, 810, "1.5", "", "eight", {}]) assert.equal(grade(b, bad).outcome, "malformed");
});

test("createFixture native task requires reading durations; correct max after read passes", async () => {
  const b = generate(SEED, 4);
  const ans = String(expected(b));
  assert.equal(createFixture(b).verify({ answer: ans }).nativeTaskPassed, false, "no read -> native fail");
  const cf = createFixture(b);
  await cf.tools[0].handler({});
  const good = cf.verify({ answer: ans });
  assert.equal(good.nativeTaskPassed, true);
  assert.equal(good.verificationScope, "native-tools-and-answer");
  const cf2 = createFixture(b);
  await cf2.tools[0].handler({});
  assert.equal(cf2.verify({ answer: String(b.facts.durations.reduce((a, c) => a + c, 0)) }).nativeTaskPassed, false, "sequential sum after read -> fail");
});

test("projection key is COMPARABLE to real consumed inventory (decisionKey === datasetDigest)", () => {
  assert.equal(asyncCodeFixture({ seed: 215 }).fixture.datasetDigest, "1672eb29");
  // reconstruct seed-215 durations and confirm the projection reproduces the real key
  const s = 215, n = 3 + (s % 3);
  const durations = Array.from({ length: n }, (_, k) => 40 + ((k * 37 + s * 53) % 260));
  const body = { family: FAMILY, index: 0, facts: { durations } };
  assert.equal(project(body).decisionKeys[0], "1672eb29", "reproduces the real consumed decisionKey");
  assert.equal(project(body).signatureChecked, false);
  assert.notEqual(project(generate(SEED, 0)).decisionKeys[0], "1672eb29");
});
