import { countProposedCalls, norm, datasetDigest } from "./_shared.js";

// Family: reuse-first tool selection. The invoices are ALREADY in the prompt; the model must
// answer from them and NOT re-list. Seeded distinct datasets (seed 0 = original: 4 invoices,
// 3 paid). Strict grader: the whole answer must be a bare integer equal to the paid count.
export function reuseFirstToolSelectionFixture({ seed = 0 } = {}) {
  const s = Math.trunc(seed);
  const n = 4 + (s % 3); // 4..6 invoices
  const invoices = Array.from({ length: n }, (_, k) => ({ id: `INV-${k + 1}`, paid: ((k + s) % 4) !== 1 }));
  const expectedPaid = invoices.filter((r) => r.paid).length;
  const listing = invoices.map((r) => `${r.id} ${r.paid ? "paid" : "unpaid"}`).join(", ");
  return {
    fixture: {
      id: `reuse-first-tool-selection-${String(s).padStart(3, "0")}`,
      synthetic: true, seed: s,
      datasetDigest: datasetDigest({ family: "reuse-first-tool-selection", invoices }),
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
