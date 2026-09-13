import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorkedExampleExperiment, buildWorkedExampleMessages, getWorkedExample } from '../src/workedExampleExperiment.js';
import { validateCheckedProcedure, executeCheckedProcedure } from '../src/checkedProcedure.js';
import { buildSequentialDemonstrations, sequentialEvidenceHash } from '../src/sequentialSkillLearning.js';
import { emptySkillLibrary, validateSkillLibrary } from '../src/persistentSkillLibrary.js';
import { createSequentialSkillFixture } from '../evals/sequentialSkillFixture.js';

const modelIdentity = { model: 'worked-example-native-test', weightsSha256: 'd'.repeat(64) };
const ref = path => ({ $ref: path });
const call = (tool, args, saveAs) => ({ type: 'call', tool, args, saveAs });
const branch = (left, equals, then, otherwise = []) => ({ type: 'if', left, equals, then, else: otherwise });
const loop = (items, as, steps) => ({ type: 'for_each', items, as, steps });
const done = { type: 'return', status: 'completed' };
const program = steps => ({ schema: 'amos.checked-procedure.v1', steps });
const inspectOrder = () => call('inspect_order', { orderId: ref('vars.target.orderId') }, 'order');
const inspectInvoice = () => call('inspect_invoice', { orderId: ref('vars.target.orderId') }, 'invoice');

// Test candidates use only public goals/receipts. They exercise native admission;
// their success is not evidence about a model's ability to induce programs.
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
const response = (value, finishReason = 'stop') => ({ message: { content: JSON.stringify(value) },
  providerResponse: { choices: [{ finish_reason: finishReason }] } });
const content = text => ({ message: { content: text } });
const key = input => `${input.replicate}/${input.family}/${input.arm}`;
const experiment = options => runWorkedExampleExperiment({ modelIdentity, ...options });

test('the worked example is immutable, native-valid and read-only on both guard and predicate paths', async () => {
  const example = getWorkedExample(), second = getWorkedExample();
  assert.deepEqual(example, second);
  assert.notEqual(example, second);
  assert.notEqual(example.program, second.program);
  assert.equal(Object.isFrozen(example), true);
  assert.equal(Object.isFrozen(example.program.steps), true);
  assert.throws(() => { example.goal.orders.push({ orderId: 'changed' }); }, TypeError);
  assert.deepEqual(validateCheckedProcedure(example.program, { toolNames: ['inspect_order'], maxNodes: 512, maxDepth: 8 }), example.program);
  assert.equal(JSON.stringify(example).includes('reserve_line'), false);
  assert.equal(JSON.stringify(example).includes('create_invoice'), false);
  const teachingOptions = { seed: 730_000, split: 'worked-example', family: 'compose', variant: 'ambiguous' };
  const teaching = createSequentialSkillFixture(teachingOptions);
  assert.deepEqual(example.goal.orders, teaching.goal.orders.map(({ orderId }) => ({ orderId })));
  const publicReads = example.goal.orders.map(({ orderId }) => ({ name: 'inspect_order', args: { orderId },
    result: teaching.execute('inspect_order', { orderId }) }));
  assert.deepEqual(publicReads, example.publicTrace, 'every teaching receipt comes from the real tool executor');
  const stateWithoutReadAudit = fixture => {
    const { steps, log, ...state } = fixture.snapshotForTesting();
    return state;
  };
  for (const scenario of ['success', 'missing-order', 'non-open']) {
    const fixture = createSequentialSkillFixture(scenario === 'non-open'
      ? { seed: 730_001, split: 'worked-example-branch', family: 'invoice-order', variant: 'fresh' } : teachingOptions);
    const goal = scenario === 'non-open' ? { ...example.goal, orders: fixture.goal.orders.map(({ orderId }) => ({ orderId })) }
      : structuredClone(example.goal);
    if (scenario === 'missing-order') goal.orders.at(-1).orderId = 'missing-teaching-order';
    const initial = stateWithoutReadAudit(fixture);
    const publicTrace = [];
    let mutationAttempts = 0;
    const result = await executeCheckedProcedure(example.program, { goal, getState: () => ({ observations: publicTrace }),
      toolNames: fixture.tools.map(tool => tool.function.name), maxNodes: 512, maxDepth: 8, maxSteps: 256, maxToolCalls: 64,
      executeTool: async (name, args) => {
        if (name !== 'inspect_order') { mutationAttempts++; throw new Error('The example must only inspect'); }
        assert.deepEqual(Object.keys(args), ['orderId']);
        const result = fixture.execute(name, args);
        publicTrace.push({ name, args: structuredClone(args), result: structuredClone(result) });
        return result;
      } });
    assert.equal(result.status, scenario === 'success' ? 'completed' : 'needs_reasoning');
    assert.equal(result.error, undefined, 'all exits are explicit returns, not failed dereferences');
    assert.equal(result.trace.at(-1).type, 'return');
    assert.equal(result.toolCalls, scenario === 'non-open' ? 1 : 2);
    assert.equal(mutationAttempts, 0);
    assert.deepEqual(stateWithoutReadAudit(fixture), initial);
    if (scenario === 'success') assert.deepEqual(publicTrace, example.publicTrace);
    if (scenario === 'missing-order') assert.ok(result.trace.some(event => event.type === 'if' && event.left === false && !event.matched));
    if (scenario === 'non-open') assert.ok(result.trace.some(event => event.type === 'if' && event.left === 'reserved' && !event.matched));
  }
});

