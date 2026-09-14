import test from 'node:test';
import assert from 'node:assert/strict';
import { createContinualTask, buildContinualDemonstration } from '../src/continualCurriculum.js';
import { evaluateContinualTask, replayContinualTask, compareContinualPanels } from '../src/continualLearningEvaluation.js';
const clone = x => JSON.parse(JSON.stringify(x));
function fixture(category = 'acquisition', seed = 1) {
  const task = createContinualTask({ lineageId: 'signed-ledger', split: 'training', seed, category });
  const demo = buildContinualDemonstration(task);
  const call = clone(demo.rows[0].messages.at(-1));
  for (const item of call.tool_calls) if (typeof item.function.arguments !== 'string') item.function.arguments = JSON.stringify(item.function.arguments);
  return { task, call, answer: demo.rows[1].messages.at(-1) };
}
test('executes the model-selected explicit operation and independently replays completion', async () => {
  const { task, call, answer } = fixture();
  let n = 0;
  const result = await evaluateContinualTask({ task, request: async input => {
    assert.equal(Object.hasOwn(input, 'spec'), false);
    assert.equal(Object.hasOwn(input, 'expectedAnswer'), false);
    return { message: n++ ? answer : call, finishReason: 'stop' };
  } });
  assert.equal(result.verdict.passed, true);
  assert.equal(result.modelCalls, 2);
  assert.equal(result.toolCalls, 1);
  assert.equal(replayContinualTask(task, result).passed, true);
  const forged = clone(result); forged.trace[0].tools[0].args.input.opening++;
  assert.throws(() => replayContinualTask(task, forged), /arguments differ/);
});
test('correct answer without required tool execution fails and task state does not leak', async () => {
  const { task, call, answer } = fixture();
  const result = await evaluateContinualTask({ task, request: async () => ({ message: answer }) });
  assert.equal(result.verdict.finalAnswerCorrect, true);
  assert.equal(result.verdict.nativeToolRequirementMet, false);
  let n = 0;
  const complete = await evaluateContinualTask({ task, request: async () => ({ message: n++ ? answer : call }) });
  assert.equal(complete.verdict.passed, true);
  const again = await evaluateContinualTask({ task, request: async () => ({ message: answer }) });
  assert.equal(again.verdict.passed, false);
});
test('invalid second tool arguments cause zero executions from that response', async () => {
  const { task, call } = fixture();
  const message = clone(call); message.tool_calls.push({ id: 'broken', type: 'function', function: { name: 'calculate_arithmetic', arguments: '{broken' } });
  const result = await evaluateContinualTask({ task, request: async () => ({ message }) });
  assert.equal(result.stop, 'invalid-tool-arguments');
  assert.equal(result.toolCalls, 0);
  assert.equal(replayContinualTask(task, result).passed, false);
});
test('output truncation and endless tool calls cannot pass a task', async () => {
  const { task, call, answer } = fixture();
  const truncated = await evaluateContinualTask({ task, request: async () => ({ message: answer, finishReason: 'length' }) });
  assert.equal(truncated.stop, 'output-limit');
  assert.equal(truncated.verdict.passed, false);
  const loop = await evaluateContinualTask({ task, request: async () => ({ message: call }) });
  assert.equal(loop.modelCalls, 4);
  assert.equal(loop.toolCalls, 3);
  assert.equal(loop.verdict.passed, false);
  replayContinualTask(task, loop);
});
test('advancement needs complete categories, acquisition gains and retention against anchor', async () => {
  const f = ['acquisition', 'acquisition', 'general-retention', 'prior-skill-retention', 'composition-transfer'].map((category, i) => fixture(category, i + 100));
  const candidate = [];
  for (const { task, call, answer } of f) {
    let n = 0; candidate.push(await evaluateContinualTask({ task, request: async () => ({ message: n++ ? answer : call }) }));
  }
  const parent = clone(candidate);
  for (const index of [0, 1]) parent[index] = await evaluateContinualTask({ task: f[index].task, request: async () => ({ message: { role: 'assistant', content: 'wrong' } }) });
  const anchor = clone(parent), panel = f.map(x => x.task);
  assert.equal(compareContinualPanels({ candidate, parent, anchor, panel }).accepted, true);
  const regression = clone(candidate);
  regression[2] = await evaluateContinualTask({ task: f[2].task, request: async () => ({ message: { role: 'assistant', content: 'wrong' } }) });
  assert.equal(compareContinualPanels({ candidate: regression, parent, anchor, panel }).accepted, false);
  assert.throws(() => compareContinualPanels({ candidate: candidate.slice(1), parent, anchor, panel }), /Incomplete/);
  const rebound = clone(candidate); rebound[0].taskSha256 = '0'.repeat(64);
  assert.throws(() => compareContinualPanels({ candidate: rebound, parent, anchor, panel }), /input mismatch/);
  for (const arm of ['candidate', 'parent', 'anchor']) {
    const forged = { candidate: clone(candidate), parent: clone(parent), anchor: clone(anchor), panel };
    forged[arm][2].verdict.passed = false;
    assert.throws(() => compareContinualPanels(forged), /verdict replay mismatch/);
  }
});

