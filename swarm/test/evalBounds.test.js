import test from "node:test";
import assert from "node:assert/strict";
import { DESKTOP_EVAL_FIXTURES, buildFixture, FIXTURE_FAMILIES } from "../evals/desktopFixtures/index.js";
import {
  PER_FAMILY_BOUNDS, PER_REQUEST_CAPS, EVAL_STOP_BOUNDS, SERVING_PREFLIGHT,
  aggregateWorkload, preflightEvalBounds, estimateFixtureInputTokens,
} from "../evals/desktopFixtures/evalBounds.js";

test("every planned family and every built fixture has declared bounds", () => {
  for (const key of FIXTURE_FAMILIES) assert.ok(PER_FAMILY_BOUNDS[key], `family ${key} missing bounds`);
  for (const key of Object.keys(DESKTOP_EVAL_FIXTURES)) assert.ok(PER_FAMILY_BOUNDS[key], `built ${key} missing bounds`);
});

test("the default cohort fits the preregistered stop bounds, worst-case included", () => {
  const agg = aggregateWorkload();
  assert.equal(agg.arms, 2);
  assert.ok(agg.expectedHttpCalls <= agg.worstCaseHttpCalls);
  assert.ok(agg.worstCaseHttpCalls <= EVAL_STOP_BOUNDS.maxHttpCallsPrimary, `worst-case ${agg.worstCaseHttpCalls} must fit ${EVAL_STOP_BOUNDS.maxHttpCallsPrimary}`);
  assert.ok(agg.maxOutputTokens <= EVAL_STOP_BOUNDS.maxHostedTokens);
  assert.equal(agg.withinStopBounds, true);
  assert.equal(preflightEvalBounds().ok, true);
});

test("primary reasoning tokens are zero (thinking off) and retries are disabled", () => {
  assert.equal(PER_REQUEST_CAPS.maxReasoningTokensPerRequest.primary, 0);
  assert.equal(EVAL_STOP_BOUNDS.autoRetryAfterFailedRun, false);
  assert.equal(EVAL_STOP_BOUNDS.maxConcurrency, 2);
});

test("each built fixture's own input footprint is small and within the per-request cap", () => {
  for (const key of Object.keys(DESKTOP_EVAL_FIXTURES)) {
    const est = estimateFixtureInputTokens(buildFixture(key));
    assert.ok(est > 0 && est < PER_REQUEST_CAPS.maxInputTokensPerRequest, `${key} input ${est}`);
  }
});

test("a cohort too large to fit the call ceiling is rejected by preflight", () => {
  const bad = preflightEvalBounds({ casesPerFamily: 40 });
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.some((i) => /exceeds stop bounds/.test(i)));
});

test("the serving preflight names the both-arm gate, served_model check and load guard", () => {
  const joined = SERVING_PREFLIGHT.join(" | ");
  assert.match(joined, /both-arm served-identity gate/);
  assert.match(joined, /served_model check/);
  assert.match(joined, /load guard/);
  assert.match(joined, /no automatic retry/);
});
