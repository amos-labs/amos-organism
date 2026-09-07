import { norm } from "./_shared.js";

// Family: numeric reconciliation. The model must read two synthetic ledgers via read-only
// tools and report the exact signed difference (A total - B total). Deterministic; the
// correct answer is fixed by the stub data, so the verifier is exact, not fuzzy.
export function numericReconciliationFixture() {
  const ledgerA = [{ id: "a1", amount: 1250 }, { id: "a2", amount: 375 }, { id: "a3", amount: 4090 }];
  const ledgerB = [{ id: "b1", amount: 1250 }, { id: "b2", amount: 400 }, { id: "b3", amount: 3990 }];
  const totalA = ledgerA.reduce((s, r) => s + r.amount, 0); // 5715
  const totalB = ledgerB.reduce((s, r) => s + r.amount, 0); // 5640
  const expected = totalA - totalB; // 75
  return {
    fixture: {
      id: "numeric-reconciliation-001",
      synthetic: true,
      prompt: "Two ledgers, A and B, hold amounts in whole dollars. Read both with the tools, sum each, and report ONLY the signed difference (total A minus total B) as a bare integer, no words or currency sign."
    },
    tools: [
      { name: "read_ledger_a", description: "Return ledger A rows [{id, amount}].", readOnly: true, parallelSafe: true,
        parameters: { type: "object", properties: {}, additionalProperties: false },
        handler: async (_a, { signal } = {}) => { if (signal?.aborted) throw new Error("aborted"); return { ok: true, rows: ledgerA }; } },
      { name: "read_ledger_b", description: "Return ledger B rows [{id, amount}].", readOnly: true, parallelSafe: true,
        parameters: { type: "object", properties: {}, additionalProperties: false },
        handler: async (_a, { signal } = {}) => { if (signal?.aborted) throw new Error("aborted"); return { ok: true, rows: ledgerB }; } }
    ],
    verify: (execution) => {
      const a = norm(execution?.answer);
      const m = a.match(/-?\d+/);
      const got = m ? Number(m[0]) : NaN;
      return { verdict: got === expected ? "pass" : "fail", expected, got: Number.isNaN(got) ? null : got, family: "numeric-reconciliation" };
    }
  };
}
