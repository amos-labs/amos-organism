import { createHash } from 'node:crypto';
import { executeContinualTool, checkContinualAnswer } from './continualCurriculum.js';

export const CONTINUAL_EVALUATION_PROTOCOL = 'amos.continual-learning-evaluation.v1';
export const CONTINUAL_DEFAULT_ENVIRONMENT_ID = 'continual-curriculum-v1';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const DEFAULT_ENVIRONMENT = Object.freeze({ id: CONTINUAL_DEFAULT_ENVIRONMENT_ID,
  executeTool: executeContinualTool, checkAnswer: checkContinualAnswer });

function nativeEnvironment(task, provided) {
  const id = task.metadata?.environmentId ?? CONTINUAL_DEFAULT_ENVIRONMENT_ID;
  if (typeof id !== 'string' || !/^[a-z][a-z0-9._-]{0,100}$/.test(id)) throw new Error('Invalid native environment identity');
  if (id === CONTINUAL_DEFAULT_ENVIRONMENT_ID && provided === undefined) return DEFAULT_ENVIRONMENT;
  if (!provided || provided.id !== id || typeof provided.executeTool !== 'function' || typeof provided.checkAnswer !== 'function') {
    throw new Error('Task requires its matching native environment adapter');
  }
  if (id === CONTINUAL_DEFAULT_ENVIRONMENT_ID && (provided.executeTool !== executeContinualTool || provided.checkAnswer !== checkContinualAnswer)) {
    throw new Error('Default native environment cannot be replaced');
  }
  return provided;
}

function nativeResult(value) {
  if (value && typeof value.then === 'function') throw new Error('Native environment methods must be synchronous for independent replay');
  return value;
}

function nativeVerdict(value) {
  const verdict = nativeResult(value);
  if (!verdict || ['passed', 'finalAnswerCorrect', 'nativeToolRequirementMet'].some(key => typeof verdict[key] !== 'boolean')) {
    throw new Error('Native environment verdict requires explicit Boolean outcomes');
  }
  return verdict;
}

function responseAction(message, finishReason, toolsRemaining) {
  if (!message || message.role !== 'assistant') throw new Error('Evaluation requires an assistant message');
  if (finishReason === 'length') return { stop: 'output-limit' };
  const toolCalls = message.tool_calls ?? [];
  if (!Array.isArray(toolCalls)) return { stop: 'invalid-tool-calls' };
  if (!toolCalls.length) return { stop: 'final', finalAnswer: message.content ?? '' };
  if (toolCalls.length > toolsRemaining) return { stop: 'tool-limit' };
  const ids = new Set(), parsed = [];
  for (const call of toolCalls) {
    if (!call || call.type !== 'function' || typeof call.id !== 'string' || !call.id || ids.has(call.id) ||
        typeof call.function?.name !== 'string' || typeof call.function.arguments !== 'string') return { stop: 'invalid-tool-calls' };
    ids.add(call.id);
    try {
      const args = JSON.parse(call.function.arguments);
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be object');
      parsed.push({ call, args });
    } catch { return { stop: 'invalid-tool-arguments' }; }
  }
  return { parsed, toolCalls };
}

function validateBudgets({ maxModelCalls, maxToolCalls, maxOutputTokens }) {
  if (!Number.isInteger(maxModelCalls) || maxModelCalls < 1 || maxModelCalls > 4 ||
      !Number.isInteger(maxToolCalls) || maxToolCalls < 0 || maxToolCalls > 3 ||
      !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 1536) throw new Error('Invalid task budget');
}

