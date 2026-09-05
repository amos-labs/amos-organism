#!/usr/bin/env node
import { readFile, writeFile, stat } from "node:fs/promises";
import { compareVerifiedMissions } from "../src/missionComparison.js";
const [input, output, ...extra] = process.argv.slice(2);
if (!input || !output || extra.length) throw Error("Usage: node swarm/scripts/compareVerifiedMissions.js executions.json comparison.json");
if ((await stat(input)).size > 64 * 1024 * 1024) throw Error("Mission evidence exceeds 64 MiB");
const bytes = await readFile(input);
if (bytes.length > 64 * 1024 * 1024) throw Error("Mission evidence exceeds 64 MiB");
const report = compareVerifiedMissions(JSON.parse(bytes));
const serialized = JSON.stringify(report, null, 2) + "\n";
try { await writeFile(output, serialized, { flag: "wx", mode: 0o600 }); }
catch (error) { if (error.code !== "EEXIST" || await readFile(output, "utf8") !== serialized) throw error; }
console.log(JSON.stringify({ passed: report.passed, metrics: report.metrics, checks: report.checks, digest: report.digest, automaticallyPromoted: false }));
