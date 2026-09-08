import { DESKTOP_EVAL_FIXTURES, buildFixture, FIXTURE_FAMILIES } from "./index.js";

// Organism-owned workload / cost / stop bounds and serving preflight for the next
// representative S5 evaluation (base vs S5, thinking OFF, through the corrected Desktop
// AgentLoop). Two kinds of numbers are kept distinct:
//   - HARD per-case guards (maxToolCalls, maxHttpCallsPerCase, maxOutputTokensPerRequest,
//     the global maxInputTokensPerRequest): the controller aborts a case that exceeds them.
//   - EXPECTED per-case footprint (expectedHttpCallsPerCase): the planning number for the
//     aggregate budget. Hosted-token TOTAL is not multiplied out from per-request maxima
//     (that overshoots); it is bounded by the hard EVAL_STOP_BOUNDS.maxHostedTokens abort and
//     estimated at preflight from the measured Desktop system-prompt footprint.
// The default cohort is sized so even the worst-case HTTP-call count fits the preregistered
// call ceiling. See coordination/artifacts/next-representative-eval-plan-20260907.md.

export function estimateTokens(text) { return Math.ceil(String(text ?? "").length / 4); }

/** Estimated per-request INPUT footprint of a fixture itself (prompt + tool-schema manifest); excludes the Desktop system prompt, which is measured at preflight. */
export function estimateFixtureInputTokens(fixture) {
  const toolSchema = JSON.stringify(fixture.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })));
  return estimateTokens(fixture.fixture.prompt) + estimateTokens(toolSchema);
}

// maxHttpCallsPerCase = initial turn + up to maxToolCalls tool round-trips + final answer turn.
// expectedHttpCallsPerCase is the typical resolved path used for the aggregate plan.
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

/** Global per-request hard caps (both arms), independent of family. */
export const PER_REQUEST_CAPS = Object.freeze({ maxInputTokensPerRequest: 8192, maxReasoningTokensPerRequest: { primary: 0, boundedThinking: 1024 } });

/** Preregistered aggregate stop bounds (both arms combined). */
export const EVAL_STOP_BOUNDS = Object.freeze({
  maxHttpCallsPrimary: 600,
  wallCeilingSeconds: 3600,
  maxConcurrency: 2,
  maxHostedTokens: 400000,
  autoRetryAfterFailedRun: false,
  arms: ["amos-qwen38-27b-fp8", "stage1-060408-r32-s5"],
  casesPerFamilyDefault: 6, // 6 x 8 families = 48 sealed cases; worst-case HTTP calls fit the 600 ceiling
});

/**
 * Aggregate the planned cohort. Returns expected and worst-case HTTP-call counts and the
 * output-token ceiling; the hosted-token total is bounded by EVAL_STOP_BOUNDS.maxHostedTokens
 * (hard abort) and measured at preflight. withinStopBounds requires BOTH the worst-case call
 * count and the expected calls to fit the preregistered ceiling.
 */
export function aggregateWorkload({ casesPerFamily = EVAL_STOP_BOUNDS.casesPerFamilyDefault, families = FIXTURE_FAMILIES, arms = EVAL_STOP_BOUNDS.arms.length } = {}) {
  let expectedHttpCalls = 0;
  let worstCaseHttpCalls = 0;
  let maxOutputTokens = 0;
  for (const key of families) {
    const b = PER_FAMILY_BOUNDS[key];
    if (!b) throw new Error(`no bounds declared for family ${key}`);
    expectedHttpCalls += b.expectedHttpCallsPerCase * casesPerFamily * arms;
    worstCaseHttpCalls += b.maxHttpCallsPerCase * casesPerFamily * arms;
    maxOutputTokens += b.maxOutputTokensPerRequest * b.maxHttpCallsPerCase * casesPerFamily * arms;
  }
  return Object.freeze({
    casesPerFamily, families: families.length, arms, caseRuns: families.length * casesPerFamily * arms,
    expectedHttpCalls, worstCaseHttpCalls, maxOutputTokens,
    hostedTokenTotal: "bounded by EVAL_STOP_BOUNDS.maxHostedTokens; measured at preflight from the Desktop system-prompt footprint",
    withinStopBounds: worstCaseHttpCalls <= EVAL_STOP_BOUNDS.maxHttpCallsPrimary && expectedHttpCalls <= EVAL_STOP_BOUNDS.maxHttpCallsPrimary,
  });
}

/** Serving preflight the controller runs before any scored generation. All must pass to dispatch. */
export const SERVING_PREFLIGHT = Object.freeze([
  "both-arm served-identity gate: base and S5 each serve a bounded 16-token thinking-OFF warm-up before scoring",
  "served_model check: response amos.served_model equals the arm under test (amos-qwen38-27b-fp8 vs stage1-060408-r32-s5)",
  "thinking OFF on both arms (enable_thinking=false, reasoning tokens 0) for the PRIMARY comparison",
  "direct-cortex transport, byte-identical bodies per arm except model; identity bound via missionComparisonProtocol",
  "measure the Desktop system-prompt token footprint and confirm the projected hosted-token total <= maxHostedTokens",
  "regression cohort (28 live-review cases) kept separate: sealedHoldout false, missionComparisonEligible false, never the gate",
  "fresh sealed seed only after regression + preflight + preregistration; empty/error cases retained",
  "load guard (option A live cell): abort on primary-traffic p95 +20% or any 5xx; concurrency <= 2",
  "no automatic retry after a failed run; stop at the preregistered HTTP/token/wall ceilings",
]);

/** Every declared family has bounds, and the planned cohort fits the preregistered stop bounds. */
export function preflightEvalBounds({ casesPerFamily } = {}) {
  const issues = [];
  for (const key of Object.keys(DESKTOP_EVAL_FIXTURES)) {
    if (!PER_FAMILY_BOUNDS[key]) issues.push(`missing bounds for built fixture ${key}`);
  }
  for (const key of FIXTURE_FAMILIES) {
    if (!PER_FAMILY_BOUNDS[key]) issues.push(`missing bounds for planned family ${key}`);
  }
  const agg = aggregateWorkload(casesPerFamily ? { casesPerFamily } : {});
  if (!agg.withinStopBounds) issues.push(`aggregate exceeds stop bounds: worstCaseHttpCalls ${agg.worstCaseHttpCalls} > ${EVAL_STOP_BOUNDS.maxHttpCallsPrimary}`);
  return { ok: issues.length === 0, issues, aggregate: agg };
}
