import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSequentialSkillFixture, SEQUENTIAL_SKILL_VARIANTS } from '../evals/sequentialSkillFixture.js';
import { emptySkillLibrary, admitCheckedSkill } from '../src/persistentSkillLibrary.js';
import { acquireSequentialSkill, buildSequentialDemonstrations, runSequentialSkillStage,
  runSequentialTask, sequentialEvidenceHash } from '../src/sequentialSkillLearning.js';

const modelIdentity = { model: 'isolated-test-model', weightsSha256: 'a'.repeat(64) };
const empty = () => emptySkillLibrary({ modelIdentity });
const ref = path => ({ $ref: path });
const call = (tool, args, saveAs) => ({ type: 'call', tool, args, saveAs });
const branch = (left, equals, then, otherwise = []) => ({ type: 'if', left, equals, then, else: otherwise });
const loop = (items, as, steps) => ({ type: 'for_each', items, as, steps });
const done = status => ({ type: 'return', status });
const program = steps => ({ schema: 'amos.checked-procedure.v1', steps });
const inspectOrder = () => call('inspect_order', { orderId: ref('vars.target.orderId') }, 'order');
const inspectInvoice = () => call('inspect_invoice', { orderId: ref('vars.target.orderId') }, 'invoice');

// Deliberately test-only compiled candidates. These read public responses and have
// no access to fixture state or the verifier. Two passes handle the single fault.
const reserveProgram = program([
  loop(ref('goal.orders'), 'target', [
    loop([0, 1], 'pass', [
      inspectOrder(),
      branch(ref('vars.order.order.status'), 'open', [
        loop(ref('vars.order.order.lines'), 'line', [
          branch(ref('vars.line.reserved'), false, [
            inspectOrder(),
            call('reserve_line', { orderId: ref('vars.target.orderId'), sku: ref('vars.line.sku'),
              quantity: ref('vars.line.quantity'), expectedRevision: ref('vars.order.order.revision') }, 'written'),
            inspectOrder()
          ])
        ]),
        inspectOrder(),
        call('confirm_order', { orderId: ref('vars.target.orderId'), expectedRevision: ref('vars.order.order.revision') }, 'written'),
        inspectOrder()
      ])
    ])
  ]),
  done('completed')
]);
const invoiceProgram = program([
  loop(ref('goal.orders'), 'target', [
    inspectOrder(),
    loop([0, 1], 'pass', [
      inspectInvoice(),
      branch(ref('vars.invoice.invoice'), null, [
        call('create_invoice', { orderId: ref('vars.target.orderId'), expectedOrderRevision: ref('vars.order.order.revision') }, 'written'),
        inspectInvoice()
      ])
    ]),
    loop([0, 1], 'pass', [
      inspectInvoice(),
      branch(ref('vars.invoice.invoice.reference'), ref('vars.target.invoiceReference'), [], [
        call('annotate_invoice', { invoiceId: ref('vars.invoice.invoice.id'), reference: ref('vars.target.invoiceReference'),
          expectedRevision: ref('vars.invoice.invoice.revision') }, 'written'),
        inspectInvoice()
      ])
    ])
  ]),
  done('completed')
]);
const compiled = (value, finishReason = 'stop') => ({ message: { content: JSON.stringify(value) },
  providerResponse: { choices: [{ finish_reason: finishReason }] } });
const final = (finishReason = 'stop') => ({ message: { content: 'Finished from public observations.' },
  providerResponse: { choices: [{ finish_reason: finishReason }] } });
const actions = (...items) => ({ message: { tool_calls: items.map(([name, args], index) => ({ id: `call-${index}`, type: 'function',
  function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } })) } });
const world = (family = 'reserve-order', variant = 'fresh', seed = 823, split = 'evaluation') =>
  createSequentialSkillFixture({ family, variant, seed, split });
