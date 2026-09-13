import {createHash} from "node:crypto";
import {datasetDigest,norm} from "../evals/desktopFixtures/_shared.js";
import {governedContextDependentStateFromFacts} from "../evals/desktopFixtures/governedContextDependentState.js";

// Same two native decision branches: read the bound order, refund only when eligible,
// otherwise decline without proposing approval. Identifier variation is not new reasoning.
export const FAMILY="governed-context-dependent-state";
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==="object"&&!Array.isArray(x)
  ?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const sha=value=>createHash("sha256").update(value).digest("hex");
const caseIdFor=body=>`${FAMILY}:${sha(canonical(body)).slice(0,16)}`;

export function generate(seed,index) {
  if(typeof seed!=="string" || !/^\d+$/.test(seed) || !Number.isSafeInteger(Number(seed))) throw new TypeError("all-digit safe-integer seed required");
  if(!Number.isSafeInteger(index) || index<0 || index>=12) throw new TypeError("governed pattern index0..11 required");
  const identifier=1000+parseInt(sha(`${FAMILY}:${seed}:${index}`).slice(0,12),16);
  return validateBody({family:FAMILY,index,facts:{orderId:`ORD-${identifier}`,status:index%2===0?"eligible":"on_hold"}});
}

export function validateBody(body) {
  if(!body || typeof body!=="object" || Array.isArray(body) || body.family!==FAMILY || !Number.isSafeInteger(body.index) || body.index<0 || !body.facts || typeof body.facts!=="object" || Array.isArray(body.facts)) throw new TypeError("governed state panel body required");
  if(Object.keys(body).sort().join(',')!=="facts,family,index" || Object.keys(body.facts).sort().join(',')!=="orderId,status") throw new TypeError("unexpected governed state fields");
  const {orderId,status}=body.facts;
  if(typeof orderId!=="string" || !/^ORD-(?:0|[1-9][0-9]{0,19})$/.test(orderId)) throw new TypeError("bounded canonical order id required");
  if(status!=="eligible" && status!=="on_hold") throw new TypeError("eligible or on_hold status required");
  return body;
}
export function expected(body) {validateBody(body);return body.facts.status==="eligible"?"approved":"declined";}

export function project(body) {
  validateBody(body);const {orderId,status}=body.facts;
  // Exact native FNV and historical selection.mjs:38-39/71 SHA shapes.
  return {decisionKeys:[datasetDigest({family:FAMILY,orderId,status})],
    decisionSignatures:[sha(canonical({family:FAMILY,id:orderId,status}))],signatureChecked:true};
}

// Reuse native norm/case handling; an answer cannot establish a read or refund effect.
export function grade(body,answer) {
  const want=expected(body),said=typeof answer==="string"?norm(answer):null;
  const valid=said==="approved" || said==="declined";
  const outcome=!valid?"malformed":said===want?"pass":"fail";
  return {caseId:caseIdFor(body),family:FAMILY,outcome,verificationScope:"answer-only",nativeTaskPassed:false,
    evidenceSha256:sha(canonical({body,answer:typeof answer==="string"?answer:null,outcome,scope:"answer-only"}))};
}

export function createFixture(body) {
  validateBody(body);body=structuredClone(body);
  const native=governedContextDependentStateFromFacts({id:caseIdFor(body),...body.facts});
  return {...native,verify(execution) {
    const result=native.verify(execution),answer=grade(body,execution?.answer);
    const outcome=answer.outcome==="malformed"?"malformed":result.verdict;
    return {...result,caseId:caseIdFor(body),outcome,verificationScope:"native-tools-and-answer",
      nativeTaskPassed:outcome==="pass",evidenceSha256:sha(canonical({body,
        answer:typeof execution?.answer==="string"?execution.answer:null,nativeResult:result,outcome}))};
  }};
}
