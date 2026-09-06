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

export const BALANCED_ARM_ORDER_VERSION = 2;
// Fixed, non-evaluation warm-up request sent through the real worker before each
// arm's turn in a block. It is never scored and never shown a scenario.
export const CURRICULUM_WARMUP_PROMPT = "Reply with the single word ready.";
export const CURRICULUM_WARMUP_DIGEST = digestResearchValue({ curriculumWarmup: CURRICULUM_WARMUP_PROMPT, version: 1 });
export const CURRICULUM_WARMUP_MAX_OUTPUT_TOKENS = 16;

export async function runCurriculumGrading({
  worker,
  scenarios,
  maxOutputTokens = 1_200,
  repairAttempts = 1,
  now = () => new Date(),
  signal = null,
  onScenario = null,
  concurrency = 1
}) {
  validateGradingInputs({ worker, scenarios, repairAttempts, concurrency });
  const startedAt = now().toISOString();
  const runs = await gradeScenarios({ worker, scenarios, maxOutputTokens, repairAttempts, concurrency, signal, onScenario });
  return buildGradingReport({
    worker,
    runs,
    startedAt,
    finishedAt: now().toISOString(),
    repairAttempts,
    maxOutputTokens,
    concurrency,
    aborted: signal?.aborted === true,
    armOrder: { mode: "sequential" }
  });
}

/**
 * Grade several served models on the same scenarios with a balanced arm order.
 *
 * The scenario list is cut into blocks of `blockSize`; inside every block the
 * arms run one after another in a rotation of a seeded base order, so each
 * model takes every position (first, second, ...) equally often when the block
 * count is a multiple of the arm count. This balances position effects (server
 * warm-up, cache state, drift) across arms; it does not remove them. Before each
 * arm's turn in a block one fixed, bounded, non-evaluation inference request is
 * sent through the real worker (`warmup.mode === "inference"`); its count, wall
 * time and tokens are recorded per arm, separately from scored attempts. A
 * warm-up that cannot be executed aborts the run instead of being reported as
 * done. `warmup.mode === "none"` declares truthfully that no warm-up ran. Every
 * model still grades every scenario with the same protocol, so the per-model
 * reports keep the schema of `runCurriculumGrading` and stay comparable with
 * `compareCurriculumGrading`.
 */