const toolNames = () => world().tools.map(item => item.function.name);
const boundLibrary = (candidate, skillId = 'reserve-order') => admitCheckedSkill(empty(), {
  skillId, description: 'Test receipt; native acquisition is tested separately.', program: candidate, toolNames: toolNames(),
  learningEvidence: { demonstrationsSha256: 'b'.repeat(64), validationTraceSha256: 'c'.repeat(64), validationCases: 1, passedCases: 1 }
});

// A mock model's next action uses only the exact goal/observations sent to it.
// This must never read snapshotForTesting(), verify(), or the fixture closure.
function publicNextAction({ goal, observations }) {
  const latest = observations.at(-1);
  if (latest?.result.error?.code === 'outcome_unknown') {
    const orderMutation = ['reserve_line', 'confirm_order'].includes(latest.name);
    const invoice = observations.toReversed().find(item => item.result.invoice?.id === latest.args.invoiceId)?.result.invoice;
    return [orderMutation ? 'inspect_order' : 'inspect_invoice', { orderId: latest.args.orderId ?? invoice.orderId }];
  }
  for (const target of goal.orders) {
    const order = observations.toReversed().find(item => item.result.order?.id === target.orderId)?.result.order;
    if (!order) return ['inspect_order', { orderId: target.orderId }];
    if (goal.family !== 'invoice-order' && order.status !== 'reserved') {
      const line = order.lines.find(item => !item.reserved);
      if (line) return ['reserve_line', { orderId: order.id, sku: line.sku, quantity: line.quantity, expectedRevision: order.revision }];
      return ['confirm_order', { orderId: order.id, expectedRevision: order.revision }];
    }
    if (goal.family === 'reserve-order') continue;
    const receipt = observations.toReversed().find(item => item.result.ok &&
      (item.result.invoice?.orderId === order.id || item.name === 'inspect_invoice' && item.args.orderId === order.id));
    if (!receipt) return ['inspect_invoice', { orderId: order.id }];
    if (receipt.result.invoice === null) return ['create_invoice', { orderId: order.id, expectedOrderRevision: order.revision }];
    const invoice = receipt.result.invoice;
    if (invoice.reference !== target.invoiceReference) return ['annotate_invoice', {
      invoiceId: invoice.id, reference: target.invoiceReference, expectedRevision: invoice.revision
    }];
  }
  return null;
}
function mockRequest(log = [], { candidates = {}, useSkills = true } = {}) {
  return async input => {
    const data = JSON.parse(input.messages.at(-1).content);
    log.push({ ...input, data });
    if (input.phase === 'compile') return compiled(candidates[input.caseId.includes('reserve-order') ? 'reserve-order' : 'invoice-order'] ??
      (input.caseId.includes('reserve-order') ? reserveProgram : invoiceProgram));
    const appropriate = data.goal.family === 'compose' ? ['reserve-order', 'invoice-order'] : [data.goal.family];
    if (useSkills) {
      const next = appropriate.find(id => data.learnedSkills.some(item => item.skillId === id) && !data.skillReturns.some(item => item.skillId === id));
      if (next) return actions(['use_learned_skill', { skillId: next }]);
    }
    const action = publicNextAction(data);
    return action ? actions(action) : final();
  };
}
async function solvePublicly(fixture) {
  const observations = [];
  for (let index = 0; index < 64; index++) {
    const action = publicNextAction({ goal: fixture.goal, observations });
    if (!action) return observations;
    const [name, args] = action;
    observations.push({ name, args, result: await fixture.execute(name, args) });
  }
  throw new Error('Test public solver exceeded its bound');
}
async function acquire(family = 'reserve-order', overrides = {}) {
  return acquireSequentialSkill({ family, seed: 61_000, replicate: 0, modelIdentity, library: empty(),
    demonstrations: await buildSequentialDemonstrations({ family }), request: mockRequest(), ...overrides });
}

