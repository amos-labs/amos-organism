import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileEventStore, MemoryEventStore } from "../src/eventStore.ts";
import { PersistentLearningController, type LearningObservation } from "../src/persistentLearningController.ts";

const observation: LearningObservation = {
  id: "s7-date-summary", modelId: "s7", family: "date-time", passed: 0, total: 6,
  partition: "qualification", cohortId: "consumed48", evidenceSha256: "a".repeat(64),
  observedAt: "2026-09-11T00:00:00.000Z",
};
const now = () => new Date("2026-09-11T01:00:00.000Z");

test("file-backed restart restores evidence and never reflects the same input twice", () => {
  const directory = mkdtempSync(join(tmpdir(), "amos-learning-"));
  try {
    const path = join(directory, "events.jsonl");
    const first = new PersistentLearningController({ store: new FileEventStore(path), now });
    first.ingestObservation(observation);
    const before = first.selfModel();
    const action = first.planNext();
    assert.ok(action);
    const restarted = new PersistentLearningController({ store: new FileEventStore(path), now });
    assert.deepEqual(restarted.selfModel(), before);
    assert.deepEqual(restarted.planNext(), action);
    const reflection = restarted.reflect(action);
    const again = new PersistentLearningController({ store: new FileEventStore(path), now });
    assert.equal(again.planNext(), null);
    assert.deepEqual(again.reflect(action), reflection);
    assert.deepEqual(again.ingestObservation({ ...observation }), observation);
    assert.equal(new FileEventStore(path).events().length, 2);
    assert.equal(reflection.hypotheses.every((item) => item.status === "unproven"), true);
    assert.equal(reflection.trainingRowsProduced, 0);
    assert.equal(reflection.qualityImprovementEstablished, false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("duplicate IDs are idempotent only for identical validated payloads", () => {
  const store = new MemoryEventStore();
  const controller = new PersistentLearningController({ store, now });
  controller.ingestObservation(observation);
  controller.ingestObservation({ ...observation });
  for (const change of [{ passed: 1 }, { evidenceSha256: "b".repeat(64) }, { cohortId: "other" }]) {
    assert.throws(() => controller.ingestObservation({ ...observation, ...change }), /different payload/);
  }
  assert.equal(store.events().length, 1);
});

test("strict JSON aggregate contract rejects malformed and content-bearing inputs before writing", () => {
  const store = new MemoryEventStore();
  const controller = new PersistentLearningController({ store, now });
  for (const change of [
    { total: 0 }, { total: 1_000_001 }, { passed: 7 }, { passed: -1 }, { passed: -0 },
    { passed: 0.5 }, { total: Infinity }, { total: "6" }, { passed: NaN },
    { partition: "training" }, { evidenceSha256: "A".repeat(64) },
    { observedAt: "2026-09-11T00:00:00Z" }, { observedAt: "2026-02-30T00:00:00.000Z" },
    { id: "bad\nidentifier" }, { family: "x".repeat(257) }, { answer: "raw answer" },
  ]) assert.throws(() => controller.ingestObservation({ ...observation, ...change }));
  assert.throws(() => controller.ingestObservation(null));
  const { total: _total, ...missing } = observation;
  assert.throws(() => controller.ingestObservation(missing));
  assert.equal(store.events().length, 0);
});

test("unrelated cohorts stay separate and apparent score rises never claim improvement", () => {
  const controller = new PersistentLearningController({ store: new MemoryEventStore(), now });
  controller.ingestObservation(observation);
  controller.ingestObservation({ ...observation, id: "later", cohortId: "different6", passed: 6 });
  const model = controller.selfModel();
  assert.equal(model.capabilities.length, 2);
  assert.deepEqual(model.capabilities.map((item) => item.cohortId).sort(), ["consumed48", "different6"]);
  assert.equal(model.qualityImprovementEstablished, false);
  assert.equal(model.evidenceBasis, "operator-imported-aggregate");
  const next = controller.planNext();
  assert.ok(next);
  controller.reflect(next);
  assert.equal(controller.planNext(), null);
});

test("actions must match actual evidence and the next pending reflection", () => {
  const store = new MemoryEventStore();
  const controller = new PersistentLearningController({ store, now });
  assert.equal(controller.planNext(), null);
  controller.ingestObservation(observation);
  const action = controller.planNext();
  assert.ok(action);
  for (const change of [
    { id: "invented" }, { observationId: "unknown" }, { evidenceSha256: "b".repeat(64) },
    { type: "train" }, { reward: 100 },
  ]) assert.throws(() => controller.reflect({ ...action, ...change }));
  assert.equal(store.events().length, 1);
  controller.reflect(action);
  assert.equal(store.events().length, 2);
});

test("planning is deterministic across import ordering and consumes each failed observation once", () => {
  const left = new PersistentLearningController({ store: new MemoryEventStore(), now });
  const right = new PersistentLearningController({ store: new MemoryEventStore(), now });
  const second = { ...observation, id: "second", modelId: "s6", passed: 4 };
  for (const row of [observation, second]) left.ingestObservation(row);
  for (const row of [second, observation]) right.ingestObservation(row);
  assert.deepEqual(left.selfModel(), right.selfModel());
  for (let index = 0; index < 2; index++) {
    const action = left.planNext();
    assert.ok(action);
    assert.deepEqual(action, right.planNext());
    assert.deepEqual(left.reflect(action), right.reflect(action));
  }
  assert.equal(left.planNext(), null);
  assert.equal(right.planNext(), null);
});

test("a hash-chained but fabricated reflection cannot establish gain on replay", () => {
  const store = new MemoryEventStore();
  const controller = new PersistentLearningController({ store, now });
  controller.ingestObservation(observation);
  const action = controller.planNext();
  assert.ok(action);
  const reflection = controller.reflect(action);
  const forged = new MemoryEventStore();
  const source = store.events()[0];
  assert.ok(source);
  forged.append(source);
  forged.append({ id: reflection.id, type: "learning.gap-reflected.v1", missionId: "persistent-learning",
    occurredAt: now().toISOString(), authority: "organism", payload: { reflection: { ...reflection, qualityImprovementEstablished: true } } });
  assert.throws(() => new PersistentLearningController({ store: forged, now }), /Invalid.*reflection/);
});
