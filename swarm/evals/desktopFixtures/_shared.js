// Helpers shared by the Organism-owned Desktop-eval fixtures.
// Each fixture is a pure factory returning { fixture, tools, verify } matching
// amos-agent src/evals/desktopFixtureRunner.js (runDesktopFixture). The controller
// (Codex) supplies modelConfig/fetchImpl/expectedServedModel/limits and the transport;
// fixtures supply only the synthetic prompt, trusted deterministic tool handlers over a
// PRIVATE world object, and an independent verifier. No network, no randomness.
//
// Correct verifier discipline (Codex 20260907T174205Z, reproduced false passes in #58):
//  - PROPOSED calls (including rejected/forbidden ones) live in
//    execution.turns[].message.tool_calls[] with { id, function:{ name, arguments } };
//    there is NO top-level toolCalls field and NO tool_call event. Use countProposedCalls
//    to guard against forbidden proposals.
//  - SUCCESSFUL effects are proven by PRIVATE world state that the trusted handler mutates
//    only on a valid target, then re-read (never by a proposal or ledger count). A proposed
//    or rejected action must never count as a completed effect.

export function countProposedCalls(execution, name) {
  const turns = Array.isArray(execution?.turns) ? execution.turns : [];
  let n = 0;
  for (const t of turns) {
    const calls = t?.message?.tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const c of calls) if ((c?.function?.name ?? c?.name) === name) n += 1;
  }
  return n;
}

export function norm(answer) {
  return String(answer ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}
