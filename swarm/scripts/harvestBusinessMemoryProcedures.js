#!/usr/bin/env node
/**
 * Harvest procedural memory from a model's graded failures on the development
 * pool and write a procedure store the benchmark runner can load with
 * --procedures. Never run against the holdout pool.
 *
 *   node swarm/scripts/harvestBusinessMemoryProcedures.js \
 *     --worker "qwen|amos-qwen38-27b-fp8|http://127.0.0.1:18080|qwen" \
 *     --from-run output/business-memory/development.json --worker-id qwen \
 *     --output swarm/benchmarks/business-memory-procedures-harvested-qwen-v1.json
 *
 * Without --from-run the memory arm is run fresh first.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { generateBusinessMemoryCases } from "../src/businessMemoryBenchmark.js";
import { runBusinessMemoryBenchmark } from "../src/businessMemoryGrading.js";
import { harvestBusinessMemoryProcedures } from "../src/businessMemoryHarvest.js";
import { OpenAiResearchWorker } from "../src/openAiResearchWorker.js";

const args = process.argv.slice(2);
const [id, model, baseUrl, dialect = "generic"] = requiredOption("--worker").split("|").map((part) => part.trim());
if (!id || !model || !baseUrl) throw new Error("--worker must be id|model|baseUrl[|dialect]");
const pool = option("--pool") || "development";
if (pool === "holdout") throw new Error("Procedures are never harvested from the holdout pool");
const worlds = integerOption("--worlds", 4, 1, 200);
const casesPerFamily = integerOption("--cases-per-family", 2, 1, 20);
const seed = option("--seed") || "amos-business-memory-v1";
const maxOutputTokens = integerOption("--max-output-tokens", 600, 128, 8_192);
const reasoningEffort = option("--reasoning-effort") || "none";
const outputPath = resolve(requiredOption("--output"));
const fromRun = option("--from-run") ? resolve(option("--from-run")) : null;
const fromWorkerId = option("--worker-id") || id;

const manifest = generateBusinessMemoryCases({ seed, pool, worlds, casesPerFamily });
const worker = new OpenAiResearchWorker({
  controlId: `business-memory-harvest-${id}`,
  model,
  baseUrl,
  apiKey: process.env.AMOS_LOCAL_BENCHMARK_API_KEY || null,
  dialect,
  reasoningEffort,
  temperature: 0,
  seed: 7,
  allowRemote: true
});
await worker.probe();

let memoryRuns;
if (fromRun) {
  const run = JSON.parse(await readFile(fromRun, "utf8"));
  if (run.manifestDigest !== manifest.digest) {
    throw new Error(`--from-run manifest ${run.manifestDigest} does not match the generated manifest ${manifest.digest}`);
  }
  const entry = run.reports.find((item) => item.workerId === fromWorkerId);
  if (!entry) throw new Error(`--from-run has no worker ${fromWorkerId}`);
  memoryRuns = entry.report.runs.filter((item) => item.arm === "memory");
} else {
  const report = await runBusinessMemoryBenchmark({
    worker,
    manifest,
    arms: ["memory"],
    procedures: [],
    maxOutputTokens,
    onCase: (run) => process.stderr.write(`${JSON.stringify({ arm: run.arm, caseId: run.caseId, passed: run.passed })}\n`)
  });
  memoryRuns = report.runs;
}

const store = await harvestBusinessMemoryProcedures({
  worker,
  manifest,
  memoryRuns,
  maxOutputTokens,
  onEvent: (event) => process.stderr.write(`${JSON.stringify(event)}\n`)
});
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  output: outputPath,
  model,
  failuresRepaired: store.repairs.filter((item) => item.repaired).length,
  failures: store.repairs.length,
  candidates: store.candidateCount,
  admitted: store.procedures.map(({ id: procedureId, family, statement, lineage }) => ({ id: procedureId, family: lineage.family, wins: lineage.pairedWins, statement })),
  rejected: store.rejected.map(({ family, reason, statement }) => ({ family, reason, statement }))
}, null, 2));

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
