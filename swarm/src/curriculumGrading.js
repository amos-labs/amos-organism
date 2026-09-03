import { digestResearchValue } from "./experimentProtocol.js";
import { runResearchInference } from "./modelScaffold.js";
import {
  generateCurriculumScenarios,
  gradeCurriculumAnswerText
} from "./amosCurriculumGenerator.js";

/**
 * Grade a served model on curriculum scenarios with the executable verifier.
 *
 * One bounded repair attempt is offered after a failed first attempt: the
 * verifier's failure list is fed back as typed feedback, never the target. A
 * recovered scenario yields a verified preference pair; a first-attempt pass
 * yields a verified answer. Holdout-pool results are evaluation evidence only.
 */

export const CURRICULUM_GRADING_REPORT_SCHEMA = "amos.curriculum-grading-report";
export const CURRICULUM_GRADING_COMPARISON_SCHEMA = "amos.curriculum-grading-comparison";
export const CURRICULUM_GRADING_VERSION = 1;

export async function runCurriculumGrading({
  worker,
  scenarios,
  maxOutputTokens = 1_200,
  repairAttempts = 1,
  now = () => new Date(),
  signal = null,
  onScenario = null
}) {
  if (!worker || typeof worker.runCase !== "function") {
    throw new Error("Curriculum grading requires a research worker");
  }
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    throw new Error("Curriculum grading requires scenarios");
  }
  if (!Number.isInteger(repairAttempts) || repairAttempts < 0 || repairAttempts > 2) {
    throw new Error("repairAttempts must be 0, 1, or 2");
  }
  const startedAt = now().toISOString();
  const runs = [];
  for (const scenario of scenarios) {
    if (signal?.aborted) break;
    const attempts = [];
    let previous = null;
    for (let attempt = 0; attempt <= repairAttempts; attempt += 1) {
      const messages = gradingMessages(scenario, previous);
      const observation = await runResearchInference({
        worker,
        caseId: `curriculum-${scenario.id}-attempt-${attempt + 1}`,
        messages,
        dataManifestDigest: scenario.digest,
        repetition: 1,
        maxOutputTokens,
        answerReserveTokens: Math.max(128, Math.floor(maxOutputTokens / 4)),
        promptSessionId: `curriculum-${worker.model}-${scenario.id}`,
        signal
      });
      const answerText = visibleText(observation.message);
      const verification = gradeCurriculumAnswerText({ scenario, text: answerText });
      attempts.push({
        attempt: attempt + 1,
        answerText,
        verification,
        outputTokens: observation.metrics?.outputTokens ?? null
      });
      if (verification.passed) break;
      previous = { answerText, failures: verification.failures };
    }
    const final = attempts.at(-1).verification;
    const run = {
      scenarioId: scenario.id,
      scenarioDigest: scenario.digest,
      family: scenario.family,
      pool: scenario.pool,
      passed: final.passed,
      firstAttemptPassed: attempts[0].verification.passed,
      recovered: !attempts[0].verification.passed && final.passed,
      calls: attempts.length,
      passedCheckRate: final.checkCount > 0 ? final.passedChecks / final.checkCount : 0,
      attempts
    };
    runs.push(run);
    if (typeof onScenario === "function") await onScenario(run, scenario);
  }
  const summary = summarizeRuns(runs);
  const reportBase = {
    schema: CURRICULUM_GRADING_REPORT_SCHEMA,
    version: CURRICULUM_GRADING_VERSION,
    modelId: worker.model,
    controlId: worker.controlId ?? null,
    startedAt,
    finishedAt: now().toISOString(),
    protocol: {
      verifier: "amos-executable-contract-verifier",
      repairAttempts,
      maxOutputTokens,
      feedbackIsVerifierFailuresOnly: true,
      targetNeverShown: true
    },
    pools: [...new Set(runs.map(({ pool }) => pool))].sort(),
    scenarioCount: runs.length,
    aborted: signal?.aborted === true,
    ...summary,
    runs,
    interpretation: {
      verifiedEvaluations: runs.reduce((total, run) => total + run.calls, 0),
      holdoutEvidence: runs.some(({ pool }) => pool === "holdout"),
      qualityClaimAllowed: false,
      promotionAllowed: false
    }
  };
  return { ...reportBase, digest: digestResearchValue(reportBase) };
}

