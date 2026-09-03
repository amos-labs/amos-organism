import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { generateCurriculumScenarios, recordCurriculumScenarios } from "../src/amosCurriculumGenerator.js";
import { compileAmosNativeTrainingDataset } from "../src/amosNativeTrainingDataset.js";
import { openSwarmLearningStore } from "../src/swarmLearningStore.js";
import {
  createQwenAdapterStageOneContract,
  validateQwenAdapterStageOneContract,
  validateQwenAdapterStageZeroContract
} from "../src/qwenAdapterTrainingContract.js";
import {
  consolidationReadiness,
  createConsolidationLedgerEntry,
  nextConsolidationJob,
  planAdapterConsolidation
} from "../src/adapterConsolidation.js";

const swarmRoot = fileURLToPath(new URL("..", import.meta.url));
const catalog = JSON.parse(await readFile(join(swarmRoot, "benchmarks/amos-tool-catalog-v1.json"), "utf8"));
const plan = JSON.parse(await readFile(join(swarmRoot, "benchmarks/swarm-qwen-adapter-training-v1.json"), "utf8"));
const checkpoint = JSON.parse(await readFile(join(swarmRoot, "benchmarks/qwen38-27b-training-checkpoint-v1.json"), "utf8"));
const IMAGE = "123456789012.dkr.ecr.us-east-1.amazonaws.com/amos/trainer@sha256:" + "c".repeat(64);
const REVISION = "d".repeat(40);

async function qualifiedDataset() {
  const root = await mkdtemp(join(tmpdir(), "amos-consolidation-"));
  const store = await openSwarmLearningStore(root);
  const scenarios = generateCurriculumScenarios({ catalog, scenariosPerFamily: 64, seed: "consolidate" });
  await recordCurriculumScenarios({ store, scenarios, catalog });
  return compileAmosNativeTrainingDataset({ store, plan });
}
const dataset = await qualifiedDataset();

test("a stage-one contract binds a qualified dataset, a plan rank, and a non-selecting trainer", () => {
  const contract = createQwenAdapterStageOneContract({
    id: "stage1-test-r32-s1",
    plan,
    datasetManifest: dataset.manifest,
    checkpoint,
    trainerImageUri: IMAGE,
    datasetUri: "s3://bucket/stage1/test/dataset",
    outputUri: "s3://bucket/stage1/test/runs/r32-s1",
    sourceRevision: REVISION,
    seed: 1,
    rank: 32
  });
  assert.equal(contract.purpose, "amos-system-competence-sft");
  assert.equal(contract.qualityClaimAllowed, false);
  assert.equal(contract.recipe.stage, 1);
  assert.equal(contract.recipe.adapter.alpha, 64);
  assert.equal(contract.dataset.trainingFile.rows, dataset.manifest.counts.trainingExamples);
  assert.equal(contract.selection.trainerMayNotSelect, true);
  assert.equal(validateQwenAdapterStageOneContract(contract).id, contract.id);
  assert.throws(() => validateQwenAdapterStageZeroContract(contract), /stage-zero/);
  assert.throws(() => createQwenAdapterStageOneContract({
    id: "bad-rank", plan, datasetManifest: dataset.manifest, checkpoint, trainerImageUri: IMAGE,
    datasetUri: "s3://bucket/d", outputUri: "s3://bucket/o", sourceRevision: REVISION, seed: 1, rank: 8
  }), /not one of the plan's stage-one candidates/);
  const thin = { ...dataset.manifest, counts: { ...dataset.manifest.counts, trainingExamples: 10 } };
  assert.throws(() => createQwenAdapterStageOneContract({
    id: "thin", plan, datasetManifest: thin, checkpoint, trainerImageUri: IMAGE,
    datasetUri: "s3://bucket/d", outputUri: "s3://bucket/o", sourceRevision: REVISION, seed: 1
  }), /digest does not match/);
});

test("consolidation plans one immutable job per rank and seed and never selects a winner", () => {
  assert.deepEqual(consolidationReadiness({ dataset }).reasons, []);
  assert.deepEqual(consolidationReadiness({ dataset: { ready: false, manifest: { blockers: ["training-examples:10/200"] } } }).reasons, ["dataset-not-ready", "blocker:training-examples:10/200"]);
  const { plan: consolidation, contracts } = planAdapterConsolidation({
    idPrefix: "stage1-test",
    plan,
    checkpoint,
    datasetManifest: dataset.manifest,
    trainerImageUri: IMAGE,
    datasetUri: "s3://bucket/stage1/test/dataset",
    outputPrefix: "s3://bucket/stage1/test/runs",
    contractPrefix: "s3://bucket/stage1/test/training-contracts",
    sourceRevision: REVISION,
    ranks: [16, 32],
    seeds: [1, 2, 3],
    generatedAt: new Date("2026-09-03T00:00:00Z")
  });
  assert.equal(consolidation.jobs.length, 6);
  assert.equal(contracts.length, 6);
  assert.equal(consolidation.selection.promotionAllowed, false);
  assert.equal(consolidation.selection.controlModel, plan.base.model);
  assert.ok(consolidation.jobs.every((job, index) => job.contractDigest === contracts[index].digest));
  assert.equal(consolidation.jobs[0].contractUri, "s3://bucket/stage1/test/training-contracts/stage1-test-r16-s1.json");

  const entry = createConsolidationLedgerEntry({ planDigest: consolidation.digest, job: consolidation.jobs[0], status: "completed", startedAt: new Date(), finishedAt: new Date(), instanceId: "i-1", resultDigest: "a".repeat(64) });
  const next = nextConsolidationJob(consolidation, [entry]);
  assert.equal(next.contractId, "stage1-test-r16-s2");
  assert.throws(() => planAdapterConsolidation({
    idPrefix: "too-many", plan, checkpoint, datasetManifest: dataset.manifest, trainerImageUri: IMAGE,
    datasetUri: "s3://b/d", outputPrefix: "s3://b/o", contractPrefix: "s3://b/c", sourceRevision: REVISION,
    ranks: [16, 32, 64], seeds: [1, 2, 3, 4, 5]
  }), /capped at twelve/);
});
