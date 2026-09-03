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
import { compareCurriculumGrading, runCurriculumGrading, scenariosForGrading } from "../src/curriculumGrading.js";
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

const apiKey = process.env.AMOS_LOCAL_BENCHMARK_API_KEY;
const baseUrl = process.env.AMOS_QWEN_RESEARCH_URL;
if (!apiKey || !baseUrl) throw new Error("Grading needs AMOS_QWEN_RESEARCH_URL and AMOS_LOCAL_BENCHMARK_API_KEY");
const catalog = validateToolCatalog(JSON.parse(await readFile(catalogPath, "utf8")));
const scenarios = scenariosForGrading({ catalog, pool, scenariosPerFamily, seed });
const scenariosById = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
if (harvestStorePath && pool !== "training") {
  throw new Error("Harvesting is only permitted from the training pool; holdout results are evaluation evidence");
}

const reports = [];
const harvests = [];
for (const modelId of modelIds) {
  const worker = new OpenAiResearchWorker({
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
  await worker.probe();
  const report = await runCurriculumGrading({
    worker,
    scenarios,
    maxOutputTokens,
    repairAttempts,
    onScenario: (run) => process.stderr.write(`${JSON.stringify({ modelId, scenario: run.scenarioId, passed: run.passed, calls: run.calls })}\n`)
  });
  reports.push(report);
  if (harvestStorePath) {
    const store = await openSwarmLearningStore(harvestStorePath);
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
  seed,
  scenarioCount: scenarios.length,
  reports,
  comparison,
  harvests
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  output: outputPath,
  pool,
  scenarios: scenarios.length,
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
