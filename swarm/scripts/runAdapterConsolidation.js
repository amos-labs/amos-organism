#!/usr/bin/env node
/**
 * Consolidate verified experience into stage-one adapter training jobs.
 *
 * Default is plan-only: compile the dataset, check the gate, write the dataset
 * and contracts locally, and print exactly what --execute would do. With
 * --execute it uploads the dataset and contracts, points the trainer at each
 * contract through the SSM parameter the instance reads at boot, starts the
 * disposable trainer, waits for it to stop itself, and pulls the results.
 */
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileAmosNativeTrainingDataset, writeAmosNativeTrainingDataset } from "../src/amosNativeTrainingDataset.js";
import { openSwarmLearningStore } from "../src/swarmLearningStore.js";
import {
  consolidationReadiness,
  createConsolidationLedgerEntry,
  nextConsolidationJob,
  planAdapterConsolidation
} from "../src/adapterConsolidation.js";

const swarmRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = resolve(swarmRoot, "..");
const args = process.argv.slice(2);
const storePath = resolve(option("--store") || ".amos-agent/research/swarm-learning");
const outputDir = resolve(option("--output") || ".amos-agent/research/adapter-consolidation");
const planPath = resolve(option("--plan") || resolve(swarmRoot, "benchmarks/swarm-qwen-adapter-training-v1.json"));
const checkpointPath = resolve(option("--checkpoint") || resolve(swarmRoot, "benchmarks/qwen38-27b-training-checkpoint-v1.json"));
const bucket = option("--bucket") || process.env.AMOS_RESEARCH_ARTIFACT_BUCKET;
const runId = option("--run-id") || `stage1-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`;
const trainerImageUri = option("--trainer-image") || process.env.AMOS_TRAINER_IMAGE_URI;
const sourceRevision = option("--source-revision") || execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const ranks = (option("--ranks") || "32").split(",").map(Number);
const seeds = (option("--seeds") || "20260903,20260904,20260905").split(",").map(Number);
const epochs = integerOption("--epochs", 3, 1, 20);
const region = option("--region") || process.env.AWS_REGION || "us-east-1";
const instanceId = option("--instance-id") || process.env.AMOS_TRAINER_INSTANCE_ID;
const parameterName = option("--parameter-name") || process.env.AMOS_TRAINER_CONTRACT_PARAMETER || "/amos/qwen-research-plane/trainer/contract-uri";
const execute = flag("--execute");
const wait = !flag("--no-wait");
const pollSeconds = integerOption("--poll-seconds", 60, 10, 900);
if (!bucket) throw new Error("--bucket or AMOS_RESEARCH_ARTIFACT_BUCKET is required");
if (!trainerImageUri) throw new Error("--trainer-image or AMOS_TRAINER_IMAGE_URI (immutable @sha256 URI) is required");

