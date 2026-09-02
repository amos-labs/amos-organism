#!/usr/bin/env node
// Syntax-check every swarm module and script so `npm run check` exercises the
// research tree even though it is plain ESM JavaScript outside tsc's reach.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const swarmRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const files = [];
for (const directory of ["src", "src/runtime", "scripts", "test", "test/fixtures"]) {
  for (const entry of readdirSync(join(swarmRoot, directory), { withFileTypes: true })) {
    if (entry.isFile() && /\.(mjs|js)$/.test(entry.name)) {
      files.push(join(swarmRoot, directory, entry.name));
    }
  }
}
for (const file of files.sort()) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}
process.stdout.write(`swarm syntax ok: ${files.length} files under ${relative(repoRoot, swarmRoot)}/\n`);
