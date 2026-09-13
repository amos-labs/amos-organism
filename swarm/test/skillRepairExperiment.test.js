import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSkillRepairMessages, runSkillRepairExperiment } from '../src/skillRepairExperiment.js';
import { buildSequentialDemonstrations, sequentialEvidenceHash } from '../src/sequentialSkillLearning.js';
import { validateSkillLibrary } from '../src/persistentSkillLibrary.js';

const modelIdentity = { model: 'repair-native-test', weightsSha256: 'e'.repeat(64) };
const ARMS = ['feedback-only', 'diagnostics', 'candidate-diagnostics'];
const ref = path => ({ $ref: path });
const call = (tool, args, saveAs) => ({ type: 'call', tool, args, saveAs });
const branch = (left, equals, then, otherwise = []) => ({ type: 'if', left, equals, then, else: otherwise });
const loop = (items, as, steps) => ({ type: 'for_each', items, as, steps });
const done = { type: 'return', status: 'completed' };
const program = steps => ({ schema: 'amos.checked-procedure.v1', steps });
const inspectOrder = () => call('inspect_order', { orderId: ref('vars.target.orderId') }, 'order');
const inspectInvoice = () => call('inspect_invoice', { orderId: ref('vars.target.orderId') }, 'invoice');

// These test-only candidates use public receipts and generalize changed IDs.
// They validate the harness; they are not measurements of a model's repair skill.
const candidates = {
  'reserve-order': program([loop(ref('goal.orders'), 'target', [loop([0, 1], 'pass', [
    inspectOrder(), branch(ref('vars.order.order.status'), 'open', [
      loop(ref('vars.order.order.lines'), 'line', [branch(ref('vars.line.reserved'), false, [
        inspectOrder(), call('reserve_line', { orderId: ref('vars.target.orderId'), sku: ref('vars.line.sku'),
          quantity: ref('vars.line.quantity'), expectedRevision: ref('vars.order.order.revision') }, 'written'), inspectOrder()
      ])]), inspectOrder(), call('confirm_order', { orderId: ref('vars.target.orderId'),
        expectedRevision: ref('vars.order.order.revision') }, 'written'), inspectOrder()
    ])
  ])]), done]),
  'invoice-order': program([loop(ref('goal.orders'), 'target', [inspectOrder(),
    loop([0, 1], 'pass', [inspectInvoice(), branch(ref('vars.invoice.invoice'), null, [
      call('create_invoice', { orderId: ref('vars.target.orderId'), expectedOrderRevision: ref('vars.order.order.revision') }, 'written'), inspectInvoice()
    ])]),
    loop([0, 1], 'pass', [inspectInvoice(), branch(ref('vars.invoice.invoice.reference'), ref('vars.target.invoiceReference'), [], [
      call('annotate_invoice', { invoiceId: ref('vars.invoice.invoice.id'), reference: ref('vars.target.invoiceReference'),
        expectedRevision: ref('vars.invoice.invoice.revision') }, 'written'), inspectInvoice()
    ])])
  ]), done])
};
const withoutReturn = family => ({ ...candidates[family], steps: candidates[family].steps.slice(0, -1) });
const response = (value, finishReason = 'stop') => ({ message: { content: JSON.stringify(value) },
  providerResponse: { choices: [{ finish_reason: finishReason }] } });
const user = messages => JSON.parse(messages.at(-1).content);
const key = input => `${input.replicate}/${input.family}/${input.arm}`;
const experiment = options => runSkillRepairExperiment({ modelIdentity, ...options });

