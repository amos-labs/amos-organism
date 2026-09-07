// Helpers shared by the Organism-owned Desktop-eval fixtures.
// Each fixture is a pure factory returning { fixture, tools, verify } matching
// amos-agent src/evals/desktopFixtureRunner.js (runDesktopFixture). The controller
// (Codex) supplies modelConfig/fetchImpl/expectedServedModel/limits and the transport;
// fixtures supply only the synthetic prompt, trusted deterministic tool handlers and an
// independent verifier. No real external tools, no network, no randomness.

// Count how many times a named tool was invoked in an execution result. Defensive across
// the runner's reported shapes (toolCalls[] or loop events with a tool_call/tool name);
// the exact field is confirmed against the runner in the integration harness.
export function countToolCalls(execution, name) {
  if (!execution || typeof execution !== "object") return 0;
  const calls = Array.isArray(execution.toolCalls) ? execution.toolCalls : null;
  if (calls) return calls.filter((c) => (c?.name ?? c?.tool ?? c?.function?.name) === name).length;
  const events = Array.isArray(execution.events) ? execution.events : [];
  return events.filter((e) => (e?.type === "tool_call" || e?.kind === "tool_call") &&
    (e?.name ?? e?.tool ?? e?.toolName) === name).length;
}

// A trusted handler that records each call into a shared, per-run mutable ledger so a
// verifier can assert side-effect-once semantics (recover-without-replaying).
export function recordingHandler(ledger, key, result) {
  return async (_args, { signal } = {}) => {
    if (signal?.aborted) throw new Error("aborted");
    ledger[key] = (ledger[key] ?? 0) + 1;
    return typeof result === "function" ? result(_args) : result;
  };
}

// Normalize the model's final answer for comparison (trim, collapse whitespace, lower).
export function norm(answer) {
  return String(answer ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}
