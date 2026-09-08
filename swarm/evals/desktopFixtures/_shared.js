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

// Stable semantic digest of a fixture's seeded dataset (task/world content), independent of its
// case id. The cohort builder deduplicates by this so two seeds that yield the same task are not
// counted as distinct cases, and holdout seeds can be chosen disjoint from inspected development
// cases (Codex 20260908T023953Z). FNV-1a over a canonical JSON with sorted keys.
export function datasetDigest(value) {
  const canonical = JSON.stringify(value, (_k, v) =>
    (v && typeof v === "object" && !Array.isArray(v))
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
      : v);
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
