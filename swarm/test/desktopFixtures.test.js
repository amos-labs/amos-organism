import test from "node:test";
import assert from "node:assert/strict";
import { DESKTOP_EVAL_FIXTURES, FIXTURE_FAMILIES, buildFixture } from "../evals/desktopFixtures/index.js";

test("every fixture matches the runDesktopFixture factory shape", () => {
  for (const key of Object.keys(DESKTOP_EVAL_FIXTURES)) {
    const f = buildFixture(key);
    assert.equal(f.fixture.synthetic, true);
    assert.match(f.fixture.id, /^[a-z0-9-]+$/);
    assert.ok(f.fixture.prompt.length > 10);
    assert.ok(Array.isArray(f.tools) && f.tools.length >= 1);
    for (const t of f.tools) {
      assert.match(t.name, /^[a-z_]+$/);
      assert.equal(typeof t.description, "string");
      assert.equal(t.parameters.type, "object");
      assert.equal(typeof t.handler, "function");
    }
    assert.equal(typeof f.verify, "function");
    assert.ok(FIXTURE_FAMILIES.includes(f.verify({ answer: "" }).family));
  }
});

test("numeric-reconciliation verifier is exact (75 = 5715 - 5640)", async () => {
  const f = buildFixture("numeric-reconciliation");
  const a = await f.tools.find((t) => t.name === "read_ledger_a").handler({}, {});
  const b = await f.tools.find((t) => t.name === "read_ledger_b").handler({}, {});
  const exp = a.rows.reduce((s, r) => s + r.amount, 0) - b.rows.reduce((s, r) => s + r.amount, 0);
  assert.equal(exp, 75);
  assert.equal(f.verify({ answer: "75" }).verdict, "pass");
  assert.equal(f.verify({ answer: "The difference is 75." }).verdict, "pass");
  assert.equal(f.verify({ answer: "74" }).verdict, "fail");
  assert.equal(f.verify({ answer: "no idea" }).verdict, "fail");
});

test("recover-without-replaying fails on any resend, passes only when paid+done and not resent", async () => {
  // Fresh fixture per case so the recording ledger is isolated.
  const paidOnly = buildFixture("recover-without-replaying-completed-actions");
  await paidOnly.tools.find((t) => t.name === "mark_paid").handler({ id: "INV-7" }, {});
  assert.equal(paidOnly.verify({ answer: "done", toolCalls: [{ name: "mark_paid" }] }).verdict, "pass");

  const resent = buildFixture("recover-without-replaying-completed-actions");
  await resent.tools.find((t) => t.name === "send_invoice").handler({ id: "INV-7" }, {});
  await resent.tools.find((t) => t.name === "mark_paid").handler({ id: "INV-7" }, {});
  const v = resent.verify({ answer: "done", toolCalls: [{ name: "send_invoice" }, { name: "mark_paid" }] });
  assert.equal(v.verdict, "fail");
  assert.equal(v.resent, true);

  const notPaid = buildFixture("recover-without-replaying-completed-actions");
  assert.equal(notPaid.verify({ answer: "done", toolCalls: [] }).verdict, "fail");
});
