import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../scripts/runSequentialSkillLearning.js', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const ref = path => ({ $ref: path });
const call = (tool, args, saveAs) => ({ type: 'call', tool, args, saveAs });
const inspectOrder = () => call('inspect_order', { orderId: ref('vars.target.orderId') }, 'order');

// A test-only candidate that can acquire A through native TRAIN validation. It
// reads public responses exclusively; no fixture state or verifier is imported.
const reserveProgram = { schema: 'amos.checked-procedure.v1', steps: [
  { type: 'for_each', items: ref('goal.orders'), as: 'target', steps: [
    { type: 'for_each', items: [0, 1], as: 'pass', steps: [
      inspectOrder(),
      { type: 'if', left: ref('vars.order.order.status'), equals: 'open', then: [
        { type: 'for_each', items: ref('vars.order.order.lines'), as: 'line', steps: [
          { type: 'if', left: ref('vars.line.reserved'), equals: false, then: [
            inspectOrder(),
            call('reserve_line', { orderId: ref('vars.target.orderId'), sku: ref('vars.line.sku'),
              quantity: ref('vars.line.quantity'), expectedRevision: ref('vars.order.order.revision') }, 'written'),
            inspectOrder()
          ] }
        ] },
        inspectOrder(),
        call('confirm_order', { orderId: ref('vars.target.orderId'), expectedRevision: ref('vars.order.order.revision') }, 'written'),
        inspectOrder()
      ] }
    ] }
  ] },
  { type: 'return', status: 'completed' }
] };

// Every fetch is replaced in the child process, including unexpected endpoints.
// A real server is neither required nor reachable through this mock.
const mockSource = `
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
const reserveProgram = ${JSON.stringify(reserveProgram)};
let tokenized = null;
const record = value => appendFileSync(process.env.CLI_MOCK_CALLS, JSON.stringify(value) + '\\n');
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url).pathname;
  record({ path });
  const body = init.body ? JSON.parse(init.body) : null;
  if (path === '/v1/models') return Response.json({ data: [{ id: 'cli-mock-research' }] });
  if (path === '/tokenize') {
    assert.equal(init.headers.Authorization, 'Bearer local-test-key');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(body.add_generation_prompt, true);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    tokenized = body;
    if (process.env.CLI_MOCK_MODE === 'oversized') return Response.json({ count: 8192, max_model_len: 8192 });
    if (process.env.CLI_MOCK_MODE === 'malformed-tokenizer') return Response.json({ count: 18.5, max_model_len: 8192 });
    return Response.json({ count: 100, max_model_len: 8192 });
  }
  if (path === '/v1/chat/completions') {
    assert.deepEqual(body.messages, tokenized.messages);
    assert.deepEqual(body.tools, tokenized.tools);
    assert.deepEqual(body.chat_template_kwargs, tokenized.chat_template_kwargs);
    assert.equal(body.model, tokenized.model);
    assert.equal(body.seed, 20260913);
    assert.equal(body.max_tokens, body.temperature === 1 ? 3072 : 1536);
    assert.ok([0, 1].includes(body.temperature));
    record({ payloadMatched: true, phase: body.temperature === 1 ? 'compile' : 'execute',
      toolsPresent: Object.hasOwn(body, 'tools') });
    if (process.env.CLI_MOCK_MODE === 'malformed-inference') return new Response('not-json', { status: 200 });
    assert.equal(process.env.CLI_MOCK_MODE, 'normal');
    return Response.json({ choices: [{ message: { role: 'assistant', content:
      body.temperature === 1 ? JSON.stringify(reserveProgram) : 'Done.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 105, completion_tokens: 20 } });
  }
  throw new Error('Unexpected mock endpoint: ' + path);
};
`;

