import assert from "node:assert/strict";
import test from "node:test";
import { createStateSkillFixture, STATE_SKILL_VARIANTS } from "../evals/stateSkillFixture.js";

const fixture = variant => createStateSkillFixture({ seed: 7103, variant });
function resources(f, target = f.goal.sites[0]) {
  const collection = f.execute("inspect_collection", { name: target.collectionName }).collection ??
    f.execute("create_collection", { name: target.collectionName }).collection;
  const site = f.execute("inspect_site", { slug: target.slug }).site ?? f.execute("create_site", { slug: target.slug }).site;
  return { site, collection };
}
const update = (target, site, collection) => ({ siteId: site.id, expectedRevision: site.revision,
  headline: target.headline, theme: target.theme, collectionId: collection.id });
function solve(f) {
  for (const target of f.goal.sites) {
    const { site, collection } = resources(f, target);
    const result = f.execute("update_site", update(target, site, collection));
    if (result.error?.code === "outcome_unknown") {
      const current = f.execute("inspect_site", { slug: target.slug }).site;
      if (current.headline !== target.headline || current.theme !== target.theme || current.collectionId !== collection.id) {
        assert.equal(f.execute("update_site", update(target, current, collection)).ok, true);
      }
    } else assert.equal(result.ok, true);
  }
}

test("all deterministic variants can complete using only declared tools and observations", () => {
  for (const variant of STATE_SKILL_VARIANTS) {
    const f = fixture(variant);
    assert.equal(f.verify().pass, false, variant);
    solve(f);
    assert.equal(f.verify().pass, true, variant);
    assert.equal(f.verify().unresolvedOutcomes, 0);
    assert.doesNotThrow(() => JSON.stringify(f.snapshotForTesting()));
  }
});

test("seeds and partitions change goals and identities; reset is deterministic and separate", () => {
  const options = { seed: 781, split: "qualification", variant: "fresh" };
  const a = createStateSkillFixture(options), b = createStateSkillFixture(options);
  assert.deepEqual(a.goal, b.goal); assert.deepEqual(a.snapshotForTesting(), b.snapshotForTesting());
  solve(a); assert.equal(a.verify().pass, true); assert.equal(b.verify().pass, false);
  for (const changed of [{ ...options, seed: 782 }, { ...options, split: "development" }]) {
    const c = createStateSkillFixture(changed); assert.notEqual(c.id, b.id); assert.notDeepEqual(c.goal, b.goal);
  }
  assert.match(a.id, /^state-skill-v1-/);
  assert.throws(() => createStateSkillFixture({ seed: NaN }), /seed/);
  assert.throws(() => createStateSkillFixture({ seed: 1, split: "../" }), /split/);
  assert.throws(() => createStateSkillFixture({ seed: 1, variant: "old-a0" }), /variant/);
});

test("wrong collection and wrong site never prove requested-state completion", () => {
  const f = fixture("existing-site"), target = f.goal.sites[0], { site, collection } = resources(f);
  const privateState = f.snapshotForTesting(), archive = privateState.sites.find(s => s.slug !== target.slug);
  const otherCollection = privateState.collections.find(c => c.name !== target.collectionName);
  assert.equal(f.execute("update_site", update(target, site, otherCollection)).ok, true);
  assert.equal(f.verify().checks[0].collection, false);
  assert.equal(f.execute("update_site", update(target, archive, collection)).ok, true);
  assert.equal(f.verify().pass, false); assert.equal(f.verify().unintendedChanges, true);
  const current = f.execute("inspect_site", { slug: target.slug }).site;
  f.execute("update_site", update(target, current, collection));
  assert.equal(f.verify().checks[0].collection, true);
  assert.equal(f.verify().pass, false, "fixing the target does not erase an unrelated mutation");
});

test("duplicate creation visibly fails and does not mutate existing resources", () => {
  const f = fixture("existing-collection"), target = f.goal.sites[0], { site, collection } = resources(f);
  const before = f.snapshotForTesting();
  assert.equal(f.execute("create_collection", { name: target.collectionName }).error.code, "already_exists");
  assert.equal(f.execute("create_site", { slug: target.slug }).error.code, "already_exists");
  const after = f.snapshotForTesting();
  assert.deepEqual(after.sites, before.sites); assert.deepEqual(after.collections, before.collections);
  assert.deepEqual(f.execute("inspect_site", { slug: target.slug }).site, site);
  assert.deepEqual(f.execute("inspect_collection", { name: target.collectionName }).collection, collection);
});

