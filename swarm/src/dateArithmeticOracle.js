import { createHash } from "node:crypto";

// Deterministic date-arithmetic grader for the development panel's date-time family
// (the family S7 regressed on: correct month_lengths retrieval, wrong final date).
// It independently computes the expected calendar-correct date and grades a candidate
// answer, emitting the { caseId, family, outcome, evidenceSha256 } shape the
// development checkpoint selector consumes. Pure, UTC-only (no timezone drift), no
// model/tool/GPU calls. This is the OWNER answer grader; the selector never checks
// answers itself.

const FAMILY = "date-time";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const canonical = (v) => JSON.stringify(sortKeys(v));
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

// Days in a 1-based month of a given year (UTC): day 0 of the next month.
export function monthLength(year, month) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new TypeError("monthLength(year, month:1-12) required");
  }
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// Compute the calendar-correct expected answer for a supported task spec.
export function expectedDate(task) {
  if (!task || typeof task !== "object") throw new TypeError("date task required");
  if (task.kind === "date-add") {
    if (!ISO_DATE.test(task.start ?? "")) throw new TypeError("date-add.start must be YYYY-MM-DD");
    if (!Number.isInteger(task.addDays)) throw new TypeError("date-add.addDays integer required");
    const base = new Date(`${task.start}T00:00:00.000Z`);
    if (Number.isNaN(base.getTime())) throw new TypeError("date-add.start is not a real date");
    return new Date(base.getTime() + task.addDays * 86400000).toISOString().slice(0, 10);
  }
  if (task.kind === "month-length-resolve") {
    // A requested day that overflows its month rolls into the following month(s),
    // exactly the month_lengths boundary case S7 got wrong.
    const { year, month, requestedDay } = task;
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) throw new TypeError("month-length-resolve year/month required");
    if (!Number.isInteger(requestedDay) || requestedDay < 1) throw new TypeError("month-length-resolve.requestedDay >= 1 required");
    let y = year, m = month, remaining = requestedDay;
    while (remaining > monthLength(y, m)) { remaining -= monthLength(y, m); m += 1; if (m > 12) { m = 1; y += 1; } }
    return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(remaining).padStart(2, "0")}`;
  }
  throw new TypeError("unsupported date task kind: " + task.kind);
}

// Grade a candidate answer. Non-ISO output is 'malformed'; a wrong date is 'fail';
// the calendar-correct date is 'pass'. Returns the selector-report case shape.
export function gradeDateAnswer(task, answer) {
  if (typeof task?.caseId !== "string" || task.caseId.length === 0) throw new TypeError("task.caseId required");
  const expected = expectedDate(task);
  let outcome;
  if (typeof answer !== "string" || !ISO_DATE.test(answer.trim())) outcome = "malformed";
  else outcome = answer.trim() === expected ? "pass" : "fail";
  const evidenceSha256 = sha256(canonical({ caseId: task.caseId, task, answer: typeof answer === "string" ? answer : null, expected, outcome }));
  return { caseId: task.caseId, family: FAMILY, outcome, expected, evidenceSha256 };
}
