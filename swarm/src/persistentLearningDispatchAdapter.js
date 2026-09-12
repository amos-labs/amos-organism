import { createHash } from "node:crypto";

// Persistent-mind Slice 2: connect the persistent-learning controller's selected
// development work to the EXISTING sleep-cycle / standing-order executors, with a
// durable dispatch lifecycle so a crash after dispatch reconciles the prior job
// instead of blindly repeating a model call or training launch
// (docs/PERSISTENT_MIND_CONTROLLER.md Slice 2).
//
// Repaired per artifacts/persistent-mind-slice2-review-20260912/REVIEW.md:
//  - explicit reconciliation outcomes (completed/running/unknown/not-started);
//    ONLY authoritatively not-started may retry; missing reconciler or a
//    null/unknown/running outcome stays UNRESOLVED and never re-executes.
//  - per-key single-flight so concurrent same-key dispatches cannot both execute.
//  - an immutable work-specification digest is bound to the record; a changed
//    work spec under the same action is rejected, never aliased to the old receipt.
//  - receipt digests are validated as sha256 hex before acceptance.
//
// Pure and dependency-injected: the journal (durable store), executor (an existing
// sleep-cycle executor) and reconcile hook are supplied by the caller. It performs
// NO model/tool/GPU work and starts no resource; the live executor + resource
// envelope bind separately after review. Codex owns controller lifecycle/gate
// semantics; this is the Organism executor-connection half. Dispatch completion
// establishes neither quality nor fitness.

export const DISPATCH_STATES = Object.freeze(["submitted", "running", "reconciling", "unresolved", "completed"]);
export const RECONCILE_OUTCOMES = Object.freeze(["completed", "running", "unknown", "not-started"]);
const SHA256 = /^[a-f0-9]{64}$/;
const CANONICAL_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const sha256hex = (s) => createHash("sha256").update(s).digest("hex");
const canonical = (obj) => JSON.stringify(sortKeys(obj));
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}
function deepFreeze(v) {
  if (v && typeof v === "object") { for (const k of Object.keys(v)) deepFreeze(v[k]); return Object.freeze(v); }
  return v;
}

// Stable idempotency key for a controller-selected development action — identity
// fields only (never timestamps/attempt counts) so replay stays idempotent.
export function dispatchActionIdentity(action) {
  if (!action || typeof action !== "object") throw new TypeError("dispatch action required");
  const { actionId, workKind, observation } = action;
  if (typeof actionId !== "string" || actionId.length === 0) throw new TypeError("action.actionId required");
  if (typeof workKind !== "string" || workKind.length === 0) throw new TypeError("action.workKind required");
  if (!observation || typeof observation !== "object") throw new TypeError("action.observation required");
  for (const k of ["modelId", "family", "cohortId"]) {
    if (typeof observation[k] !== "string" || observation[k].length === 0) throw new TypeError(`action.observation.${k} required`);
  }
  return sha256hex(canonical({ actionId, workKind, modelId: observation.modelId, family: observation.family, cohortId: observation.cohortId }));
}

// Immutable digest of the exact work specification, bound to the dispatch record.
export function workSpecificationDigest(workItem) {
  if (!workItem || typeof workItem !== "object") throw new TypeError("workItem object required");
  return sha256hex(canonical(workItem));
}

function assertReceiptDigest(digest) {
  if (typeof digest !== "string" || !SHA256.test(digest)) throw new Error("receipt digest must be sha256 hex");
  return digest;
}

