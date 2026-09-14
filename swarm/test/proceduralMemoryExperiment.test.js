import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMemoryAcquisitionInput, createEmptyProceduralMemorySnapshot, createProceduralMemorySnapshot,
  getProceduralMemoryCases, runProceduralMemoryTask, PROCEDURAL_MEMORY_LIMITS } from '../src/proceduralMemoryExperiment.js';
import { loadReplayMemory, saveReplayMemory, validateReplayMemory, createObservedExperience, createReplayMemory } from '../src/persistentReplayMemory.js';
import { sequentialEvidenceHash as hash } from '../src/sequentialSkillLearning.js';
import { createSequentialSkillFixture } from '../evals/sequentialSkillFixture.js';

const modelIdentity = { model: 'isolated-prose-memory-test', weightsSha256: 'a'.repeat(64) };
const response = (content, finish_reason = 'stop') => ({ message: { content }, providerResponse: { choices: [{ finish_reason }], usage: { total_tokens: 23 } } });
const actions = (...items) => ({ message: { tool_calls: items.map(([name, args], i) => ({ id: `call-${i}`, type: 'function',
  function: { name, arguments: JSON.stringify(args) } })) }, providerResponse: { choices: [{ finish_reason: 'tool_calls' }] } });
const inputs = await Promise.all(['reserve-order', 'invoice-order'].map(family => buildMemoryAcquisitionInput({ family, modelIdentity })));
const goodTexts = ['Read the order. Reuse existing reservations. Reserve exact quantities with the latest revision, then confirm. Inspect unknown effects before another mutation or completion. Leave invoices unchanged.',
  'Inspect the order and its invoice. Reuse a draft or create one for a reserved order. Annotate the current invoice with the required reference. Reconcile unknown effects by inspection. Never send invoices.'];
const acquire = (responses = goodTexts.map(text => response(text))) => createProceduralMemorySnapshot({ modelIdentity,
  acquisitions: inputs.map((input, i) => ({ input, ...(responses[i] instanceof Error ? { error: responses[i].message } : { response: responses[i] }) })) });
const memory = acquire();
const empty = createEmptyProceduralMemorySnapshot({ modelIdentity });

// Test-only actor. Every decision is derived from the current public goal and
// receipts; it has no fixture state, hidden variant, seed, or private verifier.
function publicSolver(input) {
  const { goal, observations } = JSON.parse(input.messages.at(-1).content);
  const target = goal.orders[0], last = observations.at(-1);
  if (last?.result?.error?.code === 'outcome_unknown') {
    return actions([goal.family === 'reserve-order' ? 'inspect_order' : 'inspect_invoice', { orderId: target.orderId }]);
  }
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
  if (invoice.reference !== target.invoiceReference) return actions(['annotate_invoice', {
    invoiceId: invoice.id, reference: target.invoiceReference, expectedRevision: invoice.revision }]);
  return response('Completed from public receipts.');
}
const run = (overrides = {}) => runProceduralMemoryTask({ request: publicSolver, modelIdentity,
  loadedMemory: memory.snapshot, arm: 'procedural-memory', caseIndex: 0, ...overrides });