/** Each task gets a fresh host environment. Only messages/tools enter inference. */
export async function evaluateContinualTask({ task: input, request, onEvent = async () => {},
  signal, maxModelCalls = 4, maxToolCalls = 3, maxOutputTokens = 1536, seed = 20260914, environment }) {
  const budgets = { maxModelCalls, maxToolCalls, maxOutputTokens };
  validateBudgets(budgets);
  const task = copy(input), messages = copy(task.messages), trace = [];
  const native = nativeEnvironment(task, environment);
  let toolsExecuted = 0, calls = 0, finalAnswer = null, stop = 'call-limit';
  const taskSha256 = digest(task);
  await onEvent({ type: 'task-start', taskId: task.id, taskSha256, metadata: task.metadata });
  while (calls < maxModelCalls) {
    signal?.throwIfAborted();
    const observation = await request({ taskId: task.id, messages: copy(messages), tools: copy(task.tools),
      maxOutputTokens, seed, signal });
    calls++;
    const message = observation?.message;
    const turn = { message: copy(message), finishReason: observation.finishReason ?? null, tools: [] };
    trace.push(turn);
    await onEvent({ type: 'model-response', taskId: task.id, call: calls, observation });
    signal?.throwIfAborted();
    const action = responseAction(message, turn.finishReason, maxToolCalls - toolsExecuted);
    if (action.stop) { stop = action.stop; finalAnswer = action.finalAnswer ?? null; break; }
    const { parsed, toolCalls } = action; // Validate the full response before any execution.
    messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: copy(toolCalls) });
    for (const { call, args } of parsed) {
      signal?.throwIfAborted();
      const result = nativeResult(native.executeTool(task, call.function.name, args));
      toolsExecuted++;
      turn.tools.push({ id: call.id, name: call.function.name, args: copy(args), result: copy(result) });
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      await onEvent({ type: 'tool-result', taskId: task.id, ...turn.tools.at(-1) });
    }
  }
  signal?.throwIfAborted();
  const verdict = finalAnswer === null
    ? { passed: false, finalAnswerCorrect: false, nativeToolRequirementMet: false, errors: [stop] }
    : nativeVerdict(native.checkAnswer(task, finalAnswer));
  const result = { protocol: CONTINUAL_EVALUATION_PROTOCOL, taskId: task.id, taskSha256,
    ...(native.id === CONTINUAL_DEFAULT_ENVIRONMENT_ID ? {} : { environmentId: native.id }),
    metadata: task.metadata, budgets, stop, modelCalls: calls, toolCalls: toolsExecuted, finalAnswer, verdict, trace };
  await onEvent({ type: 'task-completed', taskId: task.id, result });
  return result;
}

/** Reconstruct native state from raw tool calls, independently of the saved verdict. */
export function replayContinualTask(taskInput, saved, environment) {
  const task = copy(taskInput);
  const native = nativeEnvironment(task, environment);
  if ((Object.hasOwn(saved, 'environmentId') ? saved.environmentId : CONTINUAL_DEFAULT_ENVIRONMENT_ID) !== native.id) throw new Error('Saved native environment identity mismatch');
  if (saved.taskSha256 !== digest(task) || saved.taskId !== task.id) throw new Error('Task identity mismatch');
  validateBudgets(saved.budgets ?? {});
  const { maxModelCalls, maxToolCalls } = saved.budgets;
  let count = 0, stop = 'call-limit', finalAnswer = null;
  if (saved.protocol !== CONTINUAL_EVALUATION_PROTOCOL || !Array.isArray(saved.trace) ||
      !Number.isInteger(saved.modelCalls) || saved.modelCalls < 1 || saved.trace.length !== saved.modelCalls || saved.modelCalls > maxModelCalls ||
      !Number.isInteger(saved.toolCalls) || saved.toolCalls < 0 || saved.toolCalls > maxToolCalls) throw new Error('Trace budget/count mismatch');
  for (const [turnIndex, turn] of saved.trace.entries()) {
    if (!Object.hasOwn(turn, 'finishReason') || !Array.isArray(turn.tools)) throw new Error('Incomplete response receipt');
    const action = responseAction(turn.message, turn.finishReason, maxToolCalls - count);
    if (action.stop) {
      if (turn.tools.length || turnIndex !== saved.trace.length - 1) throw new Error('Trace continued after terminal response');
      stop = action.stop; finalAnswer = action.finalAnswer ?? null;
      break;
    }
    if (turn.tools.length !== action.parsed.length) throw new Error('Executed calls differ from model output');
    for (const [index, tool] of turn.tools.entries()) {
      const call = turn.message.tool_calls[index];
      if (tool.id !== call.id || tool.name !== call.function.name || digest(tool.args) !== digest(JSON.parse(call.function.arguments))) throw new Error('Tool arguments differ from model output');
      const actual = nativeResult(native.executeTool(task, tool.name, tool.args));
      if (digest(actual) !== digest(tool.result)) throw new Error('Native tool replay mismatch');
      count++;
    }
  }
  if (count !== saved.toolCalls) throw new Error('Native tool count mismatch');
  if (stop === 'call-limit' && saved.modelCalls !== maxModelCalls) throw new Error('Trace ended before a terminal response or call limit');
  if (stop !== saved.stop || digest(finalAnswer) !== digest(saved.finalAnswer)) throw new Error('Final answer or stop differs from model output');
  const actual = finalAnswer === null
    ? { passed: false, finalAnswerCorrect: false, nativeToolRequirementMet: false, errors: [stop] }
    : nativeVerdict(native.checkAnswer(task, finalAnswer));
  if (actual.passed !== saved.verdict.passed || actual.finalAnswerCorrect !== saved.verdict.finalAnswerCorrect ||
      actual.nativeToolRequirementMet !== saved.verdict.nativeToolRequirementMet) throw new Error('Native verdict replay mismatch');
  if (native.id !== CONTINUAL_DEFAULT_ENVIRONMENT_ID && digest(actual) !== digest(saved.verdict)) throw new Error('Native environment outcome evidence differs');
  return { taskId: task.id, passed: actual.passed, toolCalls: count };
}

