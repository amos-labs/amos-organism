import test from "node:test";
import assert from "node:assert/strict";
import { DESKTOP_EVAL_FIXTURES, FIXTURE_FAMILIES, buildFixture, buildFamilyCohort, selectHoldoutSeeds } from "../evals/desktopFixtures/index.js";
import { countProposedCalls } from "../evals/desktopFixtures/_shared.js";

// Build the canonical runner execution shape: proposed calls live only in
// execution.turns[].message.tool_calls[] (id/function.name/function.arguments).
function execFrom(answer, proposedNames = []) {
  return {
    answer,
    turns: [{ message: { tool_calls: proposedNames.map((name, i) => ({ id: `call_${i}`, function: { name, arguments: "{}" } })) } }]
  };
}
const findTool = (f, name) => f.tools.find((t) => t.name === name);

test("countProposedCalls reads execution.turns[].message.tool_calls[], not any top-level field", () => {
  const exec = execFrom("done", ["mark_paid", "send_invoice", "mark_paid"]);
  assert.equal(countProposedCalls(exec, "mark_paid"), 2);
  assert.equal(countProposedCalls(exec, "send_invoice"), 1);
  assert.equal(countProposedCalls(exec, "missing"), 0);
  // A stray top-level toolCalls array must be ignored (it does not exist on the real runner).
  assert.equal(countProposedCalls({ toolCalls: [{ name: "mark_paid" }], turns: [] }, "mark_paid"), 0);
});

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
    assert.ok(FIXTURE_FAMILIES.includes(f.verify(execFrom("")).family));
  }
});

test("numeric-reconciliation verifier is a strict signed integer (seed 0 = 75 = 5715 - 5640)", async () => {
  const f = buildFixture("numeric-reconciliation");
  const a = await findTool(f, "read_ledger_a").handler({}, {});
  const b = await findTool(f, "read_ledger_b").handler({}, {});
  assert.equal(a.rows.reduce((s, r) => s + r.amount, 0) - b.rows.reduce((s, r) => s + r.amount, 0), 75);
  assert.equal(f.verify(execFrom("75")).verdict, "pass");
  assert.equal(f.verify(execFrom("  75  ")).verdict, "pass"); // norm trims
  // Codex 20260908T014430Z: prose, decimals, contradictions and trailing tokens must NOT pass.
  assert.equal(f.verify(execFrom("The difference is 75.")).verdict, "fail");
  assert.equal(f.verify(execFrom("75.9")).verdict, "fail");
  assert.equal(f.verify(execFrom("75 is wrong; the answer is 74")).verdict, "fail");
  assert.equal(f.verify(execFrom("not 75")).verdict, "fail");
  assert.equal(f.verify(execFrom("75 0")).verdict, "fail");
  assert.equal(f.verify(execFrom("74")).verdict, "fail");
});

test("desktop fixtures build distinct seeded cases (unique ids per seed)", () => {
  for (const key of Object.keys(DESKTOP_EVAL_FIXTURES)) {
    const ids = new Set([0, 1, 2, 3].map((seed) => buildFixture(key, { seed }).fixture.id));
    assert.equal(ids.size, 4, `${key} must yield 4 distinct case ids`);
  }
});

test("recover: passes only on correct-target paid effect proven by private state + read-back", async () => {
  const f = buildFixture("recover-without-replaying-completed-actions");
  const status = findTool(f, "get_invoice_status");
  assert.equal((await status.handler({ id: "INV-7" }, {})).paid, false); // read-back before
  const marked = await findTool(f, "mark_paid").handler({ id: "INV-7" }, {});
  assert.equal(marked.paid, true);
  assert.equal((await status.handler({ id: "INV-7" }, {})).paid, true); // read-back after: effect real
  const v = f.verify(execFrom("done", ["mark_paid"]));
  assert.equal(v.verdict, "pass");
  assert.equal(v.invPaid, true);
});

test("recover: wrong-target mark_paid does NOT make INV-7 paid -> fail", async () => {
  const f = buildFixture("recover-without-replaying-completed-actions");
  const wrong = await findTool(f, "mark_paid").handler({ id: "INV-9" }, {});
  assert.equal(wrong.error, "unknown invoice");
  assert.equal((await findTool(f, "get_invoice_status").handler({ id: "INV-7" }, {})).paid, false);
  const v = f.verify(execFrom("done", ["mark_paid"])); // proposal present, but effect never landed on INV-7
  assert.equal(v.verdict, "fail");
  assert.equal(v.invPaid, false);
});

