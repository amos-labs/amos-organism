#!/usr/bin/env node
// Record an adapter through the research-recordable gates of the candidate
// ledger from the artifacts already on disk: a stage-one training result, a
// frozen-holdout grading report and a sealed-holdout grading report.
//
//   node swarm/scripts/recordAdapterCandidateGates.js \
//     --candidate stage1-implicit-r32-s3 \
//     --training-result swarm/benchmarks/results/<contract>.result.json \
//     --adapter-uri s3://bucket/stage1/<run>/runs/<contract>/adapter \
//     --base-model <served base id> \
//     --treatment <training treatment id> \
//     --adapter-model-id implicit-r32-s3 \
//     --frozen swarm/benchmarks/results/<frozen grading>.json \
//     --sealed swarm/benchmarks/results/<sealed grading>.json \
//     --out swarm/benchmarks/results/adapter-candidate-<id>.json
//
// Canary and promotion are host decisions and cannot be recorded here.
import { readFile, writeFile } from "node:fs/promises";
import {
  createAdapterCandidate,
  holdoutGateFromComparison,
  nextAdapterAction,
  recordAdapterGate
} from "../src/adapterCandidates.js";

const args = process.argv.slice(2);
function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}
function required(name) {
  const value = option(name);
  if (!value) {
    console.error(`${name} is required`);
    process.exit(2);
  }
  return value;
}
async function json(path) { return JSON.parse(await readFile(path, "utf8")); }

const trainingResult = await json(required("--training-result"));
const frozen = await json(required("--frozen"));
const sealed = await json(required("--sealed"));
const adapterModelId = required("--adapter-model-id");
const now = option("--now") ? new Date(option("--now")) : new Date();

if (trainingResult.probes?.adapterReloadExact !== true || trainingResult.probes?.baseBitwiseUnchanged !== true) {
  console.error("training result lacks the reload-exact / base-unchanged probes");
  process.exit(1);
}

let candidate = createAdapterCandidate({
  id: required("--candidate"),
  contractId: trainingResult.contractId,
  contractDigest: trainingResult.contractDigest,
  rank: Number(option("--rank", "32")),
  seed: Number(required("--seed")),
  trainingResultDigest: trainingResult.digest,
  adapterUri: required("--adapter-uri"),
  baseModel: required("--base-model"),
  trainingTreatments: [required("--treatment")],
  createdAt: now
});

candidate = recordAdapterGate(candidate, {
  id: "trained",
  status: "passed",
  evaluator: "disposable-trainer",
  receiptDigest: trainingResult.digest,
  evaluatedAt: now,
  metrics: {
    trainableAdapterParameters: trainingResult.parameters?.trainableAdapterParameters ?? null,
    holdoutSupervisedTokenAccuracy: trainingResult.metrics?.holdout?.supervisedTokenAccuracy ?? null,
    holdoutMeanLoss: trainingResult.metrics?.holdout?.meanLoss ?? null,
    adapterReloadExact: trainingResult.probes.adapterReloadExact,
    baseBitwiseUnchanged: trainingResult.probes.baseBitwiseUnchanged,
    datasetDigest: trainingResult.preflight?.datasetDigest ?? null
  },
  feedbackSignals: []
});

for (const [gateId, report] of [["frozen-holdout", frozen], ["sealed-holdout", sealed]]) {
  const gate = holdoutGateFromComparison({
    gateId,
    comparison: report.comparison,
    adapterModelId,
    minimumPairedMargin: Number(option("--minimum-paired-margin", "1"))
  });
  candidate = recordAdapterGate(candidate, {
    ...gate,
    evaluatedAt: report.generatedAt ?? now,
    metrics: { ...gate.metrics, rulebook: report.rulebook ?? null, seed: report.seed ?? null, pool: report.pool ?? null }
  });
}

const out = option("--out");
if (out) await writeFile(out, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  id: candidate.id,
  status: candidate.status,
  gates: candidate.gates.map(({ id, status, metrics }) => ({ id, status, pairedWins: metrics.pairedWins ?? null, pairedLosses: metrics.pairedLosses ?? null })),
  nextGate: candidate.nextGate,
  nextAction: nextAdapterAction(candidate),
  deployment: candidate.deployment,
  digest: candidate.digest,
  out
}, null, 2));