test('replay rejects continuation after truncated, final, invalid or unexecuted tool responses', async () => {
  const { task, call, answer } = fixture();
  let n = 0;
  const good = await evaluateContinualTask({ task, request: async () => ({ message: n++ ? answer : call }) });
  for (const change of [
    trace => { trace[0].finishReason = 'length'; },
    trace => { trace[0].message = answer; trace[0].tools = []; },
    trace => { trace[0].message.tool_calls[0].function.arguments = '{broken'; },
    trace => { trace[0].tools = []; },
    trace => { delete trace[0].finishReason; }
  ]) {
    const bad = clone(good); change(bad.trace);
    assert.throws(() => replayContinualTask(task, bad), /terminal response|Executed calls|Incomplete response/);
  }
  const truncated = await evaluateContinualTask({ task, request: async () => ({ message: answer, finishReason: 'length' }) });
  assert.equal(replayContinualTask(task, truncated).passed, false);
  const forged = clone(truncated); forged.stop = 'final'; forged.finalAnswer = answer.content;
  assert.throws(() => replayContinualTask(task, forged), /stop differs/);
});

test('a deadline reached while inference or its receipt is awaited cannot execute tools or complete', async () => {
  const { task, call } = fixture();
  for (const abortAt of ['response', 'receipt', 'tool']) {
    const controller = new AbortController(), events = [];
    await assert.rejects(evaluateContinualTask({ task, signal: controller.signal,
      request: async () => { if (abortAt === 'response') controller.abort(new Error('deadline')); return { message: call }; },
      onEvent: async event => {
        events.push(event);
        if ((abortAt === 'receipt' && event.type === 'model-response') || (abortAt === 'tool' && event.type === 'tool-result')) controller.abort(new Error('deadline'));
      }
    }), /deadline/);
    assert.equal(events.some(event => event.type === 'task-completed'), false);
    assert.equal(events.filter(event => event.type === 'tool-result').length, abortAt === 'tool' ? 1 : 0);
  }
});

function businessFixture({ alreadyDone = false, category = 'acquisition', id = 'business-case' } = {}) {
  const states = new WeakMap();
  const state = task => { if (!states.has(task)) states.set(task, { paid: task.spec.initialPaid, unrelated: 7 }); return states.get(task); };
  const environment = { id: 'workflow-acquisition-v1',
    executeTool(task, name, args) {
      const current = state(task);
      if (name !== 'pay_invoice' || args.invoiceId !== task.spec.invoiceId) return { ok: false };
      current.paid = true;
      return { ok: true, invoiceId: args.invoiceId, paid: true };
    },
    checkAnswer(task, _answer) {
      const current = state(task), outcomeEvidence = { taskStateAchieved: current.paid, unrelatedRecordsPreserved: current.unrelated === 7 };
      const passed = outcomeEvidence.taskStateAchieved && outcomeEvidence.unrelatedRecordsPreserved;
      return { passed, finalAnswerCorrect: true, nativeToolRequirementMet: true, finalAnswerRequirement: 'none',
        nativeToolRequirement: 'not-required', outcomeEvidence, errors: passed ? [] : ['Invoice is not paid'] };
    }
  };
  const task = { id, metadata: { environmentId: environment.id, category }, spec: { invoiceId: 'invoice-1', initialPaid: alreadyDone },
    messages: [{ role: 'user', content: alreadyDone ? 'Receipt: invoice-1 is already paid. Complete the task.' : 'Pay invoice-1.' }],
    tools: [{ type: 'function', function: { name: 'pay_invoice', parameters: { type: 'object', required: ['invoiceId'], properties: { invoiceId: { type: 'string' } } } } }] };
  const call = { role: 'assistant', content: null, tool_calls: [{ id: 'pay-1', type: 'function', function: { name: 'pay_invoice', arguments: JSON.stringify({ invoiceId: 'invoice-1' }) } }] };
  const answer = { role: 'assistant', content: 'Done.' };
  return { task, environment, call, answer };
}