test('pure prompt transform adds only declared candidate/diagnostic fields and exactly selected TRAIN evidence', () => {
  const messages = [{ role: 'system', content: 'compiler' }, { role: 'user', content: JSON.stringify({ task: 'learn',
    demonstrations: [{ events: ['full demonstration'] }], previousTrainingFeedback: { kind: 'training-validation-failure',
      cases: [{ verification: { fixtureId: 'second' } }, { verification: { fixtureId: 'first' } }] } }) }];
  const event = fixtureId => ({ type: 'training-validation', split: 'training-validation', fixtureId, variant: 'ambiguous', pass: false,
    programResult: { status: 'needs_reasoning', error: null, stepsExecuted: 5, toolCalls: 2,
      trace: [{ type: 'stop', reason: 'Procedure ended without an explicit return', secret: 'not-input' }], variables: { secret: 'not-input' } } });
  const events = [event('first'), event('extra'), event('second')];
  const previousCandidate = { content: '{ invalid candidate, keep exact whitespace  ', sourceCaseId: 'previous-request', finishReason: 'length' };
  const before = structuredClone({ messages, events, previousCandidate });
  const prompts = Object.fromEntries(ARMS.map(arm => [arm, user(buildSkillRepairMessages({ messages, arm, previousCandidate,
    trainingValidationEvents: events }))]));
  assert.equal(Object.hasOwn(prompts['feedback-only'], 'executionDiagnostics'), false);
  assert.equal(Object.hasOwn(prompts['feedback-only'], 'previousCandidate'), false);
  assert.deepEqual(prompts.diagnostics.executionDiagnostics.map(row => row.fixtureId), ['second', 'first']);
  assert.ok(prompts.diagnostics.executionDiagnostics.every(row => row.terminal.reason === 'Procedure ended without an explicit return'));
  assert.equal(JSON.stringify(prompts).includes('not-input'), false);
  assert.deepEqual(prompts['candidate-diagnostics'].executionDiagnostics, prompts.diagnostics.executionDiagnostics);
  assert.equal(prompts['candidate-diagnostics'].previousCandidate.content, previousCandidate.content);
  const { executionDiagnostics, ...commonD } = prompts.diagnostics;
  const { previousCandidate: carried, ...commonCD } = prompts['candidate-diagnostics'];
  assert.deepEqual(commonD, prompts['feedback-only']);
  assert.deepEqual(commonCD, prompts.diagnostics);
  assert.deepEqual({ messages, events, previousCandidate }, before);
  assert.throws(() => buildSkillRepairMessages({ messages, arm: 'diagnostics',
    trainingValidationEvents: events.map(row => ({ ...row, split: 'evaluation' })) }), /missing or ambiguous/);
  const initial = structuredClone(messages); const payload = user(initial); payload.previousTrainingFeedback = null;
  initial.at(-1).content = JSON.stringify(payload);
  const initialPrompt = user(buildSkillRepairMessages({ messages: initial, arm: 'shared-initial', previousCandidate, trainingValidationEvents: events }));
  assert.equal(Object.hasOwn(initialPrompt, 'previousCandidate'), false);
  assert.equal(Object.hasOwn(initialPrompt, 'executionDiagnostics'), false);
});

test('program-authored return reasons never enter diagnostics while CD retains the complete candidate', () => {
  const longReason = 'PROGRAM_TEXT_ONLY '.repeat(200);
  const candidateText = JSON.stringify(program([{ type: 'return', status: 'needs_reasoning', reason: longReason }]));
  const previousCandidate = { content: candidateText, sourceCaseId: 'long-return-candidate', finishReason: 'stop' };
  const messages = [{ role: 'user', content: JSON.stringify({ task: 'repair', previousTrainingFeedback: {
    kind: 'training-validation-failure', cases: [{ verification: { fixtureId: 'world' } }] } }) }];
  const trainingValidationEvents = [{ type: 'training-validation', split: 'training-validation', pass: false,
    fixtureId: 'world', variant: 'fresh', programResult: { status: 'needs_reasoning', stepsExecuted: 1, toolCalls: 0,
      trace: [{ type: 'return', path: 'steps[0]', status: 'needs_reasoning', reason: longReason }] } }];
  const d = user(buildSkillRepairMessages({ messages, arm: 'diagnostics', previousCandidate, trainingValidationEvents }));
  const cd = user(buildSkillRepairMessages({ messages, arm: 'candidate-diagnostics', previousCandidate, trainingValidationEvents }));
  assert.equal(JSON.stringify(d).includes('PROGRAM_TEXT_ONLY'), false);
  assert.deepEqual(d.executionDiagnostics[0].terminal, { type: 'return', path: 'steps[0]', reason: null,
    reasonSource: 'program-authored-omitted' });
  assert.deepEqual(cd.executionDiagnostics, d.executionDiagnostics);
  assert.equal(cd.previousCandidate.content, candidateText);
  assert.equal(JSON.stringify(cd.executionDiagnostics).includes('PROGRAM_TEXT_ONLY'), false);
});

