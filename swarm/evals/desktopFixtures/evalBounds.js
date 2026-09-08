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
  systemPromptTokens: 4300,            // system + 3 injected conversation/scratchpad tools
  fixtureAndSchemaTokens: 600,          // per-request fixture prompt + fixture tool schemas; measured full initial 4782-4933 tok (Codex compiled-input-manifest 20260908T031940Z, ~4900)
  avgHistoryTokensPerPriorCall: 250,   // accumulated tool results + prior turns
  avgOutputTokensPerCall: 160,
  note: "measured initial 4782-4933 tok/request from Codex compiled Desktop inputs (031940Z); chars/4-scale estimate; RECONCILE with actual usage: every hosted call writes a provider_usage_events row (sku + metadata.model_id/input_tokens/output_tokens, per Platform 20260908T020000Z), so per-case cost is MEASURED from a pilot case rather than this estimate; the controller also re-measures direct-cortex requests with the pinned tokenizer at preflight (system prompt + schemas + growing history)",
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
  maxHostedTokens: 3500000,        // headroom over ~2.9M projected with the measured initial footprint (estimate; re-measured with the pinned tokenizer at preflight)
  autoRetryAfterFailedRun: false,
  arms: ["amos-qwen38-27b-fp8", "stage1-060408-r32-s5"], // dev 2-arm default (base vs S5)
  maxArms: 3, // the targeted-pilot fresh comparison adds a 3rd arm (base, S5, pilot) per Codex 20260908T075808Z
  casesPerFamilyDefault: 6, // 6 x 8 families = 48 distinct seeded cases; worst-case HTTP calls fit 600
});

