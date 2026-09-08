import { DESKTOP_EVAL_FIXTURES, buildFixture, buildFamilyCohort, allFamiliesBuilt, FIXTURE_FAMILIES } from "./index.js";

// Organism-owned workload / cost / stop bounds and serving preflight for the next
// representative S5 evaluation (base vs S5, thinking OFF, through the corrected Desktop
// AgentLoop / direct-cortex #265). Corrected per Codex 20260908T014430Z review:
//  - fail-closed readiness (all families BUILT with distinct seeded cases, valid counts/arms),
//  - a feasible compiled-request token model that includes the real Desktop system prompt,
//  - served identity via top-level response.model (direct-cortex #265), not amos.served_model,
//  - warmup / regression / secondary cells declared separately AND in the aggregate.
// These remain a PROPOSAL. evalBounds declares the bounds; Codex's controller/runner enforces
// them (reserving input+output before dispatch, cancelling on limit/load). No run is authorized.

export function estimateTokens(text) { return Math.ceil(String(text ?? "").length / 4); }

export function estimateFixtureInputTokens(fixture) {
  const toolSchema = JSON.stringify(fixture.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })));
  return estimateTokens(fixture.fixture.prompt) + estimateTokens(toolSchema);
}

// Compiled-request token model. An ESTIMATE (chars/4-scale); the controller re-measures with the
// pinned Qwen tokenizer at preflight over full compiled requests, including growing history.
export const REQUEST_TOKEN_MODEL = Object.freeze({
  systemPromptTokens: 3500,            // measured ~14000 chars at Desktop 8ba4801c (Codex 014430Z)
  fixtureAndSchemaTokens: 400,         // per-request fixture prompt + tool-schema manifest
  avgHistoryTokensPerPriorCall: 250,   // accumulated tool results + prior turns
  avgOutputTokensPerCall: 160,
  note: "chars/4-scale estimate; controller re-measures with the pinned tokenizer at preflight, full compiled requests + growing history",
});

// maxHttpCallsPerCase = initial turn + up to maxToolCalls tool round-trips + final answer turn.
export const PER_FAMILY_BOUNDS = Object.freeze({
  "numeric-reconciliation": { maxToolCalls: 3, maxHttpCallsPerCase: 5, expectedHttpCallsPerCase: 3, maxOutputTokensPerRequest: 256 },
  "constrained-planning": { maxToolCalls: 4, maxHttpCallsPerCase: 6, expectedHttpCallsPerCase: 4, maxOutputTokensPerRequest: 256 },
  "async-code": { maxToolCalls: 4, maxHttpCallsPerCase: 6, expectedHttpCallsPerCase: 4, maxOutputTokensPerRequest: 512 },
  "date-time": { maxToolCalls: 2, maxHttpCallsPerCase: 4, expectedHttpCallsPerCase: 2, maxOutputTokensPerRequest: 128 },
  "tenant-bound-reporting": { maxToolCalls: 2, maxHttpCallsPerCase: 4, expectedHttpCallsPerCase: 2, maxOutputTokensPerRequest: 128 },
  "governed-context-dependent-state": { maxToolCalls: 4, maxHttpCallsPerCase: 6, expectedHttpCallsPerCase: 4, maxOutputTokensPerRequest: 256 },
  "recover-without-replaying-completed-actions": { maxToolCalls: 3, maxHttpCallsPerCase: 5, expectedHttpCallsPerCase: 3, maxOutputTokensPerRequest: 256 },
  "reuse-first-tool-selection": { maxToolCalls: 1, maxHttpCallsPerCase: 3, expectedHttpCallsPerCase: 2, maxOutputTokensPerRequest: 128 },
});

export const PER_REQUEST_CAPS = Object.freeze({ maxInputTokensPerRequest: 8192, maxReasoningTokensPerRequest: { primary: 0, boundedThinking: 1024 } });