test('prompt transformation adds exactly the workedExample field and preserves all existing feedback verbatim', () => {
  const messages = [{ role: 'system', content: 'fixed system' }, { role: 'user', content: JSON.stringify({
    task: 'fixed task', tools: [], demonstrations: [{ id: 'other-training-world' }],
    previousTrainingFeedback: { kind: 'syntax-or-execution-error', error: 'exact feedback' }
  }) }];
  const original = structuredClone(messages);
  const guide = buildWorkedExampleMessages({ messages, arm: 'guide-only' });
  const worked = buildWorkedExampleMessages({ messages, arm: 'worked-example' });
  assert.deepEqual(guide, original);
  assert.notEqual(guide, messages);
  const treated = JSON.parse(worked.at(-1).content);
  assert.deepEqual(treated.workedExample, getWorkedExample());
  delete treated.workedExample;
  assert.equal(JSON.stringify(treated), messages.at(-1).content);
  assert.deepEqual(worked[0], messages[0]);
  assert.deepEqual(messages, original);
  assert.equal(Object.hasOwn(treated, 'previousCandidate'), false);
  assert.equal(Object.hasOwn(treated, 'executionDiagnostics'), false);
  assert.throws(() => buildWorkedExampleMessages({ messages: worked, arm: 'guide-only' }), /already be present/);
  assert.throws(() => buildWorkedExampleMessages({ messages, arm: 'other' }), /Unknown/);
});

