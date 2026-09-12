import test from "node:test";
import assert from "node:assert/strict";
import {
  identityKey, rowContentValue, canonicalJsonlRowValues, buildExclusionSet,
  assertPanelDisjoint, exclusionReceipt, panelVersusInventoryReceipt, IDENTITY_TYPES,
} from "../src/developmentPanelExclusions.js";

// Unified identity model: both sides derive identities the same way; partition is
// provenance only, never part of the collision key.

test("identityKey validates type + value and encodes unambiguously", () => {
  assert.ok(IDENTITY_TYPES.includes("row-content"));
  assert.equal(identityKey("row-content", "a".repeat(64)), JSON.stringify(["row-content", "a".repeat(64)]));
  assert.throws(() => identityKey("not-a-type", "x"), /unknown identity type/);
  assert.throws(() => identityKey("row-content", ""), /value required/);
  // separator characters in the value cannot conflate distinct identities
  assert.notEqual(identityKey("row-content", "a\nb"), identityKey("row-content", "a\tb"));
});

test("rowContentValue is key-order independent; raw text is not hashed", () => {
  assert.equal(rowContentValue({ z: 1, a: 2 }), rowContentValue({ a: 2, z: 1 }));
  const vals = canonicalJsonlRowValues('{"z":1,"a":2}\n{"a":2,"z":1}\n\n');
  assert.equal(vals.length, 2);
  assert.equal(vals[0], vals[1], "same parsed object hashes identically regardless of key order");
});

test("a value shared across DIFFERENT types does not falsely collide; same type+value does", () => {
  const shared = "a".repeat(64);
  const excluded = buildExclusionSet([{ type: "row-content", value: shared }]);
  assert.ok(assertPanelDisjoint([{ type: "decision-signature", value: shared }], excluded), "different type is not a collision");
  assert.throws(() => assertPanelDisjoint([{ type: "row-content", value: shared }], excluded), /overlaps excluded material/);
});

test("partition is provenance only: a panel row-content matching ANY excluded partition collides", () => {
  const v = rowContentValue({ task: "reused" });
  const excluded = buildExclusionSet([{ type: "row-content", value: v, partition: "train" }]);
  // panel body carries no partition, yet still collides because the collision key omits partition
  assert.throws(() => assertPanelDisjoint([{ type: "row-content", value: v }], excluded), /overlaps/);
});

test("exclusionReceipt reports counts by type + partition, unique total and a stable structured digest", () => {
  const entries = [
    { type: "row-content", value: "a".repeat(64), partition: "train" },
    { type: "row-content", value: "a".repeat(64), partition: "train" },
    { type: "row-content", value: "b".repeat(64), partition: "diagnostic-validation" },
    { type: "decision-key", value: "1778583f", partition: "parent-trajectory" },
  ];
  const r = exclusionReceipt(entries);
  assert.equal(r.countsByType["row-content"], 3);
  assert.equal(r.countsByType["decision-key"], 1);
  assert.equal(r.countsByPartition["train"], 2);
  assert.equal(r.totalUniqueIdentities, 3);
  assert.match(r.exclusionSetSha256, /^[a-f0-9]{64}$/);
  assert.equal(exclusionReceipt(entries).exclusionSetSha256, r.exclusionSetSha256, "deterministic");
  assert.match(r.coverage, /NOT.*semantic novelty|does NOT prove semantic novelty/);
});

test("structured digest is unambiguous across separator characters in values", () => {
  const a = exclusionReceipt([{ type: "row-content", value: "x\ny" }]);
  const b = exclusionReceipt([{ type: "row-content", value: "x" }, { type: "row-content", value: "y" }]);
  assert.notEqual(a.exclusionSetSha256, b.exclusionSetSha256, "an embedded newline must not conflate one entry with two");
});

test("panelVersusInventoryReceipt requires nonempty inventory + comparable panel identities, then proves disjointness", () => {
  const inventory = [
    { type: "row-content", value: "c".repeat(64), partition: "train" },
    { type: "decision-key", value: "deadbeef", partition: "consumed-case" },
  ];
  const panel = [
    { type: "case-id", value: "date-time:0123456789abcdef" },
    { type: "row-content", value: "d".repeat(64) },
  ];
  const receipt = panelVersusInventoryReceipt({ inventoryEntries: inventory, panelEntries: panel });
  assert.equal(receipt.disjoint, true);
  assert.equal(receipt.inventory.totalUniqueIdentities, 2);
  assert.equal(receipt.panel.totalUniqueIdentities, 2);
  assert.match(receipt.inventory.exclusionSetSha256, /^[a-f0-9]{64}$/);
  // guards
  assert.throws(() => panelVersusInventoryReceipt({ inventoryEntries: [], panelEntries: panel }), /nonempty excluded inventory/);
  assert.throws(() => panelVersusInventoryReceipt({ inventoryEntries: inventory, panelEntries: [] }), /nonempty comparable panel/);
  assert.throws(() => panelVersusInventoryReceipt({ inventoryEntries: inventory, panelEntries: [{ type: "case-id", value: "x:y" }] }), /missing required type 'row-content'/);
  // overlap is caught
  const clash = [{ type: "row-content", value: "c".repeat(64) }, { type: "case-id", value: "x:y" }];
  assert.throws(() => panelVersusInventoryReceipt({ inventoryEntries: inventory, panelEntries: clash }), /overlaps/);
});
