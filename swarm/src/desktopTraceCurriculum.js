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
 * Parse a native tool exchange into ordered groups, one per assistant tool_calls turn followed by
 * the tool results that answer it. This is the single parser used by both retrieved-data helpers so
 * they share exactly one grouping/binding rule.
 *
 * Each group is an assistant message carrying one or more tool_calls (a serial single call, or the
 * real Desktop PARALLEL representation of several calls in one turn) followed by exactly one tool
 * result per call id. Results are matched to their group's pending call ids: an orphan (id not issued
 * by this group), a duplicate (id answered twice) or a missing result all fail closed. The retrieved
 * context is preserved in order; callers decide which trailing group is the supervised decision.
 */
function parseNativeExchange(turns, label) {
  const groups = [];
  let index = 0;
  while (index < turns.length) {
    const call = turns[index];
    requireAssistantToolCall(call, `${label} group ${groups.length}`);
    const callIds = call.tool_calls.map((tc, i) => {
      const id = tc?.id;
      if (typeof id !== "string" || id.length === 0) throw new Error(`${label} group ${groups.length} tool_call ${i} needs an id`);
      return id;
    });
    if (new Set(callIds).size !== callIds.length) throw new Error(`${label} group ${groups.length} has duplicate tool_call ids`);
    index += 1;
    const pending = new Set(callIds);
    const results = [];
    while (index < turns.length && turns[index]?.role === "tool") {
      const result = turns[index];
      const id = result.tool_call_id;
      if (!pending.has(id)) throw new Error(`${label} group ${groups.length} result has an unmatched tool_call_id ${JSON.stringify(id)} (orphan or duplicate)`);
      pending.delete(id);
      results.push(result);
      index += 1;
    }
    if (pending.size > 0) throw new Error(`${label} group ${groups.length} is missing tool results for ${[...pending].join(", ")}`);
    groups.push({ call, results });
  }
  return groups;
}

/** Flatten parsed groups back to their native message order (call then its results). */
function flattenGroups(groups) {
  return groups.flatMap((group) => [group.call, ...group.results]);
}

/**
 * True when `value` appears in `text` as a standalone number: not part of a larger integer and not
 * the head of a longer decimal. A trailing sentence period ("USD 38000. Compute") still counts as a
 * match, while "380001" and "38000.5" do not.
 */