test('sequential skill CLI persists bounded, auditable dispatches through mocked endpoints', { timeout: 30_000 }, async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'amos-sequential-cli-test-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  await writeFile(join(scratch, 'mock.mjs'), mockSource);
  await writeFile(join(scratch, 'key'), 'local-test-key');

  const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
  const readCalls = async name => {
    const contents = await readFile(join(scratch, `${name}.calls`), 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return '';
    });
    return contents.trim() ? contents.trim().split('\n').map(JSON.parse) : [];
  };
  function dispatch(name, { mode = 'normal', stage = 'A', prior, outputName = name } = {}) {
    const output = join(scratch, outputName);
    const args = ['--experimental-strip-types', '--import', join(scratch, 'mock.mjs'), cli,
      '--stage', stage, '--replicate', '0', '--output', output, '--model', 'cli-mock-research',
      '--weights-sha256', 'a'.repeat(64), '--manifest-digest', 'b'.repeat(64), '--api-key-file', join(scratch, 'key')];
    if (prior) args.push('--prior', prior);
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, CLI_MOCK_MODE: mode, CLI_MOCK_CALLS: join(scratch, `${name}.calls`) } });
    assert.ifError(result.error);
    return { output, result };
  }

  // Keep A as a prerequisite outside the subtests: B must consume a real CLI
  // artifact containing an admitted, persisted procedure, not a hand-built prior.
  const a = dispatch('a');
  assert.equal(a.result.status, 0, a.result.stderr);
  const aReport = await readJson(join(a.output, 'report.json'));
  assert.equal(aReport.acquisition.admitted, true);
  assert.equal(aReport.library.entries.length, 1);

  await t.test('stage B reloads A from disk in another process and preserves its admitted bytes', async () => {
    const libraryBefore = await readFile(join(a.output, 'library.json'));
    const b = dispatch('b', { stage: 'B', prior: join(a.output, 'report.json') });
    assert.equal(b.result.status, 0, b.result.stderr);
    const bReport = await readJson(join(b.output, 'report.json'));
    assert.equal(aReport.results.length, 6);
    assert.equal(bReport.results.length, 13);
    assert.notEqual(aReport.processId, bReport.processId);
    assert.equal(bReport.priorReload.processId, aReport.processId);
    assert.equal(bReport.priorReload.reloadedInProcessId, bReport.processId);
    assert.equal(bReport.priorReload.libraryPath, join(a.output, 'library.json'));
    assert.equal(bReport.priorReload.libraryDigest, aReport.library.digest);
    assert.deepEqual(bReport.library.entries[0], aReport.library.entries[0]);
    assert.deepEqual(await readFile(join(a.output, 'library.json')), libraryBefore);
    const completed = await readJson(join(b.output, 'completed.json'));
    assert.equal(completed.reportSha256, sha256(await readFile(join(b.output, 'report.json'))));
    assert.equal(completed.libraryDigest, bReport.library.digest);
  });

  await t.test('tokenizer matches actual messages/tools and logs observed prompt-token disagreement', async () => {
    const manifest = await readJson(join(a.output, 'manifest.json'));
    const calls = await readCalls('a');
    const inferences = aReport.inferenceAccounting.logicalRequests;
    assert.equal(manifest.limits.promptFitCheckedByCli, true);
    assert.equal(manifest.limits.maximumTokenizerRequestsPerLogicalRequest, 1);
    assert.equal(aReport.tokenizer.count, inferences.length);
    assert.equal(calls.filter(row => row.path === '/tokenize').length, inferences.length);
    assert.equal(calls.filter(row => row.payloadMatched).length, inferences.length);
    assert.ok(calls.some(row => row.payloadMatched && row.phase === 'compile' && !row.toolsPresent));
    assert.ok(calls.some(row => row.payloadMatched && row.phase === 'execute' && row.toolsPresent));
    assert.ok(inferences.every(row => row.status === 'returned' && row.transportAttempts === 1 &&
      row.promptTokenCheck.delta === 5 && row.promptTokenCheck.exactMatch === false));
    assert.equal(aReport.transport.unresolvedAttemptCost, false);
    const tokenizerJournal = await readFile(join(a.output, 'tokenizer.jsonl'), 'utf8');
    assert.ok(!tokenizerJournal.includes('local-test-key'));
    const finished = tokenizerJournal.trim().split('\n').map(JSON.parse).filter(row => row.status === 'passed');
    assert.equal(finished.length, inferences.length);
    assert.ok(finished.every(row => row.count === 100 && row.max_model_len === 8192 &&
      /^[a-f0-9]{64}$/.test(row.requestSha256)));
  });

  for (const mode of ['oversized', 'malformed-tokenizer']) {
    await t.test(`${mode} preflight records no inference attempts or unknown GPU cost`, async () => {
      const run = dispatch(mode, { mode });
      assert.equal(run.result.status, 0, run.result.stderr);
      const report = await readJson(join(run.output, 'report.json'));
      const calls = await readCalls(mode);
      assert.equal(calls.filter(row => row.path === '/v1/chat/completions').length, 0);
      assert.equal(calls.filter(row => row.path === '/tokenize').length, report.tokenizer.count);
      assert.ok(report.tokenizer.count > 0);
      assert.equal(report.transport.unresolvedAttemptCost, false);
      assert.ok(report.inferenceAccounting.logicalRequests.every(row => row.transportAttempts === 0 &&
        row.inferenceDispatched === false && row.status === 'rejected-before-inference'));
      assert.ok(Object.values(report.inferenceAccounting.usage).every(row =>
        row.requestsDispatchedForInference === 0 && row.incomplete === false));
      assert.ok(report.tokenizer.requests.every(row => row.status === 'rejected'));
    });
  }

  await t.test('malformed inference responses retain actual attempts and unknown usage cost', async () => {
    const run = dispatch('malformed-inference', { mode: 'malformed-inference' });
    assert.equal(run.result.status, 0, run.result.stderr);
    const report = await readJson(join(run.output, 'report.json'));
    const calls = await readCalls('malformed-inference');
    assert.ok(calls.filter(row => row.path === '/v1/chat/completions').length > 0);
    assert.equal(report.transport.unresolvedAttemptCost, true);
    assert.ok(report.inferenceAccounting.logicalRequests.every(row => row.inferenceDispatched &&
      row.transportAttempts === 1 && row.status === 'failed'));
    assert.ok(Object.values(report.inferenceAccounting.usage).every(row =>
      row.requestsDispatchedForInference > 0 && row.incomplete === true && row.responsesWithKnownUsage === 0));
  });

  await t.test('rebound prior with changed source identity fails before probing', async () => {
    const changedDirectory = join(scratch, 'changed-a');
    await cp(a.output, changedDirectory, { recursive: true });
    const prior = await readJson(join(changedDirectory, 'report.json'));
    prior.sourceHashes[Object.keys(prior.sourceHashes)[0]] = 'f'.repeat(64);
    const priorBytes = JSON.stringify(prior, null, 2) + '\n';
    await writeFile(join(changedDirectory, 'report.json'), priorBytes);
    const completed = await readJson(join(changedDirectory, 'completed.json'));
    completed.reportSha256 = sha256(priorBytes);
    await writeFile(join(changedDirectory, 'completed.json'), JSON.stringify(completed));
    const run = dispatch('changed-b', { stage: 'B', prior: join(changedDirectory, 'report.json') });
    assert.equal(run.result.status, 1);
    const failed = await readJson(join(run.output, 'failed.json'));
    assert.match(failed.error, /source hashes differ/);
    assert.deepEqual(await readCalls('changed-b'), []);
  });

  await t.test('duplicate output refuses dispatch and leaves prior evidence byte-identical', async () => {
    const names = ['manifest.json', 'report.json', 'completed.json', 'library.json', 'events.jsonl', 'transport.jsonl', 'tokenizer.jsonl'];
    const before = await Promise.all(names.map(name => readFile(join(a.output, name))));
    const duplicate = dispatch('duplicate', { outputName: 'a' });
    assert.equal(duplicate.result.status, 1);
    assert.match(duplicate.result.stderr, /EEXIST/);
    assert.deepEqual(await readCalls('duplicate'), []);
    const after = await Promise.all(names.map(name => readFile(join(a.output, name))));
    assert.deepEqual(after, before);
  });
});
