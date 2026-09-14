import test from 'node:test';
import assert from 'node:assert/strict';
import { WORKFLOW_MEMORY_ARMS, createPlan, buildAcquisitionInput, buildSnapshots, validateSnapshot,
  runTask, validateTaskResult } from '../src/workflowMemoryExperiment.js';
import { createWorkflowMemoryFixture } from '../evals/workflowMemoryFixture.js';
import { createSequentialSkillFixture } from '../evals/sequentialSkillFixture.js';
import { createObservedExperience, createReplayMemory, validateReplayMemory } from '../src/persistentReplayMemory.js';
import { sequentialEvidenceHash as hash } from '../src/sequentialSkillLearning.js';

const modelIdentity = { model: 'workflow-memory-native-test', weightsSha256: 'a'.repeat(64) };
const plan = createPlan({ modelIdentity });
const inputs = plan.acquisitions.map(slot => buildAcquisitionInput({ acquisitionId: slot.acquisitionId, modelIdentity }));
const response = (content, finish_reason = 'stop') => ({ message: { content },
  providerResponse: { choices: [{ finish_reason }], usage: { total_tokens: 23 } } });
const actions = (...items) => ({ message: { tool_calls: items.map(([name, args], index) => ({
  id: `call-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) }
})) }, providerResponse: { choices: [{ finish_reason: 'tool_calls' }] } });
const policyFrom = input => input.demonstrations[0].events.find(event => event.name === 'inspect_workflow_policy').result.policy;
const goodTexts = inputs.map(input => input.arm === 'docs-advice'
  ? 'Inspect the current workflow policy to discover its normalization convention. Inspect the order and invoice, reuse a draft or create one, then annotate using the current revision. Reconcile unknown effects and never send the invoice.'
  : `For ${input.profileId} version 1, normalize externalReference with ${JSON.stringify(policyFrom(input).normalization)}. Use this convention only for the matching profile and version. On a version change inspect the current policy. Reuse or create a draft invoice, annotate with the latest revision, and inspect unknown effects before retrying. Never send invoices.`);
const acquire = (overrides = {}) => buildSnapshots({ modelIdentity, acquisitions: inputs.map((input, index) => ({
  acquisitionId: input.acquisitionId, input,
  ...(Object.hasOwn(overrides, input.acquisitionId) ? overrides[input.acquisitionId] : { response: response(goodTexts[index]) })
})) });
const memory = acquire();
const experienceInput = inputs.find(input => input.arm === 'experience-memory');
const emptyAdvice = { profileId: null, policyVersion: null, text: '' };
const worldFor = spec => spec.profileId
  ? createWorkflowMemoryFixture({ ...spec, workflowProfile: spec.profileId }) : createSequentialSkillFixture(spec);

function normalize(reference, convention) {
  let text = convention.trim ? reference.trim() : reference;
  text = convention.case === 'upper' ? text.toUpperCase() : text.toLowerCase();
  return convention.prefix + text + convention.suffix;
}

// Every action uses only the current public goal, advice, and tool receipts.
// No actor decision reads a case seed, hidden fault, private verifier, or policy table.
function publicSolver(input, { useMatchingAdvice = false } = {}) {
  const { goal, observations, memoryAdvice } = JSON.parse(input.messages.at(-1).content);
  const target = goal.orders[0], last = observations.at(-1);
  if (last?.result?.error?.code === 'outcome_unknown') {
    return actions([goal.family === 'reserve-order' ? 'inspect_order' : 'inspect_invoice', { orderId: target.orderId }]);
  }
  let convention = observations.findLast(event => event.result.ok && event.result.policy && event.result.policy.workflowProfile === goal.workflowProfile
    && event.result.policy.policyVersion === goal.policyVersion)?.result.policy.normalization;
  if (!convention && useMatchingAdvice && memoryAdvice.profileId === goal.workflowProfile && memoryAdvice.policyVersion === goal.policyVersion) {
    const saved = memoryAdvice.text.match(/normalize externalReference with (\{[^\n]+?\})\./u);
    if (saved) convention = JSON.parse(saved[1]);
  }
  if (goal.workflowProfile && !convention) return actions(['inspect_workflow_policy', {
    workflowProfile: goal.workflowProfile, policyVersion: goal.policyVersion
  }]);
  const order = observations.findLast(event => event.result.ok && event.result.order?.id === target.orderId)?.result.order;
  if (!order) return actions(['inspect_order', { orderId: target.orderId }]);
  if (goal.family === 'reserve-order') {
    if (order.status === 'reserved') return response('Completed from public receipts.');
    const line = order.lines.find(item => !item.reserved);
    return line ? actions(['reserve_line', { orderId: order.id, sku: line.sku, quantity: line.quantity, expectedRevision: order.revision }])
      : actions(['confirm_order', { orderId: order.id, expectedRevision: order.revision }]);
  }
  const invoiceEvent = observations.findLast(event => event.result.ok && Object.hasOwn(event.result, 'invoice'));
  if (!invoiceEvent) return actions(['inspect_invoice', { orderId: target.orderId }]);
  const invoice = invoiceEvent.result.invoice;
  if (!invoice) return actions(['create_invoice', { orderId: target.orderId, expectedOrderRevision: order.revision }]);
  const reference = goal.workflowProfile ? normalize(target.externalReference, convention) : target.invoiceReference;
  if (invoice.reference !== reference) return actions(['annotate_invoice', {
    invoiceId: invoice.id, reference, expectedRevision: invoice.revision
  }]);
  return response('Completed from public receipts.');
}
const run = (spec = plan.tasks[0], overrides = {}) => runTask({ taskId: spec.taskId, modelIdentity,
  loadedMemory: memory.snapshots[spec.arm], request: publicSolver, ...overrides });
const stripAdvice = row => {
  const messages = structuredClone(row.messages), user = JSON.parse(messages.at(-1).content);
  delete user.memoryAdvice; messages.at(-1).content = JSON.stringify(user); return messages;
};

test('fixed eight-case triplets, source seeds, arm rotation, and hard caps are bound before requests', () => {
  assert.equal(plan.schema, 'amos.workflow-memory-experiment.v1');
  assert.deepEqual(plan.arms, ['no-memory', 'docs-advice', 'experience-memory']);
  assert.deepEqual(plan.cases.map(row => row.seed), [280000, 280100, 281000, 281100, 282000, 282100, 260100, 270200]);
  assert.deepEqual(plan.cases.map(row => row.variant), ['fresh', 'ambiguous', 'fresh', 'ambiguous', 'fresh', 'partial', 'partial', 'ambiguous']);
  assert.deepEqual(inputs.filter(row => row.arm === 'experience-memory').map(row => row.trainingReceipts.map(receipt => receipt.seed)),
    [[290000, 290101], [291000, 291100]]);
  assert.equal(plan.tasks.length, 24);
  assert.equal(new Set(plan.tasks.map(row => row.taskId)).size, 24);
  assert.equal(new Set(plan.cases.map(row => row.fixtureId)).size, 8);
  assert.deepEqual(plan.limits, { maxLogicalRequests: 292, maxModelCallsPerTask: 12, maxToolCallsPerTask: 32,
    taskTimeoutMs: 120000, maxMinutes: 60, executionMaxOutputTokens: 1536, acquisitionMaxOutputTokens: 512, maxMemoryWords: 160 });
  for (const spec of plan.cases) {
    const triplet = plan.tasks.filter(row => row.caseIndex === spec.caseIndex);
    assert.deepEqual(triplet.map(row => row.arm), Array.from({ length: 3 }, (_, offset) => WORKFLOW_MEMORY_ARMS[(spec.caseIndex + offset) % 3]));
    assert.ok(triplet.every(row => row.fixtureId === spec.fixtureId && row.modelSeed === 20260919 + spec.caseIndex * 101));
    const world = worldFor(spec);
    assert.equal(world.id, spec.fixtureId);
    if (spec.ambiguityApplied !== undefined) assert.equal(world.snapshotForTesting().fault.applied, spec.ambiguityApplied);
    if (spec.profileId) assert.equal(world.snapshotForTesting().policySha256, spec.policySha256);
  }
  assert.equal(Object.isFrozen(plan.tasks[0]), true);
});

test('docs source has zero episodes or policy constants; experience source replays against real native tools', () => {
  const trainingIds = new Set();
  for (const input of inputs) {
    const user = JSON.parse(input.messages.at(-1).content);
    assert.equal(input.phase, 'memory-acquisition');
    assert.equal(input.temperature, 1);
    assert.equal(input.maxOutputTokens, 512);
    assert.equal(input.responseFormat, null);
    assert.equal(input.modelSeed, 20260918 + (input.profileId === 'wf-b8a1' ? 101 : 0));
    assert.deepEqual(input.tools, []);
    assert.deepEqual(Object.keys(user).sort(), ['demonstrations', 'policyVersion', 'profileId', 'task', 'tools']);
    assert.equal(input.demonstrationsSha256, hash(user.demonstrations));
    assert.equal(input.trainingReceiptsSha256, hash(input.trainingReceipts));
    assert.equal(Object.isFrozen(input.messages), true);
    if (input.arm === 'docs-advice') {
      assert.deepEqual(user.demonstrations, []);
      assert.deepEqual(input.trainingReceipts, []);
      assert.deepEqual(input.entityIdentifiers, []);
      assert.equal(input.sourcePolicySha256, null);
      const stringLeaves = value => typeof value === 'string' ? [value]
        : value && typeof value === 'object' ? Object.values(value).flatMap(stringLeaves) : [];
      const publicText = [input.messages[0].content, ...stringLeaves(user)];
      for (const constant of ['NX/', '/4', 'qr:', ':8', 'vt:', ':2', 'LM/', '/7']) {
        assert.equal(publicText.some(value => value.includes(constant)), false, constant);
      }
      continue;
    }
    assert.equal(input.demonstrations.length, 2);
    assert.deepEqual(input.trainingReceipts.map(row => row.variant), ['fresh', 'ambiguous']);
    for (const [index, receipt] of input.trainingReceipts.entries()) {
      const world = createWorkflowMemoryFixture(receipt), demo = input.demonstrations[index];
      trainingIds.add(world.id);
      assert.equal(receipt.split, 'workflow-memory-training');
      assert.equal(demo.id, world.id);
      assert.deepEqual(demo.goal, world.goal);
      assert.equal(receipt.eventsSha256, hash(demo.events));
      for (const event of demo.events) assert.deepEqual(world.execute(event.name, event.args), event.result);
      assert.deepEqual(world.verify(), receipt.verification);
      assert.equal(receipt.verification.pass, true);
      assert.equal(receipt.verification.evidenceComplete, true);
      assert.equal(world.snapshotForTesting().policySha256, input.sourcePolicySha256);
    }
    const doc = inputs.find(row => row.arm === 'docs-advice' && row.profileId === input.profileId);
    assert.equal(input.messages[0].content, doc.messages[0].content);
    const withoutEpisodes = { ...user, demonstrations: [] };
    assert.deepEqual(withoutEpisodes, JSON.parse(doc.messages.at(-1).content));
  }
  assert.equal(trainingIds.size, 4);
  assert.ok(plan.cases.every(row => !trainingIds.has(row.fixtureId)));
});

test('generated advice stays unverified with exact arm/profile/source provenance and no source episodes in the store', () => {
  assert.equal(memory.snapshots['no-memory'].records.length, 0);
  assert.equal(memory.memories.length, 4);
  assert.ok(memory.memories.every(row => row.available && !row.rejectionReasons.length));
  for (const arm of WORKFLOW_MEMORY_ARMS) {
    const snapshot = memory.snapshots[arm];
    assert.deepEqual(validateSnapshot({ snapshot, arm, memoryKey: arm, modelIdentity }), snapshot);
    assert.deepEqual(validateReplayMemory(snapshot), snapshot);
    for (const record of snapshot.records) {
      const provenance = JSON.parse(record.source.reference), input = inputs.find(row => row.acquisitionId === provenance.acquisitionId);
      assert.equal(record.verification.status, 'unverified');
      assert.equal(record.verification.receiptSha256, null);
      assert.equal(record.example, null);
      assert.equal(record.partition, 'training');
      assert.deepEqual(record.source.permittedUses, ['evaluation', 'memory']);
      assert.equal(provenance.arm, arm);
      assert.deepEqual(provenance.modelIdentity, modelIdentity);
      for (const key of ['inputSha256', 'demonstrationsSha256', 'trainingReceiptsSha256', 'sourcePolicySha256']) assert.equal(provenance[key], input[key]);
      assert.equal(record.text, goodTexts[inputs.indexOf(input)]);
      const exported = JSON.stringify(record);
      for (const identifier of input.entityIdentifiers) assert.equal(exported.includes(identifier), false);
      assert.equal(exported.includes('teacher'), false);
    }
  }
});

test('availability records all fixed rejection types, trims ephemeral references, and allows stable rules and numbers', () => {
  const acquisitionId = experienceInput.acquisitionId;
  const externalReference = experienceInput.demonstrations[0].goal.orders[0].externalReference;
  assert.notEqual(externalReference, externalReference.trim());
  assert.ok(experienceInput.entityIdentifiers.includes(externalReference.trim()));
  const cases = [
    { acquired: { response: response('  ') }, reason: 'empty-text' },
    { acquired: { response: { message: {} } }, reason: 'empty-text' },
    { acquired: {}, reason: 'empty-text' },
    { acquired: { response: response('Retain the rule.', 'length') }, reason: 'output-truncated' },
    { acquired: { response: response(Array(161).fill('word').join('\n')) }, reason: 'word-limit' },
    { acquired: { response: response(`Use ${externalReference.trim()} here.`) }, reason: 'copied-training-identifier' },
    { acquired: { error: 'Provider disconnected', response: response('Untrusted partial advice.') }, reason: 'request-error' }
  ];
  for (const { acquired, reason } of cases) {
    const result = acquire({ [acquisitionId]: acquired }), receipt = result.memories.find(row => row.acquisitionId === acquisitionId);
    assert.equal(receipt.available, false);
    assert.ok(receipt.rejectionReasons.includes(reason));
    assert.equal(receipt.recordId, null);
    assert.equal(result.snapshots['experience-memory'].records.length, 1);
    assert.equal(result.snapshots['docs-advice'].records.length, 2);
    assert.deepEqual(receipt.response, acquired.response ?? null);
    assert.equal(receipt.error, acquired.error ?? null);
  }
  const allowed = acquire({ [acquisitionId]: { response: response('  wf-6f2c version 1 uses NX/ and /4; retain 123456789 or 42.  ') } });
  const allowedRow = allowed.memories.find(row => row.acquisitionId === acquisitionId);
  assert.equal(allowedRow.available, true);
  assert.deepEqual(allowedRow.copiedIdentifiers, []);
  assert.equal(allowed.snapshots['experience-memory'].records.find(row => row.id === allowedRow.recordId).text,
    'wf-6f2c version 1 uses NX/ and /4; retain 123456789 or 42.');
  const exactLimit = acquire({ [acquisitionId]: { response: response(Array(160).fill('word').join('\t')) } });
  assert.equal(exactLimit.memories.find(row => row.acquisitionId === acquisitionId).available, true);
  assert.equal(exactLimit.memories.find(row => row.acquisitionId === acquisitionId).wordCount, 160);
  assert.throws(() => buildSnapshots({ modelIdentity, acquisitions: [] }), /four acquisition/);
  const changed = structuredClone(inputs[0]); changed.messages.at(-1).content = '{}';
  assert.throws(() => buildSnapshots({ modelIdentity, acquisitions: inputs.map((input, index) => ({
    acquisitionId: input.acquisitionId, input: index ? input : changed, response: response(goodTexts[index])
  })) }), /provenance/);
});

test('valid replay records cannot cross advice arms or forge source, model, availability, or verification provenance', () => {
  const snapshot = memory.snapshots['experience-memory'], original = snapshot.records[0];
  const validate = value => validateSnapshot({ snapshot: value, arm: 'experience-memory', memoryKey: 'experience-memory', modelIdentity });
  const forged = mutate => {
    const input = structuredClone(original); mutate(input);
    return createReplayMemory({ tenantId: snapshot.tenantId, observations: [createObservedExperience(input)] });
  };
  const alterReference = mutate => forged(input => {
    const provenance = JSON.parse(input.source.reference); mutate(provenance); input.source.reference = JSON.stringify(provenance);
  });
  assert.throws(() => validateSnapshot({ snapshot, arm: 'docs-advice', memoryKey: 'docs-advice', modelIdentity }), /provenance/);
  assert.throws(() => validateSnapshot({ snapshot, arm: 'no-memory', memoryKey: 'no-memory', modelIdentity }), /size/);
  assert.throws(() => validateSnapshot({ snapshot, arm: 'experience-memory', memoryKey: 'docs-advice', modelIdentity }), /scope/);
  assert.throws(() => validateSnapshot({ snapshot, arm: 'experience-memory', memoryKey: 'experience-memory',
    modelIdentity: { ...modelIdentity, weightsSha256: 'b'.repeat(64) } }), /scope/);
  for (const key of ['inputSha256', 'demonstrationsSha256', 'trainingReceiptsSha256', 'sourcePolicySha256']) {
    assert.throws(() => validate(alterReference(value => { value[key] = 'f'.repeat(64); })), /binding/, key);
  }
  assert.throws(() => validate(alterReference(value => { value.acquisitionId = 'docs-advice-wf-6f2c'; })), /binding/);
  assert.throws(() => validate(alterReference(value => { value.responseSha256 = null; })), /binding/);
  assert.throws(() => validate(alterReference(value => { value.policyVersion = 2; })), /provenance/);
  assert.throws(() => validate(forged(input => { input.verification = { status: 'verified', receiptSha256: 'c'.repeat(64), verifierId: 'forged-native-checker' }; })), /provenance/);
  assert.throws(() => validate(forged(input => { input.lineageGroups = input.lineageGroups.filter(value => !value.startsWith('input-')); })), /binding/);
  assert.throws(() => validate(forged(input => { input.text = Array(161).fill('word').join(' '); })), /binding/);
  assert.throws(() => validate(forged(input => { input.text = `Copy ${experienceInput.demonstrations[0].goal.orders[0].externalReference.trim()}`; })), /binding/);
  assert.throws(() => validate(forged(input => { input.source.permittedUses = ['memory', 'training']; })), /binding/);
  const corrupt = structuredClone(snapshot); corrupt.records[0].text = 'Changed without recomputing the digest.';
  assert.throws(() => validate(corrupt), /changed/);
});

test('public-policy solver completes every native world in all three arms with exact normalized triplet inputs', async () => {
  for (const spec of plan.cases) {
    const results = [];
    for (const task of plan.tasks.filter(row => row.caseIndex === spec.caseIndex)) {
      const events = [], result = await run(task, { onEvent: event => { events.push(event); } });
      assert.equal(result.pass, true, JSON.stringify(result));
      assert.equal(result.verification.taskStateAchieved, true);
      assert.equal(result.verification.evidenceComplete, true);
      assert.equal(result.verification.unsafeRetries, 0);
      assert.equal(result.termination, 'model-finished');
      assert.equal(result.modelCalls, result.requests.length);
      assert.equal(result.policyLookups, spec.profileId ? 1 : 0);
      assert.equal(result.skillInvocations.length, 0);
      assert.equal(events.filter(event => event.type === 'workflow-task-request-start').length, result.modelCalls);
      assert.equal(events.filter(event => event.type === 'workflow-task-request-finished').length, result.modelCalls);
      validateTaskResult({ taskSpec: task, result, modelIdentity });
      if (spec.cohort === 'changed-version') assert.deepEqual(result.versionSafety,
        { currentPolicyLookupBeforeFirstAnnotation: true, staleWriteAttempts: 0, pass: true });
      else assert.equal(result.versionSafety, null);
      results.push(result);
    }
    const baseline = results.find(result => result.arm === 'no-memory');
    for (const result of results) {
      assert.equal(result.firstInputSha256, baseline.firstInputSha256);
      assert.deepEqual(result.observations, baseline.observations);
      assert.equal(result.requests.length, baseline.requests.length);
      for (const [index, row] of result.requests.entries()) {
        const user = JSON.parse(row.messages.at(-1).content), expected = baseline.requests[index];
        assert.deepEqual(Object.keys(user).sort(), ['demonstrations', 'goal', 'learnedSkills', 'memoryAdvice', 'observations', 'remainingRawToolCalls', 'skillReturns']);
        assert.deepEqual(user.demonstrations, []);
        assert.deepEqual(user.learnedSkills, []);
        assert.deepEqual(stripAdvice(row), stripAdvice(expected));
        assert.equal(row.inputSha256, expected.inputSha256);
        assert.deepEqual(row.tools, expected.tools);
        assert.equal(row.tools.some(tool => tool.function.name === 'use_learned_skill'), false);
        assert.equal(row.temperature, 0);
        assert.equal(row.maxOutputTokens, 1536);
        assert.equal(row.responseFormat, null);
        assert.equal(row.modelSeed, spec.modelSeed);
        assert.equal(row.status, 'returned');
        if (spec.profileId && result.arm !== 'no-memory') {
          const input = inputs.find(item => item.arm === result.arm && item.profileId === spec.profileId);
          assert.deepEqual(user.memoryAdvice, { profileId: spec.profileId, policyVersion: 1, text: goodTexts[inputs.indexOf(input)] });
          assert.notEqual(row.actualInputSha256, expected.actualInputSha256);
          assert.equal(result.memoryAvailable, true);
          assert.equal(result.memoryProfileVersion, 1);
        } else {
          assert.deepEqual(user.memoryAdvice, emptyAdvice);
          assert.equal(row.actualInputSha256, expected.actualInputSha256);
          assert.equal(result.memoryAvailable, false);
          assert.equal(result.memoryRecordId, null);
        }
      }
    }
  }
});

test('matching public advice can save a lookup, while its unchanged v1 scope forces refresh on v2 tasks', async () => {
  for (const spec of plan.cases.filter(row => row.profileId)) {
    const results = [];
    for (const task of plan.tasks.filter(row => row.caseIndex === spec.caseIndex)) {
      const result = await run(task, { request: input => publicSolver(input, { useMatchingAdvice: true }) });
      assert.equal(result.pass, true);
      results.push(result);
    }
    const experience = results.find(row => row.arm === 'experience-memory');
    const controls = results.filter(row => row.arm !== 'experience-memory');
    if (spec.cohort === 'stable') {
      assert.equal(experience.policyLookups, 0);
      for (const control of controls) {
        assert.equal(control.policyLookups, 1);
        assert.equal(experience.modelCalls, control.modelCalls - 1);
        assert.equal(experience.toolCalls, control.toolCalls - 1);
      }
    } else {
      assert.equal(experience.memoryProfileVersion, 1);
      assert.equal(experience.policyVersion, 2);
      assert.equal(experience.policyLookups, 1);
      assert.equal(experience.versionSafety.pass, true);
    }
  }
});

test('unavailable advice remains empty and unsupported completion or unresolved effects fail native verification', async () => {
  const task = plan.tasks.find(row => row.caseIndex === 0 && row.arm === 'experience-memory');
  const unavailable = acquire({ [experienceInput.acquisitionId]: { response: response('') } });
  const result = await run(task, { loadedMemory: unavailable.snapshots['experience-memory'], request: input => {
    assert.deepEqual(JSON.parse(input.messages.at(-1).content).memoryAdvice, emptyAdvice);
    return response('Everything is complete.');
  } });
  assert.equal(result.memoryAvailable, false);
  assert.equal(result.memoryRecordDigest, null);
  assert.equal(result.pass, false);
  assert.equal(result.verification.taskStateAchieved, false);
  const ambiguous = plan.tasks.find(row => row.caseIndex === 1 && row.arm === 'no-memory');
  const unresolved = await run(ambiguous, { request: input => {
    const observations = JSON.parse(input.messages.at(-1).content).observations;
    return observations.at(-1)?.result?.error?.code === 'outcome_unknown' ? response('Done.') : publicSolver(input);
  } });
  assert.equal(unresolved.pass, false);
  assert.equal(unresolved.verification.evidenceComplete, false);
  assert.equal(unresolved.verification.unresolvedOutcomes, 1);
});

test('native correctness does not erase a stale write attempt from the separate version-safety receipt', async () => {
  const task = plan.tasks.find(row => row.caseIndex === 4 && row.arm === 'experience-memory');
  let staleAttempted = false;
  const result = await run(task, { request: input => {
    const { goal, memoryAdvice } = JSON.parse(input.messages.at(-1).content);
    const next = publicSolver(input), call = next.message.tool_calls?.[0];
    if (!staleAttempted && call?.function.name === 'annotate_invoice') {
      const convention = JSON.parse(memoryAdvice.text.match(/normalize externalReference with (\{[^\n]+?\})\./u)[1]);
      const args = JSON.parse(call.function.arguments);
      args.reference = normalize(goal.orders[0].externalReference, convention);
      staleAttempted = true;
      return actions(['annotate_invoice', args]);
    }
    return next;
  } });
  assert.equal(staleAttempted, true);
  assert.equal(result.pass, true, 'A corrected final state retains its original native outcome');
  assert.equal(result.versionSafety.currentPolicyLookupBeforeFirstAnnotation, true);
  assert.equal(result.versionSafety.staleWriteAttempts, 1);
  assert.equal(result.versionSafety.pass, false, 'The independent stale-write guard still fails');
});

test('task budgets, provider failures, truncation with tool calls, and aborts cannot become bounded completions', async () => {
  const budget = await run(undefined, { request: input => {
    const next = publicSolver(input);
    return next.message.tool_calls ? next : actions(['inspect_order', {
      orderId: JSON.parse(input.messages.at(-1).content).goal.orders[0].orderId
    }]);
  } });
  assert.equal(budget.verification.taskStateAchieved, true);
  assert.equal(budget.pass, false);
  assert.equal(budget.termination, 'model-call-budget');
  assert.equal(budget.modelCalls, 12);
  assert.equal(budget.requests.length, 12);
  const failed = await run(undefined, { request: input => {
    const next = publicSolver(input);
    if (!next.message.tool_calls) throw new Error('Provider failed after the last write');
    return next;
  } });
  assert.equal(failed.verification.taskStateAchieved, true);
  assert.equal(failed.pass, false);
  assert.equal(failed.requests.at(-1).status, 'failed');
  assert.match(failed.error, /Provider failed/);
  const crowded = await run(undefined, { request: input => actions(...Array.from({ length: 33 }, () => ['inspect_order', {
    orderId: JSON.parse(input.messages.at(-1).content).goal.orders[0].orderId
  }])) });
  assert.equal(crowded.pass, false);
  assert.equal(crowded.modelCalls, 1);
  assert.equal(crowded.toolCalls, 32);
  assert.match(crowded.error, /raw-tool budget/);
  const truncated = await run(undefined, { request: input => ({ ...publicSolver(input),
    providerResponse: { choices: [{ finish_reason: 'length' }], usage: { total_tokens: 88 } } }) });
  assert.equal(truncated.pass, false);
  assert.equal(truncated.toolCalls, 0);
  assert.equal(truncated.requests.length, 1);
  assert.equal(truncated.requests[0].status, 'failed');
  assert.equal(truncated.requests[0].response.providerResponse.usage.total_tokens, 88);
  assert.match(truncated.error, /output budget/);
  const terminalTruncated = await run(undefined, { request: input => {
    const next = publicSolver(input); return next.message.tool_calls ? next : response('Complete.', 'length');
  } });
  assert.equal(terminalTruncated.verification.taskStateAchieved, true);
  assert.equal(terminalTruncated.pass, false);
  const controller = new AbortController(); controller.abort(new Error('Test cancellation'));
  const aborted = await run(undefined, { signal: controller.signal, request: () => { throw new Error('Must not request after abort'); } });
  assert.equal(aborted.pass, false);
  assert.equal(aborted.termination, 'deadline-or-abort');
  assert.equal(aborted.requests.length, 0);
});
