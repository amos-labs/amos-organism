#!/usr/bin/env node
// Derive the learning selection snapshot from an organism event chain and write
// it (plus a .digest sidecar) for the Platform and gateway to consume.
//
//   node scripts/publishLearningSelectionSnapshot.ts \
//     --events /var/lib/amos-research/organism/platform-events.jsonl \
//     --runtime amos-qwen38-27b-fp8@e31eb568681d3a718b7aaa5ce646b6711494b186 \
//     --runtime stage1-implicit-r32-s3@e31eb568681d3a718b7aaa5ce646b6711494b186:2a08c46b… \
//     --out /var/lib/amos-research/organism/learning-selection-snapshot.json [--id <id>] [--valid-hours 6]
//
// Replay is read-only; a chain without admitted genes publishes the empty snapshot.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { FileEventStore } from "../src/eventStore.ts";
import { deriveLearningSelectionSnapshot, parseRuntimePin } from "../src/learningSnapshotPublisher.ts";

const args = process.argv.slice(2);
const option = (name: string, fallback: string | null = null): string | null => { const index = args.indexOf(name); return index === -1 ? fallback : args[index + 1] ?? fallback; };
const all = (name: string): string[] => args.flatMap((value, index) => (value === name && args[index + 1] ? [args[index + 1]!] : []));
const eventsPath = option("--events");
const outPath = option("--out");
if (!eventsPath || !outPath || all("--runtime").length === 0) {
  console.error("usage: --events <jsonl> --out <path> --runtime modelId@revision[:adapterSha] [--runtime ...] [--id id] [--valid-hours n]");
  process.exit(2);
}
const now = new Date();
const { snapshot, chain } = deriveLearningSelectionSnapshot({
  events: new FileEventStore(eventsPath).events(),
  id: option("--id") ?? `snapshot-${now.toISOString().replace(/[-:.]/g, "").slice(0, 15)}Z`,
  compatibleRuntimes: all("--runtime").map(parseRuntimePin),
  validForMs: Number(option("--valid-hours", "6")) * 60 * 60 * 1000,
  now
});
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(`${outPath}.tmp`, `${JSON.stringify(snapshot, null, 2)}\n`);
writeFileSync(`${outPath}.digest.tmp`, `${snapshot.digest}\n`);
// Rename after both files are complete so a reader never sees a half-written snapshot.
const { renameSync } = await import("node:fs");
renameSync(`${outPath}.tmp`, outPath);
renameSync(`${outPath}.digest.tmp`, `${outPath}.digest`);
console.log(JSON.stringify({ out: outPath, id: snapshot.id, digest: snapshot.digest, procedureSnapshotSha256: snapshot.procedureSnapshotSha256, validUntil: snapshot.validUntil, chain }));
