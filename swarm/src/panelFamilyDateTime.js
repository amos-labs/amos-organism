import {createHash} from "node:crypto";
import {expectedDate,gradeDateAnswer,monthLength} from "./dateArithmeticOracle.js";
import {datasetDigest} from "../evals/desktopFixtures/_shared.js";
import {dateTimeFromFacts} from "../evals/desktopFixtures/dateTime.js";

export const FAMILY="date-time";
export const COVERAGE=Object.freeze([
  "nonleap-February-forward","leap-February-forward","nonleap-century-February",
  "leap-400-year-February","30-day-month-forward","31-day-month-forward",
  "year-forward","nonleap-February-backward","leap-February-backward",
  "year-backward","year-below-100-forward","multi-month-and-year-forward",
]);
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const canonical=v=>JSON.stringify(stable(v));
const sha=s=>createHash("sha256").update(s).digest("hex");
const iso=(year,month,day)=>`${String(year).padStart(4,"0")}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;

// Source proposal only: no seed is preselected or case panel emitted at import.
// Twelve declared patterns vary facts deterministically with seed, not the task.
export function generate(seed,index) {
  if(typeof seed!=="string" || !/^\d+$/.test(seed) || !Number.isSafeInteger(Number(seed)))throw new TypeError("all-digit safe-integer seed required");
  if(!Number.isSafeInteger(index)||index<0||index>=12)throw new TypeError("date pattern index0..11 required");
  const n=parseInt(sha(`${FAMILY}:${seed}:${index}`).slice(0,8),16);
  const normal=2001+4*(n%1000);
  let leap=2000+4*(n%1000);if(monthLength(leap,2)!==29)leap+=4;
  let century=100*(1+n%95);if(century%400===0)century+=100;
  const ordinary=1000+n%7000;
  const choices=[
    [iso(normal,2,27),3+n%4],
    [iso(leap,2,27),3+n%4],
    [iso(century,2,28),1],
    [iso(400*(1+n%23),2,28),1],
    [iso(ordinary,4,29),3+n%4],
    [iso(ordinary,1,30),3+n%4],
    [iso(ordinary,12,30),3+n%4],
    [iso(normal,3,1),-(1+n%3)],
    [iso(leap,3,1),-1],
    [iso(ordinary,1,2),-(3+n%4)],
    [iso(1+n%97,12,31),1+n%3],
    [iso(leap,1,31),366+n%65],
  ];
  const [start,addDays]=choices[index];
  return validateBody({family:FAMILY,index,facts:{start,addDays}});
}

export function validateBody(body) {
  if(!body || typeof body!=="object" || Array.isArray(body) || body.family!==FAMILY || !Number.isSafeInteger(body.index)||body.index<0 || !body.facts || typeof body.facts!=="object" || Array.isArray(body.facts))throw new TypeError("date panel body required");
  if(Object.keys(body).sort().join(',')!=='facts,family,index' || Object.keys(body.facts).sort().join(',')!=='addDays,start')throw new TypeError("unexpected date panel fields");
  expectedDate({kind:"date-add",...body.facts}); // accepted oracle owns all date/domain validation
  return body;
}
export function expected(body) {validateBody(body);return expectedDate({kind:"date-add",...body.facts});}
const caseIdFor=body=>`${FAMILY}:${sha(canonical(body)).slice(0,16)}`;
export function signatureFacts(body) {validateBody(body);return {family:FAMILY,start:body.facts.start,days:body.facts.addDays};}
export function project(body) {
  const normalized=signatureFacts(body);
  // Same SHA facts and FNV historical construction. Prior consumed metadata used
  // nonnegative offsets; negative additions share the native/oracle task semantics.
  return {decisionSignatures:[sha(canonical(normalized))],decisionKeys:[datasetDigest({family:FAMILY,...body.facts})]};
}
// Pure answer check: no claim that a Desktop execution completed successfully.
export function grade(body,answer) {
  validateBody(body);const result=gradeDateAnswer({caseId:caseIdFor(body),kind:"date-add",...body.facts},answer);
  return {...result,verificationScope:"answer-only",nativeTaskPassed:false};
}
export function createFixture(body) {
  validateBody(body);body=structuredClone(body);
  const native=dateTimeFromFacts({id:caseIdFor(body),...body.facts});
  return {...native,verify(execution){
    const result=native.verify(execution),answer=grade(body,execution?.answer);
    const outcome=answer.outcome==='malformed'?'malformed':result.verdict;
    return {...result,caseId:caseIdFor(body),outcome,verificationScope:"native-execution-date-answer",
      nativeTaskPassed:outcome==='pass',evidenceSha256:sha(canonical({caseId:caseIdFor(body),body,answer:typeof execution?.answer==='string'?execution.answer:null,
        verdict:outcome,toolReadRequired:false,observedMonthLengthYears:result.observedMonthLengthYears}))};
  }};
}
