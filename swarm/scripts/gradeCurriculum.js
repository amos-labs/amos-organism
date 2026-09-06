#!/usr/bin/env node
/**
 * Grade one or more served model IDs on curriculum scenarios with the
 * executable verifier and compare them pairwise. This is the adapter-direct
 * versus base-direct arm of the training experiment.
 *
 *   node swarm/scripts/gradeCurriculum.js --model-ids amos-qwen38-27b-fp8,amos-qwen38-stage1-r32-s1 \
 *     --pool holdout --per-family 8 --output reports/grading.json
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateToolCatalog } from "../src/amosCurriculumGenerator.js";
import { compareCurriculumGrading, runBalancedCurriculumGrading, runCurriculumGrading, scenariosForGrading } from "../src/curriculumGrading.js";
import { OpenAiResearchWorker } from "../src/openAiResearchWorker.js";
import { harvestCurriculumGrading, recordHarvestedPairs } from "../src/preferencePairHarvest.js";
import { openSwarmLearningStore } from "../src/swarmLearningStore.js";

const swarmRoot = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const modelIds = requiredOption("--model-ids").split(",").map((value) => value.trim()).filter(Boolean);
const pool = option("--pool") || "holdout";
const scenariosPerFamily = integerOption("--per-family", 8, 1, 1_000);
const seed = option("--seed") || `amos-curriculum-grading-${new Date().toISOString().slice(0, 10)}`;
const outputPath = resolve(requiredOption("--output"));
const catalogPath = resolve(option("--catalog") || resolve(swarmRoot, "benchmarks/amos-tool-catalog-v1.json"));
const harvestStorePath = option("--harvest-store") ? resolve(option("--harvest-store")) : null;
const maxOutputTokens = integerOption("--max-output-tokens", 1_200, 128, 8_192);
const repairAttempts = integerOption("--repair-attempts", 1, 0, 2);
const rulebook = option("--rulebook") || "explicit";
const concurrency = integerOption("--concurrency", 1, 1, 16);
// Arm order: "sequential" grades one model after another (the historical protocol);
// "balanced" rotates the model order per scenario block from a frozen order seed so
// latency and cache state are not confounded with model identity.
const armOrder = option("--arm-order") || "sequential";
if (!["sequential", "balanced"].includes(armOrder)) throw new Error("--arm-order must be sequential or balanced");
const orderSeed = option("--order-seed") || `${seed}:arm-order`;
const blockSize = option("--block-size") ? integerOption("--block-size", concurrency, 1, 1_000) : concurrency;
if (armOrder === "balanced" && modelIds.length < 2) throw new Error("--arm-order balanced needs at least two --model-ids");

const apiKey = process.env.AMOS_LOCAL_BENCHMARK_API_KEY;
const baseUrl = process.env.AMOS_QWEN_RESEARCH_URL;
if (!apiKey || !baseUrl) throw new Error("Grading needs AMOS_QWEN_RESEARCH_URL and AMOS_LOCAL_BENCHMARK_API_KEY");
const catalog = validateToolCatalog(JSON.parse(await readFile(catalogPath, "utf8")));
const scenarios = scenariosForGrading({ catalog, pool, scenariosPerFamily, seed, rulebook });
const scenariosById = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
if (harvestStorePath && pool !== "training") {
  throw new Error("Harvesting is only permitted from the training pool; holdout results are evaluation evidence");
}

const harvests = [];
const makeWorker = (modelId) => new OpenAiResearchWorker({
  controlId: `curriculum-grading-${modelId}`,
  model: modelId,
  baseUrl,
  apiKey,
  dialect: "qwen",
  reasoningEffort: "medium",
  temperature: 0.2,
  seed: 7,
  allowRemote: true
});
const logScenario = (modelId) => (run, _scenario, placement = null) => process.stderr.write(`${JSON.stringify({
  modelId,
  scenario: run.scenarioId,
  passed: run.passed,
  calls: run.calls,
  ...(placement ? { block: placement.block, position: placement.position } : {})
})}\n`);
let reports = [];
let schedule = null;
if (armOrder === "balanced") {
  const workers = modelIds.map(makeWorker);
  for (const worker of workers) await worker.probe();
  const balanced = await runBalancedCurriculumGrading({
    workers,
    scenarios,
    orderSeed,
    blockSize,
    maxOutputTokens,
    repairAttempts,
    concurrency,
    onScenario: (run, scenario, placement) => logScenario(placement.modelId)(run, scenario, placement)
  });
  reports = balanced.reports;
  schedule = balanced.schedule;
} else {
  for (const modelId of modelIds) {
    const worker = makeWorker(modelId);
    await worker.probe();
    reports.push(await runCurriculumGrading({
      worker,
      scenarios,
      maxOutputTokens,
      repairAttempts,
      concurrency,
      onScenario: logScenario(modelId)
    }));
  }
}
if (harvestStorePath) {
  const store = await openSwarmLearningStore(harvestStorePath);
  for (const report of reports) {
    const { pairs, verifiedAnswers } = harvestCurriculumGrading({ report, scenariosById });
    harvests.push(await recordHarvestedPairs({ store, items: [...pairs, ...verifiedAnswers] }));
  }
}
const comparison = reports.length >= 2 ? compareCurriculumGrading(reports) : null;
const output = {
  schema: "amos.curriculum-grading-run",
  version: 1,
  generatedAt: new Date().toISOString(),
  catalogDigest: catalog.digest,
  pool,
  rulebook,
  seed,
  scenarioCount: scenarios.length,
  armOrder: schedule ?? { mode: "sequential" },
  reports,
  comparison,
  harvests
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  output: outputPath,
  pool,
  rulebook,
  scenarios: scenarios.length,
  armOrder: schedule ? { mode: "balanced", orderSeed, blockSize, blocks: schedule.blocks, balanced: schedule.balanced } : { mode: "sequential" },
  models: reports.map(({ modelId, passRate, firstAttemptPassRate, recoveryRate }) => ({ modelId, passRate, firstAttemptPassRate, recoveryRate })),
  comparison: comparison?.candidates.map(({ modelId, passRateLift, pairedWins, pairedLosses }) => ({ modelId, passRateLift, pairedWins, pairedLosses })) ?? null,
  harvested: harvests.map(({ recorded, pairs }) => ({ recorded, pairs }))
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
