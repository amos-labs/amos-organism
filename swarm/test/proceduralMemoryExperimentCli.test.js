import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const cli = fileURLToPath(new URL('../scripts/runProceduralMemoryExperiment.js', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const mock = `
import assert from 'node:assert/strict';
import { readFileSync, appendFileSync } from 'node:fs';
const inputIndex = process.argv.indexOf('--input');
const runtime = inputIndex < 0 ? null : JSON.parse(readFileSync(process.argv[inputIndex + 1], 'utf8'));
const record = row => appendFileSync(process.env.MEMORY_MOCK_LOG, JSON.stringify({ ...row, pid: process.pid, cwd: process.cwd() }) + '\\n');
let tokenized;
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url).pathname;
  const body = init.body ? JSON.parse(init.body) : null;
  record({ path, phase: runtime?.mode ?? 'parent' });
  if (path === '/v1/models') {
    assert.equal(runtime, null, 'only the parent probes');
    return Response.json({ data: [{ id: 'memory-mock-research' }] });
  }
  if (path === '/tokenize') {
    assert.equal(init.headers.Authorization, 'Bearer memory-test-key');
    assert.equal(body.add_generation_prompt, true);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    tokenized = body;
    return Response.json({ count: runtime.mode === 'acquire' && process.env.MEMORY_MOCK_MODE === 'tokenizer-failure' ? '100' : 100, max_model_len: 8192 });
  }
  if (path !== '/v1/chat/completions') throw new Error('Unexpected mocked endpoint');
  assert.deepEqual(body.messages, tokenized.messages);
  assert.deepEqual(body.tools, tokenized.tools);
  assert.equal(Object.hasOwn(body, 'response_format'), false);
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
  const acquisition = runtime.mode === 'acquire';
  assert.equal(body.temperature, acquisition ? 1 : 0);
  assert.equal(body.max_tokens, acquisition ? 512 : 1536);
  const payload = JSON.parse(body.messages.at(-1).content);
  let content = 'Read the current goal and inspect existing records before changing them. Reuse completed work. Use current revisions. Reconcile an unknown write by inspecting before retrying. Stop only after confirming all requested effects. Never send invoices or alter unrelated records.';
  let tool_calls;
  if (acquisition) {
    assert.equal(payload.demonstrations.length, 2);
    assert.equal(body.seed, payload.family === 'reserve-order' ? 20260917 : 20261018);
    if (process.env.MEMORY_MOCK_MODE === 'unavailable') content = 'advice '.repeat(161);
  } else {
    assert.equal(body.seed, 20260917 + 101 * runtime.caseIndex);
    assert.deepEqual(payload.demonstrations, []);
    assert.deepEqual(payload.learnedSkills, []);
    assert.equal(Object.hasOwn(payload, 'previousTrainingFeedback'), false);
    assert.equal(Object.hasOwn(payload, 'proceduralMemory'), runtime.arm === 'procedural-memory');
    const normalized = { ...payload }; delete normalized.proceduralMemory;
    record({ actor: true, caseIndex: runtime.caseIndex, arm: runtime.arm,
      proceduralMemory: payload.proceduralMemory ?? null, normalizedInitial: payload.observations.length === 0 ? JSON.stringify(normalized) : null });
    if (process.env.MEMORY_MOCK_MODE === 'killed-task' && runtime.caseIndex === 0 && runtime.arm === 'procedural-memory') process.exit(23);
    content = 'Done.';
    if (process.env.MEMORY_MOCK_MODE === 'budget') tool_calls = [{ id: 'inspect-' + payload.observations.length,
      type: 'function', function: { name: 'inspect_order', arguments: JSON.stringify({ orderId: payload.goal.orders[0].orderId }) } }];
  }
  return Response.json({ choices: [{ message: { role: 'assistant', content, ...(tool_calls ? { tool_calls } : {}) }, finish_reason: 'stop' }],
    ...(acquisition && process.env.MEMORY_MOCK_MODE === 'missing-usage' ? {} : { usage: { prompt_tokens: 100, completion_tokens: acquisition ? 50 : 10 } }) });
};
`;

test('procedural-memory CLI performs real agent-process restarts with bounded mocked inference', { timeout: 120_000 }, async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'amos-procedural-memory-cli-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const mockPath = join(scratch, 'mock.mjs'), keyPath = join(scratch, 'key');
  await writeFile(mockPath, mock); await writeFile(keyPath, 'memory-test-key');
  const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
  function dispatch(name, mode = 'normal', outputName = name) {
    const directory = join(scratch, outputName);
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--import', mockPath, cli,
      '--output', directory, '--model', 'memory-mock-research', '--weights-sha256', 'a'.repeat(64),
      '--manifest-digest', 'b'.repeat(64), '--api-key-file', keyPath], { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, MEMORY_MOCK_MODE: mode, MEMORY_MOCK_LOG: join(scratch, name + '.calls') } });
    assert.ifError(result.error);
    return { directory, result };
  }
  async function calls(name) {
    return (await readFile(join(scratch, name + '.calls'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  }
  const normal = dispatch('normal');
  const initialFailure = normal.result.status === 0 ? null : await readJson(join(normal.directory, 'failed.json'));
  const childFailures = initialFailure ? await Promise.all(initialFailure.children.map(row => readJson(join(row.directory, 'failed.json')).catch(() => null))) : null;
  assert.equal(normal.result.status, 0, JSON.stringify({ error: initialFailure?.error, children: childFailures }));
  const report = await readJson(join(normal.directory, 'report.json'));

  await t.test('acquisition exits before 16 separate tasks and each child opens an unchanged snapshot', async () => {
    assert.equal(report.tasks.length, 16);
    assert.equal(report.acquisition.receipt.code, 0);
    assert.equal(report.acquisition.report.result.memories.filter(row => row.available).length, 2);
    const acquisitionPid = report.acquisition.receipt.processId;
    assert.equal(new Set(report.tasks.map(row => row.process.processId)).size, 16);
    assert.equal(new Set(report.tasks.map(row => row.process.processNonce)).size, 16);
    for (const task of report.tasks) {
      assert.notEqual(task.process.processId, acquisitionPid);
      assert.equal(task.process.code, 0);
      assert.ok(Date.parse(task.report.startedAt) >= Date.parse(report.acquisition.receipt.exitedAt));
      assert.equal(task.report.result.acquisitionExit.processId, acquisitionPid);
      const input = await readJson(join(task.process.directory, 'input.json'));
      assert.equal(Object.hasOwn(input, 'demonstrations'), false);
      assert.equal(Object.hasOwn(input, 'acquisitions'), false);
      assert.ok(!(await readdir(task.process.directory)).some(name => name.includes('training')));
      const load = task.report.result.memoryLoad;
      assert.equal(load.processId, task.process.processId);
      assert.equal(load.byteSha256, input.snapshotByteSha256);
      assert.equal(load.byteSha256, task.report.result.snapshotAfterSha256);
      assert.equal(hash(await readFile(load.path)), load.byteSha256);
      assert.equal(load.records.length, task.arm === 'no-memory' ? 0 : 2);
      assert.ok(load.records.every(row => row.verification === 'unverified'));
      const receipt = await readJson(join(task.process.directory, 'completed.json'));
      assert.equal(receipt.reportSha256, hash(await readFile(join(task.process.directory, 'report.json'))));
    }
    assert.equal(report.memoryPreservation.acquiredBeforeSha256, report.memoryPreservation.acquiredAfterSha256);
    assert.equal(report.memoryPreservation.baselineBeforeSha256, report.memoryPreservation.baselineAfterSha256);
    assert.match(report.isolation, /no OS filesystem sandbox/);
    assert.equal(report.modelServerRestartClaimed, false);
  });

  await t.test('only memory text changes paired initial prompts; acquisition is charged once', async () => {
    const observed = await calls('normal');
    assert.equal(observed.filter(row => row.path === '/v1/models').length, 1);
    assert.equal(observed.filter(row => row.path === '/v1/chat/completions').length, 18);
    assert.equal(observed.filter(row => row.path === '/tokenize').length, 18);
    const actors = observed.filter(row => row.actor);
    assert.equal(actors.length, 16);
    for (let index = 0; index < 8; index++) {
      const pair = actors.filter(row => row.caseIndex === index);
      assert.equal(pair.length, 2);
      assert.equal(pair[0].normalizedInitial, pair[1].normalizedInitial);
      assert.ok(pair.find(row => row.arm === 'procedural-memory').proceduralMemory.length > 0);
      const results = report.tasks.filter(row => row.caseIndex === index).map(row => row.report.result);
      assert.equal(results[0].firstInputSha256, results[1].firstInputSha256);
      assert.notEqual(results[0].firstActualInputSha256, results[1].firstActualInputSha256);
    }
    assert.equal(report.accounting.logicalRequests.length, 18);
    assert.equal(report.byArm['no-memory'].endToEndUsage.logicalRequests, 8);
    assert.equal(report.byArm['procedural-memory'].evaluationUsage.logicalRequests, 8);
    assert.equal(report.byArm['procedural-memory'].endToEndUsage.logicalRequests, 10);
    assert.deepEqual(report.byArm['procedural-memory'].endToEndReceiptCounts, { inferenceTransportAttempts: 10, tokenizerRequests: 10 });
    assert.equal(report.byArm['no-memory'].endToEndChildWallMilliseconds, report.byArm['no-memory'].childWallMilliseconds);
    assert.ok(report.byArm['procedural-memory'].endToEndChildWallMilliseconds > report.byArm['procedural-memory'].childWallMilliseconds);
    assert.equal(report.accounting.unresolvedAttemptCost, false);
    assert.ok(report.accounting.logicalRequests.every(row => row.promptTokenCheck.exactMatch));
    assert.equal(report.byArm['no-memory'].endToEndLogicalRequestsPerSolvedTask, null);
  });

  await t.test('model-call limits retain 194 unique requests and tool attempts instead of truncating history', async () => {
    const run = dispatch('budget', 'budget');
    assert.equal(run.result.status, 0, run.result.stderr);
    const bounded = await readJson(join(run.directory, 'report.json'));
    assert.equal(bounded.accounting.logicalRequests.length, 194);
    assert.equal(bounded.accounting.tokenizer.length, 194);
    assert.equal(bounded.accounting.transport.length, 195);
    assert.ok(bounded.tasks.every(row => row.report.result.modelCalls === 12 && row.report.result.toolCalls === 12 && !row.pass));
    assert.equal(bounded.byArm['procedural-memory'].endToEndUsage.logicalRequests, 98);
    assert.equal(bounded.byArm['no-memory'].endToEndUsage.logicalRequests, 96);
    assert.equal(bounded.accounting.toolEvents.length, 192);
  });

  await t.test('unavailable memories remain empty treatment slots with their acquisition cost', async () => {
    const run = dispatch('unavailable', 'unavailable');
    assert.equal(run.result.status, 0, run.result.stderr);
    const unavailable = await readJson(join(run.directory, 'report.json'));
    assert.ok(unavailable.acquisition.report.result.memories.every(row => !row.available && row.rejectionReasons.includes('word-limit')));
    assert.equal(unavailable.tasks.length, 16);
    assert.ok((await calls('unavailable')).filter(row => row.actor && row.arm === 'procedural-memory').every(row => row.proceduralMemory === ''));
    assert.equal(unavailable.byArm['procedural-memory'].endToEndUsage.logicalRequests, 10);
  });

  await t.test('a child dying after inference dispatch retains costs and the failed paired task', async () => {
    const run = dispatch('killed-task', 'killed-task');
    assert.equal(run.result.status, 0, run.result.stderr);
    const failed = await readJson(join(run.directory, 'report.json'));
    const lost = failed.tasks.find(row => row.arm === 'procedural-memory' && row.caseIndex === 0);
    assert.equal(lost.process.code, 23); assert.equal(lost.report, null); assert.equal(lost.pass, false);
    assert.equal(failed.tasks.length, 16);
    assert.equal(failed.accounting.logicalRequests.length, 18);
    assert.equal(failed.accounting.transport.length, 19);
    assert.equal(failed.accounting.tokenizer.length, 18);
    assert.equal(failed.accounting.unresolvedAttemptCost, true);
    assert.equal(failed.byArm['procedural-memory'].evaluationUsage.logicalRequests, 8);
    assert.equal(failed.byArm['procedural-memory'].endToEndUsage.logicalRequests, 10);
    assert.equal(failed.byArm['procedural-memory'].endToEndUsage.incomplete, true);
    assert.deepEqual(failed.byArm['procedural-memory'].evaluationReceiptCounts, { inferenceTransportAttempts: 8, tokenizerRequests: 8 });
    assert.deepEqual(failed.byArm['procedural-memory'].endToEndReceiptCounts, { inferenceTransportAttempts: 10, tokenizerRequests: 10 });
    assert.ok(failed.accounting.transport.some(row => row.arm === 'procedural-memory' && row.caseIndex === 0 && row.lifecycle === 'started'));
  });

  await t.test('tokenizer-only summary failures never become unknown GPU cost', async () => {
    const run = dispatch('tokenizer-failure', 'tokenizer-failure');
    assert.equal(run.result.status, 0, run.result.stderr);
    const failed = await readJson(join(run.directory, 'report.json'));
    assert.equal(failed.accounting.logicalRequests.length, 18);
    assert.equal(failed.accounting.usage.dispatchedRequests, 16);
    assert.equal(failed.accounting.usage.rejectedBeforeInference, 2);
    assert.equal(failed.accounting.tokenizer.length, 18);
    assert.equal(failed.accounting.unresolvedAttemptCost, false);
    assert.deepEqual(failed.byArm['procedural-memory'].endToEndReceiptCounts, { inferenceTransportAttempts: 8, tokenizerRequests: 10 });
    assert.ok(failed.acquisition.report.result.memories.every(row => !row.available));
  });

  await t.test('accepted responses without usage retain an explicit unknown-cost flag', async () => {
    const run = dispatch('missing-usage', 'missing-usage');
    assert.equal(run.result.status, 0, run.result.stderr);
    const unknown = await readJson(join(run.directory, 'report.json'));
    assert.equal(unknown.accounting.logicalRequests.length, 18);
    assert.equal(unknown.accounting.usage.responsesWithKnownUsage, 16);
    assert.equal(unknown.accounting.unresolvedAttemptCost, true);
    assert.equal(unknown.byArm['procedural-memory'].endToEndUsage.incomplete, true);
    assert.equal(unknown.byArm['no-memory'].endToEndUsage.incomplete, false);
    assert.ok(unknown.acquisition.report.result.memories.every(row => row.available));
  });

  await t.test('exclusive output refuses a second dispatch without changing evidence', async () => {
    const before = await readFile(join(normal.directory, 'report.json'));
    const duplicate = dispatch('duplicate', 'normal', 'normal');
    assert.equal(duplicate.result.status, 1);
    assert.match(duplicate.result.stderr, /EEXIST/);
    assert.deepEqual(await readFile(join(normal.directory, 'report.json')), before);
  });
});
