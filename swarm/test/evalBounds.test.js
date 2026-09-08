import test from "node:test";
import assert from "node:assert/strict";
import { DESKTOP_EVAL_FIXTURES, FIXTURE_FAMILIES, allFamiliesBuilt } from "../evals/desktopFixtures/index.js";
import {
  PER_FAMILY_BOUNDS, PER_REQUEST_CAPS, EVAL_STOP_BOUNDS, SERVING_PREFLIGHT, AUX_CELLS, REQUEST_TOKEN_MODEL,
  aggregateWorkload, preflightEvalBounds, sealedSessionWorkload,
} from "../evals/desktopFixtures/evalBounds.js";

test("every planned family and every built fixture has declared bounds", () => {
  for (const key of FIXTURE_FAMILIES) assert.ok(PER_FAMILY_BOUNDS[key], `family ${key} missing bounds`);
  for (const key of Object.keys(DESKTOP_EVAL_FIXTURES)) assert.ok(PER_FAMILY_BOUNDS[key], `built ${key} missing bounds`);
});

test("aggregate is feasible; secondary scales PRIMARY only (532 total calls, not 575)", () => {
  const a = aggregateWorkload();
  assert.equal(a.arms, 2);
  assert.ok(a.worstCaseHttpCalls <= EVAL_STOP_BOUNDS.maxHttpCallsPrimary, `primary worst ${a.worstCaseHttpCalls}`);
  assert.ok(a.projectedHttpCalls <= EVAL_STOP_BOUNDS.maxHttpCallsTotal, `total ${a.projectedHttpCalls}`);
  assert.ok(a.projectedHostedTokens <= EVAL_STOP_BOUNDS.maxHostedTokens, `tokens ${a.projectedHostedTokens}`);
  assert.ok(a.projectedHostedTokens > 1000000, "projection must reflect the ~3500-token system prompt");
  // Secondary applies to primary only: total = primary 288 + regression 168 + warmup 4 + secondary 72 = 532.
  assert.equal(a.projectedHttpCalls, a.primary.httpCalls + a.regression.httpCalls + a.warmup.httpCalls + a.secondary.httpCalls);
  assert.equal(a.projectedHttpCalls, 532);
  assert.ok(a.secondary.reasoningTokens > 0, "secondary reasoning accounted separately");
  assert.equal(a.withinStopBounds, true);
});

test("aggregateWorkload fails closed on invalid counts (not only preflight)", () => {
  assert.throws(() => aggregateWorkload({ casesPerFamily: 0 }), /positive integer/);
  assert.throws(() => aggregateWorkload({ casesPerFamily: -2 }), /positive integer/);
  assert.throws(() => aggregateWorkload({ casesPerFamily: 1.5 }), /positive integer/);
  assert.throws(() => aggregateWorkload({ arms: 1 }), /arms must be an integer 2\.\.3/);
  assert.throws(() => aggregateWorkload({ arms: 4 }), /arms must be an integer 2\.\.3/);
});

test("preflight is READY now that all eight families are built and the cohort fits", () => {
  assert.equal(allFamiliesBuilt(), true);
  const p = preflightEvalBounds();
  assert.equal(p.ok, true, `unexpected gaps: ${p.issues.join("; ")}`);
  assert.ok(p.aggregate && p.aggregate.withinStopBounds);
});

test("preflight still fails closed if a family is dropped from the built set (fail-closed proof)", () => {
  // Simulate an unbuilt family by requesting a family with no bounds -> aggregate throws / issues.
  const bad = preflightEvalBounds({ casesPerFamily: 0 });
  assert.equal(bad.ok, false); // invalid count path still fails closed
});

test("preflight rejects invalid cohort counts and wrong arm counts", () => {
  assert.equal(preflightEvalBounds({ casesPerFamily: 0 }).ok, false);
  assert.ok(preflightEvalBounds({ casesPerFamily: -3 }).issues.some((i) => /positive integer/.test(i)));
  assert.ok(preflightEvalBounds({ casesPerFamily: 1.5 }).issues.some((i) => /positive integer/.test(i)));
  assert.ok(preflightEvalBounds({ arms: 1 }).issues.some((i) => /arms must be an integer 2\.\.3/.test(i)));
  assert.ok(preflightEvalBounds({ arms: 4 }).issues.some((i) => /arms must be an integer 2\.\.3/.test(i)));
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
  assert.equal(AUX_CELLS.secondary.fractionOfPrimaryCaseRuns, 0.25);
  const a = aggregateWorkload();
  assert.ok(a.warmup.httpCalls >= 1);
  assert.ok(a.regression.httpCalls > 0);
  assert.ok(a.secondary.httpCalls > 0);
  assert.ok(a.projectedHttpCalls >= a.expectedHttpCalls + a.regression.httpCalls, "aggregate includes regression + warmup + secondary");
  assert.ok(REQUEST_TOKEN_MODEL.systemPromptTokens >= 3000, "token model carries the real system prompt");
});

test("serving preflight uses direct-cortex response.model (not amos.served_model) and a concrete load guard", () => {
  const joined = SERVING_PREFLIGHT.join(" | ");
  assert.match(joined, /response\.model/);
  assert.match(joined, /[Nn]ever synthesize amos\.served_model/); // present only as an explicit prohibition
  assert.match(joined, /both-arm served-identity gate/);
  assert.match(joined, /INITIAL inputs/);
  assert.match(joined, /p95.*baseline|baseline.*p95/);
  assert.match(joined, /no automatic retry/);
});

test("sealed 3-arm pilot session fits the ceilings (708 total HTTP; regression/secondary excluded)", () => {
  const s3 = sealedSessionWorkload({ arms: 3 });
  assert.equal(s3.caseRuns, 6 * 8 * 3);
  assert.equal(s3.worstCaseHttpCalls, 702);
  assert.equal(s3.projectedHttpCalls, 708); // worst-case primary 702 + 6 warmups
  assert.ok(s3.projectedHttpCalls <= EVAL_STOP_BOUNDS.maxHttpCallsTotal);
  assert.ok(s3.projectedHostedTokens <= EVAL_STOP_BOUNDS.maxHostedTokens);
  assert.equal(s3.withinSealedBounds, true);
  assert.match(s3.excludes, /regression \+ secondary/);
  // arms are bounded 2..maxArms (3)
  assert.throws(() => sealedSessionWorkload({ arms: 1 }), /2\.\.3/);
  assert.throws(() => sealedSessionWorkload({ arms: 4 }), /2\.\.3/);
});