test('teacher demonstrations replay exactly and solve both applied and unapplied ambiguity using public evidence', async () => {
  for (const family of ['reserve-order', 'invoice-order']) {
    const seen = new Set();
    for (let seed = 0; seed < 12; seed++) {
      const demos = await buildSequentialDemonstrations({ family, seed });
      assert.equal(demos.length, 2);
      for (const [index, demo] of demos.entries()) {
        // The selector keeps private fault labels out of model inputs. Rebuild
        // candidates by public fixture identity to audit the selected receipts.
        let replay;
        for (let candidate = seed; candidate < seed + 1000; candidate++) {
          const candidateWorld = world(family, 'ambiguous', candidate, 'training');
          if (candidateWorld.id === demo.id) { replay = candidateWorld; break; }
        }
        assert.ok(replay, 'demonstration is reproducible from the declared training seed range');
        assert.deepEqual(demos[index].goal, replay.goal);
        assert.equal(demos[index].id, replay.id);
        assert.deepEqual(Object.keys(demos[index]).sort(), ['events', 'goal', 'id', 'teacher', 'verified']);
        for (const event of demos[index].events) assert.deepEqual(await replay.execute(event.name, event.args), event.result);
        assert.equal(replay.verify().pass, true, `${family}/ambiguous/${seed}`);
        assert.equal(replay.verify().unsafeRetries, 0);
        seen.add(replay.snapshotForTesting().fault.applied);
        assert.equal(demos[index].events.filter(item => item.result.error?.code === 'outcome_unknown').length, 1);
      }
    }
    assert.deepEqual(seen, new Set([false, true]), 'the test covers both hidden timeout outcomes');
  }
});

test('a declared completed candidate cannot acquire a skill without every native TRAIN validation', async () => {
  const requests = [], events = [];
  const result = await acquire('reserve-order', { request: async input => { requests.push(input); return compiled(program([done('completed')])); },
    onEvent: event => events.push(event) });
  assert.equal(result.admitted, false);
  assert.equal(result.library.digest, empty().digest);
  assert.equal(result.attempts.length, 3);
  assert.equal(requests.length, 3);
  assert.ok(requests.every(item => item.phase === 'compile' && item.tools.length === 0));
  assert.equal(events.filter(item => item.type === 'training-validation').length, 12);
  for (const attempt of result.attempts) {
    assert.equal(attempt.error, 'Procedure failed native TRAIN validation');
    assert.deepEqual(attempt.validations.map(row => row.variant), ['fresh', 'partial', 'ambiguous', 'ambiguous']);
    assert.ok(attempt.validations.every(row => row.programResult.status === 'completed' && !row.verification.pass && !row.pass && row.split === 'training-validation'));
  }
  const feedback = JSON.parse(requests[1].messages.at(-1).content).previousTrainingFeedback;
  assert.equal(feedback.kind, 'training-validation-failure');
  assert.ok(feedback.cases.every(item => item.verification.fixtureId.includes('-training-validation-')));
});

test('native TRAIN validation binds the admitted program, all case traces and demonstration receipt', async () => {
  for (const family of ['reserve-order', 'invoice-order']) {
    const result = await acquire(family);
    assert.equal(result.admitted, true, JSON.stringify(result.attempts.map(item => item.error)));
    assert.equal(result.attempts.length, 1);
    const attempt = result.attempts[0], entry = result.library.entries[0];
    assert.equal(attempt.validations.length, 4);
    assert.ok(attempt.validations.every(item => item.pass && item.verification.pass && item.programResult.status === 'completed'));
    assert.equal(entry.learningEvidence.validationTraceSha256, sequentialEvidenceHash(attempt.validations));
    assert.equal(entry.learningEvidence.demonstrationsSha256, result.demonstrationsSha256);
    assert.equal(entry.learningEvidence.validationCases, 4);
    assert.equal(entry.learningEvidence.passedCases, 4);
    const faultOutcomes = new Set();
    for (const row of attempt.validations) {
      const replay = world(family, row.variant, row.seed, row.split);
      for (const event of row.events) assert.deepEqual(await replay.execute(event.name, event.args), event.result);
      assert.deepEqual(replay.verify(), row.verification);
      assert.notEqual(row.fixtureId, world(family, row.variant, row.seed, 'evaluation').id);
      if (row.variant === 'ambiguous') faultOutcomes.add(replay.snapshotForTesting().fault.applied);
    }
    assert.deepEqual(faultOutcomes, new Set([true, false]), 'admission covers both hidden timeout outcomes');
  }
});