export async function runBalancedCurriculumGrading({
  workers,
  scenarios,
  orderSeed,
  blockSize = null,
  warmup = { mode: "inference", maxOutputTokens: CURRICULUM_WARMUP_MAX_OUTPUT_TOKENS },
  maxOutputTokens = 1_200,
  repairAttempts = 1,
  now = () => new Date(),
  signal = null,
  onScenario = null,
  concurrency = 1
}) {
  if (!Array.isArray(workers) || workers.length < 2) {
    throw new Error("Balanced grading needs at least two workers");
  }
  for (const worker of workers) validateGradingInputs({ worker, scenarios, repairAttempts, concurrency });
  const modelIds = workers.map((worker) => worker.model);
  if (new Set(modelIds).size !== modelIds.length) throw new Error("Balanced grading needs distinct model ids");
  if (typeof orderSeed !== "string" || orderSeed.length === 0) throw new Error("Balanced grading needs an orderSeed");
  const size = blockSize ?? concurrency;
  if (!Number.isInteger(size) || size < 1 || size > scenarios.length) {
    throw new Error("blockSize must be an integer from 1 to the scenario count");
  }
  const warmupPlan = validateWarmup(warmup);
  const blocks = [];
  for (let offset = 0; offset < scenarios.length; offset += size) blocks.push(scenarios.slice(offset, offset + size));
  const baseOrder = seededArmOrder(workers.length, orderSeed);
  const schedule = blocks.map((_, index) => rotate(baseOrder, index % workers.length));
  const startedAt = now().toISOString();
  const runsByArm = workers.map(() => new Array(scenarios.length));
  const positions = workers.map(() => new Array(workers.length).fill(0));
  const warmups = workers.map(() => ({ requests: 0, wallMilliseconds: 0, promptTokens: 0, outputTokens: 0 }));
  let offset = 0;
  for (const [blockIndex, block] of blocks.entries()) {
    for (const [position, arm] of schedule[blockIndex].entries()) {
      if (signal?.aborted) break;
      const worker = workers[arm];
      positions[arm][position] += 1;
      if (warmupPlan.mode === "inference") {
        const executed = await executeWarmup({ worker, blockIndex, maxOutputTokens: warmupPlan.maxOutputTokens, signal });
        warmups[arm].requests += 1;
        warmups[arm].wallMilliseconds += executed.wallMilliseconds;
        warmups[arm].promptTokens += executed.promptTokens;
        warmups[arm].outputTokens += executed.outputTokens;
      }
      const runs = await gradeScenarios({
        worker,
        scenarios: block,
        maxOutputTokens,
        repairAttempts,
        concurrency,
        signal,
        onScenario: onScenario ? (run, scenario) => onScenario(run, scenario, { modelId: worker.model, block: blockIndex, position }) : null
      });
      runs.forEach((run, index) => { if (run) runsByArm[arm][offset + index] = run; });
    }
    offset += block.length;
  }
  const finishedAt = now().toISOString();
  const balanced = blocks.length % workers.length === 0;
  const reports = workers.map((worker, arm) => buildGradingReport({
    worker,
    runs: runsByArm[arm],
    startedAt,
    finishedAt,
    repairAttempts,
    maxOutputTokens,
    concurrency,
    aborted: signal?.aborted === true,
    armOrder: {
      mode: "balanced",
      version: BALANCED_ARM_ORDER_VERSION,
      orderSeed,
      blockSize: size,
      blocks: blocks.length,
      arms: modelIds.length,
      balanced,
      positions: positions[arm],
      // Executed warm-up work for this arm, kept apart from scored attempts and counted in the run budget.
      warmup: { ...warmupPlan, ...warmups[arm] }
    }
  }));
  const scheduleBase = {
    mode: "balanced",
    version: BALANCED_ARM_ORDER_VERSION,
    orderSeed,
    blockSize: size,
    blocks: blocks.length,
    balanced,
    warmup: warmupPlan,
    order: schedule.map((order) => order.map((arm) => modelIds[arm]))
  };
  return { reports, schedule: { ...scheduleBase, digest: digestResearchValue(scheduleBase) } };
}

function validateWarmup(warmup) {
  if (!warmup || typeof warmup !== "object") throw new Error("warmup must be an object with a mode");
  if (warmup.mode === "none") return { mode: "none" };
  if (warmup.mode !== "inference") throw new Error("warmup.mode must be inference or none");
  const maxOutputTokens = warmup.maxOutputTokens ?? CURRICULUM_WARMUP_MAX_OUTPUT_TOKENS;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 256) {
    throw new Error("warmup.maxOutputTokens must be an integer from 1 to 256");
  }
  return { mode: "inference", prompt: CURRICULUM_WARMUP_PROMPT, promptDigest: CURRICULUM_WARMUP_DIGEST, maxOutputTokens, requestsPerArmPerBlock: 1 };
}

// One bounded inference request through the real worker. Failure propagates: a
// warm-up that did not happen is never reported as done.
async function executeWarmup({ worker, blockIndex, maxOutputTokens, signal }) {
  const observation = await worker.runCase({
    caseId: `curriculum-warmup-block-${blockIndex + 1}`,
    messages: [{ role: "user", content: CURRICULUM_WARMUP_PROMPT }],
    dataManifestDigest: CURRICULUM_WARMUP_DIGEST,
    repetition: 1,
    maxOutputTokens,
    reasoningEffortOverride: "none",
    promptSessionId: `curriculum-warmup-${worker.model}`,
    signal
  });
  if (!observation || typeof observation !== "object" || !observation.message) {
    throw new Error(`Warm-up request for ${worker.model} returned no message`);
  }
  const metrics = observation.metrics ?? {};
  return {
    wallMilliseconds: Number.isFinite(metrics.wallMilliseconds) ? metrics.wallMilliseconds : 0,
    promptTokens: Number.isFinite(metrics.promptTokens) ? metrics.promptTokens : 0,
    outputTokens: Number.isFinite(metrics.outputTokens) ? metrics.outputTokens : 0
  };
}