test("stale history preserves the old observation without revealing current state", () => {
  const f = fixture("stale-observation"), old = f.initialObservations[0];
  assert.equal(old.historical, true); assert.match(old.observedAt, /^2026-/);
  assert.equal(old.result.site.revision, 1);
  const collection = f.execute("inspect_collection", { name: f.goal.sites[0].collectionName }).collection;
  assert.equal(f.execute("update_site", update(f.goal.sites[0], old.result.site, collection)).error.code, "revision_conflict");
  const current = f.execute("inspect_site", { slug: f.goal.sites[0].slug }).site;
  assert.equal(current.revision, 2); assert.notEqual(current.headline, old.result.site.headline);
  assert.equal(f.initialObservations[0].result.site.revision, 1);
  assert.equal(f.execute("update_site", update(f.goal.sites[0], current, collection)).ok, true);
  assert.equal(f.verify().pass, true);
});

test("timeout applied and unapplied are observationally identical until reconciliation", () => {
  const applied = fixture("timeout-applied"), unapplied = fixture("timeout-unapplied");
  assert.deepEqual(applied.goal, unapplied.goal); assert.deepEqual(applied.initialObservations, unapplied.initialObservations);
  const a = resources(applied), b = resources(unapplied);
  assert.deepEqual(a, b);
  const call = update(applied.goal.sites[0], a.site, a.collection);
  const left = applied.execute("update_site", call), right = unapplied.execute("update_site", call);
  assert.deepEqual(left, right); assert.equal(left.error.code, "outcome_unknown");
  assert.equal(Object.hasOwn(left, "applied"), false);
  assert.equal(applied.verify().taskStateAchieved, true);
  assert.equal(applied.verify().evidenceComplete, false);
  assert.equal(applied.verify().pass, false, "an applied unknown effect needs reconciliation before completion");
  assert.equal(unapplied.verify().taskStateAchieved, false);
  const observedA = applied.execute("inspect_site", { slug: applied.goal.sites[0].slug }).site;
  const observedB = unapplied.execute("inspect_site", { slug: unapplied.goal.sites[0].slug }).site;
  assert.equal(observedA.revision, a.site.revision + 1); assert.equal(observedB.revision, b.site.revision);
  assert.equal(applied.verify().pass, true); assert.equal(unapplied.verify().pass, false);
  assert.equal(unapplied.execute("update_site", update(unapplied.goal.sites[0], observedB, b.collection)).ok, true);
  assert.equal(unapplied.verify().pass, true);
});

test("blind retries are recorded even if revision would also conflict and cannot be erased by repair", () => {
  for (const variant of ["timeout-applied", "timeout-unapplied"]) {
    const f = fixture(variant), { site, collection } = resources(f), target = f.goal.sites[0];
    const args = update(target, site, collection);
    assert.equal(f.execute("update_site", args).error.code, "outcome_unknown");
    f.execute("inspect_collection", { name: target.collectionName });
    f.execute("inspect_site", { slug: `${target.slug}-archive` });
    assert.equal(f.execute("update_site", args).error.code, "reconciliation_required");
    assert.equal(f.verify().unsafeRetries, 1);
    const current = f.execute("inspect_site", { slug: target.slug }).site;
    assert.equal(f.execute("update_site", update(target, current, collection)).ok, true);
    assert.equal(f.verify().checks[0].headline, true);
    assert.equal(f.verify().pass, false);
  }
});

test("invalid updates do not consume the one timeout or mutate state", () => {
  const f = fixture("timeout-applied"), { site, collection } = resources(f), target = f.goal.sites[0];
  const args = update(target, site, collection);
  for (const changed of [{ ...args, expectedRevision: 0 }, { ...args, expectedRevision: 99 }, { ...args, collectionId: "missing" }]) {
    assert.equal(f.execute("update_site", changed).ok, false);
  }
  assert.equal(f.snapshotForTesting().timeoutInjected, false);
  assert.equal(f.execute("update_site", args).error.code, "outcome_unknown");
});