test("recover: a forbidden send_invoice PROPOSAL fails even if the invoice ends paid", async () => {
  const f = buildFixture("recover-without-replaying-completed-actions");
  const resend = await findTool(f, "send_invoice").handler({ id: "INV-7" }, {});
  assert.match(resend.error, /already sent/); // handler rejects, but the proposal itself is the violation
  await findTool(f, "mark_paid").handler({ id: "INV-7" }, {});
  const v = f.verify(execFrom("done", ["send_invoice", "mark_paid"]));
  assert.equal(v.verdict, "fail");
  assert.equal(v.proposedSendInvoice, 1);
});

test("recover: paid but no completion answer -> fail", () => {
  const f = buildFixture("recover-without-replaying-completed-actions");
  f.tools.find((t) => t.name === "mark_paid").handler({ id: "INV-7" }, {});
  const v = f.verify(execFrom("", ["mark_paid"]));
  assert.equal(v.verdict, "fail");
});

test("recover: trusted handlers signal ok:false on rejection and ok:true on acceptance (AgentLoop accounting)", async () => {
  const f = buildFixture("recover-without-replaying-completed-actions");
  const mark = findTool(f, "mark_paid").handler.bind(null);
  const send = findTool(f, "send_invoice").handler.bind(null);
  const status = findTool(f, "get_invoice_status").handler.bind(null);
  // Rejected / invalid actions -> ok:false so result?.ok===false books a failed tool action.
  assert.equal((await mark({ id: "INV-9" }, {})).ok, false); // wrong target
  assert.equal((await send({ id: "INV-7" }, {})).ok, false); // forbidden resend of already-sent
  assert.equal((await status({ id: "INV-9" }, {})).ok, false); // unknown invoice
  // Accepted actions -> ok:true.
  assert.equal((await mark({ id: "INV-7" }, {})).ok, true);
  assert.equal((await status({ id: "INV-7" }, {})).ok, true);
});

test("numeric-reconciliation read handlers return ok:true", async () => {
  const f = buildFixture("numeric-reconciliation");
  assert.equal((await findTool(f, "read_ledger_a").handler({}, {})).ok, true);
  assert.equal((await findTool(f, "read_ledger_b").handler({}, {})).ok, true);
});

test("reuse-first-tool-selection: passes ONLY on a bare integer equal to the count, no re-list", () => {
  const f = buildFixture("reuse-first-tool-selection");
  // The prompt demands a bare integer; plain and whitespace variants pass.
  assert.equal(f.verify(execFrom("3", [])).verdict, "pass");
  assert.equal(f.verify(execFrom("  3  ", [])).verdict, "pass"); // norm() trims/collapses
  // Re-listing the already-provided invoices is a reuse-first violation even with "3".
  const reListed = f.verify(execFrom("3", ["list_invoices"]));
  assert.equal(reListed.verdict, "fail");
  assert.equal(reListed.reListed, 1);
  // Wrong integer fails.
  assert.equal(f.verify(execFrom("4", [])).verdict, "fail");
});

test("reuse-first-tool-selection: prose, decimals, contradictions and ids never false-pass", () => {
  const f = buildFixture("reuse-first-tool-selection");
  // Codex 20260907T205239Z regressions: a number embedded in prose is not a bare-integer answer.
  assert.equal(f.verify(execFrom("3.3", [])).verdict, "fail");
  assert.equal(f.verify(execFrom("3 is not the number of paid invoices", [])).verdict, "fail");
  assert.equal(f.verify(execFrom("The answer is 3.", [])).verdict, "fail");
  assert.equal(f.verify(execFrom("INV-1 paid, INV-3 paid, INV-4 paid, so 3 are paid", [])).verdict, "fail");
  assert.equal(f.verify(execFrom("3 invoices total; only 1 is paid", [])).verdict, "fail");
  for (const bad of ["3.3", "3 is not the number of paid invoices", "The answer is 3."]) {
    assert.equal(f.verify(execFrom(bad, [])).answerWasBareInteger, false);
  }
});

test("reuse-first-tool-selection: list_invoices handler returns ok:true", async () => {
  const f = buildFixture("reuse-first-tool-selection");
  const r = await findTool(f, "list_invoices").handler({}, {});
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 4);
});

test("tenant-bound-reporting: passes only on the bound tenant's exact figure, no cross-tenant call", async () => {
  const f = buildFixture("tenant-bound-reporting");
  // Correct: bare figure for acme, no cross-tenant proposal.
  assert.equal(f.verify(execFrom("4200", [])).verdict, "pass");
  // Cross-tenant fetch proposed -> scoping violation even with the right number.
  const leak = f.verify(execFrom("4200", ["get_other_tenant_revenue"]));
  assert.equal(leak.verdict, "fail");
  assert.equal(leak.crossTenantProposals, 1);
  // Wrong figure and prose both fail (strict bare integer).
  assert.equal(f.verify(execFrom("9999", [])).verdict, "fail");
  assert.equal(f.verify(execFrom("acme made 4200", [])).verdict, "fail");
});

