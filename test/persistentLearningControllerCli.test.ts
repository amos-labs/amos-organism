import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { FileEventStore } from "../src/eventStore.ts";

const script = fileURLToPath(new URL("../scripts/runPersistentLearningController.ts", import.meta.url));
const example = JSON.parse(readFileSync(new URL("../research/persistent-mind/example-observations.json", import.meta.url), "utf8"));
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "amos-persistent-cli-"));
  const input = join(dir, "observations.json");
  writeFileSync(input, JSON.stringify(example));
  const state = join(dir, "state");
  return { dir, input, state, args: [script, "--state-dir", state, "--observations", input] };
}
function run(args: string[]) { return spawnSync(process.execPath, args, { encoding: "utf8", timeout: 10000 }); }
function stateBytes(path: string): Record<string, string> {
  return Object.fromEntries(readdirSync(path).filter(name => name !== ".controller-lock").sort().map(name => [name, readFileSync(join(path, name), "utf8")]));
}
function waitExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("child did not stop")); }, 10000);
    child.once("exit", code => { clearTimeout(timer); resolve(code); });
  });
}
function ready(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`controller not ready: ${output}`)), 10000);
    child.stdout!.on("data", data => {
      output += data;
      if (output.includes('"status":"ready"')) { clearTimeout(timer); resolve(); }
    });
    child.once("exit", code => { clearTimeout(timer); if (!output.includes('"status":"ready"')) reject(new Error(`early exit ${code}: ${output}`)); });
  });
}

