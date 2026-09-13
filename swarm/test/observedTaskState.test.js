import test from "node:test";
import assert from "node:assert/strict";
import { projectObservedTaskState, formatObservedContext } from "../src/observedTaskState.js";

const site = (changes = {}) => ({ id: "site-1", slug: "launch", revision: 1, headline: "Old", theme: "blue", collectionId: null, ...changes });
const inspect = (value, slug = value?.slug ?? "launch") => ({ name: "inspect_site", args: { slug }, result: { ok: true, site: value } });
const collection = (value, name = value?.name ?? "Leads") => ({ name: "inspect_collection", args: { name }, result: { ok: true, collection: value } });
const update = (result, siteId = "site-1") => ({
  name: "update_site",
  args: { siteId, expectedRevision: 1, headline: "Requested", theme: "green", collectionId: "requested-list" },
  result
});
const unknown = (siteId = "site-1") => update({ ok: false, error: { code: "outcome_unknown", message: "Response timed out." } }, siteId);

test("empty and null observations distinguish no evidence from observed nonexistence", () => {
  assert.deepEqual(projectObservedTaskState([]), {
    sitesBySlug: {}, collectionsByName: {}, unresolvedEffects: [], errors: [], observationCount: 0
  });
  const state = projectObservedTaskState([inspect(null), collection(null)]);
  assert.deepEqual(state.sitesBySlug.launch, { value: null, sourcedAt: 0 });
  assert.deepEqual(state.collectionsByName.Leads, { value: null, sourcedAt: 1 });
});

test("later observed responses replace stale snapshots without inventing monotonic revisions", () => {
  const state = projectObservedTaskState([
    inspect(site({ revision: 8 })),
    update({ ok: false, error: { code: "revision_conflict", message: "Stale write." } }),
    inspect(site({ revision: 3, headline: "Actually read" }))
  ]);
  assert.deepEqual(state.sitesBySlug.launch, { value: site({ revision: 3, headline: "Actually read" }), sourcedAt: 2 });
  assert.equal(state.errors[0].sourcedAt, 1);
  assert.equal(state.observationCount, 3);
});

test("both views retain public freshness while historical receipts make no current state claim", () => {
  const receipt = {
    ...inspect(site()), historical: true, observedAt: "2026-01-01T00:00:00.000Z",
    note: "Historical observation only; inspect before using this revision.",
    metadata: { hiddenGoal: "private target" }, hiddenWorld: "must not be copied"
  };
  const history = formatObservedContext([receipt], "history");
  const { metadata: _metadata, hiddenWorld: _hiddenWorld, ...publicReceipt } = receipt;
  assert.deepEqual(history.events, [publicReceipt]);
  const typed = formatObservedContext([receipt], "typed");
  assert.deepEqual(typed.state.sitesBySlug.launch, {
    lastObserved: { value: site(), sourcedAt: 0, observedAt: receipt.observedAt, note: receipt.note }, historical: true
  });
  assert.equal(Object.hasOwn(typed.state.sitesBySlug.launch, "value"), false);
  for (const context of [history, typed]) assert.doesNotMatch(JSON.stringify(context), /private target|hiddenWorld/);
  const absent = projectObservedTaskState([{ ...inspect(null), historical: true }]);
  assert.deepEqual(absent.sitesBySlug.launch, { lastObserved: { value: null, sourcedAt: 0 }, historical: true });
});

test("a later live inspection replaces historical state and preserves its own public freshness", () => {
  const fresh = { ...inspect(site({ revision: 2 })), historical: false, observedAt: "current read", note: "Live receipt." };
  const state = projectObservedTaskState([{ ...inspect(site()), historical: true, observedAt: "old read" }, fresh]);
  assert.deepEqual(state.sitesBySlug.launch, {
    value: site({ revision: 2 }), sourcedAt: 1, observedAt: "current read", note: "Live receipt.", historical: false
  });
  assert.equal(Object.hasOwn(state.sitesBySlug.launch, "lastObserved"), false);
});

test("historical inspection cannot reconcile an unknown effect and public error freshness survives", () => {
  const failed = { ...unknown(), historical: true, observedAt: "old failure", note: "Original response unavailable." };
  const state = projectObservedTaskState([
    { ...inspect(site()), historical: true }, failed, { ...inspect(site()), historical: true, observedAt: "old read" }
  ]);
  assert.equal(state.sitesBySlug.launch.historical, true);
  assert.deepEqual(state.sitesBySlug.launch.ambiguity, [1]);
  assert.equal(state.unresolvedEffects.length, 1);
  for (const evidence of [state.errors[0], state.unresolvedEffects[0]]) {
    assert.equal(evidence.historical, true);
    assert.equal(evidence.observedAt, "old failure");
    assert.equal(evidence.note, "Original response unavailable.");
  }
  const invalidated = projectObservedTaskState([{ ...inspect(site()), historical: true }, unknown()]);
  assert.equal(invalidated.sitesBySlug.launch.historical, true);
});