// Cells beyond the primary, declared separately and included in the aggregate.
export const AUX_CELLS = Object.freeze({
  warmup: { callsPerArm: 2, note: "16-token thinking-off served-identity warm-up per arm before scoring" },
  regression: { cases: 28, arms: 2, expectedCallsPerCase: 3, note: "versioned live-review regression cohort; sealedHoldout false, missionComparisonEligible false, NEVER the gate" },
  // Secondary applies ONLY to a fraction of the PRIMARY case-runs (not regression/warmup). Its
  // reasoning allowance (<= boundedThinking) is accounted separately (Codex 20260908T023953Z).
  secondary: { fractionOfPrimaryCaseRuns: 0.25, note: "bounded-thinking config (reasoning <= 1024) re-run on a declared subset of PRIMARY cases; reported, not gated" },
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
  // Fail-closed at this level too: aggregateWorkload rejects invalid counts even without preflight.
  if (!Number.isSafeInteger(casesPerFamily) || casesPerFamily < 1) throw new Error(`casesPerFamily must be a positive integer, got ${casesPerFamily}`);
  if (!Number.isSafeInteger(arms) || arms < 2 || arms > EVAL_STOP_BOUNDS.maxArms) throw new Error(`arms must be an integer 2..${EVAL_STOP_BOUNDS.maxArms}, got ${arms}`);
  let expectedHttpCalls = 0;
  let worstCaseHttpCalls = 0;
  let primaryInputTokens = 0;
  let primaryOutputTokens = 0;
  for (const key of families) {
    const b = PER_FAMILY_BOUNDS[key];
    if (!b) throw new Error(`no bounds declared for family ${key}`);
    const perFamilyCaseRuns = casesPerFamily * arms;
    expectedHttpCalls += b.expectedHttpCallsPerCase * perFamilyCaseRuns;
    worstCaseHttpCalls += b.maxHttpCallsPerCase * perFamilyCaseRuns;
    primaryInputTokens += expectedInputTokensForCase(b.expectedHttpCallsPerCase) * perFamilyCaseRuns;
    primaryOutputTokens += REQUEST_TOKEN_MODEL.avgOutputTokensPerCall * b.expectedHttpCallsPerCase * perFamilyCaseRuns;
  }
  const primaryCaseRuns = families.length * casesPerFamily * arms;
  const primaryTokens = primaryInputTokens + primaryOutputTokens;

  // Warmup cells (tiny; system prompt + 16 tokens per call).
  const warmupCalls = AUX_CELLS.warmup.callsPerArm * arms;
  const warmupTokens = warmupCalls * (REQUEST_TOKEN_MODEL.systemPromptTokens + 16);

  // Regression cohort (fixed 28 x 2), NOT scaled by the secondary factor.
  const regressionCaseRuns = AUX_CELLS.regression.cases * AUX_CELLS.regression.arms;
  const regressionCalls = AUX_CELLS.regression.expectedCallsPerCase * regressionCaseRuns;
  const regressionTokens = (expectedInputTokensForCase(AUX_CELLS.regression.expectedCallsPerCase)
    + REQUEST_TOKEN_MODEL.avgOutputTokensPerCall * AUX_CELLS.regression.expectedCallsPerCase) * regressionCaseRuns;

  // Secondary cells: a fraction of PRIMARY case-runs only, with a separate reasoning allowance.
  const avgCallsPerPrimaryCaseRun = primaryCaseRuns ? expectedHttpCalls / primaryCaseRuns : 0;
  const secondaryCaseRuns = Math.round(AUX_CELLS.secondary.fractionOfPrimaryCaseRuns * primaryCaseRuns);
  const secondaryCalls = Math.round(secondaryCaseRuns * avgCallsPerPrimaryCaseRun);
  const perPrimaryCaseRunTokens = primaryCaseRuns ? primaryTokens / primaryCaseRuns : 0;
  const secondaryReasoningTokens = secondaryCalls * PER_REQUEST_CAPS.maxReasoningTokensPerRequest.boundedThinking;
  const secondaryTokens = Math.round(secondaryCaseRuns * perPrimaryCaseRunTokens) + secondaryReasoningTokens;

  const projectedHttpCalls = expectedHttpCalls + regressionCalls + warmupCalls + secondaryCalls;
  const projectedHostedTokens = Math.ceil(primaryTokens + regressionTokens + warmupTokens + secondaryTokens);
  return Object.freeze({
    casesPerFamily, families: families.length, arms, caseRuns: primaryCaseRuns,
    expectedHttpCalls, worstCaseHttpCalls,
    primary: { caseRuns: primaryCaseRuns, httpCalls: expectedHttpCalls, hostedTokens: primaryTokens },
    warmup: { httpCalls: warmupCalls, hostedTokens: warmupTokens },
    regression: { caseRuns: regressionCaseRuns, httpCalls: regressionCalls, hostedTokens: regressionTokens },
    secondary: { caseRuns: secondaryCaseRuns, httpCalls: secondaryCalls, reasoningTokens: secondaryReasoningTokens, hostedTokens: secondaryTokens },
    projectedHttpCalls, projectedHostedTokens,
    tokenModel: REQUEST_TOKEN_MODEL.note,
    withinStopBounds: worstCaseHttpCalls <= EVAL_STOP_BOUNDS.maxHttpCallsPrimary
      && projectedHttpCalls <= EVAL_STOP_BOUNDS.maxHttpCallsTotal
      && projectedHostedTokens <= EVAL_STOP_BOUNDS.maxHostedTokens,
  });
}

/**
 * The FRESH sealed comparison session (Codex 20260908T075808Z): primary + warmup cells ONLY, with
 * the large optional regression/secondary cells EXCLUDED from this sealed run and counted
 * separately. Supports the 3-arm pilot (base, S5, candidate). Development/settings traffic is
 * counted against the same 12h/$50 pilot envelope, not here.
 */
export function sealedSessionWorkload({ casesPerFamily = EVAL_STOP_BOUNDS.casesPerFamilyDefault, families = FIXTURE_FAMILIES, arms = EVAL_STOP_BOUNDS.maxArms } = {}) {
  if (!Number.isSafeInteger(casesPerFamily) || casesPerFamily < 1) throw new Error(`casesPerFamily must be a positive integer, got ${casesPerFamily}`);
  if (!Number.isSafeInteger(arms) || arms < 2 || arms > EVAL_STOP_BOUNDS.maxArms) throw new Error(`arms must be an integer 2..${EVAL_STOP_BOUNDS.maxArms}, got ${arms}`);
  let expectedHttpCalls = 0, worstCaseHttpCalls = 0, primaryInputTokens = 0, primaryOutputTokens = 0;
  for (const key of families) {
    const b = PER_FAMILY_BOUNDS[key];
    if (!b) throw new Error(`no bounds declared for family ${key}`);
    const runs = casesPerFamily * arms;
    expectedHttpCalls += b.expectedHttpCallsPerCase * runs;
    worstCaseHttpCalls += b.maxHttpCallsPerCase * runs;
    primaryInputTokens += expectedInputTokensForCase(b.expectedHttpCallsPerCase) * runs;
    primaryOutputTokens += REQUEST_TOKEN_MODEL.avgOutputTokensPerCall * b.expectedHttpCallsPerCase * runs;
  }
  const warmupCalls = AUX_CELLS.warmup.callsPerArm * arms;
  const warmupTokens = warmupCalls * (REQUEST_TOKEN_MODEL.systemPromptTokens + 16);
  const projectedHttpCalls = worstCaseHttpCalls + warmupCalls; // sealed run counts worst-case primary + warmups
  const projectedHostedTokens = Math.ceil(primaryInputTokens + primaryOutputTokens + warmupTokens);
  return Object.freeze({
    casesPerFamily, families: families.length, arms, caseRuns: families.length * casesPerFamily * arms,
    expectedHttpCalls, worstCaseHttpCalls, warmupCalls, projectedHttpCalls, projectedHostedTokens,
    excludes: "regression + secondary cells (counted separately, not in this sealed session)",
    withinSealedBounds: projectedHttpCalls <= EVAL_STOP_BOUNDS.maxHttpCallsTotal && projectedHostedTokens <= EVAL_STOP_BOUNDS.maxHostedTokens,
  });
}

export const SERVING_PREFLIGHT = Object.freeze([
  "both-arm served-identity gate: base and S5 each serve a bounded 16-token thinking-OFF warm-up before scoring",
  "served-model identity is transport-specific (Platform 20260908T020000Z): the PRIMARY direct-cortex arms check top-level response.model (#265, AMOS metadata null); a hosted served-identity confirmation of the canary reads amos.served_model/amos.frontier_route. Never synthesize amos.served_model on the direct arm",
  "thinking OFF on both arms (enable_thinking=false, reasoning tokens 0) for the PRIMARY comparison",
  "byte-identical INITIAL inputs/config per arm except model; later transcripts may diverge legitimately with model/tool decisions and each is retained",
  "measure full compiled requests with the pinned tokenizer (system prompt + schemas + growing history) and reserve input+max output for all in-flight requests before dispatch",
  "regression cohort (28 live-review cases) run and counted SEPARATELY and in the aggregate: sealedHoldout false, missionComparisonEligible false, never the gate",
  "fresh sealed seed only after regression + preflight + preregistration; the eventual holdout stays uninspected; empty/error cases retained conservatively",
  "load guard (option A live cell): metric = primary-traffic p95 request latency over a fixed pre-run 10-min baseline window (>=200 samples); abort on p95 +20% or any 5xx; concurrency <= 2; insufficient samples => do not start",
  "no automatic retry after a failed run; cancel on any limit/load failure; never pass a partial cohort",
]);

/** Fail-closed readiness: every family BUILT with distinct seeded cases, valid counts/arms, feasible bounds. */
/** Fixture-readiness checks shared by every preflight: valid counts/arms, all families built with
 * distinct seeded cases. These are NEVER skipped by any session profile. */
function fixtureReadinessIssues({ casesPerFamily, arms }) {
  const issues = [];
  if (!Number.isSafeInteger(casesPerFamily) || casesPerFamily < 1) issues.push(`casesPerFamily must be a positive integer, got ${casesPerFamily}`);
  if (!Number.isSafeInteger(arms) || arms < 2 || arms > EVAL_STOP_BOUNDS.maxArms) issues.push(`arms must be an integer 2..${EVAL_STOP_BOUNDS.maxArms}, got ${arms}`);
  if (new Set(FIXTURE_FAMILIES).size !== FIXTURE_FAMILIES.length) issues.push("duplicate family names");
  for (const key of FIXTURE_FAMILIES) if (!PER_FAMILY_BOUNDS[key]) issues.push(`missing bounds for planned family ${key}`);
  for (const key of Object.keys(DESKTOP_EVAL_FIXTURES)) if (!PER_FAMILY_BOUNDS[key]) issues.push(`missing bounds for built fixture ${key}`);
  if (!allFamiliesBuilt()) issues.push(`not all families are built: missing ${FIXTURE_FAMILIES.filter((k) => !(k in DESKTOP_EVAL_FIXTURES)).join(", ")}`);
  if (Number.isSafeInteger(casesPerFamily) && casesPerFamily >= 1) {
    for (const key of Object.keys(DESKTOP_EVAL_FIXTURES)) {
      try { buildFamilyCohort(key, casesPerFamily); } catch (e) { issues.push(`family ${key}: ${e.message}`); }
    }
  }
  return issues;
}

/** Whole-session (development / 2-arm) preflight: fixture readiness + the full aggregate stop bounds. */
export function preflightEvalBounds({ casesPerFamily = EVAL_STOP_BOUNDS.casesPerFamilyDefault, arms = EVAL_STOP_BOUNDS.arms.length } = {}) {
  const issues = fixtureReadinessIssues({ casesPerFamily, arms });
  let aggregate = null;
  if (issues.length === 0) {
    aggregate = aggregateWorkload({ casesPerFamily, arms });
    if (!aggregate.withinStopBounds) issues.push(`aggregate exceeds stop bounds: httpCalls ${aggregate.projectedHttpCalls}/${aggregate.worstCaseHttpCalls}, tokens ${aggregate.projectedHostedTokens}`);
  }
  return { ok: issues.length === 0, issues, aggregate };
}

/**
 * Sealed 3-arm fresh-comparison preflight (Codex 20260908T085713Z): the SAME fixture-readiness
 * checks (family/completeness/distinct-case) plus the sealed-session workload (primary + warmup
 * only) against the 900 aggregate cap. Not a substitute for fixture readiness; never disables
 * validation to pass. Use this — not sealedSessionWorkload.withinSealedBounds alone — to gate the
 * sealed run. Expected token totals are estimates; the run-time pinned counter enforces per body.
 */
export function sealedSessionPreflight({ casesPerFamily = EVAL_STOP_BOUNDS.casesPerFamilyDefault, arms = EVAL_STOP_BOUNDS.maxArms } = {}) {
  const issues = fixtureReadinessIssues({ casesPerFamily, arms });
  let sealed = null;
  if (issues.length === 0) {
    sealed = sealedSessionWorkload({ casesPerFamily, arms });
    if (!sealed.withinSealedBounds) issues.push(`sealed session exceeds stop bounds: httpCalls ${sealed.projectedHttpCalls} (cap ${EVAL_STOP_BOUNDS.maxHttpCallsTotal}), tokens ${sealed.projectedHostedTokens} (cap ${EVAL_STOP_BOUNDS.maxHostedTokens})`);
  }
  return { ok: issues.length === 0, issues, sealed };
}
