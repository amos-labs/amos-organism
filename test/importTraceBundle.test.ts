import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { FileEventStore, OrganismKernel, StrategyGeneArchive } from "../src/index.ts";
import { AllowListHostGate } from "./helpers.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function importBundle(name: string) {
  const output = join(mkdtempSync(join(tmpdir(), "organism-import-")), `${name}.jsonl`);
  const result = spawnSync(process.execPath, [
    join(repoRoot, "scripts/importTraceBundle.ts"),
    join(repoRoot, "research/imports", `${name}.json`),
    output,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return { output, summary: JSON.parse(result.stdout) as Record<string, number> };
}

test("committed trace bundles that still say `version` import without being rejected", () => {
  const seeds = importBundle("verified-qwen-swarm-seed-genes-v1");
  assert.equal(seeds.summary.imported, 3);
  assert.equal(seeds.summary.verified, 3);
  assert.equal(seeds.summary.admittedGenes, 3);
  const active = importBundle("recursive-organism-active-hrr-energy-production-planning-20260824-r1");
  assert.equal(active.summary.imported, 2);
  assert.equal(active.summary.negative, 2);
  assert.equal(active.summary.admittedGenes, 0);
});

test("an imported bundle replays into the same admitted genes after restart", () => {
  const { output } = importBundle("verified-qwen-swarm-seed-genes-v1");
  const archive = new StrategyGeneArchive(new AllowListHostGate());
  archive.replay(new FileEventStore(output).events());
  assert.equal(archive.list().length, 3);
});

test("every committed research event log replays its admitted genes into a fresh kernel", () => {
  const eventsDirectory = join(repoRoot, "research/events");
  const logs = readdirSync(eventsDirectory).filter((name) => name.endsWith(".jsonl"));
  assert.ok(logs.length >= 2);
  let admitted = 0;
  for (const log of logs) {
    const store = new FileEventStore(join(eventsDirectory, log));
    const kernel = new OrganismKernel({ hostGate: new AllowListHostGate(), replayEvents: store.events() });
    const admittedEvents = store.events().filter((event) => event.type === "gene.admitted");
    assert.equal(kernel.genes.list().length, admittedEvents.length, log);
    admitted += kernel.genes.list().length;
  }
  assert.equal(admitted, 3);
});
