import test from "node:test";
import assert from "node:assert/strict";
import { buildArtifactReplayDevelopmentDispatch } from "../src/persistentLearningDevelopmentDispatch.js";
import { DEFAULT_ORGANISM_POLICY } from "../src/swarmOrganismSimulator.js";
import { digestResearchValue } from "../src/experimentProtocol.js";

// Increment 2 core: the REAL existing artifact-replay executor completes synthetic
// CPU development work over the authoritative EventStore, dedups on restart, and
// leaves ambiguous interrupted work unresolved. Zero model/GPU calls.

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
const clock = (start = Date.UTC(2026, 8, 12, 9, 0, 0)) => { let t = start; return () => new Date(t += 1000); };
const operatorInput = {
  candidate: {
    id: "dev-candidate-1",
    policy: { ...DEFAULT_ORGANISM_POLICY, "bid.repetitionPenalty": 4, "retry.challengerExploration": 1 },
    optimizedParameters: ["bid.repetitionPenalty", "retry.challengerExploration"],
    rank: 1,
    createdAt: "2026-09-12T00:00:00.000Z",
  },
  priorGate: { id: "simulation", status: "passed", evaluator: "organism-simulator", receiptDigest: digestResearchValue("dev-prior-gate"), metrics: { simulatedPassRate: 1 }, feedbackSignals: [], evaluatedAt: "2026-09-12T00:00:00.000Z" },
  episodes: ["synthetic-a", "synthetic-b", "synthetic-c"].map((id) => ({ id, task: { name: "accounts-payable-process" } })),
};
const observation = { id: "obs-1", modelId: "s6", family: "synthetic-replay", passed: 0, total: 1, partition: "development", cohortId: "dev-1", evidenceSha256: digestResearchValue("ev"), observedAt: "2026-09-12T00:00:00.000Z" };

test("the real artifact-replay executor completes synthetic CPU work with zero model calls", async () => {
  const store = memStore();
  const dev = buildArtifactReplayDevelopmentDispatch({ store, operatorInput, now: clock() });
  assert.equal(dev.workKind, "organism-artifact-replay");
  const r = await dev.dispatch("reflect-1", observation);
  assert.equal(r.state, "completed");
  assert.equal(r.receipt.evaluations.modelCalls, 0);
  assert.equal(r.receipt.evaluations.verified, 0);
  assert.match(r.receiptDigest, /^[a-f0-9]{64}$/);
});

test("a restart over the same journal does not re-run completed development work", async () => {
  const store = memStore();
  const first = await buildArtifactReplayDevelopmentDispatch({ store, operatorInput, now: clock() }).dispatch("reflect-1", observation);
  assert.equal(first.reused, false);
  // Fresh build over the same durable journal = process restart.
  const second = await buildArtifactReplayDevelopmentDispatch({ store, operatorInput, now: clock() }).dispatch("reflect-1", observation);
  assert.equal(second.reused, true);
  assert.equal(second.receiptDigest, first.receiptDigest);
});

test("operator input is validated (candidate, priorGate, episodes required)", () => {
  const store = memStore();
  assert.throws(() => buildArtifactReplayDevelopmentDispatch({ store, operatorInput: {} }), /candidate/);
  assert.throws(() => buildArtifactReplayDevelopmentDispatch({ store, operatorInput: { ...operatorInput, priorGate: undefined } }), /priorGate/);
  assert.throws(() => buildArtifactReplayDevelopmentDispatch({ store, operatorInput: { ...operatorInput, episodes: [] } }), /episodes/);
});

// Review 102629Z: episodes are part of the durable work binding — changed/added
// episodes under the same action must NOT reuse the old receipt.
test("changed or added episodes change the binding (no receipt reuse)", async () => {
  const store = memStore();
  await buildArtifactReplayDevelopmentDispatch({ store, operatorInput, now: clock() }).dispatch("reflect-1", observation);
  const moreEpisodes = { ...operatorInput, episodes: [...operatorInput.episodes, { id: "synthetic-d", task: { name: "accounts-payable-process" } }] };
  await assert.rejects(
    buildArtifactReplayDevelopmentDispatch({ store, operatorInput: moreEpisodes, now: clock() }).dispatch("reflect-1", observation),
    /work specification changed/,
  );
});

// Review 102629Z: mutating the caller's input after build must not change executed work.
test("operator input is snapshotted at build (post-build mutation has no effect)", async () => {
  const control = await buildArtifactReplayDevelopmentDispatch({ store: memStore(), operatorInput: structuredClone(operatorInput), now: clock() }).dispatch("reflect-1", observation);
  const mutable = structuredClone(operatorInput);
  const dev = buildArtifactReplayDevelopmentDispatch({ store: memStore(), operatorInput: mutable, now: clock() });
  mutable.episodes[0].task.name = "MUTATED"; mutable.candidate.policy["bid.repetitionPenalty"] = 999;
  const r = await dev.dispatch("reflect-1", observation);
  assert.equal(r.receiptDigest, control.receiptDigest, "post-build mutation must not change executed work");
});

// Review 102629Z: timestamps must be canonical UTC (Date.parse alone admits drift).
test("createdAt / evaluatedAt must be canonical UTC ISO timestamps", () => {
  const bad = ["2026-09-12T00:00:00.000", "2026-09-12 00:00:00.000Z", "2026-09-12T00:00:00.000+00:00", "2026-09-12T00:00:00Z"];
  for (const ts of bad) {
    assert.throws(() => buildArtifactReplayDevelopmentDispatch({ store: memStore(), operatorInput: { ...operatorInput, candidate: { ...operatorInput.candidate, createdAt: ts } } }), /canonical UTC/);
    assert.throws(() => buildArtifactReplayDevelopmentDispatch({ store: memStore(), operatorInput: { ...operatorInput, priorGate: { ...operatorInput.priorGate, evaluatedAt: ts } } }), /canonical UTC/);
  }
});
