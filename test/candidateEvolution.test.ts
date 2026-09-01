import assert from "node:assert/strict";
import test from "node:test";
import {
  CandidateEvolutionArchive,
  type MutationTransportReceipt,
  type ObjectiveCandidateEvidence,
} from "../src/candidateEvolution.ts";
import { MemoryEventStore } from "../src/eventStore.ts";
import { AllowListHostGate, receipt } from "./helpers.ts";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const digestC = "c".repeat(64);

function evidence(
  qualityVector: readonly number[],
  milestones: Readonly<Record<string, boolean>>,
  failedCheckCount: number,
): ObjectiveCandidateEvidence {
  return {
    qualityVector,
    protectedMilestones: milestones,
    failureBoundaryPresent: milestones.selfCheck === true,
    failedCheckCount,
    failedCheckIds: failedCheckCount > 0 ? ["remaining"] : [],
    artifactReceiptIds: [],
    testReceiptIds: [],
  };
}

function transport(sourceDigest: string, resultDigest: string): MutationTransportReceipt {
  return {
    sourceDigest,
    resultDigest,
    bounded: true,
    atomic: true,
    syntaxValid: true,
    interfaceValid: true,
  };
}

test("a stronger mutation becomes the monotonic incumbent", () => {
  const gate = new AllowListHostGate();
  const archive = new CandidateEvolutionArchive(gate);
  archive.initialize(
    "mission-1",
    digestA,
    evidence([0, 0, 1], { syntax: true, selfCheck: false }, 2),
    gate.allow(receipt("initial", "mission-1", "candidate-evaluated")),
  );
  const selection = archive.consider(
    "mission-1",
    digestB,
    evidence([0, 1, 1], { syntax: true, selfCheck: true }, 2),
    transport(digestA, digestB),
    gate.allow(receipt("mutation", "mission-1", "candidate-evaluated")),
  );

  assert.equal(selection.promoted, true);
  assert.equal(selection.reason, "objective-evidence-improved");
  assert.equal(archive.incumbent("mission-1").candidateDigest, digestB);
});

test("a later destructive worker cannot erase a stronger incumbent", () => {
  const gate = new AllowListHostGate();
  const archive = new CandidateEvolutionArchive(gate);
  archive.initialize(
    "mission-1",
    digestB,
    evidence([0, 1, 1], { syntax: true, selfCheck: true }, 1),
    gate.allow(receipt("initial", "mission-1", "candidate-evaluated")),
  );
  const selection = archive.consider(
    "mission-1",
    digestC,
    evidence([0, 0, 0], { syntax: false, selfCheck: false }, 0),
    transport(digestB, digestC),
    gate.allow(receipt("regression", "mission-1", "candidate-evaluated")),
  );

  assert.equal(selection.promoted, false);
  assert.equal(selection.reason, "objective-evidence-regression");
  assert.equal(archive.incumbent("mission-1").candidateDigest, digestB);
  assert.equal(archive.versions("mission-1").length, 2);
});

test("an unbound transport receipt can never promote a mutation", () => {
  const gate = new AllowListHostGate();
  const archive = new CandidateEvolutionArchive(gate);
  archive.initialize(
    "mission-1",
    digestA,
    evidence([0], { syntax: true }, 0),
    gate.allow(receipt("initial", "mission-1", "candidate-evaluated")),
  );
  const selection = archive.consider(
    "mission-1",
    digestB,
    evidence([1], { syntax: true }, 0),
    transport(digestC, digestB),
    gate.allow(receipt("unbound", "mission-1", "candidate-evaluated")),
  );

  assert.equal(selection.promoted, false);
  assert.equal(selection.reason, "invalid-mutation-transport");
  assert.equal(archive.incumbent("mission-1").candidateDigest, digestA);
});

test("candidate lineage and incumbent promotion replay from the event ledger", () => {
  const gate = new AllowListHostGate();
  const store = new MemoryEventStore();
  const archive = new CandidateEvolutionArchive(gate, store);
  archive.initialize(
    "mission-replay",
    digestA,
    evidence([0, 0], { syntax: true }, 1),
    gate.allow(receipt("replay-initial", "mission-replay", "candidate-evaluated")),
  );
  archive.consider(
    "mission-replay",
    digestB,
    evidence([1, 0], { syntax: true }, 0),
    transport(digestA, digestB),
    gate.allow(receipt("replay-mutation", "mission-replay", "candidate-evaluated")),
  );

  const restarted = new CandidateEvolutionArchive(gate, null, store.events());
  assert.equal(restarted.incumbent("mission-replay").candidateDigest, digestB);
  assert.equal(restarted.versions("mission-replay").length, 2);
  assert.equal(restarted.selections("mission-replay")[0]?.promoted, true);
});