test("public freshness fields are type checked without interpreting their contents", () => {
  for (const patch of [{ historical: "true" }, { historical: null }, { observedAt: 42 }, { note: {} }]) {
    for (const mode of ["history", "typed"]) assert.throws(() => formatObservedContext([{ ...inspect(site()), ...patch }], mode), TypeError);
  }
  assert.equal(formatObservedContext([{ ...inspect(site()), observedAt: "", note: "" }]).events[0].observedAt, "");
});

test("successful mutations use response entities, never requested values or fabricated prior snapshots", () => {
  const created = { id: "list-1", name: "Observed list", revision: 4 };
  const state = projectObservedTaskState([
    { name: "create_collection", args: { name: "Requested list" }, result: { ok: true, collection: created } },
    { name: "create_site", args: { slug: "requested-slug", headline: "Requested" }, result: { ok: true, site: site() } },
    update({ ok: true, site: site({ revision: 2, headline: "Returned" }) })
  ]);
  assert.deepEqual(state.collectionsByName, { "Observed list": { value: created, sourcedAt: 0 } });
  assert.deepEqual(state.sitesBySlug, { launch: { value: site({ revision: 2, headline: "Returned" }), sourcedAt: 2 } });
  assert.equal(Object.hasOwn(state.sitesBySlug.launch, "lastObserved"), false);
  assert.deepEqual(projectObservedTaskState([update({ ok: true, site: site() })]).sitesBySlug.launch,
    { value: site(), sourcedAt: 0 });
});

test("an unknown write invalidates current knowledge while preserving the last observation and error", () => {
  const state = projectObservedTaskState([inspect(site()), unknown()]);
  assert.deepEqual(state.sitesBySlug.launch, { lastObserved: { value: site(), sourcedAt: 0 }, ambiguity: [1] });
  assert.equal(Object.hasOwn(state.sitesBySlug.launch, "value"), false);
  assert.equal(state.unresolvedEffects[0].args.headline, "Requested");
  assert.deepEqual(state.unresolvedEffects[0].affected, { kind: "site", id: "site-1", keys: ["launch"] });
  assert.equal(state.errors[0].result.error.code, "outcome_unknown");
});

test("applied and unapplied timeouts remain indistinguishable until public inspection", () => {
  const observed = [inspect(site()), unknown()];
  const applied = observed.map(event => ({ ...event, metadata: { privateWorld: "applied" } }));
  const unapplied = observed.map(event => ({ ...event, metadata: { privateWorld: "unapplied" } }));
  for (const mode of ["history", "typed"]) assert.deepEqual(formatObservedContext(applied, mode), formatObservedContext(unapplied, mode));
  assert.deepEqual(projectObservedTaskState(applied), projectObservedTaskState(unapplied));
  const reconciled = projectObservedTaskState([...observed, inspect(site({ revision: 2, headline: "Requested" }))]);
  assert.equal(reconciled.unresolvedEffects.length, 0);
  assert.equal(reconciled.sitesBySlug.launch.value.headline, "Requested");
  assert.equal(reconciled.errors.length, 1); // Current state is resolved; historical failure evidence remains.
});

test("matching reads resolve only their own effects and leave unrelated ambiguity intact", () => {
  const second = site({ id: "site-2", slug: "other" });
  const events = [inspect(site()), inspect(second), unknown(), unknown("site-2"), collection(null), inspect(site(), "launch")];
  const state = projectObservedTaskState(events);
  assert.deepEqual(state.sitesBySlug.launch, { value: site(), sourcedAt: 5 });
  assert.deepEqual(state.sitesBySlug.other, { lastObserved: { value: second, sourcedAt: 1 }, ambiguity: [3] });
  assert.equal(state.unresolvedEffects.length, 1);
  assert.equal(state.unresolvedEffects[0].affected.id, "site-2");
  assert.deepEqual(state.errors.map(error => error.sourcedAt), [2, 3]);
});

test("a matching null read resolves unknown current state using a previously observed slug binding", () => {
  const state = projectObservedTaskState([inspect(site()), unknown(), inspect(null)]);
  assert.deepEqual(state.sitesBySlug.launch, { value: null, sourcedAt: 2 });
  assert.deepEqual(state.unresolvedEffects, []);
});

