import { createHash } from "node:crypto";

// Persistent-mind Slice 2: connect the persistent-learning controller's selected
// development work to the EXISTING sleep-cycle / standing-order executors, with a
// durable dispatch lifecycle so a crash after dispatch reconciles the prior job
// instead of blindly repeating a model call or training launch (docs/PERSISTENT_MIND_CONTROLLER.md).
//
// This module is pure and dependency-injected: the journal (durable store), the
// executor (an existing sleep-cycle executor) and an optional reconcile hook are
// supplied by the caller. It performs NO model/tool/GPU work itself and starts no
// resource; the live executor + resource envelope are bound separately after review.
// Codex owns the controller lifecycle/gate semantics; this adapter is the Organism
// executor-connection half only.

export const DISPATCH_STATES = Object.freeze(["submitted", "running", "reconciling", "completed"]);
const CANONICAL_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const canonical = (obj) => JSON.stringify(sortKeys(obj));
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

// Stable idempotency key for a controller-selected development action. Derived only
// from identity fields (never timestamps/attempt counts) so the same weakness maps
// to the same dispatch across restarts and replay stays idempotent.
export function dispatchActionIdentity(action) {
  if (!action || typeof action !== "object") throw new TypeError("dispatch action required");
  const { actionId, workKind, observation } = action;
  if (typeof actionId !== "string" || actionId.length === 0) throw new TypeError("action.actionId required");
  if (typeof workKind !== "string" || workKind.length === 0) throw new TypeError("action.workKind required");
  if (!observation || typeof observation !== "object") throw new TypeError("action.observation required");
  for (const k of ["modelId", "family", "cohortId"]) {
    if (typeof observation[k] !== "string" || observation[k].length === 0) throw new TypeError(`action.observation.${k} required`);
  }
  const identity = { actionId, workKind, modelId: observation.modelId, family: observation.family, cohortId: observation.cohortId };
  return createHash("sha256").update(canonical(identity)).digest("hex");
}

function assertRecord(record, key) {
  if (record == null) return null;
  if (record.key !== key) throw new Error("dispatch journal key mismatch");
  if (!DISPATCH_STATES.includes(record.state)) throw new Error("unknown dispatch state: " + record.state);
  if (record.state === "completed" && (typeof record.receiptDigest !== "string" || record.receiptDigest.length === 0)) {
    throw new Error("completed dispatch record missing receiptDigest");
  }
  return record;
}

// Build the adapter. `journal.read(key)` returns the persisted record or null;
// `journal.write(record)` durably persists it (append-only journal in production).
// `executor(workItem,{signal})` is an existing sleep-cycle executor returning a
// receipt with a `receiptDigest`. Optional `reconcile(workItem, priorRecord,{signal})`
// looks up an already-produced receipt for an interrupted dispatch (so a prior job
// is adopted, not repeated); if it returns null the prior dispatch had no confirmed
// effect and one execution is safe.
export function createSleepDispatchAdapter({ journal, executor, reconcile = null, now = () => new Date() }) {
  if (!journal || typeof journal.read !== "function" || typeof journal.write !== "function") {
    throw new Error("dispatch adapter requires a journal with read/write");
  }
  if (typeof executor !== "function") throw new Error("dispatch adapter requires an executor");
  if (reconcile !== null && typeof reconcile !== "function") throw new Error("reconcile must be a function when provided");

  const stamp = () => {
    const iso = now().toISOString();
    if (!CANONICAL_TS.test(iso)) throw new Error("now() must yield a canonical timestamp");
    return iso;
  };
  const persist = (record) => { journal.write(Object.freeze({ ...record })); return record; };
  const adoptReceipt = (key, action, receipt, at) => {
    if (!receipt || typeof receipt.receiptDigest !== "string" || receipt.receiptDigest.length === 0) {
      throw new Error("executor receipt missing receiptDigest");
    }
    return persist({ key, actionId: action.actionId, workKind: action.workKind, state: "completed",
      receiptDigest: receipt.receiptDigest, receiptStatus: receipt.status ?? null, completedAt: at });
  };

  async function dispatch(action, workItem, { signal = null } = {}) {
    const key = dispatchActionIdentity(action);
    const prior = assertRecord(journal.read(key), key);

    // Idempotent: a completed dispatch never re-executes (no duplicate spend).
    if (prior && prior.state === "completed") {
      return { key, state: "completed", receiptDigest: prior.receiptDigest, reused: true };
    }

    // Interrupted dispatch: reconcile the prior job BEFORE any retry — never blindly repeat.
    if (prior) {
      persist({ ...prior, key, state: "reconciling", reconciledAt: stamp() });
      if (typeof prior.receiptDigest === "string" && prior.receiptDigest.length > 0) {
        const rec = adoptReceipt(key, action, { receiptDigest: prior.receiptDigest, status: prior.receiptStatus }, stamp());
        return { key, state: "completed", receiptDigest: rec.receiptDigest, reused: true };
      }
      if (reconcile) {
        const found = await reconcile(workItem, prior, { signal });
        if (found) {
          const rec = adoptReceipt(key, action, found, stamp());
          return { key, state: "completed", receiptDigest: rec.receiptDigest, reused: true };
        }
      }
      // No confirmed prior effect: safe to execute exactly once below.
    } else {
      persist({ key, actionId: action.actionId, workKind: action.workKind, state: "submitted", submittedAt: stamp() });
    }

    persist({ key, actionId: action.actionId, workKind: action.workKind, state: "running", startedAt: stamp() });
    const receipt = await executor(workItem, { signal });
    const rec = adoptReceipt(key, action, receipt, stamp());
    return { key, state: "completed", receiptDigest: rec.receiptDigest, reused: false, receipt };
  }

  return { dispatch };
}
