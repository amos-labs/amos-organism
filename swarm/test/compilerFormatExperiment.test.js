import test from 'node:test';
import assert from 'node:assert/strict';
import { runCompilerFormatExperiment } from '../src/compilerFormatExperiment.js';
import { buildSequentialDemonstrations, sequentialEvidenceHash } from '../src/sequentialSkillLearning.js';
import { emptySkillLibrary, validateSkillLibrary } from '../src/persistentSkillLibrary.js';
import { createSequentialSkillFixture } from '../evals/sequentialSkillFixture.js';

const modelIdentity = { model: 'compiler-format-native-test', weightsSha256: 'd'.repeat(64) };
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
const experiment = options => runCompilerFormatExperiment({ modelIdentity, ...options });

test('fresh paired curricula, first prompts and balanced arms differ only in the declared format treatment', async () => {
  const requests = [], events = [];
  const report = await experiment({ request: async input => { requests.push(input); return content('invalid JSON'); },
    onEvent: event => events.push(event) });
  assert.equal(report.schema, 'amos.compiler-format-experiment.v1');
  assert.equal(report.runs.length, 12);
  assert.deepEqual(report.modelSeeds, [20260914, 20261015, 20261116]);
  assert.equal(report.logicalCompilerRequests, 36);
  assert.equal(report.maxLogicalCompilerRequests, 36);
  assert.equal(report.evaluationTasksRun, 0);
  assert.equal(report.weightsChanged, false);
  assert.equal(report.neuralRecurrenceTested, false);
  assert.equal(new Set(requests.map(input => input.caseId)).size, 36);
  assert.ok(events.every(event => ['free-form', 'json-object'].includes(event.arm) &&
    ['reserve-order', 'invoice-order'].includes(event.family) && Number.isSafeInteger(event.replicate)));
  assert.ok(events.filter(event => event.caseId).every(event => event.caseId.startsWith(`${event.arm}-`)));

  for (let replicate = 0; replicate < 3; replicate++) for (const [index, family] of ['reserve-order', 'invoice-order'].entries()) {
    const pair = report.runs.filter(run => run.replicate === replicate && run.family === family);
    assert.deepEqual(pair.map(run => run.arm), (replicate + index) % 2 ? ['json-object', 'free-form'] : ['free-form', 'json-object']);
    const expectedDemonstrationSeed = (index ? 90_000 : 80_000) + replicate * 100;
    const expectedAcquisitionSeed = 100_000 + replicate * 100 + index * 1000;
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
      assert.deepEqual(first.responseFormat, run.arm === 'json-object' ? { type: 'json_object' } : null);
      const user = JSON.parse(first.messages.at(-1).content);
      assert.deepEqual(Object.keys(user).sort(), ['demonstrations', 'previousTrainingFeedback', 'skill', 'task', 'tools']);
      assert.equal(user.previousTrainingFeedback, null);
      assert.deepEqual(user.demonstrations, expectedDemonstrations);
      assert.equal(run.requests[0].inputSha256, run.firstInputSha256);
      assert.ok(run.acquisition.attempts.every((attempt, i) => attempt.caseId === run.requests[i].caseId));
    }
    assert.equal(pair[0].inputSha256, pair[1].inputSha256);
    assert.equal(pair[0].firstInputSha256, pair[1].firstInputSha256);
    assert.notEqual(pair[0].requests[0].requestSha256, pair[1].requests[0].requestSha256);
    const common = run => {
      const { arm, caseId, responseFormat, requestSha256, ...input } = requests.find(item => key(item) === key(run));
      return input;
    };
    assert.deepEqual(common(pair[0]), common(pair[1]));
  }
  assert.deepEqual(report.byArm['free-form'], report.byArm['json-object']);
  assert.equal(report.byArm['free-form'].admitted, 0);
  assert.equal(report.byArm['free-form'].logicalCompilerRequests, 18);
  assert.equal(report.byArm['free-form'].parseableResponseAttempts, 0);
  assert.equal(report.firstAttemptPairs.length, 6);
  assert.equal(report.byArm['free-form'].firstAttempt.acquisitions, 6);
  assert.equal(report.byArm['free-form'].firstAttempt.jsonParsed, 0);
  assert.ok(report.firstAttemptPairs.every(pair => pair.byArm['free-form'].jsonParseStatus === 'invalid' &&
    pair.byArm['json-object'].jsonParseStatus === 'invalid'));
});

