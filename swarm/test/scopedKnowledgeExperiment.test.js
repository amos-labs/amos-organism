import test from 'node:test';
import assert from 'node:assert/strict';
import { SCOPED_KNOWLEDGE_ARMS, createPlan, buildAcquisitionInput, buildSnapshots, validateSnapshot, extractReceiptBackedPolicy,
  validNormalization, runTask, validateTaskResult } from '../src/scopedKnowledgeExperiment.js';
import { createScopedKnowledgeFixture } from '../evals/scopedKnowledgeFixture.js';
import { createObservedExperience, createReplayMemory } from '../src/persistentReplayMemory.js';
import { createPlan as historicalPlan } from '../src/workflowMemoryExperiment.js';
import { sequentialEvidenceHash as hash } from '../src/sequentialSkillLearning.js';
const modelIdentity = { model: 'scoped-knowledge-native-test', weightsSha256: 'a'.repeat(64) };
const plan = createPlan({ modelIdentity });
const inputs = plan.acquisitions.map(slot => buildAcquisitionInput({ ...slot, modelIdentity }));
const response = (content, finish_reason = 'stop') => ({ message: { content }, providerResponse: { choices: [{ finish_reason }], usage: { prompt_tokens: 100, completion_tokens: 20 } } });
const actions = (...items) => ({ message: { tool_calls: items.map(([name, args], index) => ({ id: `call-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) }, providerResponse: { choices: [{ finish_reason: 'tool_calls' }] } });
const convention = input => input.demonstrations[0].events.find(e => e.name === 'inspect_workflow_policy').result.policy.normalization;
const goodText = input => input.arm === 'generated-facts' ? JSON.stringify(convention(input)) : `For this profile and version use ${JSON.stringify(convention(input))}. Inspect the current policy if the version changes. Reconcile unknown invoice effects before another mutation.`;
const acquire = (overrides = {}) => buildSnapshots({ modelIdentity, acquisitions: inputs.map(input => ({ acquisitionId: input.acquisitionId, input,
  ...(overrides[input.acquisitionId] ?? { response: response(goodText(input)) }) })) });
const memory = acquire();
const worldFor = spec => createScopedKnowledgeFixture({ ...spec, workflowProfile: spec.profileId });

// Decisions use only actor-visible goals, scoped knowledge and direct receipts.
function publicSolver(input, { useKnowledge = true, ignoreVersion = false } = {}) {
  const { goal, observations, memoryKnowledge } = JSON.parse(input.messages.at(-1).content);
  const target = goal.orders[0], last = observations.at(-1);
  if (last?.result?.error?.code === 'outcome_unknown') return actions(['inspect_invoice', { orderId: target.orderId }]);
  let rule = observations.findLast(e => e.result.ok && e.result.policy?.workflowProfile === goal.workflowProfile && e.result.policy.policyVersion === goal.policyVersion)?.result.policy.normalization;
  if (!rule && useKnowledge && memoryKnowledge.profileId === goal.workflowProfile && (ignoreVersion || memoryKnowledge.policyVersion === goal.policyVersion)) {
    const knowledge = memoryKnowledge.knowledge;
    if (knowledge && typeof knowledge === 'object') rule = knowledge;
    if (typeof knowledge === 'string') { const match = knowledge.match(/\{[^\n]+?\}/u); if (match) rule = JSON.parse(match[0]); }
  }
  if (!rule) return actions(['inspect_workflow_policy', { workflowProfile: goal.workflowProfile, policyVersion: goal.policyVersion }]);
  const order = observations.findLast(e => e.result.ok && e.result.order?.id === target.orderId)?.result.order;
  if (!order) return actions(['inspect_order', { orderId: target.orderId }]);
  const observedInvoice = observations.findLast(e => e.result.ok && Object.hasOwn(e.result, 'invoice'));
  if (!observedInvoice) return actions(['inspect_invoice', { orderId: target.orderId }]);
  const invoice = observedInvoice.result.invoice;
  if (!invoice) return actions(['create_invoice', { orderId: target.orderId, expectedOrderRevision: order.revision }]);
  const transformed = observations.findLast(e => e.name === 'normalize_reference' && e.result.ok);
  if (!transformed) return actions(['normalize_reference', { reference: target.externalReference, normalization: rule }]);
  const reference = transformed.result.reference;
  if (invoice.reference !== reference) return actions(['annotate_invoice', { invoiceId: invoice.id, expectedRevision: invoice.revision, reference }]);
  return response('Completed from the resulting native receipts.');
}
const run = (spec, overrides = {}) => runTask({ taskId: spec.taskId, loadedMemory: memory.snapshots[spec.arm], modelIdentity, request: publicSolver, ...overrides });

test('three new acquisition units, nine paired worlds, six one-shot calls and four fixed conditions', () => {
  assert.equal(plan.schema, 'amos.scoped-knowledge-experiment.v1');
  assert.deepEqual(plan.arms, SCOPED_KNOWLEDGE_ARMS);
  assert.equal(plan.cases.length, 9); assert.equal(plan.tasks.length, 36); assert.equal(inputs.length, 6);
  assert.equal(plan.limits.maxLogicalRequests, 438); assert.equal(plan.limits.maxMinutes, 100);
  const old = historicalPlan({ modelIdentity });
  const oldIds = new Set(old.cases.map(x => x.fixtureId));
  assert.ok(plan.cases.every(x => !oldIds.has(x.fixtureId)));
  for (const spec of plan.cases) {
    const group = plan.tasks.filter(t => t.caseIndex === spec.caseIndex);
    assert.deepEqual(group.map(t => t.arm), Array.from({ length: 4 }, (_, offset) => plan.arms[(spec.caseIndex + offset) % 4]));
    assert.equal(new Set(group.map(t => t.fixtureId)).size, 1);
    assert.equal(worldFor(spec).id, spec.fixtureId);
    if (spec.variant === 'ambiguous') assert.equal(worldFor(spec).snapshotForTesting().fault.applied, false);
  }
  assert.equal(Object.isFrozen(plan.tasks[0]), true);
});

test('facts and prose get identical public evidence and budgets; source episodes replay and do not overlap target worlds', () => {
  for (const profileId of new Set(inputs.map(i => i.profileId))) {
    const pair = inputs.filter(i => i.profileId === profileId), [a, b] = pair;
    assert.deepEqual(a.messages[1], b.messages[1]); assert.equal(a.modelSeed, b.modelSeed);
    assert.equal(a.temperature, 1); assert.equal(a.maxOutputTokens, 512); assert.equal(a.responseFormat, null);
    assert.deepEqual(a.tools, []); assert.notEqual(a.messages[0].content, b.messages[0].content);
    assert.equal(a.demonstrationsSha256, b.demonstrationsSha256); assert.equal(a.trainingReceiptsSha256, b.trainingReceiptsSha256);
    for (const [index, receipt] of a.trainingReceipts.entries()) {
      const world = createScopedKnowledgeFixture(receipt), demo = a.demonstrations[index];
      assert.ok(plan.cases.every(c => c.fixtureId !== world.id));
      for (const e of demo.events) assert.deepEqual(world.execute(e.name, e.args), e.result);
      assert.equal(world.verify().pass, true); assert.equal(hash(world.verify()), hash(receipt.verification));
    }
  }
});

test('exact cache copies only verified public receipt fields and rejects forged source and outcome claims', () => {
  const input = inputs[0];
  const source = { profileId: input.profileId, demonstrations: input.demonstrations, receipts: input.trainingReceipts };
  const cache = extractReceiptBackedPolicy(source);
  assert.deepEqual(cache.knowledge, convention(input));
  assert.equal(cache.policyReceiptSha256, hash(input.demonstrations[0].events.find(e => e.name === 'inspect_workflow_policy')));
  for (const mutate of [s => { s.demonstrations[0].events[0].result.policy.normalization.prefix = 'fake/'; },
    s => { s.receipts[0].verification.pass = false; }, s => { s.receipts[0].workflowProfile = 'missing'; },
    s => { s.demonstrations[0].goal.description += ' altered'; }]) {
    const bad = structuredClone(source); mutate(bad); assert.throws(() => extractReceiptBackedPolicy(bad));
  }
  assert.throws(() => extractReceiptBackedPolicy({ ...source, demonstrations: [] }));
  for (const arm of plan.arms) {
    const snapshot = memory.snapshots[arm];
    validateSnapshot({ snapshot, memoryKey: arm, modelIdentity });
    assert.equal(snapshot.records.length, arm === 'no-memory' ? 0 : 3);
    for (const record of snapshot.records) {
      assert.equal(record.source.kind, arm === 'exact-policy-cache' ? 'document' : 'external-model');
      assert.equal(record.verification.status, arm === 'exact-policy-cache' ? 'verified' : 'unverified');
      assert.equal(record.example, null);
    }
  }
});

test('wrong-but-valid facts remain available; syntactic failures, copied instances and request errors stay missing without replacement', () => {
  const slot = inputs.find(i => i.arm === 'generated-facts');
  const wrong = { trim: false, case: 'lower', prefix: 'wrong/', suffix: '/still-wrong' };
  const kept = acquire({ [slot.acquisitionId]: { response: response(JSON.stringify(wrong)) } });
  const summary = kept.memories.find(m => m.acquisitionId === slot.acquisitionId);
  assert.equal(summary.available, true); assert.deepEqual(summary.rejectionReasons, []);
  const stored = kept.snapshots['generated-facts'].records.find(r => r.id === summary.recordId);
  assert.deepEqual(JSON.parse(stored.text), wrong);
  validateSnapshot({ snapshot: kept.snapshots['generated-facts'], memoryKey: 'generated-facts', modelIdentity });
  for (const override of [{ error: 'test request failure' }, { response: response('{}') }, { response: response('```json\n{}\n```') },
    { response: response(JSON.stringify({ ...wrong, secret: 'extra' })) }, { response: response(JSON.stringify({ ...wrong, case: 'title' })) },
    { response: response(JSON.stringify(wrong), 'length') }, { response: response('') },
    { response: response(JSON.stringify({ ...wrong, prefix: slot.entityIdentifiers.find(x => x.length < 32) })) }]) {
    const built = acquire({ [slot.acquisitionId]: override });
    assert.equal(built.memories.length, 6); assert.equal(built.memories.find(m => m.acquisitionId === slot.acquisitionId).available, false);
    assert.equal(built.snapshots['generated-facts'].records.length, 2);
    validateSnapshot({ snapshot: built.snapshots['generated-facts'], memoryKey: 'generated-facts', modelIdentity });
  }
  const copied = slot.entityIdentifiers.find(x => x.length < 32);
  const escaped = [...copied].map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  const escapedJson = JSON.stringify({ ...wrong, prefix: copied }).replace(copied, escaped);
  assert.equal(escapedJson.includes(copied), false);
  const rejected = acquire({ [slot.acquisitionId]: { response: response(escapedJson) } });
  assert.equal(rejected.memories.find(m => m.acquisitionId === slot.acquisitionId).available, false);
  assert.ok(rejected.memories.find(m => m.acquisitionId === slot.acquisitionId).rejectionReasons.includes('copied-training-identifier'));
  validateSnapshot({ snapshot: rejected.snapshots['generated-facts'], memoryKey: 'generated-facts', modelIdentity });
  const toolResponse = response(JSON.stringify(wrong)); toolResponse.message.tool_calls = [{ id: 'unavailable-tool' }];
  const withTool = acquire({ [slot.acquisitionId]: { response: toolResponse } });
  assert.equal(withTool.memories.find(m => m.acquisitionId === slot.acquisitionId).available, false);
  assert.throws(() => buildSnapshots({ modelIdentity, acquisitions: [] }));
  assert.equal(validNormalization({ ...wrong, prefix: 'a'.repeat(33) }), false);
  assert.equal(validNormalization(Object.assign(Object.create({ inherited: true }), wrong)), false);
  const getter = Object.defineProperty({ ...wrong }, 'prefix', { enumerable: true, get() { throw new Error('Must not read'); } });
  assert.equal(validNormalization(getter), false);
});

test('native public-tool solver completes all36 worlds, scoped memory saves lookup and version changes require refresh', async () => {
  const results = [];
  for (const spec of plan.tasks) {
    const result = await run(spec); results.push(result);
    assert.equal(result.pass, true, JSON.stringify({ spec, error: result.error, verification: result.verification }));
    assert.ok(result.modelCalls <= 12); assert.ok(result.toolCalls <= 32);
    assert.equal(result.verification.normalizationCalls, 1);
    assert.equal(result.policyLookups, spec.arm !== 'no-memory' && spec.policyVersion === 1 ? 0 : 1);
    if (spec.cohort === 'changed-version') assert.equal(result.versionSafety.pass, true);
    validateTaskResult({ taskSpec: spec, result, modelIdentity });
    for (const request of result.requests) {
      const payload = JSON.parse(request.messages.at(-1).content);
      assert.deepEqual(payload.demonstrations, []); assert.deepEqual(payload.learnedSkills, []);
      assert.deepEqual(Object.keys(payload.memoryKnowledge).sort(), ['knowledge', 'policyVersion', 'profileId']);
      assert.equal(payload.memoryKnowledge.policyVersion, 1);
    }
  }
  for (const c of plan.cases) {
    const paired = results.filter(r => r.caseIndex === c.caseIndex);
    assert.equal(new Set(paired.map(r => r.firstInputSha256)).size, 1);
    assert.deepEqual(paired[0].requests[0].tools, paired[1].requests[0].tools);
    if (c.cohort === 'stable') {
      const base = paired.find(r => r.arm === 'no-memory');
      for (const result of paired.filter(r => r.arm !== 'no-memory')) assert.equal(result.modelCalls, base.modelCalls - 1);
    }
  }
});

test('memory can be ignored, stale memory can cause native failure, and no host repairs or lookup insertion occurs', async () => {
  const stable = plan.tasks.find(t => t.arm === 'exact-policy-cache' && t.cohort === 'stable');
  const ignored = await run(stable, { request: input => publicSolver(input, { useKnowledge: false }) });
  assert.equal(ignored.pass, true); assert.equal(ignored.policyLookups, 1);
  const changed = plan.tasks.find(t => t.arm === 'exact-policy-cache' && t.cohort === 'changed-version');
  const stale = await run(changed, { request: input => publicSolver(input, { ignoreVersion: true }) });
  assert.equal(stale.pass, false); assert.equal(stale.versionSafety.pass, false); assert.equal(stale.versionSafety.staleWriteAttempts, 1);
  assert.equal(stale.policyLookups, 0); assert.equal(stale.verification.evidenceComplete, true);
});

test('snapshot corruption, scope substitution and forged cache content cannot acquire verified authority', () => {
  const original = memory.snapshots['exact-policy-cache'];
  const record = original.records[0];
  const altered = createObservedExperience({ ...record, text: JSON.stringify({ trim: true, case: 'upper', prefix: 'forged/', suffix: '' }) });
  const forged = createReplayMemory({ tenantId: original.tenantId, observations: [altered, ...original.records.slice(1)] });
  assert.throws(() => validateSnapshot({ snapshot: forged, memoryKey: 'exact-policy-cache', modelIdentity }), /binding mismatch/);
  assert.throws(() => validateSnapshot({ snapshot: original, memoryKey: 'generated-facts', modelIdentity }));
  assert.throws(() => validateSnapshot({ snapshot: original, memoryKey: 'exact-policy-cache', modelIdentity: { ...modelIdentity, model: 'other' } }));
});

test('aborted and truncated actor calls preserve failure without executing proposed tools', async () => {
  const spec = plan.tasks[0], controller = new AbortController(); controller.abort();
  const aborted = await run(spec, { signal: controller.signal, request: () => { throw new Error('Must not request'); } });
  assert.equal(aborted.pass, false); assert.equal(aborted.requests.length, 0);
  const truncated = await run(spec, { request: input => ({ ...actions(['inspect_order', { orderId: JSON.parse(input.messages.at(-1).content).goal.orders[0].orderId }]),
    providerResponse: { choices: [{ finish_reason: 'length' }] } }) });
  assert.equal(truncated.pass, false); assert.equal(truncated.toolCalls, 0); assert.equal(truncated.requests.length, 1);
});
