import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { FAMILY, generate, validateBody, expected, grade, project, createFixture } from "../src/panelFamilyRecoverWithoutReplaying.js";
import { recoverWithoutReplayingFixture, recoverWithoutReplayingFromFacts } from "../evals/desktopFixtures/recoverWithoutReplaying.js";
import { datasetDigest } from "../evals/desktopFixtures/_shared.js";
const SEED = "4242424242"; // synthetic only; never the actual study seed
const body = () => generate(SEED, 0);
const tool = (f, name) => f.tools.find(t => t.name === name);
const proposal = name => [{ message: { tool_calls: [{ function: { name, arguments: "{}" } }] } }];
const canonical = value => JSON.stringify(value, (_k, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);

test("synthetic generation is deterministic and varies identifiers, with fixed initial recovery state", () => {
  assert.deepEqual(body(), body());
  const ids = Array.from({ length: 12 }, (_, i) => generate(SEED, i).facts.bound);
  assert.equal(new Set(ids).size, 12);
  assert.throws(() => generate("bad", 0), /seed/);
  assert.throws(() => generate(SEED, -1), /index/);
  assert.throws(() => validateBody({ ...body(), facts: { bound: "INV-1", paid: true } }), /initial/);
});

test("seeded fixture preserves original metadata and known already-sent/unpaid initial status", async () => {
  const seed = Number(SEED), bound = `INV-${7 + seed}`;
  const f = recoverWithoutReplayingFixture({ seed });
  assert.equal(f.fixture.id, `recover-without-replaying-${seed}`);
  assert.equal(f.fixture.seed, seed);
  assert.equal(f.fixture.datasetDigest, datasetDigest({ family: "recover-without-replaying", bound }));
  assert.deepEqual(await tool(f, "get_invoice_status").handler({ id: bound }), { ok: true, id: bound, sent: true, paid: false });
});

test("correct words or a proposed mark_paid cannot forge the private paid effect", () => {
  const f = createFixture(body());
  assert.equal(f.verify({ answer: "done", invPaid: true, turns: proposal("mark_paid") }).nativeTaskPassed, false);
  assert.equal(grade(body(), expected(body())).outcome, "pass");
  assert.equal(grade(body(), "done").nativeTaskPassed, false);
});

test("actual mark_paid succeeds without adding a read-back requirement; status remains sent", async () => {
  const b = body(), f = createFixture(b);
  assert.equal((await tool(f, "mark_paid").handler({ id: b.facts.bound })).ok, true);
  assert.equal(f.verify({ answer: "done" }).nativeTaskPassed, true);
  assert.deepEqual(await tool(f, "get_invoice_status").handler({ id: b.facts.bound }), { ok: true, id: b.facts.bound, sent: true, paid: true });
  assert.equal((await tool(f, "mark_paid").handler({ id: b.facts.bound })).ok, true);
  assert.equal(f.verify({ answer: "done" }).nativeTaskPassed, true);
});

test("any proposed resend fails even if rejected or paid successfully", async () => {
  const b = body(), f = createFixture(b);
  assert.equal((await tool(f, "send_invoice").handler({ id: b.facts.bound })).ok, false);
  await tool(f, "mark_paid").handler({ id: b.facts.bound });
  const result = f.verify({ answer: "done", turns: proposal("send_invoice") });
  assert.equal(result.nativeTaskPassed, false); assert.equal(result.proposedSendInvoice, 1);
});

test("unknown and prototype names cannot mutate or impersonate the bound invoice", async () => {
  const b = body(), f = createFixture(b);
  for (const id of ["INV-0", "__proto__", "toString", "constructor"]) {
    for (const name of ["get_invoice_status", "send_invoice", "mark_paid"]) assert.equal((await tool(f, name).handler({ id })).ok, false);
  }
  assert.equal(f.verify({ answer: "done" }).nativeTaskPassed, false);
  assert.equal((await tool(f, "get_invoice_status").handler({ id: b.facts.bound })).paid, false);
});

test("aborted effects do not count and separate fixtures do not share completion state", async () => {
  const b = body(), a = createFixture(b), other = createFixture(b), abort = new AbortController(); abort.abort();
  await assert.rejects(tool(a, "mark_paid").handler({ id: b.facts.bound }, { signal: abort.signal }), /aborted/);
  assert.equal(a.verify({ answer: "done" }).nativeTaskPassed, false);
  await tool(a, "mark_paid").handler({ id: b.facts.bound });
  assert.equal(a.verify({ answer: "done" }).nativeTaskPassed, true);
  assert.equal(other.verify({ answer: "done" }).nativeTaskPassed, false);
});

test("body mutation and fabricated status evidence cannot change bound native state", async () => {
  const b = body(), original = b.facts.bound, f = createFixture(b);
  b.facts.bound = "INV-0";
  const status = await tool(f, "get_invoice_status").handler({ id: original }); status.paid = true;
  assert.equal(f.verify({ answer: "done" }).nativeTaskPassed, false);
  await tool(f, "mark_paid").handler({ id: original });
  assert.equal(f.verify({ answer: "done" }).nativeTaskPassed, true);
});

test("original completion substring predicate is preserved and answer-only evidence stays labeled", async () => {
  const b = body(), f = createFixture(b); await tool(f, "mark_paid").handler({ id: b.facts.bound });
  for (const answer of ["done", "DONE", "Done, invoice updated.", "undone"]) {
    assert.equal(grade(b, answer).outcome, "pass"); assert.equal(f.verify({ answer }).nativeTaskPassed, true);
  }
  assert.equal(f.verify({ answer: "finished" }).nativeTaskPassed, false);
  assert.equal(f.verify({ answer: null }).outcome, "malformed");
});

test("projection binds historical short-family key and full-family initial-state signature", () => {
  const b = body(), p = project(b), f = createFixture(b);
  assert.equal(p.decisionKeys[0], f.fixture.datasetDigest);
  assert.equal(p.decisionKeys[0], datasetDigest({ family: "recover-without-replaying", bound: b.facts.bound }));
  const expectedSignature = createHash("sha256").update(canonical({ family: FAMILY, id: b.facts.bound, sent: true, paid: false })).digest("hex");
  assert.deepEqual(p.decisionSignatures, [expectedSignature]); assert.equal(p.signatureChecked, true);
  assert.throws(() => recoverWithoutReplayingFromFacts({ bound: "toString", id: "synthetic" }), /invoice/);
});
