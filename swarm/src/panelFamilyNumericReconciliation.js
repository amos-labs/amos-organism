import { createHash } from "node:crypto";
import { numericReconciliationFromLedgers } from "../evals/desktopFixtures/numericReconciliation.js";
import { datasetDigest } from "../evals/desktopFixtures/_shared.js";

// A0 development-panel family: numeric-reconciliation. Deterministic generator + exact
// grader + comparable decision-signature projection for one of the eight named
// families. Each case is generated reproducibly from (seed, index) so the panel is
// fixed before measurement; the grader is a pure oracle (no model); the projection
// computes the SAME decisionSignature = sha256(canonical(signatureFacts)) the excluded
// inventory uses, so a panel case whose reconciliation facts match a consumed/parent
// task is caught. Also emit the exact historical FNV-1a key over the executed
// ledger rows. Normalized strong signatures ignore row IDs/order; historical keys
// preserve them. An actual inventory comparison is still required; this establishes
// exact-decision coverage, not semantic novelty.

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
  if (!Number.isSafeInteger(index) || index < 0) throw new TypeError("index must be a non-negative integer");
  if (!Number.isSafeInteger(Number(seed))) throw new RangeError("seed must be a safe integer");
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
  validateBody(body,{projection:true});
  const a = body.facts.ledgerA.map((e) => e.amount).sort((x, y) => x - y);
  const b = body.facts.ledgerB.map((e) => e.amount).sort((x, y) => x - y);
  return { family: FAMILY, a, b };
}

// Comparable normalized decision signature plus exact native historical key.
export function project(body) {
  const signature=sha256(canonical(signatureFacts(body)));
  const rows=values=>values.map(({id,amount})=>({id,amount}));
  return {decisionSignatures:[signature],decisionKeys:[datasetDigest({family:FAMILY,
    ledgerA:rows(body.facts.ledgerA),ledgerB:rows(body.facts.ledgerB)})]};
}

// Freeze the original A0 task: two actual reads, then a bare signed A-total minus
// B-total. A separate multiset requirement would be a new experimental treatment.
export function validateBody(body,{projection=false}={}) {
  if(!body || body.family!==FAMILY || !Number.isSafeInteger(body.index) || body.index<0 || !body.facts) throw new TypeError("numeric panel body required");
  for(const rows of [body.facts.ledgerA,body.facts.ledgerB]) {
    if(!Array.isArray(rows) || rows.length<(projection?1:3) || rows.length>(projection?1000:5)) throw new TypeError("panel ledger requires3..5 rows");
    const ids=new Set();
    for(let i=0;i<rows.length;i++) {
      const row=rows[i];
      if(!row || typeof row.id!=="string" || row.id.length===0 || row.id.length>128 || ids.has(row.id) || !Number.isSafeInteger(row.amount) || (!projection && (row.amount<100 || row.amount>9999))) throw new TypeError("unique row ids and integer amounts100..9999 required");
      ids.add(row.id);
    }
  }
  return body;
}
export function expected(body) {
  validateBody(body);
  const sum=rows=>rows.reduce((s,e)=>s+BigInt(e.amount),0n);
  return Number(sum(body.facts.ledgerA)-sum(body.facts.ledgerB));
}
const caseIdFor=body=>`${FAMILY}:${sha256(canonical(body)).slice(0,16)}`;
// Pure ANSWER check only. This outcome cannot establish a successful tool task.
export function grade(body, answer) {
  const exp=expected(body),text=typeof answer==="string"?answer.trim():null;
  const valid=text!==null && /^-?(?:0|[1-9][0-9]*)$/.test(text) && Number.isSafeInteger(Number(text));
  const outcome=!valid?"malformed":Number(text)===exp?"pass":"fail";
  return {caseId:caseIdFor(body),family:FAMILY,outcome,verificationScope:"answer-only",nativeTaskPassed:false,
    evidenceSha256:sha256(canonical({body,answer,verdict:outcome,scope:"answer-only"}))};
}
// Actual native fixture adapter. Wire this object into the existing Desktop
// executor. Its own read closures, not caller-supplied booleans, establish readBoth.
export function createFixture(body) {
  validateBody(body);body=structuredClone(body);
  const native=numericReconciliationFromLedgers({id:caseIdFor(body),...body.facts});
  return {...native,verify(execution){
    const result=native.verify(execution);
    const answerCheck=grade(body,execution?.answer);
    const outcome=answerCheck.outcome==="malformed"?"malformed":result.verdict;
    return {...result,caseId:caseIdFor(body),outcome,verificationScope:"native-tools-and-answer",
      nativeTaskPassed:outcome==="pass",evidenceSha256:sha256(canonical({body,answer:execution?.answer,readBoth:result.readBoth,verdict:outcome}))};
  }};
}
