import { createAmosSystemTrainingExample } from "./amosNativeTrainingDataset.js";

// Development-lineage safeguards for rights-cleared synthetic Desktop calculator derivatives.
const DEVELOPMENT_SAFEGUARDS = Object.freeze({
  credentialsRemoved: true,
  tenantFactsRemoved: true,
  hiddenReasoningExcluded: true,
  independentVerifierSelected: true,
  licensedForTraining: true
});

function requireAssistantToolCall(message, label) {
  if (message?.role !== "assistant" || !Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
    throw new Error(`${label} must be an assistant tool_calls message`);
  }
}

/**
 * Derive the development training examples from ONE native Desktop tool trajectory.
 *
 * The trajectory is the recorded seven-message shape: system, user, a failed tool call, its error,
 * the verified corrected call, its tool result, and the checked final answer. From it we mint three
 * examples, all supervising a single verified decision:
 *
 *  - `corrected-tool-call`  — recovery: the failed call and error are MASKED context, the corrected
 *                             call is supervised. The rejected call is never a positive target.
 *  - `first-correct-tool-call` — the corrected call supervised as a clean first action (zero context).
 *  - `checked-final-answer`  — the whole tool exchange is masked context, the final answer supervised.
 *
 * The failed attempt only ever appears as masked context. Callers place these on development lineage
 * (split=development), excluded from fresh validation/holdout.
 */
export function desktopTraceExamples(trajectory, { idPrefix, taskFamily = "calculator-runway", role = "tool-specialist" } = {}) {
  const messages = trajectory?.messages;
  if (!Array.isArray(messages) || messages.length !== 7) {
    throw new Error("desktop trace must be [system, user, call, error, corrected call, result, final answer]");
  }
  const [systemMessage, userMessage, failedCall, toolError, correctedCall, toolResult, finalAnswer] = messages;
  if (systemMessage?.role !== "system" || typeof systemMessage.content !== "string") throw new Error("the first message must be a system prompt");
  if (userMessage?.role !== "user" || typeof userMessage.content !== "string") throw new Error("the second message must be a user prompt");
  const system = systemMessage.content;
  const user = userMessage.content;
  requireAssistantToolCall(failedCall, "the failed call");
  requireAssistantToolCall(correctedCall, "the corrected call");
  if (toolError?.role !== "tool" || toolResult?.role !== "tool") throw new Error("tool results must be tool messages");
  if (finalAnswer?.role !== "assistant" || typeof finalAnswer.content !== "string" || finalAnswer.content.length === 0) {
    throw new Error("the final message must be an assistant text answer");
  }
  const prefix = idPrefix ?? trajectory.id ?? "desktop-trace";
  const tools = trajectory.tools;
  const base = { sourceEpisodeId: `desktop-trace:${prefix}`, taskFamily, role, correction: null, safeguards: DEVELOPMENT_SAFEGUARDS };
  const correctedTarget = { content: correctedCall.content ?? null, toolCalls: correctedCall.tool_calls };
  return [
    {
      ...base, id: `${prefix}:corrected-tool-call`,
      input: { system, user, toolTrace: { contextTurns: [failedCall, toolError], tools } },
      target: { kind: "recovery-transition", ...correctedTarget }
    },
    {
      ...base, id: `${prefix}:first-correct-tool-call`,
      input: { system, user, toolTrace: { contextTurns: [], tools } },
      target: { kind: "tool-call", ...correctedTarget }
    },
    {
      ...base, id: `${prefix}:checked-final-answer`,
      input: { system, user, toolTrace: { contextTurns: [failedCall, toolError, correctedCall, toolResult], tools } },
      target: { kind: "verified-synthesis", content: finalAnswer.content }
    }
  ];
}

/** Compile every native trajectory into its validated AMOS system training examples. */
export function compileDesktopTraceExamples(trajectories, options = {}) {
  if (!Array.isArray(trajectories)) throw new Error("trajectories must be an array");
  return trajectories.flatMap((trajectory, index) =>
    desktopTraceExamples(trajectory, { idPrefix: trajectory.id ?? `trace-${index}`, ...options }).map(createAmosSystemTrainingExample)
  );
}
