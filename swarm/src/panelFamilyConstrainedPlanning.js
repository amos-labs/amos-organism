import { createHash } from "node:crypto";
import { constrainedPlanningFromAccounts } from "../evals/desktopFixtures/constrainedPlanning.js";
import { datasetDigest } from "../evals/desktopFixtures/_shared.js";

// A0 development-panel family 2/8: constrained-planning. Native contract (unchanged):
// read each account exactly once within a tool-call budget = account count, then report
// the total as a bare integer. Fresh authored facts + a pure answer oracle + createFixture
// binding the existing Desktop execution surface (only its private read state grants a
// native pass). Decision projection emits the exact comparable KEY = datasetDigest over
// {family, accounts, budget} (verified: decisionKey === datasetDigest for this family).
// The normalized signature algorithm is only defined for numeric/date, so this family
// reports signatureChecked:false rather than claiming an unverified signature. Exact-
// identity disjointness proves no reuse, not semantic novelty.

export const FAMILY = "constrained-planning";
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

// Fresh authored accounts: 3-5 accounts, balances 100..9999, budget = account count.
// Distinct id prefix (PACC-) from the seeded fixture (ACC-) so the authored panel cannot
// coincide with the consumed seed cohort by construction.
export function generate(seed, index) {
  if (typeof seed !== "string" || !/^\d+$/.test(seed)) throw new TypeError("seed must be an all-digit string");
  if (!Number.isSafeInteger(index) || index < 0) throw new TypeError("index must be a non-negative integer");
  const next = streamFrom(`${FAMILY}:${seed}:${index}`);
  const n = 3 + (next() % 3); // 3..5
  const accounts = Array.from({ length: n }, (_, k) => ({ id: `PACC-${index}-${k + 1}`, balance: 100 + (next() % 9900) }));
  return { family: FAMILY, index, facts: { accounts, budget: n } };
}

export function validateBody(body) {
  if (!body || body.family !== FAMILY || !Number.isSafeInteger(body.index) || body.index < 0 || !body.facts) throw new TypeError("constrained-planning panel body required");
  const { accounts, budget } = body.facts;
  if (!Array.isArray(accounts) || accounts.length < 3 || accounts.length > 5) throw new TypeError("panel requires 3..5 accounts");
  const ids = new Set();
  for (const a of accounts) {
    if (!a || typeof a.id !== "string" || a.id.length === 0 || a.id.length > 128 || ids.has(a.id) || !Number.isSafeInteger(a.balance) || a.balance < 100 || a.balance > 9999) throw new TypeError("unique account ids and integer balances 100..9999 required");
    ids.add(a.id);
  }
  if (budget !== accounts.length) throw new TypeError("budget must equal the account count");
  return body;
}

// The canonical correct answer: the total balance across all accounts.
export function expected(body) {
  validateBody(body);
  return Number(body.facts.accounts.reduce((t, a) => t + BigInt(a.balance), 0n));
}

const caseIdFor = (body) => `${FAMILY}:${sha256(canonical(body)).slice(0, 16)}`;

// Comparable decision projection: the exact FNV-1a key over {family, accounts, budget}
// (= the fixture datasetDigest; decisionKey === datasetDigest verified for this family).
// No normalized signature is claimed for this family (algorithm defined only for
// numeric/date), so signatureChecked is false.
export function project(body) {
  validateBody(body);
  const accounts = body.facts.accounts.map(({ id, balance }) => ({ id, balance }));
  return { decisionKeys: [datasetDigest({ family: FAMILY, accounts, budget: body.facts.budget })], decisionSignatures: [], signatureChecked: false };
}

// Pure ANSWER check only. This outcome cannot establish the native budget/coverage task.
export function grade(body, answer) {
  const exp = expected(body);
  const text = typeof answer === "string" ? answer.trim() : null;
  const valid = text !== null && /^(?:0|[1-9][0-9]*)$/.test(text) && Number.isSafeInteger(Number(text));
  const outcome = !valid ? "malformed" : Number(text) === exp ? "pass" : "fail";
  return { caseId: caseIdFor(body), family: FAMILY, outcome, verificationScope: "answer-only", nativeTaskPassed: false,
    evidenceSha256: sha256(canonical({ body, answer, verdict: outcome, scope: "answer-only" })) };
}

// Native fixture adapter. Its own private read state (not caller booleans) establishes
// budget + exact-coverage; only the native verify after real reads grants a native pass.
export function createFixture(body) {
  validateBody(body);
  body = structuredClone(body);
  const native = constrainedPlanningFromAccounts({ id: caseIdFor(body), accounts: body.facts.accounts, budget: body.facts.budget });
  return { ...native, verify(execution) {
    const result = native.verify(execution);
    const answerCheck = grade(body, execution?.answer);
    const outcome = answerCheck.outcome === "malformed" ? "malformed" : result.verdict;
    return { ...result, caseId: caseIdFor(body), outcome, verificationScope: "native-tools-and-answer",
      nativeTaskPassed: outcome === "pass", evidenceSha256: sha256(canonical({ body, answer: execution?.answer, exactCoverage: result.exactCoverage, verdict: outcome })) };
  } };
}
