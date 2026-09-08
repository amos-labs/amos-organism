import test from "node:test";
import assert from "node:assert/strict";
import { DESKTOP_EVAL_FIXTURES, FIXTURE_FAMILIES, allFamiliesBuilt } from "../evals/desktopFixtures/index.js";
import {
  PER_FAMILY_BOUNDS, PER_REQUEST_CAPS, EVAL_STOP_BOUNDS, SERVING_PREFLIGHT, AUX_CELLS, REQUEST_TOKEN_MODEL,
  aggregateWorkload, preflightEvalBounds,
} from "../evals/desktopFixtures/evalBounds.js";

test("every planned family and every built fixture has declared bounds", () => {
  for (const key of FIXTURE_FAMILIES) assert.ok(PER_FAMILY_BOUNDS[key], `family ${key} missing bounds`);
  for (const key of Object.keys(DESKTOP_EVAL_FIXTURES)) assert.ok(PER_FAMILY_BOUNDS[key], `built ${key} missing bounds`);
});

test("aggregate is feasible: primary worst-case, total projected calls and hosted tokens fit the ceilings", () => {
  const a = aggregateWorkload();
  assert.equal(a.arms, 2);
  assert.ok(a.worstCaseHttpCalls <= EVAL_STOP_BOUNDS.maxHttpCallsPrimary, `primary worst ${a.worstCaseHttpCalls}`);
  assert.ok(a.projectedHttpCalls <= EVAL_STOP_BOUNDS.maxHttpCallsTotal, `total ${a.projectedHttpCalls}`);
  assert.ok(a.projectedHostedTokens <= EVAL_STOP_BOUNDS.maxHostedTokens, `tokens ${a.projectedHostedTokens}`);
  // Token projection must include the real Desktop system prompt (feasibility, not the old 400k).
  assert.ok(a.projectedHostedTokens > 1000000, "projection must reflect the ~3500-token system prompt");
  assert.equal(a.withinStopBounds, true);
});

test("preflight FAILS CLOSED while families are unbuilt (constrained-planning/async-code/governed-context-dependent-state)", () => {
  assert.equal(allFamiliesBuilt(), false);
  const p = preflightEvalBounds();
  assert.equal(p.ok, false);
  assert.ok(p.issues.some((i) => /not all families are built/.test(i)));
});

test("preflight rejects invalid cohort counts and wrong arm counts", () => {
  assert.equal(preflightEvalBounds({ casesPerFamily: 0 }).ok, false);
  assert.ok(preflightEvalBounds({ casesPerFamily: -3 }).issues.some((i) => /positive integer/.test(i)));
  assert.ok(preflightEvalBounds({ casesPerFamily: 1.5 }).issues.some((i) => /positive integer/.test(i)));
  assert.ok(preflightEvalBounds({ arms: 1 }).issues.some((i) => /arms must be exactly 2/.test(i)));
});

test("primary reasoning is zero (thinking off), retries disabled, arms are base vs S5", () => {
  assert.equal(PER_REQUEST_CAPS.maxReasoningTokensPerRequest.primary, 0);
  assert.equal(EVAL_STOP_BOUNDS.autoRetryAfterFailedRun, false);
  assert.equal(EVAL_STOP_BOUNDS.maxConcurrency, 2);
  assert.deepEqual(EVAL_STOP_BOUNDS.arms, ["amos-qwen38-27b-fp8", "stage1-060408-r32-s5"]);
});

test("warmup/regression/secondary cells are declared separately and folded into the aggregate", () => {
  assert.ok(AUX_CELLS.warmup.callsPerArm >= 1);
  assert.equal(AUX_CELLS.regression.cases, 28);
  const a = aggregateWorkload();
  assert.ok(a.warmupCalls >= 1);
  assert.ok(a.regression.httpCalls > 0);
  assert.ok(a.projectedHttpCalls >= a.expectedHttpCalls + a.regression.httpCalls, "aggregate includes regression + warmup");
  assert.ok(REQUEST_TOKEN_MODEL.systemPromptTokens >= 3000, "token model carries the real system prompt");
});

test("serving preflight uses direct-cortex response.model (not amos.served_model) and a concrete load guard", () => {
  const joined = SERVING_PREFLIGHT.join(" | ");
  assert.match(joined, /response\.model/);
  assert.match(joined, /never synthesize amos\.served_model/); // present only as an explicit prohibition
  assert.match(joined, /both-arm served-identity gate/);
  assert.match(joined, /INITIAL inputs/);
  assert.match(joined, /p95.*baseline|baseline.*p95/);
  assert.match(joined, /no automatic retry/);
});
