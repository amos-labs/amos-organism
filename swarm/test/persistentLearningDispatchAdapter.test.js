import test from "node:test";
import assert from "node:assert/strict";
import { createSleepDispatchAdapter, dispatchActionIdentity, workSpecificationDigest, DISPATCH_STATES } from "../src/persistentLearningDispatchAdapter.js";

// Persistent-mind Slice 2 acceptance + the duplicate-dispatch repairs from
// artifacts/persistent-mind-slice2-review-20260912/REVIEW.md. CPU-only: journal +
// executor + reconcile are injected stubs; no model/tool/GPU work.

const action = {
  actionId: "reflect-0001",
  workKind: "curriculum-grading",
  observation: { modelId: "pilot-060909-r32-s20260909", family: "date-time", cohortId: "dev-2026-09-12" },
};
const workItem = { id: "dev-task-1", kind: "curriculum-grading" };
const DIGEST = "d".repeat(64);

function memJournal(seed = null) {
  const store = new Map();
  if (seed) store.set(seed.key, Object.freeze({ ...seed }));
  return { store, read: (k) => store.get(k) ?? null, write: (r) => { store.set(r.key, r); } };
}
const clock = (start = Date.UTC(2026, 8, 12, 6, 0, 0)) => { let t = start; return () => new Date(t += 1000); };
const countingExecutor = (state) => async () => { state.calls += 1; return { status: "passed", receiptDigest: DIGEST }; };

test("dispatchActionIdentity + workSpecificationDigest are deterministic and validated", () => {
  const a = dispatchActionIdentity(action);
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.equal(a, dispatchActionIdentity({ ...action, observation: { ...action.observation } }));
  assert.notEqual(a, dispatchActionIdentity({ ...action, workKind: "artifact-replay" }));
  assert.match(workSpecificationDigest(workItem), /^[a-f0-9]{64}$/);
  assert.throws(() => dispatchActionIdentity({ ...action, actionId: "" }), /actionId required/);
  assert.throws(() => workSpecificationDigest(null), /workItem object required/);
  assert.deepEqual(DISPATCH_STATES, ["submitted", "running", "reconciling", "unresolved", "completed"]);
});

test("a fresh development task completes through the executor exactly once", async () => {
  const journal = memJournal(); const s = { calls: 0 };
  const adapter = createSleepDispatchAdapter({ journal, executor: countingExecutor(s), now: clock() });
  const r = await adapter.dispatch(action, workItem);
  assert.equal(r.state, "completed"); assert.equal(r.reused, false); assert.equal(r.receiptDigest, DIGEST);
  assert.equal(s.calls, 1);
  const rec = journal.read(dispatchActionIdentity(action));
  assert.equal(rec.state, "completed"); assert.equal(rec.workSpecDigest, workSpecificationDigest(workItem));
});

test("a repeated dispatch of a completed action is idempotent (no duplicate spend)", async () => {
  const journal = memJournal(); const s = { calls: 0 };
  const adapter = createSleepDispatchAdapter({ journal, executor: countingExecutor(s), now: clock() });
  await adapter.dispatch(action, workItem);
  const again = await adapter.dispatch(action, workItem);
  assert.equal(again.reused, true); assert.equal(s.calls, 1);
});

// REVIEW defect 1: killed-after-effect must NOT re-execute under null/unknown reconciliation.
test("an interrupted 'running' dispatch stays UNRESOLVED with no reconciler (never re-executes)", async () => {
  const key = dispatchActionIdentity(action);
  const journal = memJournal({ key, actionId: action.actionId, workKind: action.workKind, workSpecDigest: workSpecificationDigest(workItem), state: "running", startedAt: "2026-09-12T06:00:01.000Z" });
  const s = { calls: 0 };
  const adapter = createSleepDispatchAdapter({ journal, executor: countingExecutor(s), now: clock() }); // no reconcile
  await assert.rejects(adapter.dispatch(action, workItem), /unresolved: prior job is 'unknown'/);
  assert.equal(s.calls, 0, "must not re-execute a possibly-committed prior job");
  assert.equal(journal.read(key).state, "unresolved");
});

test("reconcile 'unknown' or 'running' stays UNRESOLVED; only 'not-started' retries; 'completed' adopts", async () => {
  const seed = () => ({ key: dispatchActionIdentity(action), actionId: action.actionId, workKind: action.workKind, workSpecDigest: workSpecificationDigest(workItem), state: "running", startedAt: "2026-09-12T06:00:01.000Z" });
  for (const outcome of ["unknown", "running"]) {
    const s = { calls: 0 };
    const a = createSleepDispatchAdapter({ journal: memJournal(seed()), executor: countingExecutor(s), reconcile: async () => ({ outcome }), now: clock() });
    await assert.rejects(a.dispatch(action, workItem), /unresolved/);
    assert.equal(s.calls, 0);
  }
  // not-started -> execute exactly once
  const s1 = { calls: 0 };
  const a1 = createSleepDispatchAdapter({ journal: memJournal(seed()), executor: countingExecutor(s1), reconcile: async () => ({ outcome: "not-started" }), now: clock() });
  const r1 = await a1.dispatch(action, workItem);
  assert.equal(r1.state, "completed"); assert.equal(s1.calls, 1);
  // completed -> adopt the reconciled receipt, do not execute
  const s2 = { calls: 0 };
  const a2 = createSleepDispatchAdapter({ journal: memJournal(seed()), executor: countingExecutor(s2), reconcile: async () => ({ outcome: "completed", receipt: { receiptDigest: "c".repeat(64), status: "passed" } }), now: clock() });
  const r2 = await a2.dispatch(action, workItem);
  assert.equal(r2.reused, true); assert.equal(r2.receiptDigest, "c".repeat(64)); assert.equal(s2.calls, 0);
});

