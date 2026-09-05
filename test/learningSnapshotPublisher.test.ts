import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileEventStore, MemoryEventStore, StrategyGeneArchive } from "../src/index.ts";
import { deriveLearningSelectionSnapshot, parseRuntimePin } from "../src/learningSnapshotPublisher.ts";
import { EMPTY_PROCEDURE_SNAPSHOT_SHA256, validateLearningSelectionSnapshot } from "../src/learningSelectionSnapshot.ts";
import { AllowListHostGate, receipt } from "./helpers.ts";

const runtimes = [{ modelId: "amos-qwen38-27b-fp8", adapterArtifactSha256: null, runtimeRevision: "e31eb568681d3a718b7aaa5ce646b6711494b186" }];
const spec = (name: string) => ({
  name,
  preconditions: { phases: ["recover"], artifactClasses: ["tool-call"], failureModes: ["authority-boundary"], toolFamilies: ["finance"] },
  rolePolicy: { planner: ["propose"] },
  retrievalRecipe: ["find the allowed verb"],
  procedure: ["request the boundary change", "retry with the allowed verb"],
  stopConditions: ["verifier passes"],
  rightsTags: ["amos-owned"],
  contaminationTags: []
});

test("an empty or gene-less chain publishes the empty snapshot with a chain-derived source digest", () => {
  const empty = deriveLearningSelectionSnapshot({ events: [], id: "s-empty", compatibleRuntimes: runtimes, now: new Date("2026-09-05T21:00:00Z") });
  assert.equal(empty.snapshot.procedureSnapshotSha256, EMPTY_PROCEDURE_SNAPSHOT_SHA256);
  assert.deepEqual(empty.chain, { events: 0, headDigest: null, genes: 0, published: 0, withheld: 0 });
  assert.equal(empty.snapshot.validUntil, "2026-09-06T03:00:00.000Z");
  validateLearningSelectionSnapshot(empty.snapshot);
});

test("a replayed chain publishes only genes with verified outcomes, from a file store, deterministically", () => {
  const dir = mkdtempSync(join(tmpdir(), "snapshot-publisher-"));
  const path = join(dir, "events.jsonl");
  const gate = new AllowListHostGate();
  const archive = new StrategyGeneArchive(gate, new FileEventStore(path));
  const guided = archive.register(spec("recover reserved tool"), [], gate.allow(receipt("r-1", "m-1", "gene-approved")));
  const unproven = archive.register(spec("untested idea"), [], gate.allow(receipt("r-2", "m-1", "gene-approved")));
  archive.recordOutcome({ geneId: guided.id, missionId: "m-2", verifiedQuality: 0.9, fitnessVested: 1, verifierOutcome: "pass" }, gate.allow(receipt("r-3", "m-2", "official-verification")));
  archive.recordOutcome({ geneId: guided.id, missionId: "m-3", verifiedQuality: 0, fitnessVested: 0, verifierOutcome: "uncredited" }, gate.allow(receipt("r-4", "m-3", "official-verification")));

  const events = new FileEventStore(path).events();
  const derived = deriveLearningSelectionSnapshot({ events, id: "s-1", compatibleRuntimes: runtimes, now: new Date("2026-09-05T21:00:00Z") });
  assert.equal(derived.chain.genes, 2);
  assert.equal(derived.chain.published, 1);
  assert.equal(derived.chain.withheld, 1, "a gene with no verified outcome is not offered");
  assert.equal(derived.chain.headDigest, events.at(-1)!.digest);
  assert.equal(derived.snapshot.sourceChainDigest, events.at(-1)!.digest);
  const [procedure] = derived.snapshot.procedures;
  assert.equal(procedure!.id, guided.id);
  assert.equal(procedure!.guidance, "guide");
  assert.equal(procedure!.evidence.uncreditedAttempts, 1);
  assert.ok(unproven.id !== procedure!.id);
  assert.ok(derived.snapshot.tokenBound >= procedure!.tokens);
  validateLearningSelectionSnapshot(derived.snapshot);
  const again = deriveLearningSelectionSnapshot({ events, id: "s-1", compatibleRuntimes: runtimes, now: new Date("2026-09-05T21:00:00Z") });
  assert.equal(again.snapshot.digest, derived.snapshot.digest);
  const memory = new MemoryEventStore();
  assert.equal(memory.events().length, 0);
});

test("runtime pins parse modelId@revision with an optional adapter digest", () => {
  assert.deepEqual(parseRuntimePin("amos-qwen38-27b-fp8@e31eb56"), { modelId: "amos-qwen38-27b-fp8", runtimeRevision: "e31eb56", adapterArtifactSha256: null });
  const adapter = parseRuntimePin(`stage1-implicit-r32-s3@e31eb568681d3a718b7aaa5ce646b6711494b186:${"a".repeat(64)}`);
  assert.equal(adapter.adapterArtifactSha256, "a".repeat(64));
  assert.throws(() => parseRuntimePin("nonsense"), /runtime pin/);
});
