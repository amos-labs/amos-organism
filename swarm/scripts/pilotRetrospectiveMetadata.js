#!/usr/bin/env node
// Run the structural/linkage pilot over a Platform retrospective metadata fixture.
//   node swarm/scripts/pilotRetrospectiveMetadata.js --fixture <path> [--out <report.json>] [--sidecar-digest <sha>] [--exact-file-digest <sha>]
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { runRetrospectiveMetadataPilot } from "../src/retrospectiveMetadataPilot.js";

const args = process.argv.slice(2);
const option = (name, fallback = null) => { const index = args.indexOf(name); return index === -1 ? fallback : args[index + 1]; };
const path = option("--fixture");
if (!path) { console.error("--fixture is required"); process.exit(2); }
const bytes = await readFile(path);
const fixture = JSON.parse(bytes.toString("utf8"));
const exact = createHash("sha256").update(bytes).digest("hex");
const withoutFinalNewline = createHash("sha256").update(bytes.subarray(0, bytes.at(-1) === 0x0a ? bytes.length - 1 : bytes.length)).digest("hex");
const report = runRetrospectiveMetadataPilot(fixture, { fixtureDigests: { exactFileSha256: exact, fileWithoutFinalNewlineSha256: withoutFinalNewline, sidecarSha256: option("--sidecar-digest"), sidecarMatchesFileWithoutFinalNewline: option("--sidecar-digest") ? option("--sidecar-digest") === withoutFinalNewline : null } });
if (option("--out")) await writeFile(option("--out"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ structural: { passed: report.structural.passed, failed: report.structural.failed, failedChecks: report.structural.checks.filter((c) => c.status === "failed").map((c) => `${c.id}: ${c.detail}`) }, eligibility: { candidates: report.eligibility.candidateExamples, accepted: report.eligibility.accepted, rejected: report.eligibility.rejected, eligibleRealExamples: report.eligibility.eligibleRealExamples, syntheticSeeds: report.eligibility.syntheticSeeds.length }, canonicalDigest: report.fixture.canonicalDigest, reportDigest: report.digest, out: option("--out") }, null, 2));