test('native goal achievement with needs_reasoning is not autonomous skill acquisition', async () => {
  const partial = structuredClone(reserveProgram); partial.steps.at(-1).status = 'needs_reasoning';
  const result = await acquire('reserve-order', { request: async () => compiled(partial) });
  assert.equal(result.admitted, false);
  assert.equal(result.library.entries.length, 0);
  assert.ok(result.attempts.every(attempt => attempt.validations.every(row => row.verification.pass && !row.pass)));
});

test('truncated compiler output and undeclared tool references are rejected before native validation', async () => {
  let count = 0;
  const result = await acquire('reserve-order', { request: async () => {
    count++;
    if (count === 1) return compiled(reserveProgram, 'length');
    if (count === 2) return compiled(program([call('use_learned_skill', { skillId: 'reserve-order' }, 'x'), done('completed')]));
    return compiled(reserveProgram);
  } });
  assert.equal(result.admitted, true);
  assert.equal(result.attempts.length, 3);
  assert.match(result.attempts[0].error, /output budget/);
  assert.match(result.attempts[1].error, /unknown tool/);
  assert.equal(result.attempts[0].validations, undefined);
  assert.equal(result.attempts[1].validations, undefined);
});

test('demonstration entity memorization cannot pass the disjoint native validation worlds', async () => {
  const demonstrations = await buildSequentialDemonstrations({ family: 'reserve-order' });
  const copied = program([...demonstrations[0].events.map((item, index) => call(item.name, item.args, `copy${index}`)), done('completed')]);
  const result = await acquire('reserve-order', { demonstrations, request: async () => compiled(copied) });
  assert.equal(result.admitted, false);
  assert.ok(result.attempts.every(attempt => attempt.validations.every(row => !row.pass)));
});

test('raw fallback can solve the evaluation while failed acquisition leaves the library empty', async () => {
  const acquisition = await acquire('reserve-order', { request: async () => compiled(program([done('completed')])) });
  const fixture = world('reserve-order', 'ambiguous');
  const result = await runSequentialTask({ fixture, request: mockRequest(), modelIdentity, library: acquisition.library, demonstrations: [], caseId: 'raw-fallback' });
  assert.equal(result.pass, true);
  assert.equal(result.verification.pass, true);
  assert.equal(acquisition.admitted, false);
  assert.equal(result.libraryDigest, empty().digest);
  assert.deepEqual(result.skillInvocations, []);
  assert.equal(result.directToolCalls, result.toolCalls);
});

test('direct calls and nested skill calls consume one shared case-wide raw-tool budget', async () => {
  const inspectThree = program([loop([0, 1, 2], 'repeat', [call('inspect_order', { orderId: ref('goal.orders.0.orderId') }, 'order')]), done('completed')]);
  const library = boundLibrary(inspectThree), fixture = world();
  let turn = 0;
  const result = await runSequentialTask({ fixture, modelIdentity, library, demonstrations: [], caseId: 'shared-budget', maxToolCallsPerTask: 3,
    request: async () => turn++ ? final() : actions(['inspect_order', { orderId: fixture.goal.orders[0].orderId }], ['use_learned_skill', { skillId: 'reserve-order' }]) });
  assert.equal(result.toolCalls, 3);
  assert.equal(result.directToolCalls, 1);
  assert.equal(result.observations.filter(item => item.source === 'skill:reserve-order').length, 2);
  assert.equal(result.skillInvocations[0].status, 'budget_exhausted');
  assert.equal(result.skillInvocations[0].rawToolCalls, 2);
  assert.equal(fixture.verify().steps, 3);
  assert.equal(result.pass, false);
});

