import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { digest } from "../src/digest.ts";
import { FileEventStore, MemoryEventStore } from "../src/eventStore.ts";
import { PersistentLearningController, type LearningObservation } from "../src/persistentLearningController.ts";
import type { LearningCheckpoint, LearningCycleDecision, LearningCycleSelection } from "../src/continualLearningCycle.ts";

const bridgePath: string = "../swarm/src/persistentLearningCpuBridge.js";
const { createCpuDevelopmentDispatch } = await import(bridgePath);
const now = () => new Date("2026-09-14T12:00:00.000Z");
const checkpoint = (id: string): LearningCheckpoint => ({ modelId: id, weightsSha256: digest(id), configSha256: digest("config") });
const initialParent = checkpoint("synthetic-S6-anchor");
const observation = (i: number): LearningObservation => ({ id: `release-${i}`, modelId: "synthetic-S6-anchor", family: `skill-${i}`,
  cohortId: `fresh-${i}`, passed: 0, total: 1, partition: "development", evidenceSha256: digest(`evidence-${i}`), observedAt: now().toISOString() });
const cycleInput = (i: number, parent = initialParent) => ({ cycleId: `cycle-${i}`, objectiveId: `objective-${i}`,
  observationId: observation(i).id, parent, inputSha256: digest({ release: i }), workKind: "synthetic-cpu-executor", workSpecSha256: digest({ release: i }) });
function decision(selection: LearningCycleSelection, receiptDigest: string, outcome: LearningCycleDecision["outcome"], child: LearningCheckpoint | null): LearningCycleDecision {
  return { cycleId: selection.cycleId, outcome, parent: selection.parent, candidate: child, receiptDigest,
    evidenceSha256: digest(`review-${selection.cycleId}`), evidenceKind: "cpu-development", externalRunSha256: null,
    reason: "Synthetic lifecycle proof only; no real weight training or model improvement." };
}

