#!/usr/bin/env node
/**
 * Business-memory benchmark runner.
 *
 * Dry run (no model, writes the manifest and rendered prompt sizes):
 *   node swarm/scripts/runBusinessMemoryBenchmark.js --dry-run --output reports/memory-dry.json
 *
 * Live, two models, three arms:
 *   node swarm/scripts/runBusinessMemoryBenchmark.js \
 *     --workers "qwen|amos-qwen38-27b-fp8|$AMOS_QWEN_RESEARCH_URL|qwen,opus|us.anthropic.claude-opus-5|http://127.0.0.1:8123|generic" \
 *     --control opus --pool development --worlds 4 --cases-per-family 2 \
 *     --output reports/memory-development.json
 *
 * Worker spec: id|model|baseUrl|dialect (dialect is qwen or generic). The
 * AMOS_LOCAL_BENCHMARK_API_KEY environment variable, when set, is sent to every
 * worker as a bearer token. The Opus control is reached through the Bedrock
 * benchmark gateway (swarm/scripts/bedrockBenchmarkGateway.py).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  BUSINESS_MEMORY_ARMS,
  businessMemoryProcedures,
  generateBusinessMemoryCases,
  renderArmMessages
} from "../src/businessMemoryBenchmark.js";
import {
  compareBusinessMemoryArms,
  compareBusinessMemoryModels,
  runBusinessMemoryBenchmark
} from "../src/businessMemoryGrading.js";
import { loadProcedureStore } from "../src/businessMemoryHarvest.js";
import { OpenAiResearchWorker } from "../src/openAiResearchWorker.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const jsonMode = args.includes("--json-mode");
const pool = option("--pool") || "development";
const worlds = integerOption("--worlds", 4, 1, 200);
const casesPerFamily = integerOption("--cases-per-family", 2, 1, 20);
const seed = option("--seed") || "amos-business-memory-v1";
const arms = (option("--arms") || BUSINESS_MEMORY_ARMS.join(",")).split(",").map((value) => value.trim()).filter(Boolean);
const maxOutputTokens = integerOption("--max-output-tokens", 600, 128, 8_192);
const reasoningEffort = option("--reasoning-effort") || "none";
const controlId = option("--control") || null;
const outputPath = resolve(requiredOption("--output"));
const apiKey = process.env.AMOS_LOCAL_BENCHMARK_API_KEY || null;

const manifest = generateBusinessMemoryCases({ seed, pool, worlds, casesPerFamily });
const proceduresPath = option("--procedures") ? resolve(option("--procedures")) : null;
const procedures = proceduresPath
  ? loadProcedureStore(JSON.parse(await readFile(proceduresPath, "utf8")))
  : businessMemoryProcedures();
const worldsById = new Map(manifest.worlds.map((world) => [world.id, world]));

if (dryRun) {
  const renderedChars = Object.fromEntries(arms.map((arm) => {
    const sizes = manifest.cases.map((testCase) =>
      renderArmMessages({ arm, testCase, world: worldsById.get(testCase.worldId), procedures })
        .reduce((total, message) => total + message.content.length, 0));
    return [arm, { mean: Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length), max: Math.max(...sizes) }];
  }));
  const sample = manifest.cases[0];
  const output = {
    schema: "amos.business-memory-run",
    version: 1,
    dryRun: true,
    generatedAt: new Date().toISOString(),
    manifestDigest: manifest.digest,
    renderedChars,
    sampleMessages: Object.fromEntries(arms.map((arm) => [
      arm,
      renderArmMessages({ arm, testCase: sample, world: worldsById.get(sample.worldId), procedures })
    ])),
    manifest
  };
  await writeJson(outputPath, output);
  console.log(JSON.stringify({
    output: outputPath,
    pool,
    worlds: manifest.worldCount,
    cases: manifest.caseCount,
    families: countBy(manifest.cases, (testCase) => testCase.family),
    renderedChars,
    manifestDigest: manifest.digest
  }, null, 2));
  process.exit(0);
}

const workerSpecs = parseWorkers(requiredOption("--workers"));
if (controlId && !workerSpecs.some((spec) => spec.id === controlId)) {
  throw new Error(`--control ${controlId} does not name a worker`);
}
const reports = [];
for (const spec of workerSpecs) {
  const worker = new OpenAiResearchWorker({
    controlId: `business-memory-${spec.id}`,
    model: spec.model,
    baseUrl: spec.baseUrl,
    apiKey,
    dialect: spec.dialect,
    reasoningEffort,
    temperature: 0,
    seed: 7,
    allowRemote: true
  });
  await worker.probe();
  const report = await runBusinessMemoryBenchmark({
    worker,
    manifest,
    arms,
    procedures,
    maxOutputTokens,
    jsonMode,
    onCase: (run) => process.stderr.write(`${JSON.stringify({ worker: spec.id, arm: run.arm, caseId: run.caseId, passed: run.passed, failures: run.failures.slice(0, 2) })}\n`)
  });
  reports.push({ workerId: spec.id, report, armComparison: compareBusinessMemoryArms(report) });
}
const control = controlId ? reports.find((entry) => entry.workerId === controlId) : null;
const modelComparisons = control
  ? reports
    .filter((entry) => entry.workerId !== controlId)
    .flatMap((entry) => arms.map((arm) => compareBusinessMemoryModels({ candidate: entry.report, control: control.report, arm })))
  : [];
const output = {
  schema: "amos.business-memory-run",
  version: 1,
  dryRun: false,
  generatedAt: new Date().toISOString(),
  manifestDigest: manifest.digest,
  proceduresSource: proceduresPath ?? "authored-v0",
  procedureDigests: procedures.map((procedure) => procedure.digest),
  controlWorkerId: controlId,
  reports,
  modelComparisons,
  manifest
};
await writeJson(outputPath, output);
console.log(JSON.stringify({
  output: outputPath,
  pool,
  cases: manifest.caseCount,
  models: reports.map(({ workerId, report, armComparison }) => ({
    workerId,
    arms: report.arms.map(({ arm, passRate, promptCharsMean }) => ({ arm, passRate: round(passRate), promptCharsMean: Math.round(promptCharsMean) })),
    lifts: armComparison.comparisons.map(({ label, passRateLift, pairedWins, pairedLosses }) => ({ label, lift: round(passRateLift), pairedWins, pairedLosses }))
  })),
  modelComparisons: modelComparisons.map(({ label, passRateLift, pairedWins, pairedLosses }) => ({ label, lift: round(passRateLift), pairedWins, pairedLosses })),
  claimBoundary: reports[0]?.report.interpretation.reasons ?? []
}, null, 2));

function parseWorkers(text) {
  const specs = text.split(",").map((value) => value.trim()).filter(Boolean).map((entry) => {
    const [id, model, baseUrl, dialect = "generic"] = entry.split("|").map((part) => part.trim());
    if (!id || !model || !baseUrl) throw new Error(`Worker spec must be id|model|baseUrl[|dialect]: ${entry}`);
    if (!["generic", "qwen"].includes(dialect)) throw new Error(`Worker dialect must be generic or qwen: ${entry}`);
    return { id, model, baseUrl, dialect };
  });
  if (specs.length === 0) throw new Error("--workers requires at least one worker");
  return specs;
}
function countBy(items, key) {
  const counts = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] || 0) + 1;
  return counts;
}
function round(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return value;
}
