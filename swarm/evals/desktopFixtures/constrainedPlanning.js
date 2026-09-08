import { countProposedCalls, norm } from "./_shared.js";

// Family: constrained planning. Accomplish the goal within a stated tool-call BUDGET — read each
// account exactly once and report the total, using get_account_balance at most `budget` times.
// Exceeding the budget is a planning failure even if the total is right. Seeded distinct
// (account set + balances + budget vary; seed 0 = two accounts). Strict bare-integer answer.
export function constrainedPlanningFixture({ seed = 0 } = {}) {
  const s = Math.trunc(seed);
  const n = 2 + (s % 2); // 2..3 accounts
  const accounts = Array.from({ length: n }, (_, k) => ({ id: `ACC-${k + 1}`, balance: 1000 + (k + 1) * 250 + s * 37 }));
  const budget = n; // exactly one read per account
  const total = accounts.reduce((sum, a) => sum + a.balance, 0);
  const ids = accounts.map((a) => a.id).join(", ");
  return {
    fixture: {
      id: `constrained-planning-${String(s).padStart(3, "0")}`,
      synthetic: true, seed: s,
      prompt: `Report the TOTAL balance across all ${n} accounts (${ids}). You may call get_account_balance at MOST ${budget} times — plan so you read each account exactly once. Reply with the total as a bare integer, no words.`,
    },
    tools: [
      { name: "get_account_balance", description: "Return the balance of one account by id.", readOnly: true, parallelSafe: true,
        parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        handler: async ({ id }, { signal } = {}) => { if (signal?.aborted) throw new Error("aborted");
          const acc = accounts.find((a) => a.id === id);
          return acc ? { ok: true, id, balance: acc.balance } : { ok: false, id, error: "unknown account" }; } },
    ],
    verify: (execution) => {
      const calls = countProposedCalls(execution, "get_account_balance");
      const withinBudget = calls <= budget;
      const answer = norm(execution?.answer);
      const isBareInteger = /^(?:0|[1-9][0-9]*)$/.test(answer);
      const got = isBareInteger ? Number(answer) : null;
      const correct = got === total;
      const pass = withinBudget && correct;
      return { verdict: pass ? "pass" : "fail", family: "constrained-planning", budget, calls, expected: total, got,
        reason: !withinBudget ? `exceeded the ${budget}-call budget (used ${calls})` : (!isBareInteger ? "answer is not a bare integer" : (!correct ? "wrong total" : "ok")) };
    },
  };
}