test('six fresh shared generations fork into eighteen replay-labelled branches with at most forty-two unique calls', async () => {
  const requests = [], events = [];
  const report = await experiment({ request: async input => { requests.push(input); return response(program([done])); },
    onEvent: event => events.push(event) });
  assert.equal(report.schema, 'amos.skill-repair-experiment.v1');
  assert.equal(report.logicalCompilerRequests, 42);
  assert.equal(report.maxLogicalCompilerRequests, 42);
  assert.equal(report.sharedInitials.length, 6);
  assert.equal(report.runs.length, 18);
  assert.equal(report.sharedInitialGenerations, 6);
  assert.equal(report.repairGenerations, 36);
  assert.equal(new Set(requests.map(row => row.caseId)).size, 42);
  assert.equal(events.filter(event => event.type === 'shared-initial-replay').length, 18);
  assert.equal(events.filter(event => event.type === 'repair-request-start').length, 42);
  assert.equal(events.filter(event => event.type === 'repair-request-finished').length, 42);
  assert.equal(report.evaluationTasksRun, 0);
  assert.equal(report.weightsChanged, false);
  assert.equal(report.neuralRecurrenceTested, false);
  for (const input of requests) {
    assert.equal(input.phase, 'compile');
    assert.deepEqual(input.tools, []);
    assert.deepEqual(input.responseFormat, { type: 'json_object' });
    assert.equal(input.temperature, 1);
    assert.equal(input.maxOutputTokens, 3072);
    assert.equal(input.modelSeed, [20260915, 20261016, 20261117][input.replicate]);
  }
  for (let replicate = 0; replicate < 3; replicate++) for (const [index, family] of ['reserve-order', 'invoice-order'].entries()) {
    const cell = report.runs.filter(run => run.family === family && run.replicate === replicate);
    const offset = (replicate * 2 + index) % 3;
    assert.deepEqual(cell.map(run => run.arm), [...ARMS.slice(offset), ...ARMS.slice(0, offset)]);
    const seed = (index ? 130_000 : 120_000) + replicate * 100;
    const demos = await buildSequentialDemonstrations({ family, seed });
    const shared = report.sharedInitials.find(row => row.family === family && row.replicate === replicate);
    assert.equal(requests.filter(row => row.arm === 'shared-initial' && row.family === family && row.replicate === replicate).length, 1);
    for (const run of cell) {
      assert.equal(run.demonstrationSeed, seed);
      assert.equal(run.acquisitionSeed, 140_000 + replicate * 100 + index * 1000);
      assert.deepEqual(run.demonstrations, demos);
      assert.equal(run.demonstrationsSha256, sequentialEvidenceHash(demos));
      assert.equal(run.requests.length, 3);
      assert.equal(run.requests[0].replay, true);
      assert.equal(run.requests[0].sharedCaseId, shared.caseId);
      assert.equal(run.requests[0].sharedResponseSha256, shared.responseSha256);
      assert.equal(run.firstInputSha256, shared.inputSha256);
      assert.ok(run.requests.slice(1).every(row => row.replay === false));
      assert.deepEqual(run.acquisition.attempts[0].response, shared.response);
      assert.notEqual(run.acquisition.attempts[0].response, shared.response);
      assert.equal(run.acquisition.admitted, false);
      assert.equal(run.acquisition.library.entries.length, 0);
    }
    assert.deepEqual(cell[0].acquisition.attempts[0].validations, cell[1].acquisition.attempts[0].validations);
  }
  assert.ok(Object.values(report.byArm).every(arm => arm.acquisitions === 6 && arm.initiallyFailed === 6 && arm.logicalCompilerRequests === 12));
});

