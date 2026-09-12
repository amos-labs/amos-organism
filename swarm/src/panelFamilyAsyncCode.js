import { createHash } from "node:crypto";
import { asyncCodeFromDurations } from "../evals/desktopFixtures/asyncCode.js";
import { datasetDigest } from "../evals/desktopFixtures/_shared.js";

// A0 development-panel family 4/8: async-code. Native contract (unchanged): N tasks run
// concurrently via Promise.all, so the wall-clock time is the MAX duration (the sequential
// sum is the trap). Read the durations, report the concurrent total in ms as a bare integer.
// Fresh authored facts + pure answer oracle + createFixture binding the native execution
// surface (its private read flag, not caller input, grants a native pass). Projection emits
// the exact comparable KEY = datasetDigest({family,durations}) (decisionKey === datasetDigest
// verified for this family); no normalized signature is claimed (defined only for numeric/date).

export const FAMILY = "async-code";
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const canonical = (v) => JSON.stringify(sortKeys(v));
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}
function streamFrom(label) {
  let state = parseInt(sha256(label).slice(0, 8), 16) >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = (Math.imul(z ^ (z >>> 16), 0x21f0aaad)) >>> 0;
    z = (Math.imul(z ^ (z >>> 15), 0x735a2d97)) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  };
}

// Fresh authored durations: 3-5 tasks, each 40..999 ms, with a UNIQUE maximum so the correct
// concurrent answer is unambiguous, and a distinct sequential-sum trap.
export function generate(seed, index) {
  if (typeof seed !== "string" || !/^\d+$/.test(seed)) throw new TypeError("seed must be an all-digit string");
  if (!Number.isSafeInteger(index) || index < 0) throw new TypeError("index must be a non-negative integer");
  const next = streamFrom(`${FAMILY}:${seed}:${index}`);
  const n = 3 + (next() % 3); // 3..5
  const durations = Array.from({ length: n }, () => 40 + (next() % 700)); // 40..739
  // guarantee a strict unique maximum so expected() is unambiguous
  durations[0] = Math.max(...durations) + 100 + (next() % 160); // 140..999 above the rest
  return { family: FAMILY, index, facts: { durations } };
}

export function validateBody(body) {
  if (!body || body.family !== FAMILY || !Number.isSafeInteger(body.index) || body.index < 0 || !body.facts) throw new TypeError("async-code panel body required");
  const { durations } = body.facts;
  if (!Array.isArray(durations) || durations.length < 3 || durations.length > 5) throw new TypeError("panel requires 3..5 durations");
  for (const d of durations) if (!Number.isSafeInteger(d) || d < 40 || d > 9999) throw new TypeError("durations must be integers 40..9999 ms");
  if (durations.filter((d) => d === Math.max(...durations)).length !== 1) throw new TypeError("panel requires a unique maximum duration");
  return body;
}

// Concurrent wall time = the maximum task duration.
export function expected(body) {
  validateBody(body);
  return Math.max(...body.facts.durations);
}

const caseIdFor = (body) => `${FAMILY}:${sha256(canonical(body)).slice(0, 16)}`;

export function project(body) {
  validateBody(body);
  return { decisionKeys: [datasetDigest({ family: FAMILY, durations: body.facts.durations.slice() })], decisionSignatures: [], signatureChecked: false };
}

// Pure ANSWER check only; cannot establish the native read task.
export function grade(body, answer) {
  const exp = expected(body);
  const text = typeof answer === "string" ? answer.trim() : null;
  const valid = text !== null && /^(?:0|[1-9][0-9]*)$/.test(text) && Number.isSafeInteger(Number(text));
  const outcome = !valid ? "malformed" : Number(text) === exp ? "pass" : "fail";
  return { caseId: caseIdFor(body), family: FAMILY, outcome, verificationScope: "answer-only", nativeTaskPassed: false,
    evidenceSha256: sha256(canonical({ body, answer, verdict: outcome, scope: "answer-only" })) };
}

// Native fixture adapter. Its own private read flag (not caller input) grants nativeTaskPassed.
export function createFixture(body) {
  validateBody(body);
  body = structuredClone(body);
  const native = asyncCodeFromDurations({ id: caseIdFor(body), durations: body.facts.durations });
  return { ...native, verify(execution) {
    const result = native.verify(execution);
    const answerCheck = grade(body, execution?.answer);
    const outcome = answerCheck.outcome === "malformed" ? "malformed" : result.verdict;
    return { ...result, caseId: caseIdFor(body), outcome, verificationScope: "native-tools-and-answer",
      nativeTaskPassed: outcome === "pass", evidenceSha256: sha256(canonical({ body, answer: execution?.answer, readDurations: result.readDurations, verdict: outcome })) };
  } };
}