function numberAppears(text, value) {
  const token = String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<!\\d)(?<!\\d\\.)${token}(?!\\d)(?!\\.\\d)`).test(text);
}

/**
 * Fail closed if a supervised desktop_calculate call carries a LITERAL operand value that is not
 * grounded in the available evidence (the user prompt plus any prior tool results). This prevents a
 * "verified" tool receipt from teaching an invented, unsupported operand (Codex 134029Z): a real
 * Decimal result for 40000-18000 does not make the injected 18000 authorized when the prompt never
 * supplied it. Step-reference operands and non-calculator calls are not literal facts and are skipped.
 */
function assertCalculatorOperandProvenance(call, groundingText, label) {
  const toolCall = call?.tool_calls?.[0];
  if (!toolCall || toolCall.function?.name !== "desktop_calculate") return;
  const raw = toolCall.function.arguments;
  let args;
  try { args = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { throw new Error(`${label}: desktop_calculate arguments are not valid JSON`); }
  for (const step of args?.steps ?? []) {
    for (const operand of step?.operands ?? []) {
      if (operand && typeof operand.value === "number" && !numberAppears(groundingText, operand.value)) {
        throw new Error(`${label}: supervised operand ${operand.value} (${operand.unit ?? "no unit"}) is not grounded in the prompt or prior tool results`);
      }
    }
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
  const base = { sourceEpisodeId: `desktop-trace-${prefix}`, taskFamily, role, correction: null, safeguards: DEVELOPMENT_SAFEGUARDS };
  // The supervised corrected call may only use operand literals the user prompt actually supplied.
  assertCalculatorOperandProvenance(correctedCall, user, `desktop trace ${prefix} corrected call`);
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

/**
 * Derive development examples from ONE clean retrieved-data trajectory: the model must READ data
 * with tools, then choose the calculator on the retrieved operands, then answer. Shape is
 * [system, user, (read call, read result)+, calculate call, calculate result, final answer] — a
 * clean multi-tool exchange with NO fabricated recovery error. This targets the v3 gap of choosing
 * the calculator after retrieval; from it we mint two examples, each supervising one verified target
 * with the PRIOR turns kept as masked context:
 *
 *  - `retrieved-tool-call`   — the ledger reads/results are masked context; the valid native
 *                              calculate call is supervised. We never mint a context-free arithmetic
 *                              target here, because the operands came from the reads.
 *  - `checked-final-answer`  — the whole read+calculate exchange is masked context; the checked final
 *                              answer is supervised.
 */
export function retrievedDataTraceExamples(trajectory, { idPrefix, taskFamily = "numeric-reconciliation", role = "reconciliation-specialist" } = {}) {
  const messages = trajectory?.messages;
  if (!Array.isArray(messages) || messages.length < 7) {
    throw new Error("retrieved-data trace must be [system, user, (read group)+, calculate group, final answer]");
  }
  const systemMessage = messages[0];
  const userMessage = messages[1];
  const finalAnswer = messages[messages.length - 1];
  if (systemMessage?.role !== "system" || typeof systemMessage.content !== "string") throw new Error("the first message must be a system prompt");
  if (userMessage?.role !== "user" || typeof userMessage.content !== "string") throw new Error("the second message must be a user prompt");
  if (finalAnswer?.role !== "assistant" || typeof finalAnswer.content !== "string" || finalAnswer.content.length === 0) {
    throw new Error("the final message must be an assistant text answer");
  }
  const groups = parseNativeExchange(messages.slice(2, messages.length - 1), "retrieved-data trace");
  if (groups.length < 2) throw new Error("a retrieved-data trace needs at least one read group and a final calculate group");
  const calculateGroup = groups[groups.length - 1];
  if (calculateGroup.call.tool_calls.length !== 1 || calculateGroup.call.tool_calls[0]?.function?.name !== "desktop_calculate") {
    throw new Error("the final group before the answer must be a single desktop_calculate call");
  }
  const readGroups = groups.slice(0, -1);
  if (readGroups.length < 1) throw new Error("a retrieved-data trace needs at least one prior read whose results supply the calculate operands");
  const readTurns = flattenGroups(readGroups);
  const system = systemMessage.content;
  const user = userMessage.content;
  // The supervised calculate operands must be grounded: the prompt or the retrieved read results.
  const readEvidence = `${user} ${readTurns.filter((m) => m.role === "tool").map((m) => m.content).join(" ")}`;
  assertCalculatorOperandProvenance(calculateGroup.call, readEvidence, `retrieved-data trace ${idPrefix ?? trajectory.id ?? "retrieved-trace"} calculate call`);
  const prefix = idPrefix ?? trajectory.id ?? "retrieved-trace";
  const tools = trajectory.tools;
  const base = { sourceEpisodeId: `retrieved-trace-${prefix}`, taskFamily, role, correction: null, safeguards: DEVELOPMENT_SAFEGUARDS };
  // Read-prefix supervised targets: the diagnosis found the read calls only ever appear as masked
  // context, so the model was never trained to READ. Supervise each read call in turn, with just
  // the earlier reads as context, so the model learns to fetch the data it needs before computing.
  const readPrefixExamples = readGroups.map((readGroup, index) => ({
    ...base, id: `${prefix}:read-prefix-${index}`,
    input: { system, user, toolTrace: { contextTurns: flattenGroups(readGroups.slice(0, index)), tools } },
    target: { kind: "retrieved-tool-call", content: readGroup.call.content ?? null, toolCalls: readGroup.call.tool_calls }
  }));
  return [
    ...readPrefixExamples,
    {
      ...base, id: `${prefix}:retrieved-tool-call`,
      input: { system, user, toolTrace: { contextTurns: readTurns, tools } },
      target: { kind: "retrieved-tool-call", content: calculateGroup.call.content ?? null, toolCalls: calculateGroup.call.tool_calls }
    },
    {
      ...base, id: `${prefix}:checked-final-answer`,
      input: { system, user, toolTrace: { contextTurns: [...readTurns, ...flattenGroups([calculateGroup])], tools } },
      target: { kind: "verified-synthesis", content: finalAnswer.content }
    }
  ];
}

/** Compile every retrieved-data trajectory into its validated AMOS system training examples. */
export function compileRetrievedDataTraceExamples(trajectories, options = {}) {
  if (!Array.isArray(trajectories)) throw new Error("trajectories must be an array");
  return trajectories.flatMap((trajectory, index) =>
    retrievedDataTraceExamples(trajectory, { idPrefix: trajectory.id ?? `retrieved-${index}`, ...options }).map(createAmosSystemTrainingExample)
  );
}

/**
 * Derive a development example from ONE retrieval-then-reasoned-answer trajectory:
 * [system, user, (read call, read result)+, checked final answer]. Unlike the read->calculate
 * shape there is no intermediate compute tool — the answer is reasoned from the retrieved reference
 * (e.g. read month lengths, then return the correct date). This targets the v3 date-overflow miss,
 * where the candidate read the reference and still returned a wrong date.
 *
 * We mint a single `checked-final-answer` example: the read call(s)/result(s) are masked CONTEXT and
 * the checked final answer is SUPERVISED. We do NOT mint a context-free answer target, because the
 * answer depends on the retrieved reference; the reads are never dropped from that decision.
 */
export function retrievedAnswerTraceExamples(trajectory, { idPrefix, taskFamily = "date-time", role = "reference-grounded-answerer" } = {}) {
  const messages = trajectory?.messages;
  if (!Array.isArray(messages) || messages.length < 5) {
    throw new Error("retrieved-answer trace must be [system, user, (read group)+, final answer]");
  }
  const systemMessage = messages[0];
  const userMessage = messages[1];
  const finalAnswer = messages[messages.length - 1];
  if (systemMessage?.role !== "system" || typeof systemMessage.content !== "string") throw new Error("the first message must be a system prompt");
  if (userMessage?.role !== "user" || typeof userMessage.content !== "string") throw new Error("the second message must be a user prompt");
  if (finalAnswer?.role !== "assistant" || typeof finalAnswer.content !== "string" || finalAnswer.content.length === 0) {
    throw new Error("the final message must be an assistant text answer");
  }
  const readTurns = messages.slice(2, messages.length - 1);
  const readGroups = parseNativeExchange(readTurns, "retrieved-answer trace");
  if (readGroups.length < 1) throw new Error("a retrieved-answer trace needs at least one prior read whose result grounds the answer");
  const system = systemMessage.content;
  const user = userMessage.content;
  const prefix = idPrefix ?? trajectory.id ?? "retrieved-answer-trace";
  const tools = trajectory.tools;
  const base = { sourceEpisodeId: `retrieved-answer-trace-${prefix}`, taskFamily, role, correction: null, safeguards: DEVELOPMENT_SAFEGUARDS };
  // Read-prefix supervised targets: the reference reads (e.g. month_lengths) otherwise appear only
  // as masked context, so the model was never trained to fetch the reference it reasons from.
  // Supervise each read call in turn, with only the earlier reads as context.
  const readPrefixExamples = readGroups.map((readGroup, index) => ({
    ...base, id: `${prefix}:read-prefix-${index}`,
    input: { system, user, toolTrace: { contextTurns: flattenGroups(readGroups.slice(0, index)), tools } },
    target: { kind: "retrieved-tool-call", content: readGroup.call.content ?? null, toolCalls: readGroup.call.tool_calls }
  }));
  return [
    ...readPrefixExamples,
    {
      ...base, id: `${prefix}:checked-final-answer`,
      input: { system, user, toolTrace: { contextTurns: readTurns, tools } },
      target: { kind: "verified-synthesis", content: finalAnswer.content }
    }
  ];
}

/** Compile every retrieval-then-answer trajectory into its validated AMOS system training examples. */
export function compileRetrievedAnswerTraceExamples(trajectories, options = {}) {
  if (!Array.isArray(trajectories)) throw new Error("trajectories must be an array");
  return trajectories.flatMap((trajectory, index) =>
    retrievedAnswerTraceExamples(trajectory, { idPrefix: trajectory.id ?? `retrieved-answer-${index}`, ...options }).map(createAmosSystemTrainingExample)
  );
}