export function summarizeRuns(runs) {
  const families = {};
  for (const run of runs) {
    const family = families[run.family] || { scenarios: 0, passed: 0, firstAttemptPassed: 0, recovered: 0 };
    family.scenarios += 1;
    family.passed += Number(run.passed);
    family.firstAttemptPassed += Number(run.firstAttemptPassed);
    family.recovered += Number(run.recovered);
    families[run.family] = family;
  }
  for (const family of Object.values(families)) {
    family.passRate = round(family.passed / Math.max(1, family.scenarios));
  }
  return {
    passRate: round(mean(runs.map(({ passed }) => Number(passed)))),
    firstAttemptPassRate: round(mean(runs.map(({ firstAttemptPassed }) => Number(firstAttemptPassed)))),
    recoveryRate: (() => {
      const failedFirst = runs.filter(({ firstAttemptPassed }) => !firstAttemptPassed);
      return failedFirst.length === 0 ? 0 : round(mean(failedFirst.map(({ recovered }) => Number(recovered))));
    })(),
    meanPassedCheckRate: round(mean(runs.map(({ passedCheckRate }) => passedCheckRate))),
    meanCalls: round(mean(runs.map(({ calls }) => calls))),
    perFamily: Object.fromEntries(Object.entries(families).sort(([left], [right]) => left.localeCompare(right)))
  };
}

/**
 * Paired comparison across model IDs graded on the same scenarios. The first
 * report is the control (base model); every other report is a candidate.
 */
export function compareCurriculumGrading(reports) {
  if (!Array.isArray(reports) || reports.length < 2) {
    throw new Error("A grading comparison needs a control report and at least one candidate");
  }
  const [control, ...candidates] = reports.map(validateGradingReport);
  const controlByScenario = new Map(control.runs.map((run) => [run.scenarioId, run]));
  const comparisons = candidates.map((candidate) => {
    const shared = candidate.runs.filter(({ scenarioId }) => controlByScenario.has(scenarioId));
    if (shared.length !== candidate.runs.length || shared.length !== control.runs.length) {
      throw new Error(`Candidate ${candidate.modelId} was not graded on the control's scenarios`);
    }
    let wins = 0;
    let losses = 0;
    for (const run of shared) {
      const base = controlByScenario.get(run.scenarioId);
      if (run.passed && !base.passed) wins += 1;
      if (!run.passed && base.passed) losses += 1;
    }
    return {
      modelId: candidate.modelId,
      reportDigest: candidate.digest,
      passRateLift: round(candidate.passRate - control.passRate),
      firstAttemptPassRateLift: round(candidate.firstAttemptPassRate - control.firstAttemptPassRate),
      pairedWins: wins,
      pairedLosses: losses,
      ties: shared.length - wins - losses,
      perFamilyLift: Object.fromEntries(Object.keys(control.perFamily).map((family) => [
        family,
        round((candidate.perFamily[family]?.passRate ?? 0) - control.perFamily[family].passRate)
      ]))
    };
  });
  const base = {
    schema: CURRICULUM_GRADING_COMPARISON_SCHEMA,
    version: CURRICULUM_GRADING_VERSION,
    control: { modelId: control.modelId, reportDigest: control.digest, passRate: control.passRate },
    scenarioCount: control.scenarioCount,
    pools: control.pools,
    candidates: comparisons,
    interpretation: {
      pairedOnIdenticalScenarios: true,
      verifier: "amos-executable-contract-verifier",
      qualityClaimAllowed: false,
      promotionAllowed: false,
      note: "Lift on the holdout pool is promotion evidence only after sealed-holdout and blind frontier gates."
    }
  };
  return { ...base, digest: digestResearchValue(base) };
}

export function validateGradingReport(input) {
  const report = structuredClone(input);
  if (report?.schema !== CURRICULUM_GRADING_REPORT_SCHEMA || report?.version !== CURRICULUM_GRADING_VERSION) {
    throw new Error("Unsupported curriculum grading report");
  }
  const { digest, ...rest } = report;
  if (digestResearchValue(rest) !== digest) throw new Error("Curriculum grading report digest does not match");
  return report;
}

export function scenariosForGrading({ catalog, pool = "holdout", scenariosPerFamily = 8, seed = "amos-curriculum-grading-v1", families }) {
  return generateCurriculumScenarios({ catalog, scenariosPerFamily, seed, pool, ...(families ? { families } : {}) });
}

export function gradingMessages(scenario, previous = null) {
  const messages = [
    { role: "system", content: scenario.prompt.system },
    { role: "user", content: scenario.prompt.user }
  ];
  if (previous) {
    messages.push({ role: "assistant", content: previous.answerText });
    messages.push({
      role: "user",
      content: [
        "The independent verifier rejected that answer. Failed checks:",
        ...previous.failures.map((failure) => `- ${failure}`),
        "Return only the corrected JSON contract."
      ].join("\n")
    });
  }
  return messages;
}

function visibleText(message) {
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.filter((part) => part?.type === "text" && typeof part.text === "string").map(({ text }) => text).join("\n").trim();
  }
  return "";
}

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / Math.max(1, values.length);
}

function round(value) {
  return Math.round(value * 10_000) / 10_000;
}