test('a later skill invocation cannot reset an already exhausted raw-tool budget', async () => {
  const fixture = world(), library = boundLibrary(program([call('inspect_order', { orderId: ref('goal.orders.0.orderId') }, 'order'), done('completed')]));
  const result = await runSequentialTask({ fixture, modelIdentity, library, demonstrations: [], caseId: 'no-budget-reset', maxToolCallsPerTask: 1,
    request: async () => actions(['use_learned_skill', { skillId: 'reserve-order' }], ['use_learned_skill', { skillId: 'reserve-order' }]) });
  assert.equal(result.toolCalls, 1);
  assert.equal(result.skillInvocations.length, 1);
  assert.equal(result.modelCalls, 1);
  assert.equal(result.termination, 'execution-error');
  assert.match(result.error, /raw-tool budget/);
});

test('native task achievement still fails when the model call budget ends without a final answer', async () => {
  const library = (await acquire()).library, fixture = world();
  const result = await runSequentialTask({ fixture, modelIdentity, library, demonstrations: [], caseId: 'no-final-answer', maxModelCallsPerTask: 1,
    request: async () => actions(['use_learned_skill', { skillId: 'reserve-order' }]) });
  assert.equal(result.verification.pass, true);
  assert.equal(result.termination, 'model-call-budget');
  assert.equal(result.pass, false);
  assert.equal(result.modelCalls, 1);
});

test('a truncated final response cannot turn achieved state into a bounded completion', async () => {
  const library = (await acquire()).library, fixture = world();
  let count = 0;
  const result = await runSequentialTask({ fixture, modelIdentity, library, demonstrations: [], caseId: 'truncated-final',
    request: async () => count++ ? final('length') : actions(['use_learned_skill', { skillId: 'reserve-order' }]) });
  assert.equal(result.verification.pass, true);
  assert.equal(result.termination, 'model-output-budget');
  assert.equal(result.pass, false);
});

test('an abort during the final model request cannot pass an already achieved native task', async () => {
  const fixture = world(); await solvePublicly(fixture);
  const controller = new AbortController();
  const result = await runSequentialTask({ fixture, modelIdentity, library: empty(), demonstrations: [], caseId: 'late-final', signal: controller.signal,
    request: async () => { controller.abort(); return final(); } });
  assert.equal(result.verification.pass, true);
  assert.equal(result.pass, false);
  assert.equal(result.termination, 'deadline-or-abort');
});

test('unknown or malformed skill requests cannot invoke a saved program or manufacture evidence', async () => {
  let turn = 0;
  const result = await runSequentialTask({ fixture: world(), modelIdentity, library: boundLibrary(reserveProgram), demonstrations: [], caseId: 'bad-skill',
    request: async () => turn++ ? final() : actions(['use_learned_skill', '{'], ['use_learned_skill', { skillId: 'missing' }],
      ['use_learned_skill', { skillId: 'reserve-order', force: true }]) });
  assert.equal(result.toolCalls, 0);
  assert.deepEqual(result.observations, []);
  assert.equal(result.skillInvocations.length, 3);
  assert.ok(result.skillInvocations.every(item => item.status === 'unavailable' && item.rawToolCalls === 0));
  assert.equal(result.pass, false);
});

