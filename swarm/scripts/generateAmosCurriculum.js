#!/usr/bin/env node
/**
 * Generate the combinatorial AMOS system-competence curriculum into a learning
 * store. Training-pool scenarios are training-eligible; holdout-pool scenarios
 * are written to the protected validation partition and can only be used to
 * grade a model.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateCurriculumScenarios,
  recordCurriculumScenarios,
  validateToolCatalog
} from "../src/amosCurriculumGenerator.js";
import { openSwarmLearningStore } from "../src/swarmLearningStore.js";

const swarmRoot = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const storePath = resolve(option("--store") || ".amos-agent/research/swarm-learning");
const catalogPath = resolve(option("--catalog") || resolve(swarmRoot, "benchmarks/amos-tool-catalog-v1.json"));
const seed = option("--seed") || "amos-curriculum-v1";
const pool = option("--pool") || "training";
const scenariosPerFamily = integerOption("--per-family", 64, 1, 10_000);
const manifestPath = option("--manifest") ? resolve(option("--manifest")) : null;

const catalog = validateToolCatalog(JSON.parse(await readFile(catalogPath, "utf8")));
const store = await openSwarmLearningStore(storePath);
const scenarios = generateCurriculumScenarios({ catalog, scenariosPerFamily, seed, pool });
const manifest = await recordCurriculumScenarios({ store, scenarios, catalog });
if (manifestPath) {
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
console.log(JSON.stringify({
  store: storePath,
  catalogDigest: catalog.digest,
  seed,
  pool,
  scenarios: manifest.scenarioCount,
  taskFamilies: manifest.taskFamilies.length,
  distinctTools: new Set(scenarios.flatMap(({ toolsUsed }) => toolsUsed)).size,
  manifestDigest: manifest.digest,
  manifest: manifestPath,
  sufficientFor: manifest.sufficientFor,
  insufficientFor: manifest.insufficientFor
}, null, 2));

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
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}
