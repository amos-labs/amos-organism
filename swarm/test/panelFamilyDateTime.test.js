import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {FAMILY,COVERAGE,generate,expected,grade,project,createFixture,validateBody} from '../src/panelFamilyDateTime.js';
import {dateTimeFromFacts,dateTimeFixture} from '../evals/desktopFixtures/dateTime.js';
const body=(start,addDays,index=777)=>({family:FAMILY,index,facts:{start,addDays}});
const sha=s=>createHash('sha256').update(s).digest('hex');
const known=[['2023-02-27',3,'2023-03-02'],['2024-02-27',3,'2024-03-01'],['1900-02-28',1,'1900-03-01'],['2000-02-28',1,'2000-02-29'],['2100-03-01',-1,'2100-02-28'],['2400-03-01',-1,'2400-02-29'],['2026-04-29',3,'2026-05-02'],['2026-01-30',3,'2026-02-02'],['2026-12-30',3,'2027-01-02'],['2026-01-02',-3,'2025-12-30'],['0099-12-31',1,'0100-01-01'],['0001-01-01',0,'0001-01-01'],['9999-12-31',0,'9999-12-31'],['2024-01-31',366,'2025-01-31']];
test('accepted oracle bytes remain exactly unchanged',()=>assert.equal(sha(fs.readFileSync(new URL('../src/dateArithmeticOracle.js',import.meta.url))),'83b98347ec9f59e4b045c648673fb84de0be63d68f53f02ac20c3d10b7bf75b0'));
test('known synthetic Gregorian/leap/century/zero/reverse/boundary cases',()=>{for(const [start,offset,want]of known){assert.equal(expected(body(start,offset)),want);assert.equal(grade(body(start,offset),want).outcome,'pass');assert.equal(grade(body(start,offset),want).nativeTaskPassed,false);}});
test('synthetic seed ONLY produces12 deterministic distinct declared patterns; not admitted panel',()=>{
 const syntheticSeed='4242424242',sigs=new Set(),signs=new Set();
 for(let i=0;i<12;i++){const a=generate(syntheticSeed,i),b=generate(syntheticSeed,i);assert.deepEqual(a,b);sigs.add(project(a).decisionSignatures[0]);signs.add(Math.sign(a.facts.addDays));assert.match(expected(a),/^\d{4}-\d{2}-\d{2}$/);}
 assert.equal(COVERAGE.length,12);assert.equal(sigs.size,12);assert.deepEqual([...signs].sort(),[-1,1]);
 assert.equal(expected(generate(syntheticSeed,2)).slice(5),'03-01');assert.equal(expected(generate(syntheticSeed,3)).slice(5),'02-29');assert.equal(expected(generate(syntheticSeed,8)).slice(5),'02-29');
 for(const args of [['study',0],['9007199254740992',0],[syntheticSeed,-1],[syntheticSeed,12],[syntheticSeed,0.5]])assert.throws(()=>generate(...args));
});
test('invalid task inputs fail before any grade or fixture',()=>{
 for(const [start,days]of [['2026-02-30',0],['1900-02-29',1],['0000-01-01',0],['10000-01-01',0],['0001-01-01',-1],['9999-12-31',1],['2026-01-01',0.5],['2026-01-01',Number.MAX_SAFE_INTEGER],[20260101,1],['2026-01-01','1']]){
 const t=body(start,days);assert.throws(()=>expected(t));assert.throws(()=>grade(t,'2026-01-01'));assert.throws(()=>createFixture(t));assert.throws(()=>project(t));}
 assert.throws(()=>validateBody({...body('2026-01-01',1),family:'numeric-reconciliation'}));assert.throws(()=>validateBody({...body('2026-01-01',1),expected:'hidden'}));
});
test('strict answer-only output classifications preserve accepted oracle',()=>{
 const t=body('2024-02-28',1);for(const a of [null,{},20240229,'2024-2-29','2024-02-29 extra','2024-02-29\n2024-03-01'])assert.equal(grade(t,a).outcome,'malformed');
 assert.equal(grade(t,'2024-03-03').outcome,'fail');assert.equal(grade(t,'2024-02-30').outcome,'fail');assert.equal(grade(t,' 2024-02-29 ').outcome,'pass');
});
test('native contract remains optional-tool, exact prompt and schema unchanged',async()=>{
 const t=body('2026-02-27',3),f=createFixture(t);
 // Old source factory is invoked only at a clearly synthetic negative seed, NOT any study seed.
 const ref=dateTimeFixture({seed:-4});
 assert.equal(ref.fixture.prompt,'The start date is 2026-02-27. Add -1 calendar days. Reply with ONLY the resulting date as YYYY-MM-DD (four-digit year, zero-padded month and day), no words.');
 assert.deepEqual(ref.tools.map(({handler,...x})=>x),[{name:'month_lengths',description:'Return the number of days in each month (Jan..Dec) for a given year.',readOnly:true,parallelSafe:true,parameters:{type:'object',properties:{year:{type:'integer'}},required:['year'],additionalProperties:false}}]);
 assert.equal(f.verify({answer:'2026-03-02',observedMonthLengthYears:[9999]}).verdict,'pass');assert.equal(f.verify({answer:'2026-03-02'}).toolReadRequired,false);assert.deepEqual(f.verify({answer:'2026-03-02'}).observedMonthLengthYears,[]);
 const leap=await f.tools[0].handler({year:2000});assert.equal(leap.lengths[1],29);assert.equal(leap.lengths.length,12);
 const noleap=await f.tools[0].handler({year:1900});assert.equal(noleap.lengths[1],28);leap.lengths[1]=123;assert.equal((await f.tools[0].handler({year:2000})).lengths[1],29);
 assert.deepEqual(f.verify({answer:'2026-03-02'}).observedMonthLengthYears,[2000,1900,2000]);
 const newf=createFixture(t);assert.deepEqual(newf.verify({answer:'2026-03-02'}).observedMonthLengthYears,[]);
});
test('aborted or invalid tool reference read never records successful observed year',async()=>{
 const f=createFixture(body('2024-03-01',-1));await assert.rejects(f.tools[0].handler({year:2024},{signal:{aborted:true}}));
 for(const year of [0,10000,2024.5,'2024'])await assert.rejects(f.tools[0].handler({year}));assert.deepEqual(f.verify({answer:'2024-02-29'}).observedMonthLengthYears,[]);
});
