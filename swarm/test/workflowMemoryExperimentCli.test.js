import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const cli = fileURLToPath(new URL('../scripts/runWorkflowMemoryExperiment.js', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const mock = `
import assert from 'node:assert/strict';
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const inputIndex = process.argv.indexOf('--input');
const runtime = inputIndex < 0 ? null : JSON.parse(readFileSync(process.argv[inputIndex + 1], 'utf8'));
const record = row => appendFileSync(process.env.WORKFLOW_MOCK_LOG, JSON.stringify({ ...row, pid: process.pid, cwd: process.cwd() }) + '\\n');
const mode = process.env.WORKFLOW_MOCK_MODE;
if (runtime?.mode === 'evaluate' && mode === 'snapshot-corruption' && runtime.arm === 'docs-advice' && runtime.caseIndex === 0) {
  writeFileSync(runtime.snapshotPath, '{}\\n');
}
let tokenized;
function acquisitionInput(body) {
  const prepared = JSON.parse(readFileSync(resolve(process.cwd(), 'prepared-training.json'), 'utf8'));
  const input = prepared.inputs.find(row => JSON.stringify(row.messages) === JSON.stringify(body.messages));
  assert.ok(input, 'request must match the archived acquisition input');
  const manifest = JSON.parse(readFileSync(resolve(process.cwd(), '..', 'manifest.json'), 'utf8'));
  const spec = manifest.plan.acquisitions.find(row => row.acquisitionId === input.acquisitionId);
  return { input, spec, firstForArm: manifest.plan.acquisitions.find(row => row.arm === spec.arm).acquisitionId };
}
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url).pathname, body = init.body ? JSON.parse(init.body) : null;
  record({ path, phase: runtime?.mode ?? 'parent', arm: runtime?.arm ?? null });
  if (path === '/v1/models') {
    assert.equal(runtime, null);
    return Response.json({ data: [{ id: 'workflow-mock-research' }] });
  }
  if (path === '/tokenize') {
    assert.equal(init.headers.Authorization, 'Bearer workflow-test-key');
    assert.equal(body.add_generation_prompt, true);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    tokenized = body;
    const acquired = runtime.mode === 'acquire' ? acquisitionInput(body) : null;
    const rejected = mode === 'tokenizer-failure' && acquired?.spec.arm === 'docs-advice';
    const count = rejected ? acquired.spec.acquisitionId === acquired.firstForArm ? '100' : 8192 : 100;
    return Response.json({ count, max_model_len: 8192 });
  }
  if (path !== '/v1/chat/completions') throw new Error('Unexpected mocked endpoint');
  assert.deepEqual(body.messages, tokenized.messages);
  assert.deepEqual(body.tools, tokenized.tools);
  assert.equal(Object.hasOwn(body, 'response_format'), false);
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
  const acquisition = runtime.mode === 'acquire';
  assert.equal(body.temperature, acquisition ? 1 : 0);
  assert.equal(body.max_tokens, acquisition ? 512 : 1536);
  let content = 'Read the current goal and inspect the current workflow policy before choosing reference values. Reuse completed work and current revisions. Reconcile unknown writes through inspection before retrying. Confirm all requested effects before stopping. Never send invoices or alter unrelated records.';
  let tool_calls, acquisitionSpec;
  if (acquisition) {
    const { input, spec } = acquisitionInput(body); acquisitionSpec = spec;
    assert.equal(body.seed, spec.modelSeed);
    record({ acquisition: true, acquisitionId: input.acquisitionId, arm: spec.arm, profileId: spec.profileId });
  } else {
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), '..', 'manifest.json'), 'utf8'));
    const spec = manifest.plan.tasks.find(row => row.taskId === runtime.taskId);
    assert.equal(body.seed, spec.modelSeed);
    const payload = JSON.parse(body.messages.at(-1).content);
    assert.deepEqual(payload.demonstrations, []);
    assert.deepEqual(payload.learnedSkills, []);
    assert.deepEqual(Object.keys(payload.memoryAdvice).sort(), ['policyVersion', 'profileId', 'text']);
    const normalized = { ...payload, memoryAdvice: { profileId: null, policyVersion: null, text: '' } };
    record({ actor: true, taskId: runtime.taskId, caseIndex: runtime.caseIndex, arm: runtime.arm,
      memoryAdvice: payload.memoryAdvice, normalizedInitial: payload.observations.length === 0 ? JSON.stringify(normalized) : null });
    if (mode === 'killed-task' && runtime.caseIndex === 0 && runtime.arm === 'docs-advice') process.exit(23);
    content = 'Done.';
    if (mode === 'budget') tool_calls = [{ id: 'inspect-' + payload.observations.length,
      type: 'function', function: { name: 'inspect_order', arguments: JSON.stringify({ orderId: payload.goal.orders[0].orderId }) } }];
  }
  return Response.json({ choices: [{ message: { role: 'assistant', content, ...(tool_calls ? { tool_calls } : {}) }, finish_reason: 'stop' }],
    ...(mode === 'missing-usage' && acquisitionSpec?.arm === 'docs-advice' ? {} : { usage: { prompt_tokens: 100, completion_tokens: acquisition ? 50 : 10 } }) });
};
`;

test('workflow-memory CLI uses the reusable runner with real isolated task processes', { timeout: 120_000 }, async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'amos-workflow-memory-cli-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const mockPath = join(scratch, 'mock.mjs'), keyPath = join(scratch, 'key');
  await writeFile(mockPath, mock); await writeFile(keyPath, 'workflow-test-key');
  const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
  function dispatch(name, mode = 'normal', outputName = name) {
    const directory = join(scratch, outputName);
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--import', mockPath, cli,
      '--output', directory, '--model', 'workflow-mock-research', '--weights-sha256', 'a'.repeat(64),
      '--manifest-digest', 'b'.repeat(64), '--api-key-file', keyPath], { encoding: 'utf8', timeout: 45_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, WORKFLOW_MOCK_MODE: mode, WORKFLOW_MOCK_LOG: join(scratch, name + '.calls') } });
    assert.ifError(result.error); return { directory, result };
  }
  async function calls(name) { return (await readFile(join(scratch, name + '.calls'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  async function completed(run) {
    if (run.result.status !== 0) {
      const failure = await readJson(join(run.directory, 'failed.json')).catch(() => null);
      const children = await Promise.all((failure?.children ?? []).map(row => readJson(join(row.directory, 'failed.json')).catch(() => null)));
      assert.fail(JSON.stringify({ stderr: run.result.stderr, error: failure?.error, children }));
    }
    return readJson(join(run.directory, 'report.json'));
  }
  const normal = dispatch('normal'), report = await completed(normal);

  await t.test('acquisition exits before 24 fresh processes reload bound immutable snapshots', async () => {
    assert.equal(report.plan.acquisitions.length, 4); assert.equal(report.tasks.length, 24);
    assert.equal(report.plan.limits.maxLogicalRequests, 292); assert.equal(report.plan.limits.maxMinutes, 60);
    assert.equal(new Set(report.tasks.map(row => row.process.processId)).size, 24);
    assert.equal(new Set(report.tasks.map(row => row.process.processNonce)).size, 24);
    const acquired = report.acquisition.receipt;
    for (const task of report.tasks) {
      assert.equal(task.process.code, 0); assert.notEqual(task.process.processId, acquired.processId);
      assert.ok(Date.parse(task.report.startedAt) >= Date.parse(acquired.exitedAt));
      const input = await readJson(join(task.process.directory, 'input.json'));
      assert.equal(Object.hasOwn(input, 'demonstrations'), false);
      assert.equal(Object.hasOwn(input, 'acquisitions'), false);
      assert.ok(!(await readdir(task.process.directory)).some(name => name.includes('training')));
      assert.equal(input.planSha256, report.planSha256);
      assert.equal(input.sourceHashesSha256, task.report.sourceHashesSha256);
      const load = task.report.result.memoryLoad;
      assert.equal(load.byteSha256, hash(await readFile(load.path)));
      assert.equal(load.byteSha256, task.report.result.snapshotAfterSha256);
      assert.equal(load.records.length, task.arm === 'no-memory' ? 0 : 2);
      assert.ok(load.records.every(row => row.verification === 'unverified'));
      const receipt = await readJson(join(task.process.directory, 'completed.json'));
      assert.equal(receipt.reportSha256, hash(await readFile(join(task.process.directory, 'report.json'))));
    }
    assert.ok(Object.values(report.memoryPreservation).every(row => row.beforeSha256 === row.afterSha256));
    assert.match(report.isolation, /no OS filesystem sandbox/);
  });

  await t.test('triplets share inputs and each advice arm pays for its own two generations', async () => {
    const observed = await calls('normal');
    assert.equal(observed.filter(row => row.path === '/v1/models').length, 1);
    assert.equal(observed.filter(row => row.path === '/v1/chat/completions').length, 28);
    assert.equal(observed.filter(row => row.path === '/tokenize').length, 28);
    for (let caseIndex = 0; caseIndex < 8; caseIndex++) {
      const triplet = observed.filter(row => row.actor && row.caseIndex === caseIndex);
      assert.equal(triplet.length, 3);
      assert.equal(new Set(triplet.map(row => row.normalizedInitial)).size, 1);
      assert.deepEqual(triplet.find(row => row.arm === 'no-memory').memoryAdvice, { profileId: null, policyVersion: null, text: '' });
    }
    assert.equal(report.byArm['no-memory'].endToEndUsage.logicalRequests, 8);
    for (const arm of ['docs-advice', 'experience-memory']) {
      assert.equal(report.byArm[arm].acquisitionUsage.logicalRequests, 2);
      assert.equal(report.byArm[arm].endToEndUsage.logicalRequests, 10);
      assert.deepEqual(report.byArm[arm].endToEndReceiptCounts, { inferenceTransportAttempts: 10, tokenizerRequests: 10 });
      assert.equal(report.accounting.logicalRequests.filter(row => row.phase === 'memory-acquisition' && row.arm === arm).length, 2);
    }
    assert.equal(report.accounting.unresolvedAttemptCost, false);
    assert.ok(report.accounting.logicalRequests.every(row => row.promptTokenCheck.exactMatch));
  });

  await t.test('compositional model budget preserves all 292 requests and observed tool calls', async () => {
    const bounded = await completed(dispatch('budget', 'budget'));
    assert.equal(bounded.accounting.logicalRequests.length, 292);
    assert.equal(bounded.accounting.tokenizer.length, 292);
    assert.equal(bounded.accounting.transport.length, 293);
    assert.ok(bounded.tasks.every(row => row.report.result.modelCalls === 12 && row.report.result.toolCalls === 12));
    assert.equal(bounded.accounting.toolEvents.length, 288);
    assert.equal(bounded.byArm['no-memory'].endToEndUsage.logicalRequests, 96);
    assert.equal(bounded.byArm['docs-advice'].endToEndUsage.logicalRequests, 98);
    assert.equal(bounded.byArm['experience-memory'].endToEndUsage.logicalRequests, 98);
  });

  await t.test('death after dispatch preserves the failed slot and its arm-specific costs', async () => {
    const failed = await completed(dispatch('killed-task', 'killed-task'));
    const task = failed.tasks.find(row => row.caseIndex === 0 && row.arm === 'docs-advice');
    assert.equal(task.process.code, 23); assert.equal(task.report, null); assert.equal(task.pass, false);
    assert.equal(failed.tasks.length, 24); assert.equal(failed.accounting.logicalRequests.length, 28);
    assert.equal(failed.accounting.transport.length, 29); assert.equal(failed.accounting.tokenizer.length, 28);
    assert.equal(failed.accounting.unresolvedAttemptCost, true);
    assert.equal(failed.byArm['docs-advice'].endToEndUsage.incomplete, true);
    assert.deepEqual(failed.byArm['docs-advice'].endToEndReceiptCounts, { inferenceTransportAttempts: 10, tokenizerRequests: 10 });
  });

  await t.test('tokenizer failures retain unavailable advice without inventing inference cost', async () => {
    const failed = await completed(dispatch('tokenizer-failure', 'tokenizer-failure'));
    assert.equal(failed.accounting.logicalRequests.length, 28);
    assert.equal(failed.accounting.usage.dispatchedRequests, 26);
    assert.equal(failed.accounting.unresolvedAttemptCost, false);
    assert.equal(failed.acquisition.report.result.snapshots['docs-advice'].records.length, 0);
    assert.deepEqual(failed.byArm['docs-advice'].endToEndReceiptCounts, { inferenceTransportAttempts: 8, tokenizerRequests: 10 });
    assert.equal(failed.acquisition.report.result.snapshots['experience-memory'].records.length, 2);
    const rejected = failed.accounting.tokenizer.filter(row => row.status === 'rejected');
    assert.equal(rejected.length, 2);
    assert.ok(rejected.some(row => row.error.includes('integer count')));
    assert.ok(rejected.some(row => row.error.includes('Context budget exceeded')));
  });

  await t.test('missing usage flags only the responsible advice arm as incomplete', async () => {
    const unknown = await completed(dispatch('missing-usage', 'missing-usage'));
    assert.equal(unknown.accounting.unresolvedAttemptCost, true);
    assert.equal(unknown.byArm['docs-advice'].endToEndUsage.incomplete, true);
    assert.equal(unknown.byArm['experience-memory'].endToEndUsage.incomplete, false);
    assert.equal(unknown.byArm['no-memory'].endToEndUsage.incomplete, false);
  });

  await t.test('snapshot corruption rejects the task before any actor inference', async () => {
    const corrupt = await completed(dispatch('snapshot-corruption', 'snapshot-corruption'));
    const task = corrupt.tasks.find(row => row.caseIndex === 0 && row.arm === 'docs-advice');
    assert.equal(task.process.code, 1); assert.equal(task.report, null); assert.equal(task.pass, false);
    assert.equal(corrupt.accounting.logicalRequests.length, 27);
    assert.equal(corrupt.accounting.unresolvedAttemptCost, false);
    assert.equal(corrupt.byArm['docs-advice'].intendedTasks, 8);
    assert.equal(corrupt.byArm['docs-advice'].endToEndUsage.logicalRequests, 9);
  });

  await t.test('exclusive output refuses another dispatch without changing evidence', async () => {
    const before = await readFile(join(normal.directory, 'report.json'));
    const duplicate = dispatch('duplicate', 'normal', 'normal');
    assert.equal(duplicate.result.status, 1); assert.match(duplicate.result.stderr, /EEXIST/);
    assert.deepEqual(await readFile(join(normal.directory, 'report.json')), before);
  });
});
