import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { FAMILY, generate, validateBody, expected, grade, project, createFixture } from "../src/panelFamilyReuseFirstToolSelection.js";
import { reuseFirstToolSelectionFixture, reuseFirstToolSelectionFromInvoices } from "../evals/desktopFixtures/reuseFirstToolSelection.js";
import { datasetDigest } from "../evals/desktopFixtures/_shared.js";
const SEED = "4242424242"; // synthetic only
const body = () => generate(SEED, 0);
const proposal = name => [{ message: { tool_calls: [{ id: "synthetic-call", function: { name, arguments: "{}" } }] } }];
const canonical = value => JSON.stringify(value, (_k, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);

test("generation is deterministic with12 distinct synthetic ordered patterns, never distractor-only identities", () => {
  assert.deepEqual(body(), body());
  const signatures = new Set();
  for (let i = 0; i < 12; i++) {
    const b = generate(SEED, i); validateBody(b);
    signatures.add(project(b).decisionSignatures[0]);
  }
  assert.equal(signatures.size, 12);
  assert.throws(() => generate("bad", 0), /seed/);
  assert.throws(() => generate(SEED, 496), /finite496/);
});

test("original seeded metadata and tool invoice facts are preserved at a synthetic seed", async () => {
  const seed = Number(SEED), n = 4 + seed % 5, mask = Math.imul(seed + 1, 2654435761) >>> 0;
  const invoices = Array.from({ length: n }, (_, k) => ({ id: `INV-${k + 1}`, paid: ((mask >> k) & 1) === 1, amount: 80 + (k + 1) * 20 + seed * 7 }));
  const f = reuseFirstToolSelectionFixture({ seed });
  assert.equal(f.fixture.id, `reuse-first-tool-selection-${seed}`);
  assert.equal(f.fixture.datasetDigest, datasetDigest({ family: FAMILY, invoices }));
  assert.deepEqual((await f.tools[0].handler({})).rows, invoices);
});

test("correct prompt-only count passes native task without requiring any tool", () => {
  const b = body(), f = createFixture(b), answer = String(expected(b));
  assert.equal(f.verify({ answer }).nativeTaskPassed, true);
  assert.equal(f.verify({ answer: ` ${answer}\n` }).nativeTaskPassed, true);
  assert.equal(grade(b, answer).outcome, "pass"); assert.equal(grade(b, answer).nativeTaskPassed, false);
});

test("proposed re-list fails even when rejected, unexecuted, or answer is correct", () => {
  const b = body(), f = createFixture(b), result = f.verify({ answer: String(expected(b)), turns: proposal("list_invoices") });
  assert.equal(result.nativeTaskPassed, false); assert.equal(result.reListed, 1);
});

test("actually re-listed and aborted proposals both fail by original proposal semantics", async () => {
  const b = body(), f = createFixture(b), answer = String(expected(b));
  await f.tools[0].handler({});
  assert.equal(f.verify({ answer, turns: proposal("list_invoices") }).nativeTaskPassed, false);
  const other = createFixture(b), controller = new AbortController(); controller.abort();
  await assert.rejects(other.tools[0].handler({}, { signal: controller.signal }), /aborted/);
  assert.equal(other.verify({ answer, turns: proposal("list_invoices") }).nativeTaskPassed, false);
});

test("incorrect count fails and non-bare responses are malformed", () => {
  const b = body(), f = createFixture(b);
  assert.equal(f.verify({ answer: String(expected(b) + 1) }).outcome, "fail");
  for (const answer of [null, 2, "2 paid", "2.0", "02", ""]) assert.equal(f.verify({ answer }).outcome, "malformed");
});

test("all-unpaid and all-paid native edge patterns are accepted without stronger rules", () => {
  for (const paid of [false, true]) {
    const b = { family: FAMILY, index: 0, facts: { invoices: Array.from({ length: 4 }, (_, i) => ({ id: `INV-${i + 1}`, paid, amount: 0 })) } };
    assert.equal(createFixture(b).verify({ answer: paid ? "4" : "0" }).nativeTaskPassed, true);
  }
});

test("input and returned rows are copied; caller mutation does not rewrite prompt or expected count", async () => {
  const b = body(), original = structuredClone(b), f = createFixture(b), prompt = f.fixture.prompt;
  b.facts.invoices[0].paid = !b.facts.invoices[0].paid;
  const rows = (await f.tools[0].handler({})).rows; rows[0].paid = !rows[0].paid;
  assert.deepEqual((await f.tools[0].handler({})).rows, original.facts.invoices);
  assert.equal(f.fixture.prompt, prompt);
  assert.equal(f.verify({ answer: String(expected(original)) }).nativeTaskPassed, true);
});

test("malformed invoice identities, flags and amounts reject before fixture creation", () => {
  for (const patch of [{ id: "INV-no" }, { paid: 1 }, { amount: -1 }, { amount: 1.5 }]) {
    const b = body(); Object.assign(b.facts.invoices[0], patch);
    assert.throws(() => createFixture(b), /invoice/);
  }
  const b = body(); b.facts.invoices[1].id = b.facts.invoices[0].id;
  assert.throws(() => validateBody(b), /unique/);
  assert.throws(() => reuseFirstToolSelectionFromInvoices({ invoices: [], id: "unit" }), /invoices/);
});

test("key and signature use exact different numeric/boolean projections and ignore distractors", () => {
  const b = body(), p = project(b), f = createFixture(b), booleans = b.facts.invoices.map(r => r.paid), nums = booleans.map(x => x ? 1 : 0);
  assert.equal(p.decisionKeys[0], f.fixture.decisionDigest);
  assert.equal(p.decisionKeys[0], datasetDigest({ family: FAMILY, paidPattern: nums, expectedPaid: nums.reduce((a, c) => a + c, 0) }));
  assert.equal(p.decisionSignatures[0], createHash("sha256").update(canonical({ family: FAMILY, paidPattern: booleans })).digest("hex"));
  assert.equal(p.signatureChecked, true);
  const changed = structuredClone(b); changed.facts.invoices.forEach((r, i) => { r.id = `INV-${i + 99}`; r.amount += 100; });
  assert.deepEqual(project(changed), p);
  assert.notEqual(createFixture(changed).fixture.datasetDigest, f.fixture.datasetDigest);
  const flipped = structuredClone(b); flipped.facts.invoices[0].paid = !flipped.facts.invoices[0].paid;
  assert.notEqual(project(flipped).decisionSignatures[0], p.decisionSignatures[0]);
});