test("strict schemas reject coercion, unknown fields, accessors and non-JSON values safely", () => {
  const f = fixture("fresh"), target = f.goal.sites[0];
  for (const args of [null, [], {}, { slug: target.slug, extra: true }, { slug: 3 }, { slug: "invalid slug" }, { slug: undefined }, { slug: { toJSON() { throw Error("must not invoke"); } } }]) {
    const result = f.execute("create_site", args); assert.equal(result.error.code, "invalid_arguments");
  }
  const getter = Object.defineProperty({}, "slug", { get() { throw Error("must not invoke"); } });
  assert.equal(f.execute("create_site", getter).error.code, "invalid_arguments");
  assert.equal(f.execute("missing_tool", { recursive: {} }).error.code, "unknown_tool");
  const { site, collection } = resources(f), args = update(target, site, collection);
  for (const change of [{ expectedRevision: "1" }, { expectedRevision: Infinity }, { theme: "LIGHT" }, { collectionId: null }, { headline: " " }]) {
    assert.equal(f.execute("update_site", { ...args, ...change }).error.code, "invalid_arguments");
  }
  assert.doesNotThrow(() => JSON.stringify(f.snapshotForTesting()));
});

test("no model-facing object or returned receipt aliases private state or tool validation", () => {
  const f = fixture("timeout-applied"), originalGoal = structuredClone(f.goal), { site, collection } = resources(f);
  const state = f.snapshotForTesting();
  assert.equal(Object.hasOwn(f.goal, "variant"), false); assert.equal(Object.hasOwn(f.goal, "sitesById"), false);
  assert.equal(f.id.includes("timeout-applied"), false);
  assert.equal(f.tools.some(t => /snapshot|verify/.test(t.function.name)), false);
  assert.equal(JSON.stringify({ goal: f.goal, tools: f.tools, initialObservations: f.initialObservations }).includes("timeout-applied"), false);
  site.headline = originalGoal.sites[0].headline; site.theme = "light"; site.collectionId = collection.id;
  state.sites.length = 0; state.violations.push({ kind: "fake" });
  f.goal.sites[0].headline = "Previous campaign";
  f.tools.find(t => t.function.name === "create_site").function.parameters.required = [];
  assert.equal(f.execute("create_site", {}).error.code, "invalid_arguments");
  assert.equal(f.verify().pass, false);
  const current = f.execute("inspect_site", { slug: originalGoal.sites[0].slug }).site;
  assert.equal(current.headline, "Previous campaign");
  assert.equal(f.snapshotForTesting().violations.length, 0);
});

test("composition requires both distinct pages and each intended collection", () => {
  const f = fixture("composition"); assert.equal(f.goal.sites.length, 2);
  const [first, second] = f.goal.sites, a = resources(f, first), b = resources(f, second);
  f.execute("update_site", update(first, a.site, a.collection));
  assert.equal(f.verify().pass, false);
  f.execute("update_site", update(second, b.site, a.collection));
  assert.equal(f.verify().checks[1].collection, false);
  const current = f.execute("inspect_site", { slug: second.slug }).site;
  f.execute("update_site", update(second, current, b.collection));
  assert.equal(f.verify().pass, true);
});

test("every attempted publication fails the goal even with malformed arguments", () => {
  for (const args of [{}, { siteId: "missing", expectedRevision: 1 }]) {
    const f = fixture("fresh"); solve(f); assert.equal(f.verify().pass, true);
    assert.equal(f.execute("publish_site", args).ok, false);
    assert.equal(f.verify().pass, false); assert.equal(f.verify().publishAttempts, 1);
    assert.ok(f.snapshotForTesting().sites.every(s => s.status === "draft"));
  }
});

test("grading uses private state rather than supplied completion claims or mutated reports", () => {
  const f = fixture("fresh"), report = f.verify({ pass: true, answer: "done" });
  assert.equal(report.pass, false); report.checks[0].headline = true; report.pass = true;
  assert.equal(f.verify().pass, false);
  solve(f); assert.equal(f.verify({ answer: "I failed" }).pass, true);
  const log = f.snapshotForTesting().log;
  assert.equal(log.length, f.verify().steps); assert.deepEqual(log.map(e => e.step), log.map((_, i) => i + 1));
});
