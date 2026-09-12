import test from "node:test";
import assert from "node:assert/strict";
import { createSleepDispatchAdapter, dispatchActionIdentity, DISPATCH_STATES } from "../src/persistentLearningDispatchAdapter.js";

// Persistent-mind Slice 2 acceptance: one permitted development task completes
// through the existing executor and survives interruption without duplicate spend.
// CPU-only, no model/tool/GPU work: the executor + journal are injected stubs.

const action = {
  actionId: "reflect-0001",
  workKind: "curriculum-grading",
  observation: { modelId: "pilot-060909-r32-s20260909", family: "date-time", cohortId: "dev-2026-09-12" },
};
const workItem = { id: "dev-task-1", kind: "curriculum-grading" };

function memJournal(seed = null) {
  const store = new Map();
  if (seed) store.set(seed.key, Object.freeze({ ...seed }));
  return {
    store,
    read: (k) => store.get(k) ?? null,
    write: (r) => { store.set(r.key, r); },
  };
}
const clock = (start = Date.UTC(2026, 8, 12, 5, 0, 0)) => {
  let t = start;
  return () => new Date(t += 1000);
};

test("dispatchActionIdentity is deterministic and distinct per identity", () => {
  const a = dispatchActionIdentity(action);
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.equal(a, dispatchActionIdentity({ ...action, observation: { ...action.observation } }));
  assert.notEqual(a, dispatchActionIdentity({ ...action, workKind: "artifact-replay" }));
  assert.notEqual(a, dispatchActionIdentity({ ...action, observation: { ...action.observation, family: "numeric" } }));
  assert.throws(() => dispatchActionIdentity({ ...action, actionId: "" }), /actionId required/);
});

test("a fresh development task completes through the executor exactly once", async () => {
  const journal = memJournal();
  let calls = 0;
  const executor = async () => { calls += 1; return { status: "passed", receiptDigest: "d".repeat(64) }; };
  const adapter = createSleepDispatchAdapter({ journal, executor, now: clock() });
  const r = await adapter.dispatch(action, workItem);
  assert.equal(r.state, "completed"); assert.equal(r.reused, false); assert.equal(r.receiptDigest, "d".repeat(64));
  assert.equal(calls, 1);
  const rec = journal.read(dispatchActionIdentity(action));
  assert.equal(rec.state, "completed"); assert.equal(rec.receiptDigest, "d".repeat(64));
});

test("a repeated dispatch of a completed action is idempotent (no duplicate spend)", async () => {
  const journal = memJournal();
  let calls = 0;
  const executor = async () => { calls += 1; return { status: "passed", receiptDigest: "d".repeat(64) }; };
  const adapter = createSleepDispatchAdapter({ journal, executor, now: clock() });
  await adapter.dispatch(action, workItem);
  const again = await adapter.dispatch(action, workItem);
  assert.equal(again.reused, true); assert.equal(again.state, "completed");
  assert.equal(calls, 1, "executor must not run again for a completed action");
});

test("an interrupted dispatch reconciles a prior job instead of repeating it", async () => {
  // Journal left mid-flight ('running', no receipt) — simulating a crash after dispatch.
  const key = dispatchActionIdentity(action);
  const journal = memJournal({ key, actionId: action.actionId, workKind: action.workKind, state: "running", startedAt: "2026-09-12T05:00:01.000Z" });
  let calls = 0;
  const executor = async () => { calls += 1; return { status: "passed", receiptDigest: "e".repeat(64) }; };
  // reconcile finds the prior job actually produced a receipt -> adopt, do not re-run.
  const reconcile = async () => ({ status: "passed", receiptDigest: "c".repeat(64) });
  const adapter = createSleepDispatchAdapter({ journal, executor, reconcile, now: clock() });
  const r = await adapter.dispatch(action, workItem);
  assert.equal(r.state, "completed"); assert.equal(r.reused, true); assert.equal(r.receiptDigest, "c".repeat(64));
  assert.equal(calls, 0, "must not re-execute when the prior job reconciled to a receipt");
  assert.equal(journal.read(key).state, "completed");
});

test("an interrupted dispatch with no confirmed prior effect executes exactly once", async () => {
  const key = dispatchActionIdentity(action);
  const journal = memJournal({ key, actionId: action.actionId, workKind: action.workKind, state: "submitted", submittedAt: "2026-09-12T05:00:01.000Z" });
  let calls = 0;
  const executor = async () => { calls += 1; return { status: "passed", receiptDigest: "f".repeat(64) }; };
  const reconcile = async () => null; // no prior effect found
  const adapter = createSleepDispatchAdapter({ journal, executor, reconcile, now: clock() });
  const r = await adapter.dispatch(action, workItem);
  assert.equal(r.state, "completed"); assert.equal(calls, 1);
});

test("a completed journal record missing its receiptDigest fails closed", async () => {
  const key = dispatchActionIdentity(action);
  const journal = memJournal({ key, actionId: action.actionId, workKind: action.workKind, state: "completed" });
  const adapter = createSleepDispatchAdapter({ journal, executor: async () => ({ receiptDigest: "d".repeat(64) }), now: clock() });
  await assert.rejects(adapter.dispatch(action, workItem), /completed dispatch record missing receiptDigest/);
});

test("an executor receipt without a receiptDigest is rejected", async () => {
  const adapter = createSleepDispatchAdapter({ journal: memJournal(), executor: async () => ({ status: "passed" }), now: clock() });
  await assert.rejects(adapter.dispatch(action, workItem), /receipt missing receiptDigest/);
  assert.deepEqual(DISPATCH_STATES, ["submitted", "running", "reconciling", "completed"]);
});
