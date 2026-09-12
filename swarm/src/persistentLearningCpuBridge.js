import { randomUUID } from "node:crypto";
import { createSleepDispatchAdapter } from "./persistentLearningDispatchAdapter.js";

// Persistent-mind Slice 2 CPU bridge: run the durable dispatch adapter over the
// controller's AUTHORITATIVE append-only EventStore journal, so dispatch lifecycle
// transitions live in the SAME journal under the SAME single-writer lock the
// runner already holds — no second store and no distributed lock
// (artifacts/persistent-mind-slice2-merged-review-20260912 handoff).
//
// Structural by design: `store` is any {append(proposal), events()} matching the
// OrganismEvent contract, so this bridges the root FileEventStore/MemoryEventStore
// without a cross-package type import. CPU-only; no model/tool/GPU work here.

export const DISPATCH_EVENT_TYPE = "learning.cpu-dispatch-state.v1";

// A dispatch journal ({read,write}) backed by an append-only EventStore. Each
// lifecycle transition is a distinct append; read reconstructs the latest state
// for a key by replaying the journal in sequence order. After an uncertain
// append failure, discard this bridge AND store and reopen the authoritative
// journal before retrying; the existing runner does this on every tick.
export function eventStoreDispatchJournal(store, { missionId = "persistent-learning", now = () => new Date() } = {}) {
  if (!store || typeof store.append !== "function" || typeof store.events !== "function") {
    throw new Error("eventStoreDispatchJournal requires an EventStore with append/events");
  }
  return {
    read(key) {
      let latest = null;
      for (const event of store.events()) {
        if (event.type !== DISPATCH_EVENT_TYPE || !event.payload || event.payload.key !== key) continue;
        if (event.missionId !== missionId || event.authority !== "organism" || event.hostReceiptId !== undefined) {
          throw new Error("Invalid CPU dispatch-event authority or scope");
        }
        latest = event.payload;
      }
      return latest;
    },
    write(record) {
      store.append({
        id: `cpu-dispatch:${record.key}:${record.state}:${randomUUID()}`,
        type: DISPATCH_EVENT_TYPE,
        missionId,
        occurredAt: now().toISOString(),
        authority: "organism",
        payload: record,
      });
    },
  };
}

// Compose an existing sleep-cycle executor (e.g. createArtifactReplayExecutor)
// with the durable dispatch adapter over the EventStore-backed journal. The
// executor is injected so the runner supplies the real one inside its lock; the
// caller must pass an explicit operator-bound development action + work item at
// dispatch time (a reflection is not training/GPU authority).
export function createCpuDevelopmentDispatch({ store, executor, reconcile = null, missionId = "persistent-learning", now = () => new Date() }) {
  if (typeof executor !== "function") throw new Error("createCpuDevelopmentDispatch requires an executor");
  const journal = eventStoreDispatchJournal(store, { missionId, now });
  const adapter = createSleepDispatchAdapter({ journal, executor, reconcile, now });
  return { dispatch: (action, workItem, options) => adapter.dispatch(action, workItem, options), journal };
}
