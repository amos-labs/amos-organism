import { countProposedCalls, norm, datasetDigest } from "./_shared.js";

// Family: constrained planning. Accomplish the goal within a stated tool-call BUDGET AND with
// exact target coverage: read each account exactly once (proven from PRIVATE handler state), use
// get_account_balance at most `budget` times, and report the total. A correct total with zero
// reads, duplicate reads of one account, or only rejected reads all FAIL (Codex 20260908T023953Z).
export function constrainedPlanningFixture({ seed = 0 } = {}) {
  const s = Math.trunc(seed);
  const n = 2 + (s % 2); // 2..3 accounts
  const accounts = Array.from({ length: n }, (_, k) => ({ id: `ACC-${k + 1}`, balance: 1000 + (k + 1) * 250 + s * 37 }));
  return constrainedPlanningFromAccounts({ accounts, budget: n, id: `constrained-planning-${String(s).padStart(3, "0")}`, seed: s });
}

// Shared native budget/coverage contract for authored development accounts. Fresh tool closures
// and private read state per invocation; no data or expected answer enters the prompt. budget is
// the exact number of accounts, so the plan must read each account exactly once.
export function constrainedPlanningFromAccounts({ accounts, budget, id, seed = null }) {
  if (!Array.isArray(accounts) || accounts.length === 0 || accounts.length > 1000) throw new TypeError("bounded nonempty accounts required");
  const ids = new Set();
  for (let i = 0; i < accounts.length; i++) {
    const a = accounts[i];
    if (!a || typeof a.id !== "string" || a.id.length === 0 || a.id.length > 128 || ids.has(a.id) || !Number.isSafeInteger(a.balance)) throw new TypeError("unique account ids and safe integer balances required");
    ids.add(a.id);
  }
  accounts = accounts.map(({ id, balance }) => ({ id, balance }));
  if (!Number.isSafeInteger(budget) || budget !== accounts.length) throw new TypeError("budget must equal the account count");
  if (typeof id !== "string" || id.length === 0 || id.length > 256) throw new TypeError("fixture id required");
  const n = accounts.length;
  const idList = accounts.map((a) => a.id);
  const sum = accounts.reduce((t, a) => t + BigInt(a.balance), 0n);
  if (sum > BigInt(Number.MAX_SAFE_INTEGER) || sum < BigInt(Number.MIN_SAFE_INTEGER)) throw new RangeError("total exceeds safe integer domain");
  const total = Number(sum);
  const world = { successfulReads: new Map() };
  const abortIf = (signal) => { if (signal?.aborted) throw new Error("aborted"); };
  return {
    fixture: {
      id,
      synthetic: true, seed,
      datasetDigest: datasetDigest({ family: "constrained-planning", accounts, budget }),
      prompt: `Report the TOTAL balance across all ${n} accounts (${idList.join(", ")}). You may call get_account_balance at MOST ${budget} times — plan so you read each account exactly once. Reply with the total as a bare integer, no words.`,
    },
    tools: [
      { name: "get_account_balance", description: "Return the balance of one account by id.", readOnly: true, parallelSafe: true,
        parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        handler: async ({ id: accId }, { signal } = {}) => { abortIf(signal);
          const acc = accounts.find((a) => a.id === accId);
          if (!acc) return { ok: false, id: accId, error: "unknown account" };
          world.successfulReads.set(accId, (world.successfulReads.get(accId) ?? 0) + 1);
          return { ok: true, id: accId, balance: acc.balance }; } },
    ],
    verify: (execution) => {
      const calls = countProposedCalls(execution, "get_account_balance");
      const withinBudget = calls <= budget;
      const reads = world.successfulReads;
      const exactCoverage = reads.size === idList.length && idList.every((id) => reads.get(id) === 1)
        && [...reads.keys()].every((id) => idList.includes(id));
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
