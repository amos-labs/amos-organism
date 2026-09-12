import { createHash } from "node:crypto";

// Pure development answer grader. Task dates use proleptic Gregorian years
// 0001..9999. Invalid task specs fail before a grade can be emitted.
const FAMILY = "date-time";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;
const MIN_TIME = Date.parse("0001-01-01T00:00:00.000Z");
const MAX_TIME = Date.parse("9999-12-31T00:00:00.000Z");
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const canonical = (v) => JSON.stringify(sortKeys(v));
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}
function checkYearMonth(year, month) {
  if (!Number.isSafeInteger(year) || year < 1 || year > 9999 ||
      !Number.isSafeInteger(month) || month < 1 || month > 12) {
    throw new TypeError("year:1-9999 and month:1-12 required");
  }
}
export function monthLength(year, month) {
  checkYearMonth(year, month);
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}
function parseStart(start) {
  if (typeof start !== "string" || !ISO_DATE.test(start)) throw new TypeError("date-add.start must be YYYY-MM-DD");
  const [year, month, day] = start.split("-").map(Number);
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > monthLength(year, month)) {
    throw new TypeError("date-add.start is not a real date in supported years 0001-9999");
  }
  // ISO parsing preserves years below 100; Date.UTC(year,...) maps them to 1900+year.
  return Date.parse(`${start}T00:00:00.000Z`);
}
function shiftedDate(startTime, days) {
  if (!Number.isSafeInteger(days)) throw new TypeError("day offset must be a safe integer");
  const time = startTime + days * DAY_MS;
  if (!Number.isSafeInteger(time) || time < MIN_TIME || time > MAX_TIME) {
    throw new TypeError("date result outside supported years 0001-9999");
  }
  return new Date(time).toISOString().slice(0, 10);
}
export function expectedDate(task) {
  if (!task || typeof task !== "object") throw new TypeError("date task required");
  if (task.kind === "date-add") {
    return shiftedDate(parseStart(task.start), task.addDays);
  }
  if (task.kind === "month-length-resolve") {
    const {year, month, requestedDay} = task;
    checkYearMonth(year, month);
    if (!Number.isSafeInteger(requestedDay) || requestedDay < 1) throw new TypeError("month-length-resolve.requestedDay >= 1 safe integer required");
    const first = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
    // Constant-time rollover. Invalid huge days cannot trap the grader in a loop.
    return shiftedDate(parseStart(first), requestedDay - 1);
  }
  throw new TypeError("unsupported date task kind: " + task.kind);
}
export function gradeDateAnswer(task, answer) {
  if (typeof task?.caseId !== "string" || task.caseId.length === 0) throw new TypeError("task.caseId required");
  const expected = expectedDate(task);
  let outcome;
  if (typeof answer !== "string" || !ISO_DATE.test(answer.trim())) outcome = "malformed";
  else outcome = answer.trim() === expected ? "pass" : "fail";
  const evidenceSha256 = sha256(canonical({caseId: task.caseId, task, answer: typeof answer === "string" ? answer : null, expected, outcome}));
  return {caseId: task.caseId, family: FAMILY, outcome, expected, evidenceSha256};
}
