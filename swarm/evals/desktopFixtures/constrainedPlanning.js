import { countProposedCalls, norm, datasetDigest } from "./_shared.js";

// Family: constrained planning. Accomplish the goal within a stated tool-call BUDGET AND with
// exact target coverage: read each account exactly once (proven from PRIVATE handler state), use
// get_account_balance at most `budget` times, and report the total. A correct total with zero
// reads, duplicate reads of one account, or only rejected reads all FAIL (Codex 20260908T023953Z).
export function constrainedPlanningFixture({ seed = 0 } = {}) {
  const s = Math.trunc(seed);
  const n = 2 + (s % 2); // 2..3 accounts
  const accounts = Array.from({ length: n }, (_, k) => ({ id: `ACC-${k + 1}`, balance: 1000 + (k + 1) * 250 + s * 37 }));
  const budget = n;
  const total = accounts.reduce((sum, a) => sum + a.balance, 0);
  const ids = accounts.map((a) => a.id);
  const world = { successfulReads: new Map() }; // account id -> successful read count
  const abortIf = (signal) => { if (signal?.aborted) throw new Error("aborted"); };
  return {
    fixture: {
      id: `constrained-planning-${String(s).padStart(3, "0")}`,
      synthetic: true, seed: s,
      datasetDigest: datasetDigest({ family: "constrained-planning", accounts, budget }),
      prompt: `Report the TOTAL balance across all ${n} accounts (${ids.join(", ")}). You may call get_account_balance at MOST ${budget} times — plan so you read each account exactly once. Reply with the total as a bare integer, no words.`,
    },
    tools: [
      { name: "get_account_balance", description: "Return the balance of one account by id.", readOnly: true, parallelSafe: true,
        parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        handler: async ({ id }, { signal } = {}) => { abortIf(signal);
          const acc = accounts.find((a) => a.id === id);
          if (!acc) return { ok: false, id, error: "unknown account" };
          world.successfulReads.set(id, (world.successfulReads.get(id) ?? 0) + 1);
          return { ok: true, id, balance: acc.balance }; } },
    ],
    verify: (execution) => {
      const calls = countProposedCalls(execution, "get_account_balance");
      const withinBudget = calls <= budget;
      // Exact coverage from private state: every account read successfully exactly once, no extras.
      const reads = world.successfulReads;
      const exactCoverage = reads.size === ids.length && ids.every((id) => reads.get(id) === 1)
        && [...reads.keys()].every((id) => ids.includes(id));
      const answer = norm(execution?.answer);
      const isBareInteger = /^(?:0|[1-9][0-9]*)$/.test(answer);
      const got = isBareInteger ? Number(answer) : null;
      const correct = got === total;
      const pass = withinBudget && exactCoverage && correct;
      return { verdict: pass ? "pass" : "fail", family: "constrained-planning", budget, calls, expected: total, got,
        successfulReads: reads.size, exactCoverage,
        reason: !withinBudget ? `exceeded the ${budget}-call budget (used ${calls})`
          : (!exactCoverage ? "did not read each account exactly once (coverage)" : (!isBareInteger ? "answer is not a bare integer" : (!correct ? "wrong total" : "ok"))) };
    },
  };
}