test("CLI --once persists a reflection and restart deduplicates observations and actions", () => {
  const f = fixture();
  try {
    const first = run([...f.args, "--once"]);
    assert.equal(first.status, 0, first.stderr);
    const events = new FileEventStore(join(f.state, "events.jsonl")).events();
    assert.equal(events.length, 2);
    const before = stateBytes(f.state);
    const snapshot = JSON.parse(before["snapshot.json"]!);
    assert.equal(snapshot.operation, "deterministic-cpu-reflection");
    assert.equal(snapshot.evidenceBasis, "operator-imported-aggregate");
    assert.equal(snapshot.qualityImprovementEstablished, false);
    assert.equal(snapshot.reflectionEvents.length, 1);
    assert.equal(snapshot.journalDigest, events.at(-1)!.digest);
    const second = run([...f.args, "--once"]);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(stateBytes(f.state), before);
    assert.equal(existsSync(join(f.state, ".controller-lock")), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("CLI executes at most one reflection in a tick", () => {
  const f = fixture();
  try {
    writeFileSync(f.input, JSON.stringify([example[0], { ...example[0], id: "synthetic-second", family: "synthetic-second-family" }]));
    const result = run([...f.args, "--once"]);
    assert.equal(result.status, 0, result.stderr);
    const events = new FileEventStore(join(f.state, "events.jsonl")).events();
    assert.equal(events.filter(e => e.type === "learning.observation-imported.v1").length, 2);
    assert.equal(events.filter(e => e.type === "learning.gap-reflected.v1").length, 1);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("CLI validates the entire batch before changing existing state", () => {
  const f = fixture();
  try {
    assert.equal(run([...f.args, "--once"]).status, 0);
    const before = stateBytes(f.state);
    for (const payload of ["not json", JSON.stringify([{ ...example[0], id: "synthetic-new" }, { ...example[0], id: "synthetic-invalid", passed: 99 }])]) {
      writeFileSync(f.input, payload);
      assert.equal(run([...f.args, "--once"]).status, 1);
      assert.deepEqual(stateBytes(f.state), before);
    }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("CLI prevents concurrent writers and SIGTERM releases the lock", async () => {
  const f = fixture();
  const child = spawn(process.execPath, [...f.args, "--poll-ms", "20"], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await ready(child);
    const before = stateBytes(f.state);
    const competing = run([...f.args, "--once"]);
    assert.equal(competing.status, 1);
    assert.match(competing.stderr, /state_locked/);
    assert.deepEqual(stateBytes(f.state), before);
    child.kill("SIGTERM");
    assert.equal(await waitExit(child), 0);
    assert.equal(existsSync(join(f.state, ".controller-lock")), false);
    assert.equal(run([...f.args, "--once"]).status, 0);
  } finally { child.kill("SIGKILL"); rmSync(f.dir, { recursive: true, force: true }); }
});

test("CLI reclaims a dead local writer but never a remote lock", async () => {
  const f = fixture();
  const child = spawn(process.execPath, f.args, { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await ready(child);
    child.kill("SIGKILL");
    await waitExit(child);
    const ownerPath = join(f.state, ".controller-lock", "owner.json");
    const deadOwner = JSON.parse(readFileSync(ownerPath, "utf8"));
    assert.equal(deadOwner.hostname, hostname());
    writeFileSync(ownerPath, JSON.stringify({ ...deadOwner, hostname: "synthetic-remote-host" }));
    assert.equal(run([...f.args, "--once"]).status, 1);
    assert.equal(existsSync(ownerPath), true);
    writeFileSync(ownerPath, JSON.stringify(deadOwner));
    assert.equal(run([...f.args, "--once"]).status, 0);
    assert.equal(new FileEventStore(join(f.state, "events.jsonl")).events().length, 2);
  } finally { child.kill("SIGKILL"); rmSync(f.dir, { recursive: true, force: true }); }
});

test("CLI help and strict argument parsing do not write state", () => {
  const help = run([script, "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /metadata-only CPU reflection/);
  for (const args of [[], ["--state-dir", "relative", "--observations", resolve("missing.json")], ["--once", "--once"], ["--poll-ms", "0"], ["--unknown"]]) {
    assert.equal(run([script, ...args]).status, 1);
  }
});

test("CLI replays durable events after a post-write fsync error instead of duplicating sequence", async () => {
  const f = fixture();
  const preload = join(f.dir, "synthetic-fsync-fault.mjs");
  writeFileSync(preload, `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const write = fs.writeSync;
const sync = fs.fsyncSync;
let eventFd = null;
let injected = false;
fs.writeSync = function(fd, ...args) {
  const result = write.call(fs, fd, ...args);
  if (typeof args[0] === "string" && args[0].includes("learning.observation-imported.v1")) eventFd = fd;
  return result;
};
fs.fsyncSync = function(fd) {
  sync.call(fs, fd);
  if (!injected && fd === eventFd) { injected = true; throw new Error("Synthetic failure after durable journal write"); }
};
syncBuiltinESMExports();
`);
  const child = spawn(process.execPath, ["--import", preload, ...f.args, "--poll-ms", "20"], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout!.on("data", data => { output += data; });
  try {
    await ready(child);
    child.kill("SIGTERM");
    assert.equal(await waitExit(child), 0);
    assert.match(output, /input_or_state_error/);
    const events = new FileEventStore(join(f.state, "events.jsonl")).events();
    assert.deepEqual(events.map(event => event.sequence), [1, 2]);
    assert.equal(events[1]!.previousDigest, events[0]!.digest);
    const snapshot = JSON.parse(readFileSync(join(f.state, "snapshot.json"), "utf8"));
    assert.equal(snapshot.journalDigest, events[1]!.digest);
    assert.equal(snapshot.reflectionEvents.length, 1);
  } finally { child.kill("SIGKILL"); rmSync(f.dir, { recursive: true, force: true }); }
});

test("CLI rereads changed observations, stays quiet on unchanged ticks and handles SIGINT", async () => {
  const f = fixture();
  const child = spawn(process.execPath, [...f.args, "--poll-ms", "20"], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout!.on("data", data => { output += data; });
  try {
    await ready(child);
    const updated = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("changed observations were not ingested")), 10000);
      child.stdout!.on("data", () => {
        if (output.includes('"journalSequence":4')) { clearTimeout(timer); resolve(); }
      });
    });
    writeFileSync(f.input, JSON.stringify([example[0], { ...example[0], id: "synthetic-added-later", family: "synthetic-new-family" }]));
    await updated;
    const before = output;
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(output, before);
    child.kill("SIGINT");
    assert.equal(await waitExit(child), 0);
    assert.equal(new FileEventStore(join(f.state, "events.jsonl")).events().length, 4);
    assert.equal(existsSync(join(f.state, ".controller-lock")), false);
  } finally { child.kill("SIGKILL"); rmSync(f.dir, { recursive: true, force: true }); }
});

test("CLI --development-work runs the CPU executor once inside the lock and does not re-execute on restart", () => {
  const f = fixture();
  const dev = join(f.dir, "dev.json");
  writeFileSync(dev, JSON.stringify({
    candidate: { id: "dev-cand-cli", policy: { "bid.repetitionPenalty": 4, "retry.challengerExploration": 1 }, optimizedParameters: ["bid.repetitionPenalty", "retry.challengerExploration"], rank: 1, createdAt: "2026-09-12T00:00:00.000Z" },
    priorGate: { id: "simulation", status: "passed", evaluator: "organism-simulator", receiptDigest: "0".repeat(64), metrics: {}, feedbackSignals: [], evaluatedAt: "2026-09-12T00:00:00.000Z" },
    episodes: [{ id: "ep-a", task: { name: "accounts-payable-process" } }, { id: "ep-b", task: { name: "accounts-payable-process" } }],
  }));
  const last = (out: string) => JSON.parse(out.trim().split("\n").filter(Boolean).at(-1)!);
  try {
    const first = run([...f.args, "--development-work", dev, "--once"]);
    assert.equal(first.status, 0, first.stderr);
    const s1 = last(first.stdout);
    assert.equal(s1.development.state, "completed");
    assert.equal(s1.development.reused, false);
    assert.equal(s1.development.workKind, "organism-artifact-replay");
    assert.match(s1.development.receiptDigest, /^[a-f0-9]{64}$/);
    // Restart over the same state: the reflection is already processed, so no new
    // dispatch/execution occurs — the journal does not grow.
    const second = run([...f.args, "--development-work", dev, "--once"]);
    assert.equal(second.status, 0, second.stderr);
    const s2 = last(second.stdout);
    assert.equal(s2.journalSequence, s1.journalSequence, "restart must not execute development work again");
    assert.ok(s2.development === undefined || s2.development.reused === true);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("CLI default remains metadata-only when --development-work is absent", () => {
  const f = fixture();
  try {
    const r = run([...f.args, "--once"]);
    assert.equal(r.status, 0, r.stderr);
    const s = JSON.parse(r.stdout.trim().split("\n").filter(Boolean).at(-1)!);
    assert.equal(s.development, undefined);
    assert.equal(s.operation, "deterministic-cpu-reflection");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