test('an injected business world grades actual effects and independently replays them', async () => {
  const { task, environment, call, answer } = businessFixture();
  let n = 0;
  const result = await evaluateContinualTask({ task, environment, request: async input => {
    assert.equal(Object.hasOwn(input, 'spec'), false);
    return { message: n++ ? answer : call };
  } });
  assert.equal(result.environmentId, environment.id);
  assert.equal(result.verdict.passed, true); assert.equal(result.toolCalls, 1);
  assert.equal(replayContinualTask(task, result, environment).passed, true);
  const forged = clone(result); forged.verdict.outcomeEvidence.unrelatedRecordsPreserved = false;
  assert.throws(() => replayContinualTask(task, forged, environment), /outcome evidence differs/);
});

test('correct-looking text without business effects fails; an authoritative already-done state needs no tool', async () => {
  for (const alreadyDone of [false, true]) {
    const { task, environment, answer } = businessFixture({ alreadyDone });
    const result = await evaluateContinualTask({ task, environment, request: async () => ({ message: answer }) });
    assert.equal(result.toolCalls, 0);
    assert.equal(result.verdict.passed, alreadyDone);
    assert.equal(result.verdict.finalAnswerRequirement, 'none');
    assert.equal(result.verdict.nativeToolRequirement, 'not-required');
    assert.equal(replayContinualTask(task, result, environment).passed, alreadyDone);
  }
});

test('new-world tasks and saved rows cannot fall back to the default grader or a wrong adapter', async () => {
  const { task, environment, answer } = businessFixture({ alreadyDone: true });
  let calls = 0;
  const request = async () => { calls++; return { message: answer }; };
  await assert.rejects(evaluateContinualTask({ task, request }), /matching native environment/);
  await assert.rejects(evaluateContinualTask({ task, request, environment: { ...environment, id: 'wrong-world' } }), /matching native environment/);
  assert.equal(calls, 0);
  const result = await evaluateContinualTask({ task, request, environment });
  assert.throws(() => replayContinualTask(task, result), /matching native environment/);
  assert.throws(() => replayContinualTask(task, { ...result, environmentId: 'wrong-world' }, environment), /identity mismatch/);
  const unbound = clone(result); delete unbound.environmentId;
  assert.throws(() => replayContinualTask(task, unbound, environment), /identity mismatch/);
  const native = fixture(); let n = 0;
  const legacy = await evaluateContinualTask({ task: native.task, request: async () => ({ message: n++ ? native.answer : native.call }) });
  assert.equal(Object.hasOwn(legacy, 'environmentId'), false);
  assert.equal(replayContinualTask(native.task, legacy).passed, true);
});

test('comparison uses the injected business world for every arm', async () => {
  const rows = ['acquisition', 'acquisition', 'general-retention', 'prior-skill-retention', 'composition-transfer']
    .map((category, index) => businessFixture({ category, id: `business-${index}`, alreadyDone: index > 1 }));
  const environment = rows[0].environment, candidate = [], parent = [];
  for (const { task, call, answer } of rows) {
    let n = 0;
    candidate.push(await evaluateContinualTask({ task, environment, request: async () => ({ message: n++ ? answer : call }) }));
    parent.push(await evaluateContinualTask({ task, environment, request: async () => ({ message: answer }) }));
  }
  const input = { candidate, parent, anchor: clone(parent), panel: rows.map(row => row.task), environment };
  assert.equal(compareContinualPanels(input).accepted, true);
  assert.throws(() => compareContinualPanels({ ...input, environment: undefined }), /matching native environment/);
  const wrong = clone(candidate); wrong[0].trace[0].tools[0].result.paid = false;
  assert.throws(() => compareContinualPanels({ ...input, candidate: wrong }), /Native tool replay mismatch/);
});