const [plan, checkpoint] = await Promise.all([readJson(planPath), readJson(checkpointPath)]);
const store = await openSwarmLearningStore(storePath);
const dataset = await compileAmosNativeTrainingDataset({ store, plan });
const readiness = consolidationReadiness({ dataset });
await mkdir(outputDir, { recursive: true });
if (!readiness.ready) {
  console.log(JSON.stringify({ status: "not-ready", readiness }, null, 2));
  process.exitCode = 2;
} else {
  const datasetDir = resolve(outputDir, runId, "dataset");
  await writeAmosNativeTrainingDataset(datasetDir, dataset);
  const s3Root = `s3://${bucket}/stage1/${runId}`;
  const { plan: consolidation, contracts } = planAdapterConsolidation({
    idPrefix: runId,
    plan,
    checkpoint,
    datasetManifest: dataset.manifest,
    trainerImageUri,
    datasetUri: `${s3Root}/dataset`,
    outputPrefix: `${s3Root}/runs`,
    contractPrefix: `${s3Root}/training-contracts`,
    sourceRevision,
    ranks,
    seeds,
    epochs
  });
  const planPathOut = resolve(outputDir, runId, "consolidation-plan.json");
  await writeFile(planPathOut, `${JSON.stringify(consolidation, null, 2)}\n`, "utf8");
  for (const contract of contracts) {
    await writeFile(resolve(outputDir, runId, `${contract.id}.contract.json`), `${JSON.stringify(contract, null, 2)}\n`, "utf8");
  }
  const ledgerPath = resolve(outputDir, runId, "consolidation-ledger.jsonl");
  const summary = {
    status: execute ? "executing" : "planned",
    runId,
    readiness,
    jobs: consolidation.jobs.map(({ contractId, rank, seed, contractUri, outputUri }) => ({ contractId, rank, seed, contractUri, outputUri })),
    plan: planPathOut,
    ledger: ledgerPath,
    nextSteps: execute ? [] : [
      `aws s3 sync ${datasetDir} ${s3Root}/dataset/`,
      ...consolidation.jobs.map((job) => `aws s3 cp ${resolve(outputDir, runId, `${job.contractId}.contract.json`)} ${job.contractUri}`),
      `aws ssm put-parameter --name ${parameterName} --type String --overwrite --value <contractUri>`,
      `aws ec2 start-instances --instance-ids ${instanceId ?? "<trainer-instance-id>"}`,
      "re-run with --execute to do all of the above per job and wait for each trainer to stop itself"
    ]
  };
  if (execute) {
    if (!instanceId) throw new Error("--instance-id or AMOS_TRAINER_INSTANCE_ID is required to execute");
    aws(["s3", "sync", datasetDir, `${s3Root}/dataset/`, "--only-show-errors"]);
    for (const job of consolidation.jobs) {
      aws(["s3", "cp", resolve(outputDir, runId, `${job.contractId}.contract.json`), job.contractUri, "--only-show-errors"]);
    }
    aws(["s3", "cp", planPathOut, `${s3Root}/consolidation-plan.json`, "--only-show-errors"]);
    const ledger = await readLedger(ledgerPath);
    let job = nextConsolidationJob(consolidation, ledger);
    while (job) {
      const startedAt = new Date();
      log({ event: "job-start", contractId: job.contractId, rank: job.rank, seed: job.seed, contractUri: job.contractUri });
      aws(["ssm", "put-parameter", "--name", parameterName, "--type", "String", "--overwrite", "--value", job.contractUri]);
      aws(["ec2", "start-instances", "--instance-ids", instanceId]);
      await appendFile(ledgerPath, `${JSON.stringify(createConsolidationLedgerEntry({ planDigest: consolidation.digest, job, status: "submitted", startedAt, instanceId }))}\n`);
      if (!wait) break;
      await waitForStop(instanceId);
      let status = "failed";
      let resultDigest = null;
      let error = null;
      try {
        const resultsDir = resolve(outputDir, runId, "results", job.contractId);
        await mkdir(resultsDir, { recursive: true });
        aws(["s3", "sync", `${job.outputUri}/`, resultsDir, "--only-show-errors"]);
        const result = JSON.parse(await readFile(resolve(resultsDir, "stage0-result.json"), "utf8"));
        resultDigest = result.digest ?? null;
        status = result.status?.startsWith("adapter-built") ? "completed" : "failed";
      } catch (caught) {
        error = caught?.message ?? String(caught);
      }
      const entry = createConsolidationLedgerEntry({ planDigest: consolidation.digest, job, status, startedAt, finishedAt: new Date(), instanceId, resultDigest, error });
      await appendFile(ledgerPath, `${JSON.stringify(entry)}\n`);
      log({ event: "job-finished", contractId: job.contractId, status, resultDigest, error });
      job = nextConsolidationJob(consolidation, await readLedger(ledgerPath));
    }
  }
  console.log(JSON.stringify(summary, null, 2));
}

async function waitForStop(id) {
  for (;;) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, pollSeconds * 1_000));
    const state = aws(["ec2", "describe-instances", "--instance-ids", id, "--query", "Reservations[0].Instances[0].State.Name", "--output", "text"]).trim();
    log({ event: "trainer-state", instanceId: id, state });
    if (state === "stopped" || state === "terminated") return;
  }
}

function aws(argv) {
  return execFileSync("aws", ["--region", region, ...argv], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

async function readLedger(path) {
  try {
    return (await readFile(path, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function log(entry) {
  process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

function flag(name) {
  return args.includes(name);
}

function option(name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function integerOption(name, fallback, minimum, maximum) {
  const raw = option(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return value;
}
