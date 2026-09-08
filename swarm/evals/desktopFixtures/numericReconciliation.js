import { norm, datasetDigest } from "./_shared.js";

// Family: numeric reconciliation. Read two synthetic ledgers and report the exact signed
// difference (A total - B total). Seeded: seed selects a distinct, deterministic dataset so a
// cohort of N cases is N distinct tasks (not one repeated). seed 0 reproduces the original case.
// Strict grader: the ENTIRE normalized answer must be a signed integer literal equal to the
// difference — a number extracted from prose ("75.9", "not 75", "75 is wrong; 74") never passes.
export function numericReconciliationFixture({ seed = 0 } = {}) {
  const s = Math.trunc(seed);
  const ledgerA = [{ id: "a1", amount: 1250 + s * 5 }, { id: "a2", amount: 375 }, { id: "a3", amount: 4090 }];
  const ledgerB = [{ id: "b1", amount: 1250 }, { id: "b2", amount: 400 }, { id: "b3", amount: 3990 - s * 10 }];
  const totalA = ledgerA.reduce((sum, r) => sum + r.amount, 0);
  const totalB = ledgerB.reduce((sum, r) => sum + r.amount, 0);
  const expected = totalA - totalB; // seed 0 -> 75
  const world = { readA: false, readB: false };
  return {
    fixture: {
      id: `numeric-reconciliation-${String(s).padStart(3, "0")}`,
      synthetic: true, seed: s,
      datasetDigest: datasetDigest({ family: "numeric-reconciliation", ledgerA, ledgerB }),
      prompt: "Two ledgers, A and B, hold amounts in whole dollars. Read both with the tools, sum each, and report ONLY the signed difference (total A minus total B) as a bare integer, no words or currency sign.",
    },
    tools: [
      { name: "read_ledger_a", description: "Return ledger A rows [{id, amount}].", readOnly: true, parallelSafe: true,
        parameters: { type: "object", properties: {}, additionalProperties: false },
        handler: async (_a, { signal } = {}) => { if (signal?.aborted) throw new Error("aborted"); world.readA = true; return { ok: true, rows: ledgerA }; } },
      { name: "read_ledger_b", description: "Return ledger B rows [{id, amount}].", readOnly: true, parallelSafe: true,
        parameters: { type: "object", properties: {}, additionalProperties: false },
        handler: async (_a, { signal } = {}) => { if (signal?.aborted) throw new Error("aborted"); world.readB = true; return { ok: true, rows: ledgerB }; } },
    ],
    verify: (execution) => {
      const answer = norm(execution?.answer);
      const isBareInteger = /^-?(?:0|[1-9][0-9]*)$/.test(answer);
      const got = isBareInteger ? Number(answer) : null;
      const readBoth = world.readA && world.readB; // both ledgers must be read (data is not in the prompt)
      const correct = got === expected && readBoth;
      return { verdict: correct ? "pass" : "fail", family: "numeric-reconciliation", expected, got, readBoth,
        reason: !readBoth ? "did not read both ledgers" : (!isBareInteger ? "answer is not a bare signed integer" : (got !== expected ? "wrong difference" : "ok")) };
    },
  };
}
