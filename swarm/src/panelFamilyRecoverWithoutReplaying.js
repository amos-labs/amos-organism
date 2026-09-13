import { createHash } from "node:crypto";
import { recoverWithoutReplayingFromFacts } from "../evals/desktopFixtures/recoverWithoutReplaying.js";
import { datasetDigest, norm } from "../evals/desktopFixtures/_shared.js";

// Existing recovery task: an invoice is already sent and unpaid. Mark only that
// invoice paid, do not propose send_invoice, and give the original completion
// answer. Identifier variation is NOT distinct recovery reasoning or novelty.
export const FAMILY = "recover-without-replaying-completed-actions";
const sha256 = value => createHash("sha256").update(value).digest("hex");
const canonical = value => JSON.stringify(value, (_key, v) => v && typeof v === "object" && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const caseIdFor = body => `${FAMILY}:${sha256(canonical(body)).slice(0, 16)}`;

export function generate(seed, index) {
  if (typeof seed !== "string" || !/^\d+$/.test(seed) || !Number.isSafeInteger(Number(seed))) throw new TypeError("seed must be an all-digit safe integer string");
  if (!Number.isSafeInteger(index) || index < 0) throw new TypeError("index must be a non-negative integer");
  const identifier = 1000 + Number.parseInt(sha256(`${FAMILY}:${seed}:${index}`).slice(0, 12), 16);
  return { family: FAMILY, index, facts: { bound: `INV-${identifier}` } };
}

export function validateBody(body) {
  if (!body || body.family !== FAMILY || !Number.isSafeInteger(body.index) || body.index < 0 || !body.facts) throw new TypeError("recovery panel body required");
  if (typeof body.facts.bound !== "string" || !/^INV-\d+$/.test(body.facts.bound) || body.facts.bound.length > 128) throw new TypeError("bound invoice id required");
  // State is fixed by the original task, not an ignored caller override.
  if (Object.keys(body.facts).some(k => k !== "bound")) throw new TypeError("recovery facts contain only the bound invoice; initial sent/unpaid state is fixed");
  return body;
}

export function expected(body) { validateBody(body); return "done"; }

export function project(body) {
  validateBody(body);
  // Historical dataset key deliberately used this SHORT family name.
  const key = datasetDigest({ family: "recover-without-replaying", bound: body.facts.bound });
  // Existing selection.mjs signs the FULL family and INITIAL native tool state.
  const signature = sha256(canonical({ family: FAMILY, id: body.facts.bound, sent: true, paid: false }));
  return { decisionKeys: [key], decisionSignatures: [signature], signatureChecked: true };
}

// Mirror the original native answer predicate (includes 'done'), not a new
// exact-string rule. This checks no effect and never grants a native task pass.
export function grade(body, answer) {
  validateBody(body);
  const outcome = typeof answer !== "string" ? "malformed" : norm(answer).includes("done") ? "pass" : "fail";
  return { caseId: caseIdFor(body), family: FAMILY, outcome, verificationScope: "answer-only", nativeTaskPassed: false,
    evidenceSha256: sha256(canonical({ body, answer, outcome, scope: "answer-only" })) };
}

export function createFixture(body) {
  validateBody(body);
  body = structuredClone(body);
  const native = recoverWithoutReplayingFromFacts({ bound: body.facts.bound, id: caseIdFor(body) });
  return { ...native, verify(execution) {
    const result = native.verify(execution);
    const answerCheck = grade(body, execution?.answer);
    const outcome = answerCheck.outcome === "malformed" ? "malformed" : result.verdict;
    return { ...result, caseId: caseIdFor(body), outcome, verificationScope: "native-tools-and-answer",
      nativeTaskPassed: outcome === "pass",
      evidenceSha256: sha256(canonical({ body, answer: execution?.answer, nativeResult: result, outcome })) };
  } };
}
