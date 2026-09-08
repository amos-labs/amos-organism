import { norm, datasetDigest } from "./_shared.js";

// Family: date-time reasoning. Add days to a start date across a month boundary. Seeded distinct
// (start date + offset vary; seed 0 = 2026-02-27 + 3 days = 2026-03-02, non-leap Feb). Strict
// verifier: the whole answer must be the exact resulting date as YYYY-MM-DD.
export function dateTimeFixture({ seed = 0 } = {}) {
  const s = Math.trunc(seed);
  // Fixed start in late Feb 2026 (non-leap); each seed adds a distinct number of days so the
  // resulting date is unique per seed while always crossing the Feb->Mar boundary. seed 0 = +3.
  const start = new Date(Date.UTC(2026, 1, 27));
  const addDays = 3 + s;
  const result = new Date(start.getTime());
  result.setUTCDate(result.getUTCDate() + addDays);
  const iso = (d) => d.toISOString().slice(0, 10);
  const expected = iso(result);
  return {
    fixture: {
      id: `date-time-${String(s).padStart(3, "0")}`,
      synthetic: true, seed: s,
      datasetDigest: datasetDigest({ family: "date-time", start: iso(start), addDays }),
      prompt: `The start date is ${iso(start)}. Add ${addDays} calendar days. Reply with ONLY the resulting date as YYYY-MM-DD (four-digit year, zero-padded month and day), no words.`,
    },
    tools: [
      { name: "month_lengths", description: "Return the number of days in each month (Jan..Dec) for a given year.", readOnly: true, parallelSafe: true,
        parameters: { type: "object", properties: { year: { type: "integer" } }, required: ["year"], additionalProperties: false },
        handler: async ({ year }, { signal } = {}) => { if (signal?.aborted) throw new Error("aborted");
          const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
          return { ok: true, year, lengths: [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] }; } },
    ],
    verify: (execution) => {
      const answer = norm(execution?.answer);
      const wellFormed = /^\d{4}-\d{2}-\d{2}$/.test(answer);
      const correct = wellFormed && answer === expected;
      return { verdict: correct ? "pass" : "fail", family: "date-time", expected, got: wellFormed ? answer : null,
        reason: !wellFormed ? "answer is not a bare YYYY-MM-DD date" : (!correct ? "wrong resulting date" : "ok") };
    },
  };
}