function assertRecord(record, key) {
  if (record == null) return null;
  if (record.key !== key) throw new Error("dispatch journal key mismatch");
  if (!DISPATCH_STATES.includes(record.state)) throw new Error("unknown dispatch state: " + record.state);
  if (record.state === "completed") assertReceiptDigest(record.receiptDigest);
  return record;
}

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
  const base = (key, action, workDigest) => ({ key, actionId: action.actionId, workKind: action.workKind, workSpecDigest: workDigest });
  const adopt = (key, action, workDigest, receipt) => persist({ ...base(key, action, workDigest), state: "completed",
    receiptDigest: assertReceiptDigest(receipt?.receiptDigest), receiptStatus: receipt?.status ?? null, completedAt: stamp() });

  // Per-key single-flight: chain each dispatch after the previous for the same key
  // settles, so overlapping same-key calls serialize and cannot both execute.
  const inFlight = new Map();

  async function dispatchInner(action, workItem, key, workDigest, signal) {
    const prior = assertRecord(journal.read(key), key);
    if (prior) {
      // Require a VALID, EQUAL work-spec binding before any reuse or retry. An
      // unbound/legacy record (missing or non-sha256 workSpecDigest) cannot be
      // trusted to describe this work, so it stays unresolved rather than reusing.
      if (typeof prior.workSpecDigest !== "string" || !SHA256.test(prior.workSpecDigest)) {
        persist({ ...base(key, action, workDigest), state: "unresolved", outcome: "unbound", unresolvedAt: stamp() });
        throw new Error("prior dispatch record has no valid work-spec binding; unresolved");
      }
      if (prior.workSpecDigest !== workDigest) {
        throw new Error("work specification changed for dispatch key; refusing to reuse the prior receipt");
      }
      if (prior.state === "completed") {
        return { key, state: "completed", receiptDigest: prior.receiptDigest, reused: true };
      }
      // Interrupted dispatch: reconcile explicitly BEFORE any retry. A missing
      // reconciler or a null/invalid result normalizes to 'unknown' -> unresolved.
      persist({ ...prior, key, state: "reconciling", reconciledAt: stamp() });
      const res = reconcile ? await reconcile(workItem, prior, { signal, key }) : null;
      const outcome = RECONCILE_OUTCOMES.includes(res?.outcome) ? res.outcome : "unknown";
      if (outcome === "completed") {
        const rec = adopt(key, action, workDigest, res.receipt);
        return { key, state: "completed", receiptDigest: rec.receiptDigest, reused: true };
      }
      if (outcome !== "not-started") {
        // running | unknown (or missing reconciler): the prior job may have committed
        // an effect. Fail closed — never re-execute; require reconciliation.
        persist({ ...base(key, action, workDigest), state: "unresolved", outcome, unresolvedAt: stamp() });
        throw new Error(`dispatch unresolved: prior job is '${outcome}'; refusing to re-execute without proof it never started`);
      }
      // outcome === "not-started": authoritatively proven safe to execute once.
    } else {
      persist({ ...base(key, action, workDigest), state: "submitted", submittedAt: stamp() });
    }
    persist({ ...base(key, action, workDigest), state: "running", startedAt: stamp() });
    const receipt = await executor(workItem, { signal, key });
    const rec = adopt(key, action, workDigest, receipt);
    return { key, state: "completed", receiptDigest: rec.receiptDigest, reused: false, receipt };
  }

  async function dispatch(action, workItem, { signal = null } = {}) {
    // Snapshot + freeze inputs BEFORE queueing, and derive identity/digest from the
    // SAME snapshots the executor and reconciler will see, so a caller mutating its
    // objects before the microtask runs cannot change the executed work, key,
    // digest or recorded action.
    const actionSnapshot = deepFreeze(structuredClone(action));
    const workSnapshot = deepFreeze(structuredClone(workItem));
    const key = dispatchActionIdentity(actionSnapshot);
    const workDigest = workSpecificationDigest(workSnapshot);
    action = actionSnapshot; workItem = workSnapshot;
    const prev = inFlight.get(key) ?? Promise.resolve();
    const run = prev.then(() => dispatchInner(action, workItem, key, workDigest, signal),
      () => dispatchInner(action, workItem, key, workDigest, signal));
    inFlight.set(key, run);
    run.finally(() => { if (inFlight.get(key) === run) inFlight.delete(key); }).catch(() => {});
    return run;
  }

  return { dispatch };
}
