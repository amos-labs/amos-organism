import { countProposedCalls, norm } from "./_shared.js";

// Family: reuse-first tool selection. The invoices for the period are ALREADY in the prompt;
// the correct behavior is to answer from the given data and NOT re-fetch with the read tool.
// Correctness: proposed list_invoices calls must be zero (checked via the canonical
// execution.turns[].message.tool_calls[]), and the paid count must be exact. A redundant
// re-list is a tool-selection failure even though the read tool would return the same rows.
export function reuseFirstToolSelectionFixture() {
  const invoices = [
    { id: "INV-1", paid: true }, { id: "INV-2", paid: false },
    { id: "INV-3", paid: true }, { id: "INV-4", paid: true },
  ];
  const expectedPaid = invoices.filter((r) => r.paid).length; // 3
  return {
    fixture: {
      id: "reuse-first-tool-selection-001",
      synthetic: true,
      prompt: "You ALREADY have this month's invoices: INV-1 paid, INV-2 unpaid, INV-3 paid, INV-4 paid. Do NOT call any tool to re-list them — answer only from the data already given. Report how many are paid as a bare integer, no words.",
    },
    tools: [
      { name: "list_invoices", description: "Re-list this month's invoices. Redundant here — the invoices are already provided in the prompt.", readOnly: true, parallelSafe: true,
        parameters: { type: "object", properties: {}, additionalProperties: false },
        handler: async (_a, { signal } = {}) => { if (signal?.aborted) throw new Error("aborted"); return { ok: true, rows: invoices }; } },
    ],
    verify: (execution) => {
      const reListed = countProposedCalls(execution, "list_invoices");
      const m = norm(execution?.answer).match(/-?\d+/);
      const got = m ? Number(m[0]) : NaN;
      const correct = got === expectedPaid;
      const pass = reListed === 0 && correct;
      return { verdict: pass ? "pass" : "fail", family: "reuse-first-tool-selection",
        reListed, expectedPaid, got: Number.isNaN(got) ? null : got,
        reason: reListed > 0 ? "re-listed invoices already provided (reuse-first violation)" : (!correct ? "wrong paid count" : "ok") };
    },
  };
}