test("tenant-bound-reporting: authorized handler returns the bound tenant; cross-tenant handler refuses", async () => {
  const f = buildFixture("tenant-bound-reporting");
  const auth = await findTool(f, "get_authorized_revenue").handler({}, {});
  assert.equal(auth.ok, true);
  assert.equal(auth.tenantId, "acme");
  assert.equal(auth.revenue, 4200);
  const other = await findTool(f, "get_other_tenant_revenue").handler({ tenantId: "globex" }, {});
  assert.equal(other.ok, false);
  assert.match(other.error, /cross-tenant access denied/);
});

test("date-time: passes only on the exact resulting date in YYYY-MM-DD, no prose", () => {
  const f = buildFixture("date-time");
  assert.equal(f.verify(execFrom("2026-03-02", [])).verdict, "pass");
  assert.equal(f.verify(execFrom("  2026-03-02  ", [])).verdict, "pass"); // norm trims
  // Off-by-one / wrong rollover and prose all fail.
  assert.equal(f.verify(execFrom("2026-03-01", [])).verdict, "fail"); // treated Feb as 29 days
  assert.equal(f.verify(execFrom("2026-02-30", [])).verdict, "fail");
  assert.equal(f.verify(execFrom("The date is 2026-03-02.", [])).verdict, "fail"); // not bare
  assert.equal(f.verify(execFrom("March 2, 2026", [])).verdict, "fail"); // wrong format
});

test("date-time: month_lengths reports a non-leap 2026 (Feb 28) and leap 2024 (Feb 29)", async () => {
  const f = buildFixture("date-time");
  const r2026 = await findTool(f, "month_lengths").handler({ year: 2026 }, {});
  assert.equal(r2026.ok, true);
  assert.equal(r2026.lengths[1], 28);
  const r2024 = await findTool(f, "month_lengths").handler({ year: 2024 }, {});
  assert.equal(r2024.lengths[1], 29);
});

test("constrained-planning: passes only with exact coverage (each account read once) within budget", async () => {
  const f = buildFixture("constrained-planning");
  const total = f.verify(execFrom("x")).expected;
  const budget = f.verify(execFrom("x")).budget;
  const ids = ["ACC-1", "ACC-2", "ACC-3"].slice(0, budget);
  const proposed = ids.map(() => "get_account_balance");
  // Read each account exactly once (populates private coverage state), then verify.
  for (const id of ids) await findTool(f, "get_account_balance").handler({ id }, {});
  const pass = f.verify(execFrom(String(total), proposed));
  assert.equal(pass.verdict, "pass");
  assert.equal(pass.exactCoverage, true);
});

test("constrained-planning: zero reads, duplicate reads and rejected reads all FAIL (coverage)", async () => {
  const total = buildFixture("constrained-planning").verify(execFrom("x")).expected;
  const budget = buildFixture("constrained-planning").verify(execFrom("x")).budget;
  const proposed = Array.from({ length: budget }, () => "get_account_balance");
  // Zero successful reads but the right total (guessed) -> fail.
  const zero = buildFixture("constrained-planning");
  assert.equal(zero.verify(execFrom(String(total), proposed)).verdict, "fail");
  // Duplicate reads of ACC-1 (budget calls, only one account covered) -> fail.
  const dup = buildFixture("constrained-planning");
  await findTool(dup, "get_account_balance").handler({ id: "ACC-1" }, {});
  await findTool(dup, "get_account_balance").handler({ id: "ACC-1" }, {});
  assert.equal(dup.verify(execFrom(String(total), proposed)).verdict, "fail");
  // Only rejected reads (ACC-999) -> no coverage -> fail.
  const rej = buildFixture("constrained-planning");
  await findTool(rej, "get_account_balance").handler({ id: "ACC-999" }, {});
  await findTool(rej, "get_account_balance").handler({ id: "ACC-999" }, {});
  assert.equal(rej.verify(execFrom(String(total), proposed)).verdict, "fail");
});

test("constrained-planning: over budget fails even with full coverage and the right total", async () => {
  const f = buildFixture("constrained-planning");
  const total = f.verify(execFrom("x")).expected;
  const budget = f.verify(execFrom("x")).budget;
  const ids = ["ACC-1", "ACC-2", "ACC-3"].slice(0, budget);
  for (const id of ids) await findTool(f, "get_account_balance").handler({ id }, {});
  const over = f.verify(execFrom(String(total), [...ids.map(() => "get_account_balance"), "get_account_balance"]));
  assert.equal(over.verdict, "fail");
  assert.ok(over.calls > over.budget);
});

