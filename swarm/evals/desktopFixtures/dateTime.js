import { norm } from "./_shared.js";

// Family: date-time reasoning. Add a number of calendar days to a start date across a month
// boundary (2026 is not a leap year, so February has 28 days). The answer must be exactly the
// resulting date in YYYY-MM-DD form — strict, no prose — so temporal correctness is measured,
// not a date-shaped substring pulled from arbitrary text. A read-only month_lengths tool is
// available for the model to confirm month sizes.
export function dateTimeFixture() {
  const monthLengths2026 = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; // 2026 is not a leap year
  const expected = "2026-03-02"; // 2026-02-27 + 3 days (Feb has 28 days) -> Mar 02
  return {
    fixture: {
      id: "date-time-001",
      synthetic: true,
      prompt: "The start date is 2026-02-27. Add 3 calendar days. Reply with ONLY the resulting date as YYYY-MM-DD (four-digit year, zero-padded month and day), no words.",
    },
    tools: [
      { name: "month_lengths", description: "Return the number of days in each month (Jan..Dec) for a given year.", readOnly: true, parallelSafe: true,
        parameters: { type: "object", properties: { year: { type: "integer" } }, required: ["year"], additionalProperties: false },
        handler: async ({ year }, { signal } = {}) => { if (signal?.aborted) throw new Error("aborted");
          const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
          const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
          return { ok: true, year, lengths }; } },
    ],
    verify: (execution) => {
      const answer = norm(execution?.answer);
      const wellFormed = /^\d{4}-\d{2}-\d{2}$/.test(answer);
      const correct = wellFormed && answer === expected;
      return { verdict: correct ? "pass" : "fail", family: "date-time",
        expected, got: wellFormed ? answer : null,
        reason: !wellFormed ? "answer is not a bare YYYY-MM-DD date" : (!correct ? "wrong resulting date" : "ok") };
    },
  };
}
