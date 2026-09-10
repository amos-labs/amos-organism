import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { generateCurriculumScenarios, recordCurriculumScenarios } from "../src/amosCurriculumGenerator.js";
import { compileAmosNativeTrainingDataset } from "../src/amosNativeTrainingDataset.js";
import { openSwarmLearningStore } from "../src/swarmLearningStore.js";
import { digestResearchValue } from "../src/experimentProtocol.js";
import {
  validateStageOneInitialization,
  createQwenAdapterStageOneContract,
  validateQwenAdapterStageOneContract
} from "../src/qwenAdapterTrainingContract.js";

// Codex 231313Z: the trainer must support an explicit fresh/parent initialization mode so a
// successor can CONTINUE the verified S6/pilot adapter instead of silently resetting to base.
// These are the exact parent identities Codex pinned for pilot-060909-r32-s20260909.
const PARENT = {
  mode: "parent",
  parent: {
    adapterUri: "s3://amos-qwen-research-plane-637423327454-us-east-1/stage1/pilot-2026-09-09/runs/pilot-060909-r32-s20260909/adapter",
    // The archived pilot/S6 contract id (distinct from its canonical digest ddcebf67d08e…).
    parentContractId: "stage1-2026-09-09-pilot-r32-s20260909",
    adapterConfigSha256: "edf24b93506b19ea31631fe10020918185b5efca36800084879694e651deb352",
    adapterWeightsSha256: "36fd8741c18e1a1478629473c7701584e8e9bc92f890eeedf3effff5d3638528",
    adapterWeightsBytes: 933974032,
    rank: 32
  }
};

test("fresh is the default and forbids a parent block", () => {
  assert.deepEqual(validateStageOneInitialization(undefined, { rank: 32 }), { mode: "fresh", optimizer: "reset", parent: null });
  assert.deepEqual(validateStageOneInitialization({ mode: "fresh" }, { rank: 32 }), { mode: "fresh", optimizer: "reset", parent: null });
  assert.throws(() => validateStageOneInitialization({ mode: "fresh", parent: PARENT.parent }, { rank: 32 }), /parent is only permitted/);
});

test("parent mode binds the exact parent adapter bytes and forces a trainable, non-stacking load", () => {
  const normalized = validateStageOneInitialization(PARENT, { rank: 32 });
  assert.equal(normalized.mode, "parent");
  assert.equal(normalized.optimizer, "reset");
  assert.equal(normalized.parent.adapterWeightsSha256, PARENT.parent.adapterWeightsSha256);
  assert.equal(normalized.parent.adapterConfigSha256, PARENT.parent.adapterConfigSha256);
  assert.equal(normalized.parent.adapterWeightsBytes, 933974032);
  assert.equal(normalized.parent.loadTrainable, true);
  assert.equal(normalized.parent.stackingForbidden, true);
});

test("an unsupported mode is rejected", () => {
  assert.throws(() => validateStageOneInitialization({ mode: "warmstart" }, { rank: 32 }), /must be one of fresh, parent/);
});

test("the optimizer may only be an explicit reset (no resumed optimizer state)", () => {
  assert.throws(() => validateStageOneInitialization({ ...PARENT, optimizer: "resume" }, { rank: 32 }), /optimizer must be "reset"/);
});

test("a parent rank that disagrees with the child rank is rejected", () => {
  assert.throws(() => validateStageOneInitialization(PARENT, { rank: 16 }), /must equal the child adapter rank 16/);
});

test("a non-hex / short parent digest is rejected", () => {
  const bad = { mode: "parent", parent: { ...PARENT.parent, adapterWeightsSha256: "not-a-real-digest" } };
  assert.throws(() => validateStageOneInitialization(bad, { rank: 32 }), /must be a 64-character SHA-256 hex digest/);
});

test("a non-s3 parent adapter uri is rejected", () => {
  const bad = { mode: "parent", parent: { ...PARENT.parent, adapterUri: "https://example.com/adapter" } };
  assert.throws(() => validateStageOneInitialization(bad, { rank: 32 }), /bounded s3:\/\/ URI/);
});