function validateGradingInputs({ worker, scenarios, repairAttempts, concurrency }) {
  if (!worker || typeof worker.runCase !== "function") {
    throw new Error("Curriculum grading requires a research worker");
  }
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    throw new Error("Curriculum grading requires scenarios");
  }
  if (!Number.isInteger(repairAttempts) || repairAttempts < 0 || repairAttempts > 2) {
    throw new Error("repairAttempts must be 0, 1, or 2");
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error("concurrency must be an integer from 1 to 16");
  }
}

// Deterministic base order for the arms, derived from the frozen order seed.
function seededArmOrder(arms, orderSeed) {
  const hex = digestResearchValue({ balancedArmOrder: orderSeed });
  const order = Array.from({ length: arms }, (_, index) => index);
  for (let index = arms - 1; index > 0; index -= 1) {
    const byte = Number.parseInt(hex.slice((index * 2) % (hex.length - 2), ((index * 2) % (hex.length - 2)) + 2), 16);
    const swap = byte % (index + 1);
    [order[index], order[swap]] = [order[swap], order[index]];
  }
  return order;
}

function rotate(order, by) {
  return order.map((_, index) => order[(index + by) % order.length]);
}

// Bounded parallel workers over the scenario list; results keep scenario order.
async function gradeScenarios({ worker, scenarios, maxOutputTokens, repairAttempts, concurrency, signal, onScenario }) {
  const runs = new Array(scenarios.length);
  let cursor = 0;
  const gradeOne = async (scenario) => {
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
        outputTokens: observation.metrics?.outputTokens ?? null,
        // Full per-attempt request metrics (wall time, token counts) so latency can be reported honestly.
        metrics: observation.metrics ? structuredClone(observation.metrics) : null
      });
      if (verification.passed) break;
      previous = { answerText, failures: verification.failures };
    }
    const final = attempts.at(-1).verification;
    return {
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
  };
  const lanes = Array.from({ length: Math.min(concurrency, scenarios.length) }, async () => {
    while (!signal?.aborted) {
      const position = cursor;
      cursor += 1;
      if (position >= scenarios.length) return;
      const scenario = scenarios[position];
      const run = await gradeOne(scenario);
      runs[position] = run;
      if (typeof onScenario === "function") await onScenario(run, scenario);
    }
  });
  await Promise.all(lanes);
  return runs;
}

function buildGradingReport({ worker, runs, startedAt, finishedAt, repairAttempts, maxOutputTokens, concurrency, aborted, armOrder }) {
  const graded = runs.filter(Boolean);
  const summary = summarizeRuns(graded);
  const reportBase = {
    schema: CURRICULUM_GRADING_REPORT_SCHEMA,
    version: CURRICULUM_GRADING_VERSION,
    modelId: worker.model,
    controlId: worker.controlId ?? null,
    startedAt,
    finishedAt,
    protocol: {
      verifier: "amos-executable-contract-verifier",
      repairAttempts,
      maxOutputTokens,
      feedbackIsVerifierFailuresOnly: true,
      targetNeverShown: true
    },
    protocolConcurrency: concurrency,
    armOrder,
    pools: [...new Set(graded.map(({ pool }) => pool))].sort(),
    scenarioCount: graded.length,
    aborted,
    ...summary,
    runs: graded,
    interpretation: {
      verifiedEvaluations: graded.reduce((total, run) => total + run.calls, 0),
      holdoutEvidence: graded.some(({ pool }) => pool === "holdout"),
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

export function scenariosForGrading({ catalog, pool = "holdout", scenariosPerFamily = 8, seed = "amos-curriculum-grading-v1", families, rulebook = "explicit" }) {
  return generateCurriculumScenarios({ catalog, scenariosPerFamily, seed, pool, rulebook, ...(families ? { families } : {}) });
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