test('format rejection retains every failed request and acquisition attempt without free-form fallback', async () => {
  const requests = [], events = [];
  const report = await experiment({ request: async input => {
    requests.push(input);
    if (input.arm === 'json-object') throw new Error('endpoint rejected response_format');
    return content('{');
  }, onEvent: event => events.push(event) });
  assert.equal(requests.length, 36);
  for (const run of report.runs) {
    assert.equal(run.acquisition.admitted, false);
    assert.equal(run.requests.length, 3);
    assert.equal(run.acquisition.attempts.length, 3);
    assert.ok(run.acquisition.attempts.every(attempt => attempt.error && attempt.validations === undefined));
    if (run.arm === 'json-object') {
      assert.ok(run.requests.every(row => row.status === 'failed' && row.responseFormat.type === 'json_object'));
      assert.ok(run.acquisition.attempts.every(attempt => attempt.response === undefined && /endpoint rejected/.test(attempt.error)));
      assert.ok(run.acquisition.attempts.every(attempt => attempt.classification.failureStage === 'request'));
    }
  }
  assert.equal(events.filter(event => event.type === 'compiler-request-start').length, 36);
  assert.equal(events.filter(event => event.type === 'compiler-request-finished').length, 36);
  assert.equal(events.filter(event => event.type === 'acquisition-attempt').length, 36);
  assert.equal(report.byArm['json-object'].attemptsWithResponse, 0);
  assert.equal(report.byArm['free-form'].attemptsWithResponse, 18);
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
  assert.equal(report.byArm['json-object'].admitted, 6);
  assert.equal(report.byArm['json-object'].admissionRate, 1);
  assert.equal(report.byArm['json-object'].nativeValidationCases, 48);
  assert.equal(report.byArm['json-object'].nativePassedCases, 24);
  assert.equal(report.byArm['json-object'].firstAttempt.acquisitions, 6);
  assert.equal(report.byArm['json-object'].firstAttempt.jsonParsed, 6);
  assert.equal(report.byArm['json-object'].firstAttempt.astAccepted, 6);
  assert.equal(report.byArm['json-object'].firstAttempt.nativePassed, 0);
  assert.equal(report.byArm['json-object'].firstAttempt.admitted, 0);
});

test('retry feedback may differ by arm without leaking candidates or crossing acquisition boundaries', async () => {
  const calls = new Map();
  const report = await experiment({ request: async input => {
    const previous = calls.get(key(input)) ?? [];
    previous.push(input);
    calls.set(key(input), previous);
    if (previous.length === 1) return input.arm === 'free-form' ? content('{') : response(program([done]));
    return response(candidates[input.family]);
  } });
  for (const run of report.runs) {
    assert.equal(run.acquisition.admitted, true);
    const feedback = JSON.parse(calls.get(key(run))[1].messages.at(-1).content).previousTrainingFeedback;
    assert.equal(feedback.kind, run.arm === 'free-form' ? 'syntax-or-execution-error' : 'training-validation-failure');
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
  assert.equal(report.byArm['free-form'].parseableResponseAttempts, 18);
  assert.equal(report.byArm['free-form'].astValidatedAttempts, 6);
  assert.equal(report.byArm['free-form'].nativeValidationCases, 24);
  assert.equal(report.byArm['free-form'].nativePassedCases, 0);
});

test('invalid identity and an existing abort stop before compiler dispatch', async () => {
  let calls = 0;
  const request = async () => { calls++; return content('{'); };
  await assert.rejects(runCompilerFormatExperiment({ request, modelIdentity: { model: 'x', weightsSha256: 'bad' } }), /SHA-256/);
  await assert.rejects(experiment({ request, signal: AbortSignal.abort() }), /aborted/);
  assert.equal(calls, 0);
});

test('first-attempt denominators stay fixed when early stopping and runtime feedback diverge', async () => {
  const counts = new Map();
  const report = await experiment({ request: async input => {
    const count = (counts.get(key(input)) ?? 0) + 1;
    counts.set(key(input), count);
    if (input.arm === 'json-object' || count === 3) return response(candidates[input.family]);
    if (count === 2) return content('{');
    return response(program([loop(ref('vars.unbound'), 'target', [inspectOrder()]), done]));
  } });
  assert.equal(report.byArm['free-form'].admitted, 6);
  assert.equal(report.byArm['json-object'].admitted, 6);
  assert.equal(report.byArm['free-form'].logicalCompilerRequests, 18);
  assert.equal(report.byArm['json-object'].logicalCompilerRequests, 6);
  assert.equal(report.byArm['free-form'].firstAttempt.acquisitions, 6);
  assert.equal(report.byArm['json-object'].firstAttempt.acquisitions, 6);
  assert.equal(report.byArm['free-form'].firstAttempt.astAccepted, 6);
  assert.equal(report.byArm['free-form'].firstAttempt.nativePassed, 0);
  assert.equal(report.byArm['json-object'].firstAttempt.nativePassed, 6);
  assert.equal(report.firstAttemptPairs.length, 6);
  for (const pair of report.firstAttemptPairs) {
    assert.equal(pair.byArm['free-form'].failureStage, 'native');
    assert.deepEqual(pair.byArm['free-form'].executionStatuses, { needs_reasoning: 4 });
    assert.equal(pair.byArm['json-object'].failureStage, null);
    assert.equal(pair.byArm['json-object'].nativeStatus, 'passed');
  }
});