test("three distinct durable cycles resume, reject, accept, and keep accepted ancestry through cold journal reloads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amos-successive-cycles-"));
  try {
    const path = join(dir, "events.jsonl");
    const open = () => {
      const store = new FileEventStore(path);
      return { store, controller: new PersistentLearningController({ store, now }) };
    };
    let parent = initialParent;
    let executions = 0;
    for (let index = 1; index <= 3; index++) {
      const first = open();
      first.controller.initializeLearningParent(initialParent);
      first.controller.ingestObservation(observation(index));
      const input = cycleInput(index, parent);
      const selected = first.controller.selectLearningCycle(input);
      // A new store/controller after selection reuses exactly the same frozen work.
      const resumed = open();
      assert.deepEqual(resumed.controller.selectLearningCycle(input), selected);
      assert.equal(resumed.controller.learningCycleState().activeCycleId, input.cycleId);
      const executor = async () => { executions++; return { receiptDigest: digest(`result-${index}`), status: "completed" }; };
      const bridge = createCpuDevelopmentDispatch({ store: resumed.store, executor, now });
      const action = { actionId: selected.dispatchActionId, workKind: selected.workKind, observation: selected.observation };
      const [result, duplicate] = await Promise.all([bridge.dispatch(action, { release: index }), bridge.dispatch(action, { release: index })]);
      assert.equal(duplicate.reused, true);
      assert.equal(executions, index);
      assert.equal(result.key, selected.dispatchKey);
      // Completion remains active until an explicit durable research decision arrives.
      const awaiting = open();
      assert.equal(awaiting.controller.learningCycleState().activeCycleId, input.cycleId);
      assert.deepEqual(awaiting.controller.learningCycleState().acceptedParent, parent);
      const reused = await createCpuDevelopmentDispatch({ store: awaiting.store, executor, now }).dispatch(action, { release: index });
      assert.equal(reused.reused, true);
      assert.equal(executions, index);
      const child = checkpoint(`synthetic-child-${index}`);
      const terminal = decision(selected, result.receiptDigest, index === 1 ? "rejected" : "accepted", child);
      awaiting.controller.decideLearningCycle(terminal);
      const after = open();
      const count = after.store.events().length;
      assert.deepEqual(after.controller.decideLearningCycle(terminal), terminal);
      assert.equal(after.store.events().length, count);
      if (index > 1) parent = child;
      assert.deepEqual(after.controller.learningCycleState().acceptedParent, parent);
      assert.equal(after.controller.learningCycleState().activeCycleId, null);
    }
    const state = open().controller.learningCycleState();
    assert.equal(executions, 3);
    assert.deepEqual(state.cycles.map(row => row.selection.cycleId), ["cycle-1", "cycle-2", "cycle-3"]);
    assert.deepEqual(state.cycles.map(row => row.selection.previousCycleId), [null, "cycle-1", "cycle-2"]);
    assert.deepEqual(state.cycles.map(row => row.selection.parentCycleId), [null, null, "cycle-2"]);
    assert.deepEqual(state.cycles.map(row => row.decision!.outcome), ["rejected", "accepted", "accepted"]);
    assert.equal(state.qualityImprovementEstablished, false);
    assert.equal(state.servingChanged, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("active cycles, input rebinding, reused objectives and unsafe parent switching are rejected before dispatch", async () => {
  const store = new MemoryEventStore();
  const controller = new PersistentLearningController({ store, now });
  controller.initializeLearningParent(initialParent);
  for (const index of [1, 2, 3]) controller.ingestObservation(observation(index));
  const selected = controller.selectLearningCycle(cycleInput(1));
  const before = store.events().length;
  for (const change of [{ inputSha256: digest("changed") }, { workSpecSha256: digest("changed") },
    { objectiveId: "different" }, { parent: checkpoint("unsafe") }, { observationId: observation(2).id }]) {
    assert.throws(() => controller.selectLearningCycle({ ...cycleInput(1), ...change }), /rebind/);
  }
  assert.throws(() => controller.selectLearningCycle(cycleInput(2)), /active cycle/);
  assert.throws(() => controller.initializeLearningParent(checkpoint("unsafe")), /cannot change/);
  assert.throws(() => controller.decideLearningCycle(decision(selected, digest("result"), "accepted", checkpoint("child"))), /completed dispatch/);
  assert.equal(store.events().length, before);
  const bridge = createCpuDevelopmentDispatch({ store, executor: async () => ({ receiptDigest: digest("result") }), now });
  await bridge.dispatch({ actionId: selected.dispatchActionId, workKind: selected.workKind, observation: selected.observation }, { release: 1 });
  const rejected = checkpoint("rejected-child");
  controller.decideLearningCycle(decision(selected, digest("result"), "rejected", rejected));
  assert.throws(() => controller.selectLearningCycle(cycleInput(2, rejected)), /last accepted parent/);
  assert.throws(() => controller.selectLearningCycle({ ...cycleInput(2), objectiveId: "objective-1" }), /already consumed/);
  assert.throws(() => controller.selectLearningCycle({ ...cycleInput(2), inputSha256: cycleInput(1).inputSha256 }), /work already consumed/);
  const terminal = controller.learningCycleState().cycles[0]!.decision!;
  assert.throws(() => controller.decideLearningCycle({ ...terminal, outcome: "accepted" }), /cannot change/);
  const second = controller.selectLearningCycle(cycleInput(2));
  assert.equal(second.previousCycleId, "cycle-1");
  await bridge.dispatch({ actionId: second.dispatchActionId, workKind: second.workKind, observation: second.observation }, { release: 2 });
  assert.throws(() => controller.decideLearningCycle(decision(second, digest("result"), "accepted", rejected)), /rejected checkpoint/);
  assert.throws(() => controller.decideLearningCycle({ ...decision(second, digest("result"), "accepted", checkpoint("fresh")),
    evidenceKind: "exported-training-evaluation" }), /SHA/);
  controller.decideLearningCycle({ ...decision(second, digest("result"), "accepted", checkpoint("fresh")),
    evidenceKind: "exported-training-evaluation", externalRunSha256: digest("externally-reviewed-run") });
  assert.equal(controller.learningCycleState().qualityImprovementEstablished, false);
});

test("interrupted dispatch stays unresolved on restart and cannot release a new cycle or replace its parent", async () => {
  const store = new MemoryEventStore();
  const controller = new PersistentLearningController({ store, now });
  controller.initializeLearningParent(initialParent);
  controller.ingestObservation(observation(1));
  controller.ingestObservation(observation(2));
  const selected = controller.selectLearningCycle(cycleInput(1));
  let executions = 0;
  const action = { actionId: selected.dispatchActionId, workKind: selected.workKind, observation: selected.observation };
  await assert.rejects(createCpuDevelopmentDispatch({ store, executor: async () => { executions++; throw Error("lost receipt"); }, now }).dispatch(action, { release: 1 }), /lost receipt/);
  const restarted = new PersistentLearningController({ store, now });
  await assert.rejects(createCpuDevelopmentDispatch({ store, executor: async () => { executions++; }, now }).dispatch(action, { release: 1 }), /unresolved/);
  assert.equal(executions, 1);
  assert.equal(restarted.learningCycleState().cycles[0]!.dispatchState, "unresolved");
  assert.throws(() => restarted.selectLearningCycle(cycleInput(2)), /active cycle/);
  assert.throws(() => restarted.decideLearningCycle(decision(selected, digest("unknown"), "inconclusive", null)), /completed dispatch/);
  assert.deepEqual(restarted.learningCycleState().acceptedParent, initialParent);
});

test("strict cycle inputs reject getters and hashes; replay rejects fabricated source observations or duplicate dispatch", async () => {
  const store = new MemoryEventStore();
  const controller = new PersistentLearningController({ store, now });
  controller.initializeLearningParent(initialParent);
  controller.ingestObservation(observation(1));
  let getterCalls = 0;
  const malicious = { ...cycleInput(1), get inputSha256() { getterCalls++; return digest("evil"); } };
  assert.throws(() => controller.selectLearningCycle(malicious), /non-data/);
  assert.equal(getterCalls, 0);
  assert.throws(() => controller.selectLearningCycle({ ...cycleInput(1), inputSha256: "z".repeat(64) }), /SHA/);
  const selection = controller.selectLearningCycle(cycleInput(1));
  const forged = new MemoryEventStore();
  for (const event of store.events()) {
    const { sequence: _sequence, previousDigest: _previous, digest: _digest, ...proposal } = event;
    const payload = event.type === "learning.cycle-selected.v1"
      ? { selection: { ...selection, observation: { ...selection.observation, evidenceSha256: digest("forged") } } } : event.payload;
    forged.append({ ...proposal, payload });
  }
  assert.throws(() => new PersistentLearningController({ store: forged, now }), /prior imported evidence/);
  const bridge = createCpuDevelopmentDispatch({ store, executor: async () => ({ receiptDigest: digest("result") }), now });
  await bridge.dispatch({ actionId: selection.dispatchActionId, workKind: selection.workKind, observation: selection.observation }, { release: 1 });
  const last = store.events().at(-1)!;
  const { sequence: _sequence, previousDigest: _previous, digest: _digest, ...proposal } = last;
  store.append({ ...proposal, id: "forged-second-dispatch", payload: { ...last.payload, state: "running" } });
  assert.throws(() => new PersistentLearningController({ store, now }), /duplicate dispatch/);
});
