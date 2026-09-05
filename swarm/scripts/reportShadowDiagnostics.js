#!/usr/bin/env node
// Join the gateway's shadow log to Platform episode events and report agreement
// and attribution per Mission turn. Diagnostic only; never comparator evidence.
//
//   node swarm/scripts/reportShadowDiagnostics.js --shadow shadow.jsonl --events platform-events.jsonl \
//     [--candidate swarm/benchmarks/results/adapter-candidate-<id>.json --base-model-id <id> \
//      --base-artifact <sha> --adapter-artifact <sha> --runtime-revision <sha> \
//      --prompt-compiler <sha> --scheduler-policy <sha> --inference-config <sha>] [--out report.json]
import { readFile, writeFile } from "node:fs/promises";
import { joinShadowWithEpisodes, parseJsonl, treatmentPairFromCandidate } from "../src/shadowDiagnostics.js";

const args = process.argv.slice(2);
const option = (name, fallback = null) => { const index = args.indexOf(name); return index === -1 ? fallback : args[index + 1]; };
const shadowPath = option("--shadow");
if (!shadowPath) { console.error("--shadow is required"); process.exit(2); }
const shadowRecords = parseJsonl(await readFile(shadowPath, "utf8"));
const episodeEvents = option("--events") ? parseJsonl(await readFile(option("--events"), "utf8")) : [];
let treatments = null;
if (option("--candidate")) {
  treatments = treatmentPairFromCandidate({
    candidate: JSON.parse(await readFile(option("--candidate"), "utf8")),
    baseModelId: option("--base-model-id"),
    baseArtifactSha256: option("--base-artifact"),
    adapterArtifactSha256: option("--adapter-artifact"),
    runtimeRevision: option("--runtime-revision"),
    promptCompilerSha256: option("--prompt-compiler"),
    schedulerPolicySha256: option("--scheduler-policy"),
    inferenceConfigSha256: option("--inference-config")
  });
}
const report = joinShadowWithEpisodes({ shadowRecords, episodeEvents, treatments });
if (option("--out")) await writeFile(option("--out"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ counts: report.counts, agreementByTerminalStatus: report.agreementByTerminalStatus, tasksObserved: report.tasksObserved.length, digest: report.digest, out: option("--out") }, null, 2));
