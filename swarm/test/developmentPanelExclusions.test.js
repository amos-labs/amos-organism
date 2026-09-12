import test from "node:test";
import assert from "node:assert/strict";
import { namespacedIdentity, buildExclusionSet, assertPanelDisjoint, exclusionReceipt, jsonlRowShas } from "../src/developmentPanelExclusions.js";

// Typed disjointness for the A0 development panel vs excluded material.

test("namespacedIdentity validates namespace/value and is injective across both", () => {
  const id = namespacedIdentity("dataset-row", "a".repeat(64));
  assert.ok(id.startsWith("dataset-row") && id.endsWith("a".repeat(64)));
  assert.notEqual(namespacedIdentity("nsA", "v"), namespacedIdentity("nsB", "v"));
  assert.notEqual(namespacedIdentity("ns", "vA"), namespacedIdentity("ns", "vB"));
  assert.throws(() => namespacedIdentity("", "x"), /namespace required/);
  assert.throws(() => namespacedIdentity("ns", ""), /value required/);
});

test("a disjoint panel passes; a same-namespace collision is rejected", () => {
  const excluded = buildExclusionSet([
    { namespace: "dataset-row", value: "a".repeat(64) },
    { namespace: "consumed-selection", value: "sel-1" },
  ]);
  assert.ok(assertPanelDisjoint([{ namespace: "dataset-row", value: "b".repeat(64) }, { namespace: "consumed-selection", value: "sel-2" }], excluded));
  assert.throws(() => assertPanelDisjoint([{ namespace: "dataset-row", value: "a".repeat(64) }], excluded), /overlaps excluded material/);
});

test("a value shared across DIFFERENT namespaces does not falsely collide", () => {
  const excluded = buildExclusionSet([{ namespace: "consumed-decision-key", value: "shared-value" }]);
  assert.ok(assertPanelDisjoint([{ namespace: "panel-case", value: "shared-value" }], excluded), "cross-namespace same value is not a collision");
  assert.throws(() => assertPanelDisjoint([{ namespace: "consumed-decision-key", value: "shared-value" }], excluded), /overlaps/);
});

test("exclusionReceipt reports per-namespace counts, unique total and a stable digest", () => {
  const entries = [
    { namespace: "dataset-row", value: "a".repeat(64) },
    { namespace: "dataset-row", value: "a".repeat(64) },
    { namespace: "dataset-row", value: "b".repeat(64) },
    { namespace: "consumed-selection", value: "sel-1" },
  ];
  const r = exclusionReceipt(entries);
  assert.equal(r.countsByNamespace["dataset-row"], 3);
  assert.equal(r.countsByNamespace["consumed-selection"], 1);
  assert.equal(r.totalUniqueIdentities, 3);
  assert.match(r.exclusionSetSha256, /^[a-f0-9]{64}$/);
  assert.equal(exclusionReceipt(entries).exclusionSetSha256, r.exclusionSetSha256, "deterministic");
  assert.match(r.coverage, /NOT semantic novelty/);
});

test("jsonlRowShas hashes each non-empty line to a sha256", () => {
  const shas = jsonlRowShas('{"a":1}\n{"b":2}\n\n');
  assert.equal(shas.length, 2);
  for (const s of shas) assert.match(s, /^[a-f0-9]{64}$/);
  assert.notEqual(shas[0], shas[1]);
});