export const EVAL_STOP_BOUNDS = Object.freeze({
  maxHttpCallsPrimary: 600,        // primary cohort worst-case ceiling
  maxHttpCallsTotal: 900,          // incl. warmup + regression + secondary cells
  wallCeilingSeconds: 3600,
  maxConcurrency: 2,
  maxHostedTokens: 3000000,        // feasible: ~2.5M projected primary+aux with headroom (estimate; re-measured at preflight)
  autoRetryAfterFailedRun: false,
  arms: ["amos-qwen38-27b-fp8", "stage1-060408-r32-s5"],
  casesPerFamilyDefault: 6, // 6 x 8 families = 48 distinct seeded cases; worst-case HTTP calls fit 600
});

// Cells beyond the primary, declared separately and included in the aggregate.
export const AUX_CELLS = Object.freeze({
  warmup: { callsPerArm: 2, note: "16-token thinking-off served-identity warm-up per arm before scoring" },
  regression: { cases: 28, arms: 2, note: "versioned live-review regression cohort; sealedHoldout false, missionComparisonEligible false, NEVER the gate" },
  secondary: { fractionOfPrimaryCases: 0.25, note: "bounded-thinking config (reasoning <= 1024) on a declared subset; reported, not gated" },
});

// Expected input tokens for one case with c expected calls: each call carries system+fixture
// overhead, and history grows by ~avgHistory per prior call.
function expectedInputTokensForCase(expectedCalls) {
  const m = REQUEST_TOKEN_MODEL;
  const perCall = m.systemPromptTokens + m.fixtureAndSchemaTokens;
  const history = (expectedCalls * (expectedCalls - 1) / 2) * m.avgHistoryTokensPerPriorCall;
  return expectedCalls * perCall + history;
}

/** Aggregate the planned cohort plus warmup/regression/secondary, with a feasible token projection. */
export function aggregateWorkload({ casesPerFamily = EVAL_STOP_BOUNDS.casesPerFamilyDefault, families = FIXTURE_FAMILIES, arms = EVAL_STOP_BOUNDS.arms.length } = {}) {
  let expectedHttpCalls = 0;
  let worstCaseHttpCalls = 0;
  let projectedInputTokens = 0;
  let projectedOutputTokens = 0;
  for (const key of families) {
    const b = PER_FAMILY_BOUNDS[key];
    if (!b) throw new Error(`no bounds declared for family ${key}`);
    const perFamilyCaseRuns = casesPerFamily * arms;
    expectedHttpCalls += b.expectedHttpCallsPerCase * perFamilyCaseRuns;
    worstCaseHttpCalls += b.maxHttpCallsPerCase * perFamilyCaseRuns;
    projectedInputTokens += expectedInputTokensForCase(b.expectedHttpCallsPerCase) * perFamilyCaseRuns;
    projectedOutputTokens += REQUEST_TOKEN_MODEL.avgOutputTokensPerCall * b.expectedHttpCallsPerCase * perFamilyCaseRuns;
  }
  // Warmup + regression cells (regression uses the same per-request model, avg 3 calls/case).
  const warmupCalls = AUX_CELLS.warmup.callsPerArm * arms;
  const regressionCaseRuns = AUX_CELLS.regression.cases * AUX_CELLS.regression.arms;
  const regressionCalls = 3 * regressionCaseRuns;
  const regressionInput = expectedInputTokensForCase(3) * regressionCaseRuns;
  const regressionOutput = REQUEST_TOKEN_MODEL.avgOutputTokensPerCall * 3 * regressionCaseRuns;
  const secondaryFactor = 1 + AUX_CELLS.secondary.fractionOfPrimaryCases;
  const primaryTokens = projectedInputTokens + projectedOutputTokens;
  const projectedHostedTokens = Math.ceil((primaryTokens + regressionInput + regressionOutput) * secondaryFactor
    + warmupCalls * (REQUEST_TOKEN_MODEL.systemPromptTokens + 16));
  const projectedHttpCalls = Math.ceil((expectedHttpCalls + regressionCalls + warmupCalls) * secondaryFactor);
  return Object.freeze({
    casesPerFamily, families: families.length, arms, caseRuns: families.length * casesPerFamily * arms,
    expectedHttpCalls, worstCaseHttpCalls, primary: { httpCalls: expectedHttpCalls, hostedTokens: primaryTokens },
    warmupCalls, regression: { caseRuns: regressionCaseRuns, httpCalls: regressionCalls, hostedTokens: regressionInput + regressionOutput },
    secondaryFactor, projectedHttpCalls, projectedHostedTokens,
    tokenModel: REQUEST_TOKEN_MODEL.note,
    withinStopBounds: worstCaseHttpCalls <= EVAL_STOP_BOUNDS.maxHttpCallsPrimary
      && projectedHttpCalls <= EVAL_STOP_BOUNDS.maxHttpCallsTotal
      && projectedHostedTokens <= EVAL_STOP_BOUNDS.maxHostedTokens,
  });
}