test("parent mode requires a parent block", () => {
  assert.throws(() => validateStageOneInitialization({ mode: "parent" }, { rank: 32 }), /initialization\.parent/);
});

// --- Full serialized-validator negatives (Codex PR97 review 001001Z) ------------------------
// A parent contract must fail closed against a rehash that keeps a valid digest but relaxes the
// safety fields, and must carry version 2 so a frozen pre-parent trainer rejects it.
const swarmRoot = fileURLToPath(new URL("..", import.meta.url));
const catalog = JSON.parse(await readFile(join(swarmRoot, "benchmarks/amos-tool-catalog-v1.json"), "utf8"));
const plan = JSON.parse(await readFile(join(swarmRoot, "benchmarks/swarm-qwen-adapter-training-v1.json"), "utf8"));
const checkpoint = JSON.parse(await readFile(join(swarmRoot, "benchmarks/qwen38-27b-training-checkpoint-v1.json"), "utf8"));
const IMAGE = "123456789012.dkr.ecr.us-east-1.amazonaws.com/amos/trainer@sha256:" + "c".repeat(64);
const REVISION = "d".repeat(40);
const parentDataset = await (async () => {
  const store = await openSwarmLearningStore(await mkdtemp(join(tmpdir(), "amos-parent-contract-")));
  const scenarios = generateCurriculumScenarios({ catalog, scenariosPerFamily: 64, seed: "parent-init" });
  await recordCurriculumScenarios({ store, scenarios, catalog });
  return compileAmosNativeTrainingDataset({ store, plan });
})();
const seal = (c) => { delete c.digest; c.digest = digestResearchValue(c); return c; };
const buildParent = () => createQwenAdapterStageOneContract({
  id: "stage1-parent-test-r32-s1", plan, datasetManifest: parentDataset.manifest, checkpoint,
  trainerImageUri: IMAGE, datasetUri: "s3://bucket/stage1/parent/dataset",
  outputUri: "s3://bucket/stage1/parent/runs/r32-s1", sourceRevision: REVISION, seed: 1, rank: 32,
  initialization: { mode: "parent", parent: { ...PARENT.parent } }
});

test("a valid parent contract validates and is version 2 (frozen v1 trainer rejects it)", () => {
  const c = buildParent();
  assert.equal(c.version, 2);
  assert.equal(validateQwenAdapterStageOneContract(c).id, c.id);
  assert.equal(c.recipe.initialization.parent.loadTrainable, true);
});

for (const [name, mutate] of [
  ["loadTrainable=false", (c) => { c.recipe.initialization.parent.loadTrainable = false; }],
  ["stackingForbidden=false", (c) => { c.recipe.initialization.parent.stackingForbidden = false; }],
  ["missing optimizer reset", (c) => { delete c.recipe.initialization.optimizer; }],
  ["version downgraded to 1", (c) => { c.version = 1; }],
  ["missing loadedParentTensorEqualityRequiredBeforeFirstStep", (c) => { delete c.exitCriteria.loadedParentTensorEqualityRequiredBeforeFirstStep; }],
  ["missing childAdapterMustDifferFromParentProbe", (c) => { delete c.exitCriteria.childAdapterMustDifferFromParentProbe; }],
  ["missing updateStepCountMustBeRecorded", (c) => { delete c.exitCriteria.updateStepCountMustBeRecorded; }],
  ["missing parentAndChildTensorDigestsRecorded", (c) => { delete c.exitCriteria.parentAndChildTensorDigestsRecorded; }],
  ["missing parentFileShaAndLoadedTensorDigestAreDistinctIdentities", (c) => { delete c.exitCriteria.parentFileShaAndLoadedTensorDigestAreDistinctIdentities; }]
]) {
  test(`full validator rejects a rehashed parent contract with ${name}`, () => {
    const c = buildParent();
    mutate(c);
    seal(c);
    assert.throws(() => validateQwenAdapterStageOneContract(c));
  });
}
