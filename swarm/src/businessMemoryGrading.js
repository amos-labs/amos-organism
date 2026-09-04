import { digestResearchValue } from "./experimentProtocol.js";
import { runResearchInference } from "./modelScaffold.js";
import {
  BUSINESS_MEMORY_ARMS,
  businessMemoryProcedures,
  gradeBusinessMemoryAnswerText,
  renderArmMessages
} from "./businessMemoryBenchmark.js";

/**
 * Run the business-memory benchmark against one served model and compare arms
 * pairwise on identical cases. A second report for the same manifest can be
 * compared model-to-model on the same arm.
 */

export const BUSINESS_MEMORY_REPORT_SCHEMA = "amos.business-memory-report";
export const BUSINESS_MEMORY_ARM_COMPARISON_SCHEMA = "amos.business-memory-arm-comparison";
export const BUSINESS_MEMORY_MODEL_COMPARISON_SCHEMA = "amos.business-memory-model-comparison";
export const BUSINESS_MEMORY_GRADING_VERSION = 1;

const ARM_PAIRS = Object.freeze([
  ["alone", "memory"],
  ["memory", "procedures"],
  ["alone", "procedures"]
]);

export async function runBusinessMemoryBenchmark({
  worker,
  manifest,
  arms = BUSINESS_MEMORY_ARMS,
  procedures = businessMemoryProcedures(),
  maxOutputTokens = 600,
  jsonMode = false,
  now = () => new Date(),
  signal = null,
  onCase = null
}) {
  if (!worker || typeof worker.runCase !== "function") {
    throw new Error("Business-memory grading requires a research worker");
  }
  if (!manifest || !Array.isArray(manifest.cases) || manifest.cases.length === 0) {
    throw new Error("Business-memory grading requires a manifest with cases");
  }
  for (const arm of arms) {
    if (!BUSINESS_MEMORY_ARMS.includes(arm)) throw new Error(`Unknown arm ${arm}`);
  }
  const worlds = new Map(manifest.worlds.map((world) => [world.id, world]));
  const startedAt = now().toISOString();
  const runs = [];
  for (const arm of arms) {
    for (const testCase of manifest.cases) {
      if (signal?.aborted) break;
      const world = worlds.get(testCase.worldId);
      if (!world) throw new Error(`Case ${testCase.id} references unknown world ${testCase.worldId}`);
      const messages = renderArmMessages({ arm, testCase, world, procedures });
      const promptChars = messages.reduce((total, message) => total + String(message.content).length, 0);
      const observation = await runResearchInference({
        worker,
        caseId: `${testCase.id}::${arm}`,
        messages,
        dataManifestDigest: manifest.digest,
        repetition: 1,
        maxOutputTokens,
        answerReserveTokens: Math.max(96, Math.floor(maxOutputTokens / 4)),
        responseFormat: jsonMode ? { type: "json_object" } : null,
        promptSessionId: `business-memory-${worker.model}-${arm}-${testCase.id}`,
        visibleAnswerValidator: (message) => looksLikeJson(visibleText(message)),
        signal
      });
      const answerText = visibleText(observation.message);
      const verification = gradeBusinessMemoryAnswerText({ testCase, world, text: answerText });
      const run = {
        caseId: testCase.id,
        caseDigest: testCase.digest,
        worldId: testCase.worldId,
        family: testCase.family,
        arm,
        passed: verification.passed,
        failures: verification.failures,
        answerDigest: verification.answerDigest,
        promptChars,
        outputTokens: observation.metrics?.outputTokens ?? null,
        wallMilliseconds: observation.metrics?.wallMilliseconds ?? null,
        recoveryTriggered: observation.recoveryTriggered,
        answerText
      };
      runs.push(run);
      if (onCase) onCase(run);
    }
  }
  const armSummaries = arms.map((arm) => summarizeArm(arm, runs.filter((run) => run.arm === arm)));
  const base = {
    schema: BUSINESS_MEMORY_REPORT_SCHEMA,
    version: BUSINESS_MEMORY_GRADING_VERSION,
    modelId: worker.model,
    controlId: worker.controlId,
    manifestDigest: manifest.digest,
    pool: manifest.pool,
    seed: manifest.seed,
    caseCount: manifest.cases.length,
    startedAt,
    completedAt: now().toISOString(),
    procedureDigests: procedures.map((procedure) => procedure.digest),
    arms: armSummaries,
    runs,
    interpretation: interpret(manifest, procedures, runs)
  };
  return { ...base, digest: digestResearchValue(base) };
}