test('tampered library contents, model mismatches and foreign tool catalogs are rejected before requests', async () => {
  let requests = 0;
  const base = { fixture: world(), modelIdentity, library: boundLibrary(reserveProgram), demonstrations: [], caseId: 'invalid-library', request: async () => { requests++; return final(); } };
  const tampered = structuredClone(base.library); tampered.entries[0].program.steps.at(-1).status = 'needs_reasoning';
  await assert.rejects(runSequentialTask({ ...base, library: tampered }), /hash mismatch/);
  await assert.rejects(runSequentialTask({ ...base, modelIdentity: { ...modelIdentity, weightsSha256: 'f'.repeat(64) } }), /model identity mismatch/);
  await assert.rejects(acquireSequentialSkill({ family: 'invoice-order', seed: 1, replicate: 0, modelIdentity: { ...modelIdentity, model: 'different' },
    library: base.library, demonstrations: [], request: base.request }), /model identity mismatch/);
  const foreign = admitCheckedSkill(empty(), { skillId: 'foreign', description: 'Unrelated catalog.',
    program: program([call('foreign_tool', {}, 'x'), done('completed')]), toolNames: ['foreign_tool'],
    learningEvidence: { demonstrationsSha256: 'b'.repeat(64), validationTraceSha256: 'c'.repeat(64), validationCases: 1, passedCases: 1 } });
  await assert.rejects(runSequentialTask({ ...base, library: foreign }), /outside the current native catalog/);
  assert.equal(requests, 0);
});

test('A evaluation pairs share goal, demonstrations, raw tools and budgets; acquisition calls are recorded separately', async () => {
  const requests = [], report = await runSequentialSkillStage({ stage: 'A', replicate: 1, seed: 915, modelIdentity, request: mockRequest(requests) });
  assert.equal(report.results.length, 6);
  assert.equal(report.acquisition.admitted, true);
  assert.equal(requests.filter(item => item.phase === 'compile').length, 1);
  assert.equal(report.results.reduce((sum, row) => sum + row.modelCalls, 0), requests.filter(item => item.phase === 'execute').length);
  assert.ok(report.results.every(row => row.pass), JSON.stringify(report.results.map(row => [row.caseId, row.error, row.verification])));
  for (const variant of SEQUENTIAL_SKILL_VARIANTS['reserve-order']) {
    const pair = report.results.filter(row => row.variant === variant);
    assert.deepEqual(new Set(pair.map(row => row.arm)), new Set(['baseline', 'learned']));
    assert.equal(pair[0].inputSha256, pair[1].inputSha256);
    const inputs = pair.map(row => requests.find(item => item.phase === 'execute' && item.caseId === `${row.caseId}-turn-0`));
    assert.deepEqual(inputs[0].data.goal, inputs[1].data.goal);
    assert.deepEqual(inputs[0].data.demonstrations, inputs[1].data.demonstrations);
    assert.deepEqual(inputs[0].tools.filter(item => item.function.name !== 'use_learned_skill'), inputs[1].tools.filter(item => item.function.name !== 'use_learned_skill'));
    const baseline = pair.find(row => row.arm === 'baseline'), learned = pair.find(row => row.arm === 'learned');
    assert.equal(baseline.libraryDigest, empty().digest);
    assert.equal(learned.libraryDigest, report.library.digest);
    assert.equal(baseline.skillInvocations.length, 0);
    assert.equal(learned.skillInvocations.length, 1);
  }
  for (const input of requests.filter(item => item.phase === 'execute')) {
    assert.deepEqual(Object.keys(input.data).sort(), ['demonstrations', 'goal', 'learnedSkills', 'observations', 'remainingRawToolCalls', 'skillReturns']);
    assert.ok(input.data.demonstrations.every(item => item.id.includes('-training-')));
  }
});

test('B rejects same-process and malformed prior-process evidence before requesting a model', async () => {
  const prior = await runSequentialSkillStage({ stage: 'A', replicate: 0, seed: 721, modelIdentity, request: mockRequest() });
  let requests = 0;
  const run = candidate => runSequentialSkillStage({ stage: 'B', replicate: 0, seed: 721, modelIdentity,
    prior: candidate, request: async () => { requests++; return final(); } });
  for (const processId of [process.pid, undefined, null, 0, -1, '123', 1.5]) {
    await assert.rejects(run({ ...prior, processId }), /separate process|processId|prior/i);
  }
  assert.equal(requests, 0);
});