export const SERVING_PREFLIGHT = Object.freeze([
  "both-arm served-identity gate: base and S5 each serve a bounded 16-token thinking-OFF warm-up before scoring",
  "served-model identity: direct-cortex checks the top-level provider response.model (#265) against the pinned arm model/weight/config; AMOS routing metadata stays null (never synthesize amos.served_model)",
  "thinking OFF on both arms (enable_thinking=false, reasoning tokens 0) for the PRIMARY comparison",
  "byte-identical INITIAL inputs/config per arm except model; later transcripts may diverge legitimately with model/tool decisions and each is retained",
  "measure full compiled requests with the pinned tokenizer (system prompt + schemas + growing history) and reserve input+max output for all in-flight requests before dispatch",
  "regression cohort (28 live-review cases) run and counted SEPARATELY and in the aggregate: sealedHoldout false, missionComparisonEligible false, never the gate",
  "fresh sealed seed only after regression + preflight + preregistration; the eventual holdout stays uninspected; empty/error cases retained conservatively",
  "load guard (option A live cell): metric = primary-traffic p95 request latency over a fixed pre-run 10-min baseline window (>=200 samples); abort on p95 +20% or any 5xx; concurrency <= 2; insufficient samples => do not start",
  "no automatic retry after a failed run; cancel on any limit/load failure; never pass a partial cohort",
]);

/** Fail-closed readiness: every family BUILT with distinct seeded cases, valid counts/arms, feasible bounds. */
export function preflightEvalBounds({ casesPerFamily = EVAL_STOP_BOUNDS.casesPerFamilyDefault, arms = EVAL_STOP_BOUNDS.arms.length } = {}) {
  const issues = [];
  if (!Number.isSafeInteger(casesPerFamily) || casesPerFamily < 1) issues.push(`casesPerFamily must be a positive integer, got ${casesPerFamily}`);
  if (arms !== EVAL_STOP_BOUNDS.arms.length) issues.push(`arms must be exactly ${EVAL_STOP_BOUNDS.arms.length} (base vs S5), got ${arms}`);
  if (new Set(FIXTURE_FAMILIES).size !== FIXTURE_FAMILIES.length) issues.push("duplicate family names");
  for (const key of FIXTURE_FAMILIES) if (!PER_FAMILY_BOUNDS[key]) issues.push(`missing bounds for planned family ${key}`);
  for (const key of Object.keys(DESKTOP_EVAL_FIXTURES)) if (!PER_FAMILY_BOUNDS[key]) issues.push(`missing bounds for built fixture ${key}`);
  if (!allFamiliesBuilt()) issues.push(`not all families are built: missing ${FIXTURE_FAMILIES.filter((k) => !(k in DESKTOP_EVAL_FIXTURES)).join(", ")}`);
  // Distinct seeded cases per built family (fail if a family repeats a case id).
  if (Number.isSafeInteger(casesPerFamily) && casesPerFamily >= 1) {
    for (const key of Object.keys(DESKTOP_EVAL_FIXTURES)) {
      try { buildFamilyCohort(key, casesPerFamily); } catch (e) { issues.push(`family ${key}: ${e.message}`); }
    }
  }
  let aggregate = null;
  if (issues.length === 0) {
    aggregate = aggregateWorkload({ casesPerFamily, arms });
    if (!aggregate.withinStopBounds) issues.push(`aggregate exceeds stop bounds: httpCalls ${aggregate.projectedHttpCalls}/${aggregate.worstCaseHttpCalls}, tokens ${aggregate.projectedHostedTokens}`);
  }
  return { ok: issues.length === 0, issues, aggregate };
}