test('fresh source curriculum uses existing teacher, binds native receipts, and selects all eight cases before requests', () => {
  assert.deepEqual(inputs.map(input => input.trainingReceipts.map(row => row.seed)), [[240000, 240001], [250005, 250000]]);
  for (const [index, input] of inputs.entries()) {
    assert.equal(input.trainingSplit, 'training');
    assert.equal(input.modelSeed, 20260917 + index * 101);
    assert.equal(input.phase, 'memory-acquisition');
    assert.equal(input.temperature, 1);
    assert.equal(input.maxOutputTokens, 512);
    assert.equal(input.responseFormat, null);
    assert.deepEqual(input.tools, []);
    assert.equal(Object.isFrozen(input.messages), true);
    const user = JSON.parse(input.messages.at(-1).content);
    assert.deepEqual(Object.keys(user).sort(), ['demonstrations', 'family', 'task', 'tools']);
    assert.equal(hash(user.demonstrations), input.demonstrationsSha256);
    for (const [i, receipt] of input.trainingReceipts.entries()) {
      const fixture = createSequentialSkillFixture(receipt), demo = input.demonstrations[i];
      for (const event of demo.events) assert.deepEqual(fixture.execute(event.name, event.args), event.result);
      assert.deepEqual(fixture.verify(), receipt.verification);
      assert.equal(receipt.verification.pass, true);
    }
  }
  const cases = getProceduralMemoryCases();
  assert.deepEqual(cases.map(row => row.seed), [260000, 260100, 260200, 260202, 270000, 270100, 270200, 270201]);
  assert.deepEqual(cases.map(row => row.ambiguityApplied ?? null), [null, null, true, false, null, null, true, false]);
  assert.equal(new Set(cases.map(row => row.fixtureId)).size, 8);
  assert.ok(cases.every(row => row.split === 'procedural-memory-evaluation'));
  assert.ok(cases.every(row => !inputs.flatMap(input => input.demonstrations).some(demo => demo.id === row.fixtureId)));
  assert.equal(PROCEDURAL_MEMORY_LIMITS.maxLogicalRequests, 194);
});

test('source verification does not verify prose; exact snapshot contains texts and provenance without original traces', () => {
  assert.equal(memory.snapshot.records.length, 2);
  assert.deepEqual(validateReplayMemory(memory.snapshot), memory.snapshot);
  for (const record of memory.snapshot.records) {
    const input = inputs.find(row => row.family === record.taskFamily);
    assert.equal(record.verification.status, 'unverified');
    assert.equal(record.verification.receiptSha256, null);
    assert.equal(record.example, null);
    assert.equal(record.partition, 'training');
    assert.deepEqual(record.source.permittedUses, ['evaluation', 'memory']);
    const reference = JSON.parse(record.source.reference);
    assert.equal(reference.demonstrationsSha256, input.demonstrationsSha256);
    assert.deepEqual(reference.modelIdentity, modelIdentity);
    assert.equal(record.id, `procedural-memory-${record.taskFamily}`);
  }
  assert.ok(memory.memories.every(row => row.available && row.rejectionReasons.length === 0 && row.response));
  const serialized = JSON.stringify(memory.snapshot);
  for (const input of inputs) for (const id of input.entityIdentifiers) assert.equal(serialized.includes(id), false);
  assert.equal(serialized.includes('teacher'), false);
  assert.equal(empty.records.length, 0);
});

test('one-shot availability retains empty, truncated, overlong, copied-ID and failed generations without semantic repair', () => {
  const cases = [
    { value: response('   '), reason: 'empty-text' },
    { value: { message: {} }, reason: 'empty-text' },
    { value: response(goodTexts[0], 'length'), reason: 'output-truncated' },
    { value: response(Array(161).fill('word').join('\n')), reason: 'word-limit' },
    { value: response(`Inspect ${inputs[0].entityIdentifiers[0]} first.`), reason: 'copied-training-identifier' },
    { value: new Error('transport failure'), reason: 'request-error' }
  ];
  for (const { value, reason } of cases) {
    const result = acquire([value, response(goodTexts[1])]);
    assert.equal(result.snapshot.records.length, 1);
    assert.equal(result.memories[0].available, false);
    assert.ok(result.memories[0].rejectionReasons.includes(reason));
    assert.equal(result.memories[1].available, true);
    if (!(value instanceof Error)) assert.deepEqual(result.memories[0].response, value);
  }
  const numbers = acquire([response('Inspect 123456789 records, then wait 42 seconds.'), response(Array(160).fill('word').join('\t'))]);
  assert.ok(numbers.memories.every(row => row.available), 'No general numeric or semantic-quality rejection');
  assert.equal(numbers.memories[1].wordCount, 160);
  assert.throws(() => createProceduralMemorySnapshot({ modelIdentity, acquisitions: [{ input: inputs[0] }] }), /two family/);
  const changed = structuredClone(inputs[0]); changed.messages.at(-1).content = '{}';
  assert.throws(() => createProceduralMemorySnapshot({ modelIdentity, acquisitions: [{ input: changed }, { input: inputs[1] }] }), /provenance/);
});