test("an unknown mutation without prior evidence cannot create a fake site or fake prior state", () => {
  const pending = projectObservedTaskState([unknown()]);
  assert.deepEqual(pending.sitesBySlug, {});
  assert.deepEqual(pending.unresolvedEffects[0].affected.keys, []);
  assert.equal(projectObservedTaskState([unknown(), inspect(null)]).unresolvedEffects.length, 1);
  const resolved = projectObservedTaskState([unknown(), inspect(site())]);
  assert.equal(resolved.unresolvedEffects.length, 0);
  assert.deepEqual(resolved.sitesBySlug.launch, { value: site(), sourcedAt: 1 });
});

test("multiple unknown effects survive until inspection, even after a returned mutation snapshot", () => {
  const state = projectObservedTaskState([inspect(site()), unknown(), unknown(), update({ ok: true, site: site({ revision: 2 }) })]);
  assert.deepEqual(state.sitesBySlug.launch, { lastObserved: { value: site({ revision: 2 }), sourcedAt: 3 }, ambiguity: [1, 2] });
  const resolved = projectObservedTaskState([inspect(site()), unknown(), unknown(), inspect(site())]);
  assert.deepEqual(resolved.unresolvedEffects, []);
  assert.deepEqual(resolved.errors.map(error => error.sourcedAt), [1, 2]);
});

test("unknown creates invalidate observed absence without claiming existence", () => {
  const failed = { ok: false, error: { code: "outcome_unknown", message: "No response." } };
  const events = [inspect(null), collection(null),
    { name: "create_site", args: { slug: "launch" }, result: failed },
    { name: "create_collection", args: { name: "Leads" }, result: failed }];
  const state = projectObservedTaskState(events);
  assert.deepEqual(state.sitesBySlug.launch, { lastObserved: { value: null, sourcedAt: 0 }, ambiguity: [2] });
  assert.deepEqual(state.collectionsByName.Leads, { lastObserved: { value: null, sourcedAt: 1 }, ambiguity: [3] });
  assert.equal(projectObservedTaskState([...events, inspect(null)]).unresolvedEffects.length, 1);
});

test("unfamiliar output is preserved as unprojected evidence, not silently promoted or discarded", () => {
  const event = { name: "other_tool", args: {}, result: { observed: [1, 2, "details"] } };
  const state = projectObservedTaskState([event]);
  assert.deepEqual(state.errors, [{ kind: "unprojected-observation", ...event, sourcedAt: 0 }]);
  assert.deepEqual(state.sitesBySlug, {});
});

test("history preserves all public events and output text, ignores metadata, and returns independent JSON data", () => {
  const first = inspect(site({ description: "x".repeat(20_000) }));
  first.metadata = { hiddenGoal: "must not enter either arm" };
  const events = [first, unknown()];
  const before = JSON.stringify(events);
  const history = formatObservedContext(events);
  assert.deepEqual(history, { mode: "history", events: events.map(({ name, args, result }) => ({ name, args, result })) });
  assert.deepEqual(formatObservedContext(events, "typed"), { mode: "typed", state: projectObservedTaskState(events) });
  assert.equal(JSON.stringify(events), before);
  history.events[0].result.site.headline = "mutated output";
  assert.equal(events[0].result.site.headline, "Old");
  assert.deepEqual(JSON.parse(JSON.stringify(projectObservedTaskState(events))), projectObservedTaskState(events));
});

test("rejects malformed public objects without invoking accessors", () => {
  const getter = {};
  Object.defineProperty(getter, "headline", { enumerable: true, get() { throw new Error("accessor was invoked"); } });
  const cyclic = {}; cyclic.self = cyclic;
  const unsafeArray = [inspect(site())];
  Object.defineProperty(unsafeArray, "__proto__", { value: {} });
  const invalid = [
    null, {}, [, inspect(site())], unsafeArray,
    [{ name: "inspect_site", args: {}, result: { ok: true, site: null } }],
    [{ name: "inspect_site", args: { slug: "launch" }, result: { ok: true } }],
    [inspect(site(), "mismatch")],
    [update({ ok: true, site: null })],
    [{ ...inspect(site()), result: { ok: "yes", site: site() } }],
    [{ ...inspect(site()), args: Object.create({ slug: "launch" }) }],
    [{ ...inspect(site()), result: JSON.parse('{"ok":true,"site":{"__proto__":{}}}') }],
    [{ ...inspect(site()), result: { ok: true, site: getter } }],
    [{ ...inspect(site()), result: cyclic }],
    [{ ...inspect(site()), result: { ok: true, site: site({ revision: NaN }) } }],
    [inspect(site({ slug: "__proto__" }))],
    [{ ...inspect(site()), result: { ok: false, error: { code: "bad" } } }]
  ];
  for (const events of invalid) assert.throws(() => projectObservedTaskState(events), TypeError);
  assert.throws(() => formatObservedContext([], "summary"), TypeError);
});
