#!/usr/bin/env node
/**
 * Business-memory benchmark, live arm, against a real AMOS tenant.
 *
 * Seed only (writes the world into the tenant, reads it back, renders prompt
 * sizes; no model call):
 *   AMOS_NORTHWIND_OWNER_KEY=... node swarm/scripts/runBusinessMemoryLive.js \
 *     --dry-run --output reports/memory-live-dry.json
 *
 * Live through the Hosted route (the model AMOS Hosted routes to):
 *   AMOS_NORTHWIND_OWNER_KEY=... AMOS_ADMIN_KEY=... node swarm/scripts/runBusinessMemoryLive.js \
 *     --pool holdout --world-index 0 --cases-per-family 3 \
 *     --output swarm/benchmarks/results/business-memory-live-<date>.json
 *
 * Extra workers (same live context, other models) use the synthetic runner's
 * spec: --workers "qwen|amos-qwen38-27b-fp8|http://127.0.0.1:18080|qwen".
 * The Hosted worker is always included unless --no-hosted is given.
 *
 * Credentials are read from the environment only and are never written to the
 * output. AMOS_ADMIN_KEY is optional; when present, the production grounding
 * summary is captured before and after the run so the metric can be
 * calibrated against the verifier.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { generateBusinessMemoryCases } from "../src/businessMemoryBenchmark.js";
import { OpenAiResearchWorker } from "../src/openAiResearchWorker.js";
import { AmosMcpClient } from "../src/amosMcpClient.js";
import {
  LIVE_ARMS,
  LIVE_FAMILIES,
  liveCase,
  loadLiveSnapshot,
  renderLiveArmMessages,
  runLiveBusinessMemoryBenchmark,
  seedWorldIntoTenant
} from "../src/businessMemoryLive.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const noHosted = args.includes("--no-hosted");
const baseUrl = option("--base-url") || "https://app.amoslabs.com";
const apiKeyEnv = option("--api-key-env") || "AMOS_NORTHWIND_OWNER_KEY";
const adminKeyEnv = option("--admin-key-env") || "AMOS_ADMIN_KEY";
const pool = option("--pool") || "holdout";
const worldIndex = integerOption("--world-index", 0, 0, 199);
const casesPerFamily = integerOption("--cases-per-family", 3, 1, 20);
const seed = option("--seed") || "amos-business-memory-v1";
const arms = (option("--arms") || LIVE_ARMS.join(",")).split(",").map((value) => value.trim()).filter(Boolean);
const maxOutputTokens = integerOption("--max-output-tokens", 600, 128, 8_192);
const groundingDays = integerOption("--grounding-days", 1, 1, 30);
const outputPath = resolve(requiredOption("--output"));

const apiKey = process.env[apiKeyEnv];
if (!apiKey) throw new Error(`${apiKeyEnv} must be set in the environment`);
const adminKey = process.env[adminKeyEnv] || null;

const manifest = generateBusinessMemoryCases({ seed, pool, worlds: worldIndex + 1, casesPerFamily, families: LIVE_FAMILIES });
const world = manifest.worlds[worldIndex];
const client = new AmosMcpClient({ baseUrl, apiKey });

const seedEvents = [];
const seedMap = await seedWorldIntoTenant({ client, world, onEvent: (event) => { seedEvents.push(event); process.stderr.write(`${JSON.stringify(event)}\n`); } });
const snapshot = await loadLiveSnapshot({ client, seedMap });
const cases = manifest.cases.filter((testCase) => testCase.worldId === world.id);

if (dryRun) {
  const rendered = Object.fromEntries(arms.map((arm) => {
    const sizes = cases.map((testCase) => renderLiveArmMessages({ arm, liveCase: liveCase({ testCase, world, seedMap }), world, snapshot })
      .reduce((total, message) => total + message.content.length, 0));
    return [arm, { mean: Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length), max: Math.max(...sizes) }];
  }));
  const sample = liveCase({ testCase: cases[0], world, seedMap });
  const output = {
    schema: "amos.business-memory-live-run",
    version: 1,
    dryRun: true,
    generatedAt: new Date().toISOString(),
    baseUrl,
    tenant: snapshot.identity.tenant_slug,
    manifestDigest: manifest.digest,
    worldId: world.id,
    seedMap,
    seedEvents,
    snapshotSummary: { observedAt: snapshot.observedAt, records: snapshot.records.length, identity: snapshot.identity, catalog: snapshot.catalog },
    renderedChars: rendered,
    sampleMessages: Object.fromEntries(arms.map((arm) => [arm, renderLiveArmMessages({ arm, liveCase: sample, world, snapshot })])),
    mcpCalls: client.summary(),
    cases: cases.map((testCase) => ({ id: testCase.id, family: testCase.family, liveQuestion: liveCase({ testCase, world, seedMap }).liveQuestion }))
  };
  await writeJson(outputPath, output);
  console.log(JSON.stringify({ output: outputPath, tenant: snapshot.identity.tenant_slug, worldId: world.id, cases: cases.length, created: seedEvents.filter((e) => e.kind === "record" && e.created).length, renderedChars: rendered, mcpCalls: client.summary() }, null, 2));
  process.exit(0);
}

const groundingBefore = await groundingSummary();
const workers = [];
if (!noHosted) {
  workers.push({ id: "hosted", worker: new OpenAiResearchWorker({
    controlId: "business-memory-live-hosted",
    model: "auto",
    baseUrl,
    apiKey,
    dialect: "generic",
    temperature: 0,
    seed: 7,
    allowRemote: true
  }) });
}
for (const spec of parseWorkers(option("--workers") || "")) {
  const worker = new OpenAiResearchWorker({
    controlId: `business-memory-live-${spec.id}`,
    model: spec.model,
    baseUrl: spec.baseUrl,
    apiKey: process.env.AMOS_LOCAL_BENCHMARK_API_KEY || null,
    dialect: spec.dialect,
    reasoningEffort: option("--reasoning-effort") || "none",
    temperature: 0,
    seed: 7,
    allowRemote: true
  });
  await worker.probe();
  workers.push({ id: spec.id, worker });
}
if (workers.length === 0) throw new Error("No workers: give --workers or drop --no-hosted");

const reports = [];
for (const { id, worker } of workers) {
  const report = await runLiveBusinessMemoryBenchmark({
    worker,
    client,
    manifest,
    world,
    seedMap,
    snapshot,
    arms,
    maxOutputTokens,
    onCase: (run) => process.stderr.write(`${JSON.stringify({ worker: id, arm: run.arm, caseId: run.caseId, passed: run.passed, failures: run.failures.slice(0, 2) })}\n`)
  });
  reports.push({ workerId: id, report });
}
const groundingAfter = await groundingSummary();

const output = {
  schema: "amos.business-memory-live-run",
  version: 1,
  dryRun: false,
  generatedAt: new Date().toISOString(),
  baseUrl,
  tenant: snapshot.identity.tenant_slug,
  manifestDigest: manifest.digest,
  worldId: world.id,
  seedMap,
  snapshotSummary: { observedAt: snapshot.observedAt, records: snapshot.records.length, identity: snapshot.identity, catalog: snapshot.catalog },
  grounding: { days: groundingDays, before: groundingBefore, after: groundingAfter },
  reports,
  mcpCalls: client.summary(),
  manifest
};
await writeJson(outputPath, output);
console.log(JSON.stringify({
  output: outputPath,
  tenant: snapshot.identity.tenant_slug,
  worldId: world.id,
  cases: cases.length,
  models: reports.map(({ workerId, report }) => ({
    workerId,
    arms: report.arms.map(({ arm, passed, cases: n, families }) => ({ arm, passed: `${passed}/${n}`, families })),
    paired: report.paired
  })),
  grounding: { before: groundingBefore, after: groundingAfter },
  mcpCalls: client.summary()
}, null, 2));

async function groundingSummary() {
  if (!adminKey) return null;
  try {
    const response = await fetch(`${baseUrl}/api/v1/admin/observability/grounding?days=${groundingDays}`, { headers: { "x-admin-key": adminKey } });
    if (!response.ok) return { error: `HTTP ${response.status}` };
    return await response.json();
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}
function parseWorkers(text) {
  return text.split(",").map((value) => value.trim()).filter(Boolean).map((entry) => {
    const [id, model, workerBaseUrl, dialect = "generic"] = entry.split("|").map((part) => part.trim());
    if (!id || !model || !workerBaseUrl) throw new Error(`Worker spec must be id|model|baseUrl[|dialect]: ${entry}`);
    if (!["generic", "qwen"].includes(dialect)) throw new Error(`Worker dialect must be generic or qwen: ${entry}`);
    return { id, model, baseUrl: workerBaseUrl, dialect };
  });
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
