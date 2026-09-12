import { norm, datasetDigest } from "./_shared.js";
import { expectedDate, monthLength } from "../../src/dateArithmeticOracle.js";

// Preserve the existing seeded native task and exact prompt/tool/output semantics.
export function dateTimeFixture({ seed = 0 } = {}) {
  const s = Math.trunc(seed);
  return dateTimeFromFacts({id:`date-time-${String(s).padStart(3,"0")}`,seed:s,start:"2026-02-27",addDays:3+s});
}

// Shared native adapter: optional month_lengths reference tool, exact date answer.
// The original fixture does NOT require a tool read. Do not introduce a new gate.
export function dateTimeFromFacts({id,start,addDays,seed=null}) {
  if(typeof id!=="string" || id.length===0 || id.length>256) throw new TypeError("fixture id required");
  const expected=expectedDate({kind:"date-add",start,addDays});
  const observedYears=[];
  return {
    fixture:{id,synthetic:true,seed,
      datasetDigest:datasetDigest({family:"date-time",start,addDays}),
      prompt:`The start date is ${start}. Add ${addDays} calendar days. Reply with ONLY the resulting date as YYYY-MM-DD (four-digit year, zero-padded month and day), no words.`,
    },
    tools:[{
      name:"month_lengths",description:"Return the number of days in each month (Jan..Dec) for a given year.",readOnly:true,parallelSafe:true,
      parameters:{type:"object",properties:{year:{type:"integer"}},required:["year"],additionalProperties:false},
      handler:async({year},{signal}={})=>{
        if(signal?.aborted)throw new Error("aborted");
        const lengths=Array.from({length:12},(_,i)=>monthLength(year,i+1));
        observedYears.push(year);
        return {ok:true,year,lengths};
      },
    }],
    verify:execution=>{
      const answer=norm(execution?.answer),wellFormed=/^\d{4}-\d{2}-\d{2}$/.test(answer),correct=wellFormed&&answer===expected;
      return {verdict:correct?"pass":"fail",family:"date-time",expected,got:wellFormed?answer:null,
        reason:!wellFormed?"answer is not a bare YYYY-MM-DD date":!correct?"wrong resulting date":"ok",
        toolReadRequired:false,observedMonthLengthYears:[...observedYears]};
    },
  };
}