export function compareContinualPanels({ candidate, parent, anchor, panel, environment }) {
  if (!Array.isArray(panel) || !panel.length || new Set(panel.map(t => t.id)).size !== panel.length) throw new Error('Unique panel required');
  const index = results => {
    if (results.length !== panel.length || new Set(results.map(t => t.taskId)).size !== panel.length) throw new Error('Incomplete comparison');
    const map = new Map(results.map(row => [row.taskId, row]));
    for (const task of panel) {
      const row = map.get(task.id);
      if (!row || row.taskSha256 !== digest(task) || typeof row.verdict?.passed !== 'boolean') throw new Error('Comparison input mismatch');
      replayContinualTask(task, row, environment);
      if (digest(row.budgets) !== digest({ maxModelCalls: 4, maxToolCalls: 3, maxOutputTokens: 1536 })) throw new Error('Comparison budget mismatch');
    }
    return map;
  };
  const c = index(candidate), p = index(parent), a = index(anchor), categories = {};
  for (const task of panel) {
    const category = task.metadata.category;
    const row = categories[category] ??= { total: 0, candidate: 0, parent: 0, anchor: 0, gains: 0, losses: 0 };
    const cv = c.get(task.id).verdict.passed, pv = p.get(task.id).verdict.passed, av = a.get(task.id).verdict.passed;
    row.total++; row.candidate += Number(cv); row.parent += Number(pv); row.anchor += Number(av);
    row.gains += Number(cv && !pv); row.losses += Number(!cv && pv);
  }
  // Development criterion: positive acquisition with no aggregate retention loss in ANY named panel.
  // Qualification remains small and correlated by program; this is not a statistical superiority test.
  const acquisition = categories.acquisition;
  const retention = ['general-retention', 'prior-skill-retention', 'composition-transfer'].map(k => categories[k]);
  const complete = Boolean(acquisition && retention.every(Boolean));
  const acquired = Boolean(acquisition && acquisition.candidate >= acquisition.parent + 2);
  const retained = complete && retention.every(row => row.candidate >= row.parent && row.candidate >= row.anchor);
  const totalCandidate = candidate.filter(r => r.verdict.passed).length;
  const totalParent = parent.filter(r => r.verdict.passed).length;
  return { protocol: CONTINUAL_EVALUATION_PROTOCOL, categories, totalCandidate, totalParent,
    totalAnchor: anchor.filter(r => r.verdict.passed).length, complete,
    acquired, retained, accepted: complete && acquired && retained && totalCandidate > totalParent,
    inference: 'Developmental advancement only; program-correlated tasks do not establish broad or statistical superiority.' };
}
