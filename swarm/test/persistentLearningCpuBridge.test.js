import test from "node:test";
import assert from "node:assert/strict";
import { eventStoreDispatchJournal, createCpuDevelopmentDispatch, DISPATCH_EVENT_TYPE } from "../src/persistentLearningCpuBridge.js";
import { dispatchActionIdentity, workSpecificationDigest } from "../src/persistentLearningDispatchAdapter.js";

// CPU bridge: durable dispatch over an append-only EventStore, proving the Slice 2
// exit evidence at the journal level. No model/tool/GPU work: the executor is a
// stub and the store is an in-test append-only EventStore matching the contract.

// Minimal append-only EventStore matching src/eventStore.ts (id-unique, ordered).
function memStore() {
  const events = [];
  return {
    events: () => events.slice(),
    append(p) {
      if (events.some((e) => e.id === p.id)) throw new Error("duplicate event id: " + p.id);
      const e = { ...p, sequence: events.length + 1 };
      events.push(e);
      return e;
    },
  };
}
const clock = (start = Date.UTC(2026, 8, 12, 8, 0, 0)) => { let t = start; return () => new Date(t += 1000); };
const action = { actionId: "reflect-1", workKind: "artifact-replay", observation: { modelId: "s6", family: "date-time", cohortId: "dev-1" } };
const workItem = { id: "dev-task-1", kind: "artifact-replay" };
const DIGEST = "a".repeat(64);

test("eventStoreDispatchJournal round-trips and keeps the latest state per key", () => {
  const store = memStore();
  const j = eventStoreDispatchJournal(store, { now: clock() });
  assert.equal(j.read("k1"), null);
  j.write({ key: "k1", state: "submitted" });
  j.write({ key: "k1", state: "running" });
  j.write({ key: "k2", state: "completed", receiptDigest: DIGEST });
  assert.equal(j.read("k1").state, "running");
  assert.equal(j.read("k2").state, "completed");
  assert.equal(store.events().filter((e) => e.type === DISPATCH_EVENT_TYPE).length, 3);
  assert.throws(() => eventStoreDispatchJournal({}), /requires an EventStore/);
});

test("a development task completes once and persists a receipt in the shared journal", async () => {
  const store = memStore(); const s = { calls: 0 };
  const executor = async () => { s.calls += 1; return { status: "passed", receiptDigest: DIGEST }; };
  const bridge = createCpuDevelopmentDispatch({ store, executor, now: clock() });
  const r = await bridge.dispatch(action, workItem);
  assert.equal(r.state, "completed"); assert.equal(r.receiptDigest, DIGEST); assert.equal(s.calls, 1);
  const key = dispatchActionIdentity(action);
  assert.equal(bridge.journal.read(key).state, "completed");
});

test("a restart (new bridge over the same store) does not execute completed work twice", async () => {
  const store = memStore(); const s = { calls: 0 };
  const executor = async () => { s.calls += 1; return { status: "passed", receiptDigest: DIGEST }; };
  await createCpuDevelopmentDispatch({ store, executor, now: clock() }).dispatch(action, workItem);
  // Fresh bridge instance reading the same durable journal = process restart.
  const r = await createCpuDevelopmentDispatch({ store, executor, now: clock() }).dispatch(action, workItem);
  assert.equal(r.reused, true); assert.equal(s.calls, 1, "completed work must not re-run after restart");
});

test("ambiguous interrupted work stays unresolved (no reconciler, no re-execution)", async () => {
  const store = memStore(); const s = { calls: 0 };
  const now = clock();
  // Seed an interrupted 'running' transition (valid work binding) into the journal.
  eventStoreDispatchJournal(store, { now }).write({
    key: dispatchActionIdentity(action), actionId: action.actionId, workKind: action.workKind,
    workSpecDigest: workSpecificationDigest(workItem), state: "running", startedAt: "2026-09-12T08:00:01.000Z",
  });
  const executor = async () => { s.calls += 1; return { status: "passed", receiptDigest: DIGEST }; };
  const bridge = createCpuDevelopmentDispatch({ store, executor, now });
  await assert.rejects(bridge.dispatch(action, workItem), /unresolved/);
  assert.equal(s.calls, 0);
  assert.equal(bridge.journal.read(dispatchActionIdentity(action)).state, "unresolved");
});
