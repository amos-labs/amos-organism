import test from "node:test";
import assert from "node:assert/strict";
import { eventStoreDispatchJournal, createCpuDevelopmentDispatch, DISPATCH_EVENT_TYPE } from "../src/persistentLearningCpuBridge.js";
import { dispatchActionIdentity, workSpecificationDigest } from "../src/persistentLearningDispatchAdapter.js";
import { randomUUID } from "node:crypto";

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

// Review 084316Z scope correction: a matching-key completion from a wrong mission,
// non-organism authority, or with an unexpected hostReceiptId must be REJECTED,
// not silently ignored and re-executed. Positive control: the configured scope reuses.
test("read rejects a matching-key record from a wrong mission / authority / hostReceiptId", async () => {
  const key = dispatchActionIdentity(action);
  const payload = { key, actionId: action.actionId, workKind: action.workKind, workSpecDigest: workSpecificationDigest(workItem), state: "completed", receiptDigest: DIGEST };
  const negatives = [
    { missionId: "other-mission", authority: "organism" },
    { missionId: "persistent-learning", authority: "host" },
    { missionId: "persistent-learning", authority: "organism", hostReceiptId: "hr-1" },
  ];
  for (const env of negatives) {
    const store = memStore(); const s = { calls: 0 };
    store.append({ id: `seed:${randomUUID()}`, type: DISPATCH_EVENT_TYPE, occurredAt: "2026-09-12T08:00:00.000Z", payload, ...env });
    const executor = async () => { s.calls += 1; return { status: "passed", receiptDigest: DIGEST }; };
    await assert.rejects(createCpuDevelopmentDispatch({ store, executor, now: clock() }).dispatch(action, workItem), /Invalid CPU dispatch-event authority or scope/);
    // A second fresh bridge over the same store still rejects; nothing executed.
    await assert.rejects(createCpuDevelopmentDispatch({ store, executor, now: clock() }).dispatch(action, workItem), /Invalid CPU dispatch-event authority or scope/);
    assert.equal(s.calls, 0);
  }
  // Positive control: the configured mission/organism scope is adopted (reused, no execute).
  const store = memStore(); const s = { calls: 0 };
  store.append({ id: `seed:${randomUUID()}`, type: DISPATCH_EVENT_TYPE, missionId: "persistent-learning", authority: "organism", occurredAt: "2026-09-12T08:00:00.000Z", payload });
  const r = await createCpuDevelopmentDispatch({ store, executor: async () => { s.calls += 1; return { status: "passed", receiptDigest: DIGEST }; }, now: clock() }).dispatch(action, workItem);
  assert.equal(r.reused, true); assert.equal(s.calls, 0);
});