test('fresh paired curricula, first prompts and balanced arms differ only by the complete worked example', async () => {
  const requests = [], events = [];
  const report = await experiment({ request: async input => { requests.push(input); return content('invalid JSON'); },
    onEvent: event => events.push(event) });
  assert.equal(report.schema, 'amos.worked-example-experiment.v1');
  assert.equal(report.runs.length, 12);
  assert.deepEqual(report.modelSeeds, [20260916, 20261017, 20261118]);
  assert.equal(report.logicalCompilerRequests, 36);
  assert.equal(report.maxLogicalCompilerRequests, 36);
  assert.equal(report.evaluationTasksRun, 0);
  assert.equal(report.weightsChanged, false);
  assert.equal(report.neuralRecurrenceTested, false);
  assert.equal(new Set(requests.map(input => input.caseId)).size, 36);
  assert.ok(events.every(event => ['guide-only', 'worked-example'].includes(event.arm) &&
    ['reserve-order', 'invoice-order'].includes(event.family) && Number.isSafeInteger(event.replicate)));
  assert.ok(events.filter(event => event.caseId).every(event => event.caseId.startsWith(`${event.arm}-`)));

  for (let replicate = 0; replicate < 3; replicate++) for (const [index, family] of ['reserve-order', 'invoice-order'].entries()) {
    const pair = report.runs.filter(run => run.replicate === replicate && run.family === family);
    assert.deepEqual(pair.map(run => run.arm), (replicate + index) % 2 ? ['worked-example', 'guide-only'] : ['guide-only', 'worked-example']);
    const expectedDemonstrationSeed = (index ? 170_000 : 160_000) + replicate * 100;
    const expectedAcquisitionSeed = 180_000 + replicate * 100 + index * 1000;
    const expectedDemonstrations = await buildSequentialDemonstrations({ family, seed: expectedDemonstrationSeed });
    for (const run of pair) {
      assert.equal(run.demonstrationSeed, expectedDemonstrationSeed);
      assert.equal(run.acquisitionSeed, expectedAcquisitionSeed);
      assert.equal(run.validationSeedBase, expectedAcquisitionSeed + 10_000);
      assert.deepEqual(run.demonstrations, expectedDemonstrations);
      assert.equal(run.demonstrationsSha256, sequentialEvidenceHash(expectedDemonstrations));
      assert.equal(run.acquisition.attempts.length, 3);
      assert.equal(run.acquisition.library.entries.length, 0);
      const first = requests.find(input => key(input) === key(run));
      assert.equal(first.phase, 'compile');
      assert.deepEqual(first.tools, []);
      assert.equal(first.temperature, 1);
      assert.equal(first.maxOutputTokens, 3072);
      assert.equal(first.modelSeed, report.modelSeeds[replicate]);
      assert.deepEqual(first.responseFormat, { type: 'json_object' });
      const user = JSON.parse(first.messages.at(-1).content);
      assert.deepEqual(Object.keys(user).sort(), ['demonstrations', 'previousTrainingFeedback', 'skill', 'task', 'tools',
        ...(run.arm === 'worked-example' ? ['workedExample'] : [])]);
      if (run.arm === 'worked-example') assert.deepEqual(user.workedExample, getWorkedExample());
      assert.equal(user.previousTrainingFeedback, null);
      assert.deepEqual(user.demonstrations, expectedDemonstrations);
      assert.equal(run.requests[0].inputSha256, run.firstInputSha256);
      assert.ok(run.acquisition.attempts.every((attempt, i) => attempt.caseId === run.requests[i].caseId));
    }
    assert.equal(pair[0].inputSha256, pair[1].inputSha256);
    assert.equal(pair[0].firstInputSha256, pair[1].firstInputSha256);
    assert.notEqual(pair[0].requests[0].requestSha256, pair[1].requests[0].requestSha256);
    const common = run => {
      const { arm, caseId, actualInputSha256, workedExampleSha256, requestSha256, ...input } = requests.find(item => key(item) === key(run));
      const messages = structuredClone(input.messages);
      const payload = JSON.parse(messages.at(-1).content);
      delete payload.workedExample;
      messages.at(-1).content = JSON.stringify(payload);
      return { ...input, messages };
    };
    assert.deepEqual(common(pair[0]), common(pair[1]));
  }
  assert.deepEqual(report.byArm['guide-only'], report.byArm['worked-example']);
  assert.equal(report.byArm['guide-only'].admitted, 0);
  assert.equal(report.byArm['guide-only'].logicalCompilerRequests, 18);
  assert.equal(report.byArm['guide-only'].parseableResponseAttempts, 0);
  assert.equal(report.firstAttemptPairs.length, 6);
  assert.equal(report.byArm['guide-only'].firstAttempt.acquisitions, 6);
  assert.equal(report.byArm['guide-only'].firstAttempt.jsonParsed, 0);
  assert.ok(report.firstAttemptPairs.every(pair => pair.byArm['guide-only'].jsonParseStatus === 'invalid' &&
    pair.byArm['worked-example'].jsonParseStatus === 'invalid'));
});

test('request failures retain every attempt without removing the assigned worked-example treatment', async () => {
  const requests = [], events = [];
  const report = await experiment({ request: async input => {
    requests.push(input);
    if (input.arm === 'worked-example') throw new Error('request rejected before inference');
    return content('{');
  }, onEvent: event => events.push(event) });
  assert.equal(requests.length, 36);
  for (const run of report.runs) {
    assert.equal(run.acquisition.admitted, false);
    assert.equal(run.requests.length, 3);
    assert.equal(run.acquisition.attempts.length, 3);
    assert.ok(run.acquisition.attempts.every(attempt => attempt.error && attempt.validations === undefined));
    if (run.arm === 'worked-example') {
      assert.ok(run.requests.every(row => row.status === 'failed' && row.responseFormat.type === 'json_object'));
      assert.ok(run.acquisition.attempts.every(attempt => attempt.response === undefined && /request rejected/.test(attempt.error)));
      assert.ok(run.acquisition.attempts.every(attempt => attempt.classification.failureStage === 'request'));
    }
  }
  assert.equal(events.filter(event => event.type === 'compiler-request-start').length, 36);
  assert.equal(events.filter(event => event.type === 'compiler-request-finished').length, 36);
  assert.equal(events.filter(event => event.type === 'acquisition-attempt').length, 36);
  assert.equal(report.byArm['worked-example'].attemptsWithResponse, 0);
  assert.equal(report.byArm['guide-only'].attemptsWithResponse, 18);
});

