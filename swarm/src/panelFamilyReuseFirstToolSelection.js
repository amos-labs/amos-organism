import { createHash } from "node:crypto";
import { reuseFirstToolSelectionFromInvoices } from "../evals/desktopFixtures/reuseFirstToolSelection.js";
import { datasetDigest, norm } from "../evals/desktopFixtures/_shared.js";

// Original native task: invoices are already in the prompt; count paid invoices
// without proposing list_invoices. Ordered payment patterns give finite exact
// identity variation, not evidence of new-domain or semantic generalization.
export const FAMILY = "reuse-first-tool-selection";
const sha256 = value => createHash("sha256").update(value).digest("hex");
const canonical = value => JSON.stringify(value, (_key, v) => v && typeof v === "object" && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const caseIdFor = body => `${FAMILY}:${sha256(canonical(body)).slice(0, 16)}`;
const PATTERN_COUNT = 16 + 32 + 64 + 128 + 256; // all ordered boolean patterns for4–8 invoices

export function generate(seed, index) {
  if (typeof seed !== "string" || !/^\d+$/.test(seed) || !Number.isSafeInteger(Number(seed))) throw new TypeError("seed must be an all-digit safe integer string");
  if (!Number.isSafeInteger(index) || index < 0 || index >= PATTERN_COUNT) throw new RangeError("index must be within the finite496-pattern native domain");
  // 17 is coprime to496: one fixed permutation, no hidden retry/selection loop.
  const offset = Number.parseInt(sha256(`${FAMILY}:${seed}:offset`).slice(0, 8), 16) % PATTERN_COUNT;
  let mask = (offset + 17 * index) % PATTERN_COUNT, count = 4;
  while (count < 8 && mask >= 2 ** count) { mask -= 2 ** count; count++; }
  const invoices = Array.from({ length: count }, (_, k) => ({
    id: `INV-${k + 1}`, paid: ((mask >> k) & 1) === 1,
    amount: 100 + Number.parseInt(sha256(`${FAMILY}:${seed}:${index}:${k}:amount`).slice(0, 8), 16) % 9900,
  }));
  return { family: FAMILY, index, facts: { invoices } };
}

export function validateBody(body) {
  if (!body || body.family !== FAMILY || !Number.isSafeInteger(body.index) || body.index < 0 || !body.facts) throw new TypeError("reuse-first panel body required");
  const rows = body.facts.invoices;
  if (!Array.isArray(rows) || rows.length < 4 || rows.length > 8) throw new TypeError("panel requires4–8 invoices");
  const ids = new Set();
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || !/^INV-\d+$/.test(row.id) || row.id.length > 128 || ids.has(row.id)
      || typeof row.paid !== "boolean" || !Number.isSafeInteger(row.amount) || row.amount < 0) throw new TypeError("unique invoice ids, boolean paid flags and non-negative integer amounts required");
    ids.add(row.id);
  }
  return body;
}

export function expected(body) { validateBody(body); return body.facts.invoices.filter(row => row.paid).length; }

export function project(body) {
  validateBody(body);
  const booleans = body.facts.invoices.map(row => row.paid), paidPattern = booleans.map(paid => paid ? 1 : 0);
  const expectedPaid = paidPattern.reduce((sum, n) => sum + n, 0);
  return { decisionKeys: [datasetDigest({ family: FAMILY, paidPattern, expectedPaid })],
    decisionSignatures: [sha256(canonical({ family: FAMILY, paidPattern: booleans }))], signatureChecked: true };
}

// Pure answer check; a matching count does not prove that no forbidden tool was proposed.
export function grade(body, answer) {
  const exp = expected(body), text = typeof answer === "string" ? norm(answer) : null;
  const valid = text !== null && /^(?:0|[1-9][0-9]*)$/.test(text) && Number.isSafeInteger(Number(text));
  const outcome = !valid ? "malformed" : Number(text) === exp ? "pass" : "fail";
  return { caseId: caseIdFor(body), family: FAMILY, outcome, verificationScope: "answer-only", nativeTaskPassed: false,
    evidenceSha256: sha256(canonical({ body, answer, outcome, scope: "answer-only" })) };
}

export function createFixture(body) {
  validateBody(body);
  body = structuredClone(body);
  const native = reuseFirstToolSelectionFromInvoices({ invoices: body.facts.invoices, id: caseIdFor(body) });
  return { ...native, verify(execution) {
    const result = native.verify(execution), answerCheck = grade(body, execution?.answer);
    const outcome = answerCheck.outcome === "malformed" ? "malformed" : result.verdict;
    return { ...result, caseId: caseIdFor(body), outcome, verificationScope: "native-tools-and-answer", nativeTaskPassed: outcome === "pass",
      evidenceSha256: sha256(canonical({ body, answer: execution?.answer, nativeResult: result, outcome })) };
  } };
}