test('a real fresh Node process reloads A and B preserves the exact A artifact and matched reused baselines', { timeout: 30_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'amos-sequential-core-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const priorPath = join(dir, 'A-report.json');
  const source = new URL('../src/sequentialSkillLearning.js', import.meta.url).href;
  const persistence = new URL('../src/persistentSkillLibrary.js', import.meta.url).href;
  const code = `import {writeFile} from 'node:fs/promises';
    import {runSequentialSkillStage} from ${JSON.stringify(source)};
    import {saveSkillLibrary} from ${JSON.stringify(persistence)};
    const report=await runSequentialSkillStage({stage:'A',replicate:0,seed:417,modelIdentity:${JSON.stringify(modelIdentity)},
      request:async({phase})=>({message:{content:phase==='compile'?${JSON.stringify(JSON.stringify(reserveProgram))}:'No action'}})});
    await saveSkillLibrary(${JSON.stringify(join(dir, 'library.json'))},report.library);
    await writeFile(${JSON.stringify(priorPath)},JSON.stringify(report));`;
  const child = spawn(process.execPath, ['--input-type=module'], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; }); child.stdout.resume();
  child.stdin.end(code);
  const [exitCode] = await once(child, 'exit');
  assert.equal(exitCode, 0, stderr);
  const prior = JSON.parse(await readFile(priorPath, 'utf8'));
  const { loadSkillLibrary } = await import('../src/persistentSkillLibrary.js');
  prior.library = await loadSkillLibrary(join(dir, 'library.json'));
  assert.equal(prior.processId, child.pid);
  assert.notEqual(prior.processId, process.pid);
  assert.equal(prior.acquisition.admitted, true);
  const requests = [], report = await runSequentialSkillStage({ stage: 'B', replicate: 0, seed: 417, modelIdentity, prior, request: mockRequest(requests) });
  assert.equal(report.results.length, 13);
  assert.equal(report.acquisition.admitted, true);
  assert.equal(report.parentLibraryDigest, prior.library.digest);
  assert.equal(report.library.parentDigest, prior.library.digest);
  assert.deepEqual(report.library.entries.map(item => item.skillId), ['reserve-order', 'invoice-order']);
  assert.deepEqual(report.library.entries[0], prior.library.entries[0]);
  assert.equal(report.retention.separateProcess, true);
  assert.equal(report.retention.aArtifactPreserved, true);
  assert.equal(report.retention.rows.length, 3);
  assert.ok(report.results.every(row => row.pass), JSON.stringify(report.results.map(row => [row.caseId, row.error, row.verification])));
  for (const row of report.results.filter(item => item.family === 'reserve-order')) {
    assert.equal(row.arm, 'learned');
    const baseline = prior.results.find(item => item.caseId === row.retention.baselineCaseId);
    const before = prior.results.find(item => item.caseId === row.retention.beforeCaseId);
    assert.equal(row.inputSha256, baseline.inputSha256);
    assert.equal(row.inputSha256, before.inputSha256);
    assert.equal(row.retention.baselinePass, baseline.pass);
    assert.equal(row.retention.beforePass, before.pass);
    assert.equal(row.retention.reusedBaseline, true);
    assert.equal(row.retention.repeatedCase, true);
  }
  const bCompile = requests.find(item => item.phase === 'compile');
  assert.equal(bCompile.data.demonstrations.length, 2);
  assert.ok(bCompile.data.demonstrations.every(item => item.goal.family === 'invoice-order'));
  assert.equal(bCompile.data.previousTrainingFeedback, null);
  assert.equal(requests.some(item => item.caseId.includes('B-reserve-order') && item.caseId.includes('baseline')), false);
  const changed = structuredClone(prior);
  changed.results.find(item => item.arm === 'baseline').inputSha256 = '0'.repeat(64);
  let forbiddenRequests = 0;
  await assert.rejects(runSequentialSkillStage({ stage: 'B', replicate: 0, seed: 417, modelIdentity, prior: changed,
    request: async () => { forbiddenRequests++; return final(); } }), /retention|baseline|inputs/i);
  assert.equal(forbiddenRequests, 0, 'a mismatched prior baseline must fail before any model request');
});