// REVIEW defect 2: concurrent same-key dispatches must not both execute.
test("concurrent same-key dispatches execute exactly once (per-key single-flight)", async () => {
  const journal = memJournal(); const s = { calls: 0 };
  const executor = async () => { s.calls += 1; await new Promise((r) => setTimeout(r, 10)); return { status: "passed", receiptDigest: DIGEST }; };
  const adapter = createSleepDispatchAdapter({ journal, executor, now: clock() });
  const [a, b] = await Promise.all([adapter.dispatch(action, workItem), adapter.dispatch(action, workItem)]);
  assert.equal(s.calls, 1, "executor must run once for concurrent same-key dispatches");
  assert.ok(a.state === "completed" && b.state === "completed");
  assert.ok(a.reused !== b.reused, "exactly one dispatch executes; the other reuses");
});

// REVIEW binding defects: changed work spec must not alias the old receipt; malformed digest rejected.
test("a changed work specification under the same action is rejected (no receipt aliasing)", async () => {
  const journal = memJournal(); const s = { calls: 0 };
  const adapter = createSleepDispatchAdapter({ journal, executor: countingExecutor(s), now: clock() });
  await adapter.dispatch(action, workItem);
  await assert.rejects(adapter.dispatch(action, { id: "dev-task-2", kind: "artifact-replay" }), /work specification changed/);
  assert.equal(s.calls, 1);
});

test("a malformed (non-sha256) receipt digest is rejected", async () => {
  const adapter = createSleepDispatchAdapter({ journal: memJournal(), executor: async () => ({ status: "passed", receiptDigest: "not-a-sha256" }), now: clock() });
  await assert.rejects(adapter.dispatch(action, workItem), /receipt digest must be sha256 hex/);
});

// Repair review 064904Z Fix 1: an unbound/legacy prior record (no valid workSpecDigest)
// must not reuse or retry — it is unresolved.
test("a prior record with a missing/invalid work-spec binding is unresolved (no reuse)", async () => {
  const key = dispatchActionIdentity(action); const s = { calls: 0 };
  for (const bad of [undefined, null, 123, "not-a-sha256"]) {
    const seed = { key, actionId: action.actionId, workKind: action.workKind, state: "completed", receiptDigest: DIGEST };
    if (bad !== undefined) seed.workSpecDigest = bad;
    const adapter = createSleepDispatchAdapter({ journal: memJournal(seed), executor: countingExecutor(s), now: clock() });
    await assert.rejects(adapter.dispatch(action, workItem), /no valid work-spec binding|sha256/);
  }
  assert.equal(s.calls, 0);
});

// Repair review 064904Z Fix 2: mutating the caller's inputs after dispatch is called
// must not change the executed work, key, digest or recorded action.
test("inputs are snapshotted before queueing (post-call mutation cannot alter work/identity)", async () => {
  const journal = memJournal(); let seen = null;
  const executor = async (item) => { seen = item; return { status: "passed", receiptDigest: DIGEST }; };
  const mutableAction = { ...action, observation: { ...action.observation } };
  const mutableWork = { id: "dev-task-1", kind: "curriculum-grading", nested: { n: 1 } };
  const expectedKey = dispatchActionIdentity(mutableAction);
  const adapter = createSleepDispatchAdapter({ journal, executor, now: clock() });
  const p = adapter.dispatch(mutableAction, mutableWork);
  mutableAction.actionId = "MUTATED"; mutableAction.observation.family = "MUTATED";
  mutableWork.id = "MUTATED"; mutableWork.nested.n = 999;
  const r = await p;
  assert.equal(r.key, expectedKey, "identity uses the pre-mutation snapshot");
  assert.equal(seen.id, "dev-task-1"); assert.equal(seen.nested.n, 1);
  assert.equal(journal.read(expectedKey).actionId, "reflect-0001");
});

// Repair review 064904Z normalization: a null reconcile result must resolve to
// 'unresolved', not leave the record stuck in 'reconciling'.
test("a null reconcile result normalizes to unresolved (not stuck reconciling)", async () => {
  const key = dispatchActionIdentity(action); const s = { calls: 0 };
  const seed = { key, actionId: action.actionId, workKind: action.workKind, workSpecDigest: workSpecificationDigest(workItem), state: "running", startedAt: "2026-09-12T06:00:01.000Z" };
  const journal = memJournal(seed);
  const adapter = createSleepDispatchAdapter({ journal, executor: countingExecutor(s), reconcile: async () => null, now: clock() });
  await assert.rejects(adapter.dispatch(action, workItem), /unresolved/);
  assert.equal(journal.read(key).state, "unresolved");
  assert.equal(s.calls, 0);
});
