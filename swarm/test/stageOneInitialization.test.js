import test from "node:test";
import assert from "node:assert/strict";
import { validateStageOneInitialization } from "../src/qwenAdapterTrainingContract.js";

// Codex 231313Z: the trainer must support an explicit fresh/parent initialization mode so a
// successor can CONTINUE the verified S6/pilot adapter instead of silently resetting to base.
// These are the exact parent identities Codex pinned for pilot-060909-r32-s20260909.
const PARENT = {
  mode: "parent",
  parent: {
    adapterUri: "s3://amos-qwen-research-plane-637423327454-us-east-1/stage1/pilot-2026-09-09/runs/pilot-060909-r32-s20260909/adapter",
    parentContractId: "stage1-pilot-2026-09-09-r32-s20260909-ddcebf67",
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