test('admission requires all four matched native TRAIN worlds and creates separate frozen libraries', async () => {
  const counts = new Map();
  const report = await experiment({ request: async input => {
    const count = (counts.get(key(input)) ?? 0) + 1;
    counts.set(key(input), count);
    return response(count === 1 ? program([done]) : candidates[input.family]);
  } });
  assert.equal(report.logicalCompilerRequests, 24);
  for (const run of report.runs) {
    assert.equal(run.acquisition.admitted, true);
    assert.equal(run.acquisition.attempts.length, 2);
    const [failed, admitted] = run.acquisition.attempts;
    assert.equal(failed.error, 'Procedure failed native TRAIN validation');
    assert.ok(failed.validations.every(row => row.programResult.status === 'completed' && !row.pass));
    assert.deepEqual(admitted.validations.map(row => row.variant), ['fresh', 'partial', 'ambiguous', 'ambiguous']);
    assert.ok(admitted.validations.every(row => row.pass && row.verification.pass && row.programResult.status === 'completed'));
    const library = run.acquisition.library;
    assert.equal(Object.isFrozen(library), true);
    assert.equal(Object.isFrozen(library.entries[0].program.steps), true);
    assert.deepEqual(validateSkillLibrary(library), library);
    assert.equal(library.entries.length, 1);
    assert.equal(library.entries[0].skillId, run.family);
    assert.equal(library.parentDigest, emptySkillLibrary({ modelIdentity }).digest);
    assert.equal(library.entries[0].learningEvidence.validationTraceSha256, sequentialEvidenceHash(admitted.validations));
    assert.equal(library.entries[0].learningEvidence.demonstrationsSha256, run.demonstrationsSha256);
    const other = report.runs.find(item => item.arm !== run.arm && item.family === run.family && item.replicate === run.replicate);
    assert.notEqual(other.acquisition.library, library);
    assert.deepEqual(other.acquisition.attempts[1].validations, admitted.validations);
    assert.equal(admitted.validations[0].seed, run.validationSeedBase);
    assert.equal(admitted.validations[1].seed, run.validationSeedBase + 1);
    const outcomes = new Set();
    for (const row of admitted.validations) {
      assert.equal(row.split, 'training-validation');
      const fixture = createSequentialSkillFixture({ family: run.family, variant: row.variant, seed: row.seed, split: row.split });
      assert.equal(fixture.id, row.fixtureId);
      assert.ok(run.demonstrations.every(demo => demo.id !== row.fixtureId));
      for (const event of row.events) assert.deepEqual(fixture.execute(event.name, event.args), event.result);
      assert.deepEqual(fixture.verify(), row.verification);
      if (row.variant === 'ambiguous') outcomes.add(fixture.snapshotForTesting().fault.applied);
    }
    assert.deepEqual(outcomes, new Set([true, false]));
  }
  assert.equal(report.byArm['worked-example'].admitted, 6);
  assert.equal(report.byArm['worked-example'].admissionRate, 1);
  assert.equal(report.byArm['worked-example'].nativeValidationCases, 48);
  assert.equal(report.byArm['worked-example'].nativePassedCases, 24);
  assert.equal(report.byArm['worked-example'].firstAttempt.acquisitions, 6);
  assert.equal(report.byArm['worked-example'].firstAttempt.jsonParsed, 6);
  assert.equal(report.byArm['worked-example'].firstAttempt.astAccepted, 6);
  assert.equal(report.byArm['worked-example'].firstAttempt.nativePassed, 0);
  assert.equal(report.byArm['worked-example'].firstAttempt.admitted, 0);
});

test('retry feedback may differ by arm without leaking candidates or crossing acquisition boundaries', async () => {
  const calls = new Map();
  const report = await experiment({ request: async input => {
    const previous = calls.get(key(input)) ?? [];
    previous.push(input);
    calls.set(key(input), previous);
    if (previous.length === 1) return input.arm === 'guide-only' ? content('{') : response(program([done]));
    return response(candidates[input.family]);
  } });
  for (const run of report.runs) {
    assert.equal(run.acquisition.admitted, true);
    const feedback = JSON.parse(calls.get(key(run))[1].messages.at(-1).content).previousTrainingFeedback;
    assert.equal(feedback.kind, run.arm === 'guide-only' ? 'syntax-or-execution-error' : 'training-validation-failure');
    assert.equal(Object.hasOwn(feedback, 'program'), false);
    assert.equal(Object.hasOwn(feedback, 'previousCandidate'), false);
    const other = report.runs.find(item => item.arm !== run.arm && item.family === run.family && item.replicate === run.replicate);
    assert.equal(run.firstInputSha256, other.firstInputSha256);
    assert.notEqual(run.requests[1].inputSha256, other.requests[1].inputSha256);
  }
});