test('immutable memory survives real disk reload in a distinct process and rejects model/tamper mismatch', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'amos-prose-memory-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = saveReplayMemory(directory, memory.snapshot), before = readFileSync(path);
  const moduleUrl = new URL('../src/persistentReplayMemory.js', import.meta.url).href;
  const script = `import {loadReplayMemory} from ${JSON.stringify(moduleUrl)}; const value=loadReplayMemory(process.argv[1],process.argv[2]); console.log(JSON.stringify({pid:process.pid,value}));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, path, memory.snapshot.digest], { encoding: 'utf8', cwd: directory });
  assert.equal(child.status, 0, child.stderr);
  const receipt = JSON.parse(child.stdout);
  assert.notEqual(receipt.pid, process.pid);
  assert.deepEqual(receipt.value, memory.snapshot);
  const loaded = loadReplayMemory(path, memory.snapshot.digest);
  assert.equal((await run({ loadedMemory: loaded })).pass, true);
  assert.deepEqual(readFileSync(path), before);
  const tampered = structuredClone(loaded); tampered.records[0].text = 'Changed text.';
  await assert.rejects(run({ loadedMemory: tampered }), /changed/);
  await assert.rejects(run({ modelIdentity: { ...modelIdentity, weightsSha256: 'b'.repeat(64) } }), /identity/);
  await assert.rejects(run({ arm: 'no-memory' }), /empty snapshot/);
  const forged = createObservedExperience({ ...loaded.records[0], verification: { status: 'verified', receiptSha256: 'c'.repeat(64), verifierId: 'false-verifier' } });
  const forgedStore = createReplayMemory({ tenantId: loaded.tenantId, observations: [forged] });
  await assert.rejects(run({ loadedMemory: forgedStore }), /Unexpected/);
});

test('all eight real worlds complete from public evidence; paired actor inputs differ only in the memory field', async () => {
  for (const spec of getProceduralMemoryCases()) {
    const baseline = await run({ caseIndex: spec.caseIndex, arm: 'no-memory', loadedMemory: empty });
    const treated = await run({ caseIndex: spec.caseIndex });
    assert.equal(baseline.pass, true, JSON.stringify(baseline));
    assert.equal(treated.pass, true, JSON.stringify(treated));
    assert.equal(treated.verification.evidenceComplete, true);
    assert.equal(treated.verification.unsafeRetries, 0);
    assert.equal(treated.skillInvocations.length, 0);
    assert.equal(treated.modelCalls, treated.requests.length);
    assert.equal(treated.firstInputSha256, baseline.firstInputSha256);
    assert.notEqual(treated.firstActualInputSha256, baseline.firstActualInputSha256);
    assert.deepEqual(treated.observations, baseline.observations);
    assert.equal(treated.requests.length, baseline.requests.length);
    for (const [index, row] of treated.requests.entries()) {
      const untreated = baseline.requests[index];
      const messages = structuredClone(row.messages), user = JSON.parse(messages.at(-1).content);
      assert.equal(user.proceduralMemory, goodTexts[spec.family === 'reserve-order' ? 0 : 1]);
      delete user.proceduralMemory;
      assert.deepEqual(Object.keys(user).sort(), ['demonstrations', 'goal', 'learnedSkills', 'observations', 'remainingRawToolCalls', 'skillReturns']);
      assert.deepEqual(user.demonstrations, []);
      assert.deepEqual(user.learnedSkills, []);
      messages.at(-1).content = JSON.stringify(user);
      assert.deepEqual(messages, untreated.messages);
      assert.equal(row.inputSha256, untreated.inputSha256);
      assert.deepEqual(row.tools, untreated.tools);
      assert.equal(row.tools.some(tool => tool.function.name === 'use_learned_skill'), false);
      assert.equal(row.temperature, 0);
      assert.equal(row.maxOutputTokens, 1536);
      assert.equal(row.modelSeed, 20260917 + 101 * spec.caseIndex);
      assert.equal(row.responseFormat, null);
      assert.equal(row.status, 'returned');
    }
  }
});

test('unavailable memory stays empty and false completion or unresolved effects fail native verification', async () => {
  const unavailable = acquire([response(''), response(goodTexts[1])]);
  const result = await run({ loadedMemory: unavailable.snapshot, request: input => {
    assert.equal(JSON.parse(input.messages.at(-1).content).proceduralMemory, '');
    return response('I completed everything.');
  } });
  assert.equal(result.memoryAvailable, false);
  assert.equal(result.memoryRecordDigest, null);
  assert.equal(result.pass, false);
  assert.equal(result.verification.taskStateAchieved, false);
  const unresolved = await run({ caseIndex: 2, request: input => {
    const observations = JSON.parse(input.messages.at(-1).content).observations;
    return observations.at(-1)?.result?.error?.code === 'outcome_unknown' ? response('Done.') : publicSolver(input);
  } });
  assert.equal(unresolved.pass, false);
  assert.equal(unresolved.verification.evidenceComplete, false);
  assert.equal(unresolved.verification.unresolvedOutcomes, 1);
});

test('valid state followed by budget exhaustion or request failure cannot count as completed', async () => {
  const budget = await run({ request: input => {
    const next = publicSolver(input);
    return next.message.tool_calls ? next : actions(['inspect_order', { orderId: JSON.parse(input.messages.at(-1).content).goal.orders[0].orderId }]);
  } });
  assert.equal(budget.verification.taskStateAchieved, true);
  assert.equal(budget.pass, false);
  assert.equal(budget.termination, 'model-call-budget');
  assert.equal(budget.modelCalls, 12);
  assert.equal(budget.requests.length, 12);
  const failed = await run({ request: input => {
    const next = publicSolver(input);
    if (!next.message.tool_calls) throw new Error('Provider unavailable at terminal response');
    return next;
  } });
  assert.equal(failed.verification.taskStateAchieved, true);
  assert.equal(failed.pass, false);
  assert.equal(failed.requests.at(-1).status, 'failed');
  assert.match(failed.error, /Provider unavailable/);
});

test('tool budget is case-wide and truncated responses never execute their proposed tools', async () => {
  const crowded = await run({ request: input => actions(...Array.from({ length: 33 }, () => ['inspect_order', {
    orderId: JSON.parse(input.messages.at(-1).content).goal.orders[0].orderId }])) });
  assert.equal(crowded.pass, false);
  assert.equal(crowded.toolCalls, 32);
  assert.equal(crowded.modelCalls, 1);
  assert.match(crowded.error, /raw-tool budget/);
  const truncated = await run({ request: input => ({ ...publicSolver(input), providerResponse: { choices: [{ finish_reason: 'length' }], usage: { total_tokens: 88 } } }) });
  assert.equal(truncated.pass, false);
  assert.equal(truncated.toolCalls, 0);
  assert.equal(truncated.requests.length, 1);
  assert.equal(truncated.requests[0].response.providerResponse.usage.total_tokens, 88);
  assert.match(truncated.error, /output budget/);
  const completedThenTruncated = await run({ request: input => {
    const next = publicSolver(input);
    return next.message.tool_calls ? next : response('Completed.', 'length');
  } });
  assert.equal(completedThenTruncated.verification.taskStateAchieved, true);
  assert.equal(completedThenTruncated.pass, false);
});

test('pre-aborted tasks make no requests and preserve a failed native result', async () => {
  const controller = new AbortController(); controller.abort();
  const result = await run({ signal: controller.signal, request: () => { throw new Error('Must not dispatch'); } });
  assert.equal(result.pass, false);
  assert.equal(result.requests.length, 0);
  assert.equal(result.modelCalls, 0);
  assert.equal(result.termination, 'deadline-or-abort');
  assert.equal(result.firstInputSha256, null);
});
