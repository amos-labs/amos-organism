import test from "node:test";
import assert from "node:assert/strict";
import { gradeDateAnswer, expectedDate, monthLength } from "../src/dateArithmeticOracle.js";

// Deterministic date-time grader for the development panel. Pure, UTC-only.

test("monthLength handles ordinary, short and leap-February months", () => {
  assert.equal(monthLength(2026, 1), 31);
  assert.equal(monthLength(2026, 2), 28);
  assert.equal(monthLength(2028, 2), 29); // leap year
  assert.equal(monthLength(2026, 4), 30);
  assert.throws(() => monthLength(2026, 13), /month:1-12/);
});

test("expectedDate: date-add crosses month and year boundaries correctly", () => {
  assert.equal(expectedDate({ kind: "date-add", start: "2026-01-31", addDays: 1 }), "2026-02-01");
  assert.equal(expectedDate({ kind: "date-add", start: "2026-02-28", addDays: 1 }), "2026-03-01");
  assert.equal(expectedDate({ kind: "date-add", start: "2028-02-28", addDays: 1 }), "2028-02-29"); // leap
  assert.equal(expectedDate({ kind: "date-add", start: "2026-12-31", addDays: 1 }), "2027-01-01");
  assert.throws(() => expectedDate({ kind: "date-add", start: "2026-13-01", addDays: 1 }), /not a real date|YYYY-MM-DD/);
});

test("expectedDate: month-length-resolve rolls an overflowing day into later months", () => {
  assert.equal(expectedDate({ kind: "month-length-resolve", year: 2026, month: 1, requestedDay: 15 }), "2026-01-15");
  assert.equal(expectedDate({ kind: "month-length-resolve", year: 2026, month: 1, requestedDay: 32 }), "2026-02-01");
  // Feb 2026 has 28 days: day 30 -> Mar 2.
  assert.equal(expectedDate({ kind: "month-length-resolve", year: 2026, month: 2, requestedDay: 30 }), "2026-03-02");
  // Feb 2028 (leap, 29): day 30 -> Mar 1.
  assert.equal(expectedDate({ kind: "month-length-resolve", year: 2028, month: 2, requestedDay: 30 }), "2028-03-01");
});

test("gradeDateAnswer returns pass/fail/malformed with a stable evidence hash", () => {
  const task = { caseId: "date-0001", kind: "month-length-resolve", year: 2026, month: 2, requestedDay: 30 };
  const pass = gradeDateAnswer(task, "2026-03-02");
  assert.equal(pass.outcome, "pass"); assert.equal(pass.family, "date-time");
  assert.match(pass.evidenceSha256, /^[a-f0-9]{64}$/);
  // The exact S7 failure shape: a wrong date ending in -03 is a real fail, not malformed.
  assert.equal(gradeDateAnswer(task, "2026-02-03").outcome, "fail");
  assert.equal(gradeDateAnswer(task, "not-a-date").outcome, "malformed");
  assert.equal(gradeDateAnswer(task, "2026/03/02").outcome, "malformed");
  // Deterministic: same input -> same evidence hash; different answer -> different hash.
  assert.equal(gradeDateAnswer(task, "2026-03-02").evidenceSha256, pass.evidenceSha256);
  assert.notEqual(gradeDateAnswer(task, "2026-02-03").evidenceSha256, pass.evidenceSha256);
  assert.throws(() => gradeDateAnswer({ ...task, caseId: "" }, "2026-03-02"), /caseId required/);
});

// Preaccepted regression tests from a0-date-oracle-review-20260912 (calendar-domain repair).

test('impossible fixture dates cannot produce a passing grade', () => {
  for (const start of ['2026-02-29','2026-02-30','2026-02-31','2026-04-31','1900-02-29','2100-02-29','2026-01-00']) {
    assert.throws(() => gradeDateAnswer({caseId:'synthetic-invalid',kind:'date-add',start,addDays:0},'2026-03-02'), TypeError);
  }
});
test('Gregorian leap rules including early years and century boundaries', () => {
  for (const [year, days] of [[1,28],[4,29],[96,29],[100,28],[400,29],[1900,28],[2000,29],[2100,28],[2400,29]]) {
    assert.equal(monthLength(year,2), days);
    const start = `${String(year).padStart(4,'0')}-02-28`;
    assert.equal(expectedDate({kind:'date-add',start,addDays:1}), `${String(year).padStart(4,'0')}-${days===29?'02-29':'03-01'}`);
    assert.equal(expectedDate({kind:'month-length-resolve',year,month:2,requestedDay:days+1}), `${String(year).padStart(4,'0')}-03-01`);
  }
});
test('strict types and bounded years/results prevent coercion and unbounded rollover', () => {
  for (const year of [0,-1,10000,Number.MAX_SAFE_INTEGER,NaN,Infinity,1.5,'2026']) assert.throws(() => monthLength(year,2),TypeError);
  assert.throws(() => expectedDate({kind:'date-add',start:{toString:()=> '2026-01-01'},addDays:1}),TypeError);
  for (const addDays of [Infinity,NaN,1.1,'1',Number.MAX_SAFE_INTEGER]) assert.throws(() => expectedDate({kind:'date-add',start:'2026-01-01',addDays}),TypeError);
  for (const requestedDay of [Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER+1,Infinity,0,-1]) assert.throws(() => expectedDate({kind:'month-length-resolve',year:2026,month:1,requestedDay}),TypeError);
  assert.throws(() => expectedDate({kind:'date-add',start:'9999-12-31',addDays:1}),TypeError);
  assert.throws(() => expectedDate({kind:'date-add',start:'0001-01-01',addDays:-1}),TypeError);
  assert.equal(expectedDate({kind:'date-add',start:'0001-01-01',addDays:3652058}),'9999-12-31');
});
test('correct answers, genuine model errors and stable evidence retain the owner API', () => {
  const task={caseId:'synthetic-check',kind:'month-length-resolve',year:2026,month:2,requestedDay:30};
  const pass=gradeDateAnswer(task,'2026-03-02');
  assert.equal(pass.outcome,'pass'); assert.equal(pass.family,'date-time'); assert.equal(pass.expected,'2026-03-02');
  assert.equal(gradeDateAnswer(task,'2026-03-03').outcome,'fail');
  assert.equal(gradeDateAnswer(task,'not a date').outcome,'malformed');
  assert.match(pass.evidenceSha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(gradeDateAnswer({...task},'2026-03-02'),pass);
  assert.notEqual(gradeDateAnswer(task,'2026-03-03').evidenceSha256,pass.evidenceSha256);
});