export function compareBusinessMemoryArms(report) {
  const present = new Set(report.arms.map((summary) => summary.arm));
  const comparisons = ARM_PAIRS
    .filter(([baseline, treatment]) => present.has(baseline) && present.has(treatment))
    .map(([baseline, treatment]) => pairedComparison({
      label: `${treatment} versus ${baseline}`,
      baselineRuns: report.runs.filter((run) => run.arm === baseline),
      treatmentRuns: report.runs.filter((run) => run.arm === treatment),
      baseline,
      treatment
    }));
  const base = {
    schema: BUSINESS_MEMORY_ARM_COMPARISON_SCHEMA,
    version: BUSINESS_MEMORY_GRADING_VERSION,
    modelId: report.modelId,
    manifestDigest: report.manifestDigest,
    comparisons
  };
  return { ...base, digest: digestResearchValue(base) };
}

export function compareBusinessMemoryModels({ candidate, control, arm }) {
  if (candidate.manifestDigest !== control.manifestDigest) {
    throw new Error("Model comparison requires reports on the same manifest");
  }
  if (!BUSINESS_MEMORY_ARMS.includes(arm)) throw new Error(`Unknown arm ${arm}`);
  const comparison = pairedComparison({
    label: `${candidate.modelId} versus ${control.modelId} on ${arm}`,
    baselineRuns: control.runs.filter((run) => run.arm === arm),
    treatmentRuns: candidate.runs.filter((run) => run.arm === arm),
    baseline: control.modelId,
    treatment: candidate.modelId
  });
  const base = {
    schema: BUSINESS_MEMORY_MODEL_COMPARISON_SCHEMA,
    version: BUSINESS_MEMORY_GRADING_VERSION,
    arm,
    manifestDigest: candidate.manifestDigest,
    candidateModelId: candidate.modelId,
    controlModelId: control.modelId,
    ...comparison
  };
  return { ...base, digest: digestResearchValue(base) };
}

function pairedComparison({ label, baselineRuns, treatmentRuns, baseline, treatment }) {
  const byCase = new Map(baselineRuns.map((run) => [run.caseId, run]));
  let wins = 0;
  let losses = 0;
  let ties = 0;
  const byFamily = {};
  for (const treated of treatmentRuns) {
    const base = byCase.get(treated.caseId);
    if (!base) continue;
    const family = byFamily[treated.family] ??= { wins: 0, losses: 0, ties: 0 };
    if (treated.passed && !base.passed) {
      wins += 1;
      family.wins += 1;
    } else if (!treated.passed && base.passed) {
      losses += 1;
      family.losses += 1;
    } else {
      ties += 1;
      family.ties += 1;
    }
  }
  const paired = wins + losses + ties;
  return {
    label,
    baseline,
    treatment,
    pairedCases: paired,
    pairedWins: wins,
    pairedLosses: losses,
    ties,
    baselinePassRate: passRate(baselineRuns),
    treatmentPassRate: passRate(treatmentRuns),
    passRateLift: passRate(treatmentRuns) - passRate(baselineRuns),
    byFamily
  };
}

function summarizeArm(arm, runs) {
  const byFamily = {};
  for (const run of runs) {
    const family = byFamily[run.family] ??= { passed: 0, total: 0, passRate: 0 };
    family.total += 1;
    if (run.passed) family.passed += 1;
  }
  for (const family of Object.values(byFamily)) family.passRate = family.total ? family.passed / family.total : 0;
  return {
    arm,
    total: runs.length,
    passed: runs.filter((run) => run.passed).length,
    passRate: passRate(runs),
    recoveryRate: runs.length ? runs.filter((run) => run.recoveryTriggered).length / runs.length : 0,
    promptCharsMean: mean(runs.map((run) => run.promptChars)),
    outputTokensMean: mean(runs.map((run) => run.outputTokens).filter((value) => Number.isFinite(value))),
    byFamily
  };
}

function interpret(manifest, procedures, runs) {
  const reasons = [
    "Fixture-backed synthetic business; not customer data.",
    "Single repetition per case; report paired wins and losses, not a point estimate alone."
  ];
  if (manifest.pool !== "holdout") reasons.push("Development pool is research-visible; only holdout results support a claim.");
  if (procedures.some((procedure) => procedure.origin === "authored-v0")) {
    reasons.push("Procedures are authored, not harvested; the procedures arm measures the value of supplying verified procedural memory, not the organism's ability to learn it.");
  }
  if (procedures.some((procedure) => procedure.origin === "harvested")) {
    reasons.push("Procedures were harvested from development-pool repairs; their value counts only on the holdout pool.");
  }
  return {
    qualityClaimAllowed: false,
    reasons,
    caseCount: manifest.cases.length,
    runCount: runs.length
  };
}

function passRate(runs) {
  return runs.length ? runs.filter((run) => run.passed).length / runs.length : 0;
}

function mean(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function looksLikeJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return false;
  try {
    JSON.parse(text.slice(start, end + 1));
    return true;
  } catch {
    return false;
  }
}

export function visibleText(message) {
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map(({ text }) => text)
      .join("\n")
      .trim();
  }
  return "";
}
