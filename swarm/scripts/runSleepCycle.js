#!/usr/bin/env node
/**
 * Sleep-cycle daemon for the Qwen substrate.
 *
 * Watches vLLM's request gauges; once the box has been quiet for the policy's
 * window it drains research work (artifact replays, verified phase probes) and
 * stops at the next task boundary when a live request arrives. Every cycle is
 * appended to a JSONL ledger and the advanced candidates are written back as a
 * sleep queue for the next cycle.
 *
 * Nothing here vests fitness, admits genes, or promotes adapters.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digestResearchValue } from "../src/experimentProtocol.js";
import { validateAmosOwnedMissionVerifierManifest } from "../src/amosOwnedMissionArena.js";
import { OpenAiResearchWorker } from "../src/openAiResearchWorker.js";
import { openSwarmLearningStore } from "../src/swarmLearningStore.js";
import {
  DEFAULT_SLEEP_POLICY,
  decideSleepState,
  normalizeSleepPolicy,
  parseVllmMetrics,
  runSleepCycle,
  summarizeSleepLedger
} from "../src/sleepCycle.js";
import {
  SleepCandidateRegistry,
  candidatesFromSourceQueue,
  createArtifactReplayExecutor,
  createCurriculumGradingExecutor,
  createQwenPhaseProbeExecutor,
  createSleepQueue,
  lastStandingOrderRuns,
  sleepWorkFromCandidates,
  sleepWorkFromStandingOrders
} from "../src/sleepCycleExecutors.js";

const swarmRoot = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);

const queuePath = resolve(requiredOption("--queue"));
const outputQueuePath = resolve(option("--output-queue") || queuePath.replace(/\.json$/, "") + ".sleep.json");
const ledgerPath = resolve(option("--ledger") || resolve(dirname(outputQueuePath), "sleep-ledger.jsonl"));
const storePath = resolve(option("--store") || ".amos-agent/research/swarm-learning");
const metricsUrl = option("--metrics-url");
const assumeIdle = flag("--assume-idle");
const daemon = flag("--daemon");
const enablePhaseProbes = flag("--enable-phase-probes");
const enableGrading = flag("--enable-grading");
const standingOrdersPath = option("--standing-orders") ? resolve(option("--standing-orders")) : null;
const gradingModelIds = (option("--grading-model-ids") || process.env.AMOS_QWEN_SERVED_MODEL || "qwen3.5-27b-amos").split(",").map((value) => value.trim()).filter(Boolean);
const catalogPath = resolve(option("--catalog") || resolve(swarmRoot, "benchmarks/amos-tool-catalog-v1.json"));
const reportsDir = resolve(option("--reports-dir") || resolve(dirname(ledgerPath), "sleep-reports"));
const harvest = !flag("--no-harvest");
const episodeLimit = integerOption("--episode-limit", 8, 1, 1_000);
const policy = normalizeSleepPolicy({
  quietMilliseconds: integerOption("--quiet-seconds", DEFAULT_SLEEP_POLICY.quietMilliseconds / 1_000, 1, 86_400) * 1_000,
  pollMilliseconds: integerOption("--poll-seconds", DEFAULT_SLEEP_POLICY.pollMilliseconds / 1_000, 1, 3_600) * 1_000,
  maxCycleMilliseconds: integerOption("--max-cycle-seconds", DEFAULT_SLEEP_POLICY.maxCycleMilliseconds / 1_000, 1, 86_400) * 1_000,
  maxTasksPerCycle: integerOption("--max-tasks", DEFAULT_SLEEP_POLICY.maxTasksPerCycle, 1, 10_000),
  wakeRequestThreshold: integerOption("--wake-threshold", DEFAULT_SLEEP_POLICY.wakeRequestThreshold, 1, 10_000)
});
if (!metricsUrl && !assumeIdle) {
  throw new Error("Provide --metrics-url <vLLM /metrics URL> or --assume-idle for offline runs");
}

const controller = new AbortController();
for (const signalName of ["SIGINT", "SIGTERM"]) {
  process.on(signalName, () => {
    log({ event: "shutdown-requested", signal: signalName });
    controller.abort();
  });
}

const observeLoad = assumeIdle
  ? async () => ({ observedAt: new Date(), runningRequests: 0, waitingRequests: 0 })
  : async () => {
      const response = await fetch(metricsUrl, {
        headers: process.env.AMOS_VLLM_METRICS_TOKEN
          ? { authorization: `Bearer ${process.env.AMOS_VLLM_METRICS_TOKEN}` }
          : {},
        signal: AbortSignal.timeout(Math.min(10_000, policy.pollMilliseconds))
      });
      if (!response.ok) throw new Error(`vLLM metrics returned HTTP ${response.status}`);
      return { observedAt: new Date(), ...parseVllmMetrics(await response.text()) };
    };

const store = await openSwarmLearningStore(storePath);
const episodes = (await store.listEpisodes())
  .filter(({ partition }) => partition === "development")
  .sort((left, right) => left.digest.localeCompare(right.digest))
  .slice(0, episodeLimit);
if (episodes.length === 0) throw new Error(`No development episodes in ${storePath}`);

let phaseProbeInputs = null;
let gradingWorkers = null;
let catalog = null;
if (enablePhaseProbes || enableGrading) {
  const apiKey = process.env.AMOS_LOCAL_BENCHMARK_API_KEY;
  const baseUrl = process.env.AMOS_QWEN_RESEARCH_URL;
  if (!apiKey || !baseUrl) throw new Error("Model-backed sleep work needs AMOS_QWEN_RESEARCH_URL and AMOS_LOCAL_BENCHMARK_API_KEY");
  if (enableGrading) {
    catalog = JSON.parse(await readFile(catalogPath, "utf8"));
    gradingWorkers = new Map();
    for (const modelId of gradingModelIds) {
      const worker = new OpenAiResearchWorker({
        controlId: `sleep-grading-${modelId}`,
        model: modelId,
        baseUrl,
        apiKey,
        dialect: "qwen",
        reasoningEffort: "medium",
        temperature: 0.2,
        seed: 7,
        allowRemote: true
      });
      await worker.probe();
      gradingWorkers.set(modelId, worker);
    }
  }
}
if (enablePhaseProbes) {
  const apiKey = process.env.AMOS_LOCAL_BENCHMARK_API_KEY;
  const baseUrl = process.env.AMOS_QWEN_RESEARCH_URL;
  const model = process.env.AMOS_QWEN_SERVED_MODEL || "qwen3.5-27b-amos";
  const [missionManifest, verifierInput] = await Promise.all([
    readJson(resolve(option("--missions") || resolve(swarmRoot, "benchmarks/swarm-organism-owned-missions-v1.json"))),
    readJson(resolve(option("--verifiers") || resolve(swarmRoot, "benchmarks/swarm-organism-owned-verifiers-v1.json")))
  ]);
  const worker = new OpenAiResearchWorker({
    controlId: "organism-sleep-phase-probes",
    model,
    baseUrl,
    apiKey,
    dialect: "qwen",
    reasoningEffort: "medium",
    temperature: 0.2,
    seed: 7,
    allowRemote: true
  });
  await worker.probe();
  phaseProbeInputs = {
    worker,
    missions: missionManifest.missions,
    verifiers: validateAmosOwnedMissionVerifierManifest(verifierInput).verifiers,
    maxOutputTokens: integerOption("--max-output-tokens", 800, 128, 4_096)
  };
}

let cycleIndex = 0;
do {
  const sourceQueue = await readJson(await firstExisting([outputQueuePath, queuePath]));
  const registry = new SleepCandidateRegistry(candidatesFromSourceQueue(sourceQueue));
  const kinds = enablePhaseProbes
    ? ["organism-artifact-replay", "organism-qwen-phase-probes"]
    : ["organism-artifact-replay"];
  const candidateWork = sleepWorkFromCandidates(registry.list(), { kinds });
  let standingWork = { items: [], deferred: [] };
  if (standingOrdersPath) {
    const ledgerRecords = await readLedger(ledgerPath);
    standingWork = sleepWorkFromStandingOrders(JSON.parse(await readFile(standingOrdersPath, "utf8")), {
      lastRunAt: lastStandingOrderRuns(ledgerRecords),
      kinds: enableGrading ? ["curriculum-grading"] : []
    });
  }
  const items = [...candidateWork.items, ...standingWork.items];
  const deferred = [...candidateWork.deferred, ...standingWork.deferred];
  if (items.length === 0) {
    log({ event: "no-runnable-work", deferred });
    if (!daemon) break;
    await delay(policy.pollMilliseconds * 4, controller.signal);
    continue;
  }

  await waitUntilAsleep({ observeLoad, policy, assumeIdle, signal: controller.signal });
  if (controller.signal.aborted) break;

  const executors = { "organism-artifact-replay": createArtifactReplayExecutor({ registry, episodes }) };
  if (phaseProbeInputs) {
    executors["organism-qwen-phase-probes"] = createQwenPhaseProbeExecutor({ registry, ...phaseProbeInputs, harvestStore: harvest ? store : null });
  }
  if (gradingWorkers) {
    await mkdir(reportsDir, { recursive: true });
    executors["curriculum-grading"] = createCurriculumGradingExecutor({
      workers: gradingWorkers,
      catalog,
      harvestStore: harvest ? store : null,
      onReport: async (report, item) => {
        const path = resolve(reportsDir, `${item.orderId}-${item.occurrence}-${report.modelId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
        await writeFile(path, `${JSON.stringify(report, null, 2)}
`, "utf8");
        log({ event: "grading-report", orderId: item.orderId, modelId: report.modelId, passRate: report.passRate, firstAttemptPassRate: report.firstAttemptPassRate, path });
      }
    });
  }
  cycleIndex += 1;
  const cycleId = `sleep-${new Date().toISOString().replace(/[:.]/g, "-")}-${String(cycleIndex).padStart(3, "0")}`;
  const { record } = await runSleepCycle({
    id: cycleId,
    policy,
    items,
    executors,
    observeLoad,
    signal: controller.signal
  });

  await mkdir(dirname(ledgerPath), { recursive: true });
  await appendFile(ledgerPath, `${JSON.stringify(record)}\n`, "utf8");
  const sleepQueue = createSleepQueue({
    registry,
    sourceQueueDigest: digestResearchValue(sourceQueue),
    deferred,
    cycleRecordDigest: record.digest
  });
  await mkdir(dirname(outputQueuePath), { recursive: true });
  await writeFile(outputQueuePath, `${JSON.stringify(sleepQueue, null, 2)}\n`, "utf8");

  const ledger = await readLedger(ledgerPath);
  const summary = summarizeSleepLedger(ledger);
  log({
    event: "cycle-complete",
    cycle: record.id,
    reason: record.reason,
    totals: record.totals,
    remainingItems: record.remainingItems.length,
    verifiedEvaluationsPerDay: summary.verifiedEvaluationsPerDay,
    ledger: ledgerPath,
    queue: outputQueuePath,
    digest: record.digest
  });
} while (daemon && !controller.signal.aborted);

async function waitUntilAsleep({ observeLoad: observe, policy: sleepPolicy, assumeIdle: idle, signal }) {
  if (idle) return;
  const samples = [];
  let lastState = null;
  while (!signal.aborted) {
    try {
      samples.push(await observe());
    } catch (error) {
      log({ event: "load-unobservable", error: String(error?.message ?? error) });
    }
    const horizon = Date.now() - sleepPolicy.quietMilliseconds * 2;
    while (samples.length > 0 && Date.parse(samples[0].observedAt) < horizon) samples.shift();
    const decision = decideSleepState({ samples, policy: sleepPolicy });
    if (decision.state !== lastState) {
      log({ event: "sleep-state", state: decision.state, reason: decision.reason, quietMilliseconds: decision.quietMilliseconds });
      lastState = decision.state;
    }
    if (decision.state === "asleep") return;
    await delay(sleepPolicy.pollMilliseconds, signal);
  }
}

function delay(milliseconds, signal) {
  return new Promise((resolveDelay) => {
    if (signal?.aborted) return resolveDelay();
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolveDelay(); }, milliseconds);
    function onAbort() { clearTimeout(timer); resolveDelay(); }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function readLedger(path) {
  try {
    return (await readFile(path, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function firstExisting(paths) {
  for (const path of paths) {
    try {
      await readFile(path, "utf8");
      return path;
    } catch {
      continue;
    }
  }
  throw new Error(`None of the queue paths exist: ${paths.join(", ")}`);
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

function requiredOption(name) {
  const value = option(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integerOption(name, fallback, minimum, maximum) {
  const raw = option(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}
