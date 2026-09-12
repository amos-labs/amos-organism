import { createHash } from "node:crypto";

// A0 development-panel family: numeric-reconciliation. Deterministic generator + exact
// grader + comparable decision-signature projection for one of the eight named
// families. Each case is generated reproducibly from (seed, index) so the panel is
// fixed before measurement; the grader is a pure oracle (no model); the projection
// computes the SAME decisionSignature = sha256(canonical(signatureFacts)) the excluded
// inventory uses, so a panel case whose reconciliation facts match a consumed/parent
// task is caught (the strong 64-hex identity; the historical 8-hex key is a
// non-recomputable source id and is not claimed here). Task content is NEW; exact-
// identity disjointness proves no reuse, not semantic novelty.

export const FAMILY = "numeric-reconciliation";
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const canonical = (v) => JSON.stringify(sortKeys(v));
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

// Deterministic, reproducible 32-bit stream from a string label (splitmix-style).
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

// Generate one reconciliation case body. Amounts are positive integers; ledgers have
// 3-5 entries each. Fully determined by (seed, index).
export function generate(seed, index) {
  if (typeof seed !== "string" || !/^\d+$/.test(seed)) throw new TypeError("seed must be an all-digit string");
  if (!Number.isInteger(index) || index < 0) throw new TypeError("index must be a non-negative integer");
  const next = streamFrom(`${FAMILY}:${seed}:${index}`);
  const sizeA = 3 + (next() % 3); // 3..5
  const sizeB = 3 + (next() % 3);
  const amount = () => 100 + (next() % 9900); // 100..9999
  const ledgerA = Array.from({ length: sizeA }, (_, i) => ({ id: `a${i + 1}`, amount: amount() }));
  const ledgerB = Array.from({ length: sizeB }, (_, i) => ({ id: `b${i + 1}`, amount: amount() }));
  return { family: FAMILY, index, facts: { ledgerA, ledgerB } };
}

// Normalized facts that define the case's decision identity (order-independent).
export function signatureFacts(body) {
  const a = body.facts.ledgerA.map((e) => e.amount).sort((x, y) => x - y);
  const b = body.facts.ledgerB.map((e) => e.amount).sort((x, y) => x - y);
  return { family: FAMILY, a, b };
}

// Comparable decision projection: the strong 64-hex signature only (the 8-hex historical
// key is not recomputable from task facts and is not claimed).
export function project(body) {
  return { decisionSignatures: [sha256(canonical(signatureFacts(body)))] };
}

// The canonical correct answer: the multiset of amounts in A with no equal counterpart
// in B (multiset difference A \ B), sorted ascending, plus the net total difference.
export function expected(body) {
  const bCounts = new Map();
  for (const e of body.facts.ledgerB) bCounts.set(e.amount, (bCounts.get(e.amount) ?? 0) + 1);
  const unmatched = [];
  for (const e of [...body.facts.ledgerA].sort((x, y) => x.amount - y.amount)) {
    const c = bCounts.get(e.amount) ?? 0;
    if (c > 0) bCounts.set(e.amount, c - 1);
    else unmatched.push(e.amount);
  }
  const netDifference = body.facts.ledgerA.reduce((s, e) => s + e.amount, 0) - body.facts.ledgerB.reduce((s, e) => s + e.amount, 0);
  return { unmatchedFromA: unmatched, netDifference };
}

// Exact grader. answer must be { unmatchedFromA: number[], netDifference: number }.
// Malformed (wrong shape/types) is a distinct outcome from a wrong answer.
export function grade(body, answer) {
  const caseId = `${FAMILY}:${sha256(canonical(body)).slice(0, 16)}`;
  const base = { caseId, family: FAMILY };
  if (!answer || typeof answer !== "object" || !Array.isArray(answer.unmatchedFromA) ||
      !answer.unmatchedFromA.every((n) => Number.isInteger(n)) || !Number.isInteger(answer.netDifference)) {
    return { ...base, outcome: "malformed", evidenceSha256: sha256(canonical({ body, answer, verdict: "malformed" })) };
  }
  const exp = expected(body);
  const submitted = [...answer.unmatchedFromA].sort((x, y) => x - y);
  const ok = answer.netDifference === exp.netDifference &&
    submitted.length === exp.unmatchedFromA.length && submitted.every((n, i) => n === exp.unmatchedFromA[i]);
  return { ...base, outcome: ok ? "pass" : "fail", expected: exp, evidenceSha256: sha256(canonical({ body, expected: exp, answer, verdict: ok ? "pass" : "fail" })) };
}
