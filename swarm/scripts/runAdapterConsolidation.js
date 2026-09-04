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
const driver = option("--driver") || "ssm";
if (!["ssm", "boot"].includes(driver)) throw new Error("--driver must be ssm or boot");
const excludeTreatmentIds = (option("--exclude-treatments") || "amos-native-stage0-curriculum-v1").split(",").map((value) => value.trim()).filter(Boolean);
if (!bucket) throw new Error("--bucket or AMOS_RESEARCH_ARTIFACT_BUCKET is required");
if (!trainerImageUri) throw new Error("--trainer-image or AMOS_TRAINER_IMAGE_URI (immutable @sha256 URI) is required");

const [plan, checkpoint] = await Promise.all([readJson(planPath), readJson(checkpointPath)]);
const store = await openSwarmLearningStore(storePath);
const dataset = await compileAmosNativeTrainingDataset({ store, plan, excludeTreatmentIds });
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
    driver,
    excludedTreatments: excludeTreatmentIds,
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
      if (resultAlreadyInS3(job)) {
        // A previous runner dispatched this job and the trainer finished it; do not train twice.
        log({ event: "job-already-finished", contractId: job.contractId, outputUri: job.outputUri });
        const finalized = await finalizeJob(job, consolidation, startedAt);
        await appendFile(ledgerPath, `${JSON.stringify(finalized)}\n`);
        job = nextConsolidationJob(consolidation, await readLedger(ledgerPath));
        continue;
      }
      log({ event: "job-start", contractId: job.contractId, rank: job.rank, seed: job.seed, contractUri: job.contractUri, driver });
      if (driver === "boot") {
        aws(["ssm", "put-parameter", "--name", parameterName, "--type", "String", "--overwrite", "--value", job.contractUri]);
      }
      await startInstanceWithRetry(instanceId);
      if (driver === "ssm") {
        await waitForSsmOnline(instanceId);
        const commandId = sendTrainerCommand(instanceId, job.contractUri);
        log({ event: "trainer-command-sent", contractId: job.contractId, commandId });
      }
      await appendFile(ledgerPath, `${JSON.stringify(createConsolidationLedgerEntry({ planDigest: consolidation.digest, job, status: "submitted", startedAt, instanceId }))}\n`);
      if (!wait) break;
      await waitForStop(instanceId);
      const entry = await finalizeJob(job, consolidation, startedAt);
      await appendFile(ledgerPath, `${JSON.stringify(entry)}\n`);
      log({ event: "job-finished", contractId: job.contractId, status: entry.status, resultDigest: entry.resultDigest, error: entry.error });
      job = nextConsolidationJob(consolidation, await readLedger(ledgerPath));
    }
  }
  console.log(JSON.stringify(summary, null, 2));
}

/**
 * SSM driver: the disposable trainer's boot script runs only on first boot, so
 * a stopped instance is re-aimed by running the same container start over SSM
 * Run Command. The script detaches, trains, records the exit status beside the
 * stage-zero layout, and powers the instance off; the runner waits for "stopped".
 */
function sendTrainerCommand(id, contractUri) {
  const registry = trainerImageUri.split("/")[0];
  const script = [
    "#!/bin/bash",
    "set -euo pipefail",
    "export HOME=/root",
    "install -d -m 0750 -o 10001 -g 10001 /opt/amos-stage0 /opt/amos-huggingface /opt/amos-triton /opt/amos-nvidia-cache",
    // Keep the cached base checkpoint; clear receipts, datasets, and adapters from earlier contracts.
    "find /opt/amos-stage0 -maxdepth 1 -type f -delete",
    "rm -rf /opt/amos-stage0/dataset /opt/amos-stage0/adapter /opt/amos-stage0/vllm-proof*",
    `aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin ${registry}`,
    `docker pull ${shellQuote(trainerImageUri)}`,
    "docker rm -f amos-qwen-stage1-trainer >/dev/null 2>&1 || true",
    `nohup bash -c ${shellQuote(innerTrainerScript(contractUri))} > /var/log/amos-stage1-trainer.log 2>&1 &`,
    "echo detached"
  ].join("\n");
  const parameters = JSON.stringify({ commands: [script], executionTimeout: ["600"] });
  const output = aws(["ssm", "send-command", "--instance-ids", id, "--document-name", "AWS-RunShellScript", "--comment", "amos stage-one adapter training", "--parameters", parameters, "--query", "Command.CommandId", "--output", "text"]);
  return output.trim();
}