test('literal terminal diagnostics expose missing return while native admission still requires a complete repaired procedure', async () => {
  const requests = [];
  const report = await experiment({ request: async input => {
    requests.push(input);
    return response(input.arm === 'candidate-diagnostics' ? candidates[input.family] : withoutReturn(input.family));
  } });
  assert.equal(report.logicalCompilerRequests, 36);
  assert.equal(report.byArm['feedback-only'].admitted, 0);
  assert.equal(report.byArm.diagnostics.admitted, 0);
  assert.equal(report.byArm['candidate-diagnostics'].admitted, 6);
  assert.equal(report.contrasts.diagnosticsMinusFeedbackOnly, 0);
  assert.equal(report.contrasts.candidateDiagnosticsMinusDiagnostics, 1);
  for (const run of report.runs) {
    const first = run.acquisition.attempts[0];
    assert.ok(first.validations.every(row => row.verification.pass && !row.pass));
    assert.equal(first.classification.nativeVerifierPasses, 4);
    assert.equal(first.classification.nativeContractPasses, 0);
    assert.deepEqual(first.classification.executionStatuses, { needs_reasoning: 4 });
    const repair = requests.find(row => row.arm === run.arm && row.family === run.family && row.replicate === run.replicate);
    const payload = user(repair.messages);
    if (run.arm !== 'feedback-only') {
      assert.equal(payload.executionDiagnostics.length, 2);
      assert.deepEqual(payload.executionDiagnostics.map(row => row.fixtureId), payload.previousTrainingFeedback.cases.map(row => row.verification.fixtureId));
      assert.ok(payload.executionDiagnostics.every(row => row.error === null && row.terminal.reason === 'Procedure ended without an explicit return'));
    }
    if (run.arm === 'candidate-diagnostics') {
      assert.equal(payload.previousCandidate.content, JSON.stringify(withoutReturn(run.family)));
      assert.equal(payload.previousCandidate.sourceCaseId, run.sharedCaseId);
      assert.equal(run.acquisition.attempts.length, 2);
      assert.ok(run.acquisition.attempts[1].validations.every(row => row.pass));
      assert.equal(Object.isFrozen(run.acquisition.library), true);
      assert.deepEqual(validateSkillLibrary(run.acquisition.library), run.acquisition.library);
      assert.equal(run.acquisition.library.entries[0].skillId, run.family);
    }
  }
});

test('initial successes stay in every fixed denominator without generating repairs or sharing mutable receipts', async () => {
  const report = await experiment({ request: async input => {
    assert.equal(input.arm, 'shared-initial');
    return response(candidates[input.family]);
  } });
  assert.equal(report.logicalCompilerRequests, 6);
  assert.equal(report.repairGenerations, 0);
  for (const summary of Object.values(report.byArm)) {
    assert.equal(summary.acquisitions, 6);
    assert.equal(summary.admitted, 6);
    assert.equal(summary.initiallyAdmitted, 6);
    assert.equal(summary.initiallyFailed, 0);
    assert.equal(summary.repairAdmissionRate, null);
  }
  assert.ok(report.runs.every(run => run.requests.length === 1 && run.acquisition.attempts.length === 1));
  const [first, second] = report.runs;
  first.acquisition.attempts[0].response.message.content = 'mutated audit copy';
  assert.notEqual(second.acquisition.attempts[0].response.message.content, 'mutated audit copy');
  assert.notEqual(report.sharedInitials[0].response.message.content, 'mutated audit copy');
});