test('truncation, invalid AST and false completion claims remain failed attempts with no admission', async () => {
  const calls = new Map();
  const report = await experiment({ request: async input => {
    const count = (calls.get(key(input)) ?? 0) + 1;
    calls.set(key(input), count);
    if (count === 1) return response(candidates[input.family], 'length');
    if (count === 2) return response(program([{ type: 'execute_javascript', source: 'finish()' }]));
    return response(program([done]));
  } });
  for (const run of report.runs) {
    assert.equal(run.acquisition.admitted, false);
    assert.equal(run.acquisition.library.entries.length, 0);
    const [truncated, invalid, falseClaim] = run.acquisition.attempts;
    assert.match(truncated.error, /output budget/);
    assert.match(invalid.error, /type is unknown/);
    assert.equal(truncated.validations, undefined);
    assert.equal(invalid.validations, undefined);
    assert.equal(falseClaim.validations.length, 4);
    assert.ok(falseClaim.validations.every(row => !row.pass));
    assert.equal(truncated.classification.jsonParseStatus, 'valid');
    assert.equal(truncated.classification.outputTruncated, true);
    assert.equal(truncated.classification.astStatus, 'not-checked');
    assert.equal(truncated.classification.failureStage, 'output-budget');
    assert.equal(invalid.classification.failureStage, 'ast');
    assert.equal(falseClaim.classification.failureStage, 'native');
    assert.deepEqual(falseClaim.classification.executionStatuses, { completed: 4 });
  }
  assert.equal(report.logicalCompilerRequests, 36);
  assert.equal(report.byArm['guide-only'].parseableResponseAttempts, 18);
  assert.equal(report.byArm['guide-only'].astValidatedAttempts, 6);
  assert.equal(report.byArm['guide-only'].nativeValidationCases, 24);
  assert.equal(report.byArm['guide-only'].nativePassedCases, 0);
});

test('invalid identity and an existing abort stop before compiler dispatch', async () => {
  let calls = 0;
  const request = async () => { calls++; return content('{'); };
  await assert.rejects(runWorkedExampleExperiment({ request, modelIdentity: { model: 'x', weightsSha256: 'bad' } }), /SHA-256/);
  await assert.rejects(experiment({ request, signal: AbortSignal.abort() }), /aborted/);
  assert.equal(calls, 0);
});

test('first-attempt denominators stay fixed when worked-example early stopping and feedback diverge', async () => {
  const counts = new Map();
  const report = await experiment({ request: async input => {
    const count = (counts.get(key(input)) ?? 0) + 1;
    counts.set(key(input), count);
    if (input.arm === 'worked-example' || count === 3) return response(candidates[input.family]);
    if (count === 2) return content('{');
    return response(program([loop(ref('vars.unbound'), 'target', [inspectOrder()]), done]));
  } });
  assert.equal(report.byArm['guide-only'].admitted, 6);
  assert.equal(report.byArm['worked-example'].admitted, 6);
  assert.equal(report.byArm['guide-only'].logicalCompilerRequests, 18);
  assert.equal(report.byArm['worked-example'].logicalCompilerRequests, 6);
  assert.equal(report.byArm['guide-only'].firstAttempt.acquisitions, 6);
  assert.equal(report.byArm['worked-example'].firstAttempt.acquisitions, 6);
  assert.equal(report.byArm['guide-only'].firstAttempt.astAccepted, 6);
  assert.equal(report.byArm['guide-only'].firstAttempt.nativePassed, 0);
  assert.equal(report.byArm['worked-example'].firstAttempt.nativePassed, 6);
  assert.equal(report.firstAttemptPairs.length, 6);
  for (const pair of report.firstAttemptPairs) {
    assert.equal(pair.byArm['guide-only'].failureStage, 'native');
    assert.deepEqual(pair.byArm['guide-only'].executionStatuses, { needs_reasoning: 4 });
    assert.equal(pair.byArm['worked-example'].failureStage, null);
    assert.equal(pair.byArm['worked-example'].nativeStatus, 'passed');
  }
});
