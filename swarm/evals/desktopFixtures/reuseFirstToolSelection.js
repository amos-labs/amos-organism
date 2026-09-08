import { countProposedCalls, norm, datasetDigest } from "./_shared.js";

// Family: reuse-first tool selection. The invoices are ALREADY in the prompt; the model must
// answer from them and NOT re-list. The DECISION-relevant data (which invoices are paid, and the
// count) varies with a large period via a seeded paid mask, so a held-out cohort has genuinely new
// DECISIONS — not just new distractor amounts (Codex 20260908T053845Z). datasetDigest covers the
// full case (incl. amounts); decisionDigest covers only the answer-relevant projection, and the
// cohort/holdout builder deduplicates on the decision projection.
export function reuseFirstToolSelectionFixture({ seed = 0 } = {}) {
  const s = Math.trunc(seed);
  const n = 4 + (s % 5); // 4..8 invoices
  // Seeded paid mask: low n bits of an odd-multiplier hash cycle with period 2^n, so paid
  // patterns (and counts) do not repeat every 12 seeds.
  const mask = (Math.imul(s + 1, 2654435761) >>> 0);
  const invoices = Array.from({ length: n }, (_, k) => ({
    id: `INV-${k + 1}`,
    paid: ((mask >> k) & 1) === 1,
    amount: 80 + (k + 1) * 20 + s * 7, // distractor; not answer-relevant
  }));
  const paidPattern = invoices.map((r) => (r.paid ? 1 : 0));
  const expectedPaid = paidPattern.reduce((a, b) => a + b, 0);
  const listing = invoices.map((r) => `${r.id} $${r.amount} ${r.paid ? "paid" : "unpaid"}`).join(", ");
  return {
    fixture: {
      id: `reuse-first-tool-selection-${String(s).padStart(3, "0")}`,
      synthetic: true, seed: s,
      datasetDigest: datasetDigest({ family: "reuse-first-tool-selection", invoices }),
      decisionDigest: datasetDigest({ family: "reuse-first-tool-selection", paidPattern, expectedPaid }),
      prompt: `You ALREADY have this month's invoices: ${listing}. Do NOT call any tool to re-list them — answer only from the data already given. Report how many are paid as a bare integer, no words.`,
    },
    tools: [
      { name: "list_invoices", description: "Re-list this month's invoices. Redundant here — the invoices are already provided in the prompt.", readOnly: true, parallelSafe: true,
        parameters: { type: "object", properties: {}, additionalProperties: false },
        handler: async (_a, { signal } = {}) => { if (signal?.aborted) throw new Error("aborted"); return { ok: true, rows: invoices }; } },
    ],
    verify: (execution) => {
      const reListed = countProposedCalls(execution, "list_invoices");
      const answer = norm(execution?.answer);
      const isBareInteger = /^(?:0|[1-9][0-9]*)$/.test(answer);
      const got = isBareInteger ? Number(answer) : null;
      const correct = got === expectedPaid;
      const pass = reListed === 0 && correct;
      return { verdict: pass ? "pass" : "fail", family: "reuse-first-tool-selection", reListed, expectedPaid, got, answerWasBareInteger: isBareInteger,
        reason: reListed > 0 ? "re-listed invoices already provided (reuse-first violation)" : (!isBareInteger ? "answer is not a bare integer" : (!correct ? "wrong paid count" : "ok")) };
    },
  };
}