test('shared failures are cached once and CD never carries stale candidate text after later request failures', async () => {
  const requests = [];
  const report = await experiment({ request: async input => {
    requests.push(input);
    throw new Error(input.arm === 'shared-initial' ? 'shared context rejection' : 'repair request failed');
  } });
  assert.equal(report.logicalCompilerRequests, 42);
  assert.equal(requests.filter(row => row.arm === 'shared-initial').length, 6);
  assert.ok(report.sharedInitials.every(row => row.status === 'failed' && row.error === 'shared context rejection'));
  for (const run of report.runs) {
    assert.equal(run.acquisition.attempts[0].error, 'shared context rejection');
    assert.equal(run.requests[0].status, 'failed');
    assert.equal(run.acquisition.attempts.length, 3);
    assert.equal(run.acquisition.admitted, false);
    if (run.arm === 'candidate-diagnostics') {
      const repairs = requests.filter(input => key(input) === key(run));
      const initialMissing = user(repairs[0].messages).previousCandidate;
      assert.equal(initialMissing.content, null);
      assert.equal(initialMissing.sourceCaseId, run.sharedCaseId);
      assert.equal(initialMissing.status, 'request-failed');
      const repairMissing = user(repairs[1].messages).previousCandidate;
      assert.equal(repairMissing.content, null);
      assert.equal(repairMissing.sourceCaseId, repairs[0].caseId);
      assert.equal(repairMissing.status, 'request-failed');
    }
  }
});

test('an AST rejection replaces candidate provenance and cannot inherit older native traces', async () => {
  const calls = new Map();
  const invalid = program([{ type: 'unsupported', note: 'new invalid candidate' }]);
  const report = await experiment({ request: async input => {
    if (input.arm === 'shared-initial') return response(withoutReturn(input.family));
    const previous = calls.get(key(input)) ?? [];
    previous.push(input); calls.set(key(input), previous);
    if (previous.length === 1) return response(invalid);
    const payload = user(input.messages);
    assert.equal(payload.previousTrainingFeedback.kind, 'syntax-or-execution-error');
    assert.equal(Object.hasOwn(payload, 'executionDiagnostics'), false);
    if (input.arm === 'candidate-diagnostics') {
      assert.equal(payload.previousCandidate.content, JSON.stringify(invalid));
      assert.equal(payload.previousCandidate.sourceCaseId, previous[0].caseId);
    }
    return response(program([done]));
  } });
  assert.equal(report.logicalCompilerRequests, 42);
  assert.ok(report.runs.every(run => run.acquisition.attempts[1].classification.astStatus === 'rejected'));
});

test('failed or textless repairs invalidate a formerly valid candidate and its diagnostics', async () => {
  const calls = new Map();
  await experiment({ request: async input => {
    if (input.arm === 'shared-initial') return response(withoutReturn(input.family));
    const previous = calls.get(key(input)) ?? [];
    previous.push(input); calls.set(key(input), previous);
    if (previous.length === 1) {
      if (input.replicate === 0) throw new Error('request failed after prior native validation');
      return { message: {} };
    }
    const payload = user(input.messages);
    assert.equal(Object.hasOwn(payload, 'executionDiagnostics'), false);
    if (input.arm === 'candidate-diagnostics') {
      assert.equal(payload.previousCandidate.content, null);
      assert.equal(payload.previousCandidate.sourceCaseId, previous[0].caseId);
      assert.equal(payload.previousCandidate.status, input.replicate === 0 ? 'request-failed' : 'missing-text');
    }
    return response(program([done]));
  } });
  assert.equal([...calls.values()].filter(inputs => inputs.length === 2).length, 18);
});

test('already aborted work stops before any unique shared generation', async () => {
  let calls = 0;
  await assert.rejects(experiment({ signal: AbortSignal.abort(), request: async () => { calls++; } }), /aborted/);
  assert.equal(calls, 0);
});