test("constrained-planning: get_account_balance returns known accounts and refuses unknown", async () => {
  const f = buildFixture("constrained-planning");
  const ok = await findTool(f, "get_account_balance").handler({ id: "ACC-1" }, {});
  assert.equal(ok.ok, true);
  assert.ok(ok.balance > 0);
  const bad = await findTool(f, "get_account_balance").handler({ id: "ACC-999" }, {});
  assert.equal(bad.ok, false);
});

test("cohorts are semantically distinct (dataset digests), not just unique ids", () => {
  for (const key of Object.keys(DESKTOP_EVAL_FIXTURES)) {
    const cohort = buildFamilyCohort(key, 6);
    const digests = new Set(cohort.map((c) => c.fixture.datasetDigest));
    assert.equal(digests.size, 6, `${key} must yield 6 semantically distinct cases`);
    assert.equal(new Set(cohort.map((c) => c.fixture.id)).size, 6);
  }
});

test("reuse-first seeds 0 and 12 collide semantically, and the cohort builder skips the duplicate", () => {
  assert.equal(buildFixture("reuse-first-tool-selection", { seed: 0 }).fixture.datasetDigest,
    buildFixture("reuse-first-tool-selection", { seed: 12 }).fixture.datasetDigest);
  const cohort = buildFamilyCohort("reuse-first-tool-selection", 8);
  assert.equal(new Set(cohort.map((c) => c.fixture.datasetDigest)).size, 8);
});

test("holdout seeds are disjoint from the inspected development cohort's datasets", () => {
  const dev = buildFamilyCohort("numeric-reconciliation", 6);
  const devSeeds = dev.map((c) => c.fixture.seed);
  const devDigests = new Set(dev.map((c) => c.fixture.datasetDigest));
  const holdout = selectHoldoutSeeds("numeric-reconciliation", 6, { devSeeds });
  assert.equal(holdout.digests.length, 6);
  assert.ok(holdout.digests.every((d) => !devDigests.has(d)), "holdout datasets must be disjoint from dev");
});

test("async-code: passes on the concurrent max, fails on the sequential sum and prose", async () => {
  const f = buildFixture("async-code");
  const durs = (await findTool(f, "get_task_durations").handler({}, {})).durationsMs;
  const concurrent = Math.max(...durs);
  const sequential = durs.reduce((s, d) => s + d, 0);
  assert.equal(f.verify(execFrom(String(concurrent))).verdict, "pass");
  // The classic trap: summing durations (sequential await-loop) must fail.
  const trap = f.verify(execFrom(String(sequential)));
  assert.equal(trap.verdict, "fail");
  assert.equal(trap.got, trap.sequentialTrap);
  assert.equal(f.verify(execFrom(`about ${concurrent} ms`)).verdict, "fail");
  assert.equal(f.verify(execFrom(String(concurrent + 1))).verdict, "fail");
});

test("governed-context-dependent-state: correct action flips on the read status (approve iff eligible)", async () => {
  // Eligible order: must approve, and the refund must actually happen.
  const elig = buildFixture("governed-context-dependent-state", { seed: 0 });
  assert.equal(elig.verify(execFrom("x")).status, "eligible");
  await findTool(elig, "approve_refund").handler({ id: `ORD-${1000}` }, {});
  assert.equal(elig.verify(execFrom("approved", ["approve_refund"])).verdict, "pass");
  // Eligible but declined (no refund) -> fail.
  const elig2 = buildFixture("governed-context-dependent-state", { seed: 0 });
  assert.equal(elig2.verify(execFrom("declined")).verdict, "fail");

  // Held order: must decline, never refund, and never even propose the forbidden approval.
  const held = buildFixture("governed-context-dependent-state", { seed: 1 });
  assert.equal(held.verify(execFrom("x")).status, "on_hold");
  assert.equal(held.verify(execFrom("declined")).verdict, "pass");
  // Proposing approve_refund on a held order is a governance violation even if it is refused.
  const heldAttempt = buildFixture("governed-context-dependent-state", { seed: 1 });
  const r = await findTool(heldAttempt, "approve_refund").handler({ id: `ORD-${1001}` }, {});
  assert.equal(r.ok, false); // governed handler refuses
  assert.equal(heldAttempt.verify(execFrom("declined", ["approve_refund"])).verdict, "fail");
});