function innerTrainerScript(contractUri) {
  const runsRoot = `${contractUri.replace(/\/training-contracts\/.*$/, "")}/runs`;
  return `#!/bin/bash
set +e
docker run --name amos-qwen-stage1-trainer --gpus all --ipc=host --network=bridge --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16g \
  --env AMOS_TRAINING_CONTRACT_URI=${contractUri} \
  --env TORCH_DISABLE_NATIVE_JIT=1 \
  --env HF_HOME=/home/trainer/.cache/huggingface \
  --env TRITON_CACHE_DIR=/home/trainer/.triton/cache \
  --env CUDA_CACHE_PATH=/home/trainer/.nv/ComputeCache \
  --volume /opt/amos-stage0:/work/stage0:rw \
  --volume /opt/amos-huggingface:/home/trainer/.cache/huggingface:rw \
  --volume /opt/amos-triton:/home/trainer/.triton:rw \
  --volume /opt/amos-nvidia-cache:/home/trainer/.nv:rw \
  ${trainerImageUri} > /opt/amos-stage0/container.log 2>&1
STATUS=$?
printf '%s\n' "$STATUS" > /opt/amos-stage0/container-exit-status
aws s3 cp /opt/amos-stage0/container.log ${runsRoot}/__last__/container.log --region ${region} --only-show-errors || true
sync
shutdown -h now
`;
}

/** EC2 rejects a start for a short window after an instance reports stopped. */
async function startInstanceWithRetry(id, attempts = 6) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      aws(["ec2", "start-instances", "--instance-ids", id]);
      return;
    } catch (error) {
      log({ event: "start-instances-retry", instanceId: id, attempt, error: error?.message?.split("\n")[0] ?? String(error) });
      if (attempt === attempts) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20_000));
    }
  }
}

async function waitForSsmOnline(id) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 15_000));
    const ping = aws(["ssm", "describe-instance-information", "--filters", `Key=InstanceIds,Values=${id}`, "--query", "InstanceInformationList[0].PingStatus", "--output", "text"]).trim();
    log({ event: "trainer-ssm", instanceId: id, ping });
    if (ping === "Online") return;
  }
  throw new Error(`Trainer ${id} did not come online over SSM`);
}

function shellQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

function resultAlreadyInS3(job) {
  try {
    const listing = aws(["s3", "ls", `${job.outputUri}/stage0-result.json`]);
    return listing.includes("stage0-result.json");
  } catch {
    return false;
  }
}

async function finalizeJob(job, consolidation, startedAt) {
  let status = "failed";
  let resultDigest = null;
  let error = null;
  try {
    const resultsDir = resolve(outputDir, runId, "results", job.contractId);
    await mkdir(resultsDir, { recursive: true });
    // Receipts and metrics only; adapter weights stay in S3 and are served from there.
    aws(["s3", "sync", `${job.outputUri}/`, resultsDir, "--only-show-errors", "--exclude", "adapter/*.safetensors", "--exclude", "dataset/*"]);
    const result = JSON.parse(await readFile(resolve(resultsDir, "stage0-result.json"), "utf8"));
    resultDigest = result.digest ?? null;
    status = result.status?.startsWith("adapter-built") ? "completed" : "failed";
  } catch (caught) {
    error = caught?.message ?? String(caught);
  }
  return createConsolidationLedgerEntry({ planDigest: consolidation.digest, job, status, startedAt, finishedAt: new Date(), instanceId, resultDigest, error });
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
