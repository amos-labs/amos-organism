#!/usr/bin/env node
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { FileEventStore, MemoryEventStore, type OrganismEvent } from "../src/eventStore.ts";
import { PersistentLearningController, type LearningObservation } from "../src/persistentLearningController.ts";

const USAGE = "Usage: node scripts/runPersistentLearningController.ts --state-dir ABS --observations ABS [--once] [--poll-ms N]\nLocal metadata-only CPU reflection; no model, training, network or promotion. Default poll: 15000 ms.";
const STATE_SCHEMA = "amos.persistent-learning-controller-state.v1";
const MAX_BYTES = 1024 * 1024;

function options(args: string[]) {
  let stateDir = "", observations = "", once = false, pollMs = 15000;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) throw new Error("invalid_arguments");
    seen.add(arg);
    if (arg === "--once") { once = true; continue; }
    if (!["--state-dir", "--observations", "--poll-ms"].includes(arg)) throw new Error("invalid_arguments");
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error("invalid_arguments");
    if (arg === "--state-dir") stateDir = value;
    if (arg === "--observations") observations = value;
    if (arg === "--poll-ms") {
      if (!/^\d+$/.test(value)) throw new Error("invalid_arguments");
      pollMs = Number(value);
      if (!Number.isSafeInteger(pollMs) || pollMs < 10 || pollMs > 3600000) throw new Error("invalid_arguments");
    }
  }
  if (!isAbsolute(stateDir) || !isAbsolute(observations)) throw new Error("invalid_arguments");
  return { stateDir, observations, once, pollMs };
}

function readObservations(path: string): LearningObservation[] {
  const info = statSync(path);
  if (!info.isFile() || info.size > MAX_BYTES) throw new Error("invalid_observations");
  const bytes = readFileSync(path);
  if (bytes.length > MAX_BYTES) throw new Error("invalid_observations");
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(parsed) || parsed.length > 1000) throw new Error("invalid_observations");
  return parsed as LearningObservation[];
}

function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try { renameSync(temporary, path); }
  finally { if (existsSync(temporary)) rmSync(temporary); }
}

function deadLocalPid(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return false;
  try { process.kill(pid as number, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

function lock(stateDir: string): () => void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, ".controller-lock");
  const owner = { hostname: hostname(), pid: process.pid, token: randomUUID() };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      mkdirSync(path, { mode: 0o700 });
      try { writeFileSync(join(path, "owner.json"), JSON.stringify(owner), { flag: "wx", mode: 0o600 }); }
      catch (error) { rmSync(path, { recursive: true }); throw error; }
      return () => {
        try {
          const actual = JSON.parse(readFileSync(join(path, "owner.json"), "utf8"));
          if (actual.token === owner.token) rmSync(path, { recursive: true });
        } catch { /* A missing or replaced lock is never deleted. */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // Only a positively dead PID on this host can be reclaimed. Unknown,
    // remote, inaccessible and half-written locks require operator inspection.
    const original = readFileSync(join(path, "owner.json"), "utf8");
    const stale = JSON.parse(original);
    if (stale.hostname !== hostname() || !deadLocalPid(stale.pid)) throw new Error("state_locked");
    const inode = statSync(path);
    const claim = openSync(join(path, "reclaim"), "wx", 0o600);
    closeSync(claim);
    if (readFileSync(join(path, "owner.json"), "utf8") !== original || statSync(path).ino !== inode.ino || !deadLocalPid(stale.pid)) {
      throw new Error("state_locked");
    }
    const retired = join(stateDir, `.retired-controller-lock-${randomUUID()}`);
    renameSync(path, retired);
    rmSync(retired, { recursive: true });
  }
  throw new Error("state_locked");
}

function preflight(events: readonly OrganismEvent[], observations: LearningObservation[]) {
  const store = new MemoryEventStore();
  for (const event of events) {
    const { sequence: _sequence, previousDigest: _previous, digest: _digest, ...proposal } = event;
    store.append(proposal);
  }
  const controller = new PersistentLearningController({ store });
  for (const observation of observations) controller.ingestObservation(observation);
}

async function main() {
  if (process.argv.slice(2).includes("--help")) { console.log(USAGE); return; }
  const config = options(process.argv.slice(2));
  // Reject a malformed initial batch before creating any persistent state.
  const initial = readObservations(config.observations);
  preflight([], initial);
  const unlock = lock(config.stateDir);
  let stopped = false;
  let wake: (() => void) | undefined;
  const stop = () => { stopped = true; wake?.(); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    const marker = join(config.stateDir, "controller.json");
    if (!existsSync(marker)) {
      if (readdirSync(config.stateDir).some(name => name !== ".controller-lock")) throw new Error("state_directory_not_dedicated");
    } else if (JSON.parse(readFileSync(marker, "utf8")).schema !== STATE_SCHEMA) {
      throw new Error("state_directory_not_dedicated");
    }
    const journalPath = join(config.stateDir, "events.jsonl");
    preflight(new FileEventStore(journalPath).events(), initial);
    if (!existsSync(marker)) atomicJson(marker, { schema: STATE_SCHEMA });
    let lastStatus = "";
    let firstTick = true;
    do {
      let status: Record<string, unknown>;
      try {
        // Reopen under the lock: a prior write/fsync error may have persisted
        // bytes without updating the old store's in-memory event array.
        const store = new FileEventStore(journalPath);
        const controller = new PersistentLearningController({ store });
        const observations = firstTick ? initial : readObservations(config.observations);
        firstTick = false;
        preflight(store.events(), observations);
        for (const observation of observations) controller.ingestObservation(observation);
        const action = controller.planNext();
        if (action) controller.reflect(action);
        const events = store.events();
        const head = events.at(-1);
        const snapshot = {
          schema: "amos.persistent-learning-controller-snapshot.v1",
          evidenceBasis: "operator-imported-aggregate",
          operation: "deterministic-cpu-reflection",
          journalSequence: head?.sequence ?? 0,
          journalDigest: head?.digest ?? null,
          selfModel: controller.selfModel(),
          reflectionEvents: events.filter(event => event.type === "learning.gap-reflected.v1"),
          qualityImprovementEstablished: false,
        };
        const snapshotPath = join(config.stateDir, "snapshot.json");
        const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
        if (!existsSync(snapshotPath) || readFileSync(snapshotPath, "utf8") !== serialized) atomicJson(snapshotPath, snapshot);
        status = { status: "ready", operation: snapshot.operation, evidenceBasis: snapshot.evidenceBasis, journalSequence: snapshot.journalSequence, journalDigest: snapshot.journalDigest, qualityImprovementEstablished: false };
      } catch {
        status = { status: "input_or_state_error", message: "Observation validation or local persistence failed; inspect inputs and the authoritative event journal." };
        if (config.once) process.exitCode = 1;
      }
      const serialized = JSON.stringify(status);
      if (serialized !== lastStatus) { console.log(serialized); lastStatus = serialized; }
      if (config.once || stopped) break;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { wake = undefined; resolve(); }, config.pollMs);
        wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
        if (stopped) wake();
      });
    } while (!stopped);
    if (stopped) console.log(JSON.stringify({ status: "stopped" }));
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    unlock();
  }
}

main().catch(error => {
  const code = error instanceof Error && ["invalid_arguments", "state_locked", "state_directory_not_dedicated"].includes(error.message) ? error.message : "invalid_input_or_state";
  console.error(JSON.stringify({ status: "error", code, message: code === "invalid_arguments" ? USAGE : "Controller did not start. Check input metadata, dedicated state directory and local lock ownership." }));
  process.exitCode = 1;
});
