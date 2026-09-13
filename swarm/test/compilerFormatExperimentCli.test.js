import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../scripts/runCompilerFormatExperiment.js', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');

// All requests, including unexpected URLs, remain inside this child-process mock.
// Response bodies are synthetic. No fixture oracle or native validation is mocked.
const mockSource = `
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const record = value => appendFileSync(process.env.FORMAT_MOCK_CALLS, JSON.stringify(value) + '\\n');
const originalTimeout = globalThis.setTimeout;
// Keep the worker's real retry loop and cap; only its backoff waits are shortened.
globalThis.setTimeout = (callback, ms, ...args) => originalTimeout(callback, [750,1500,2250].includes(ms) ? 0 : ms, ...args);
let tokenized;
const attempts = new Map();
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url).pathname;
  record({ path });
  const body = init.body ? JSON.parse(init.body) : null;
  if (path === '/v1/models') return Response.json({ data: [{ id: 'format-mock-research' }] });
  const user = body?.messages?.at(-1)?.content;
  const scored = typeof user === 'string' && user.startsWith('{');
  if (path === '/tokenize') {
    assert.equal(init.headers.Authorization, 'Bearer test-only-key');
    assert.equal(body.add_generation_prompt, true);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    assert.ok(init.signal instanceof AbortSignal);
    tokenized = body;
    if (process.env.FORMAT_MOCK_MODE === 'malformed-tokenizer') return Response.json({ count: '100', max_model_len: 8192 });
    return Response.json({ count: scored && process.env.FORMAT_MOCK_MODE === 'oversized-scored' ? 6000 : 100, max_model_len: 8192 });
  }
  if (path === '/v1/chat/completions') {
    assert.deepEqual(body.messages, tokenized.messages);
    assert.deepEqual(body.tools, tokenized.tools);
    assert.deepEqual(body.chat_template_kwargs, tokenized.chat_template_kwargs);
    assert.equal(body.model, tokenized.model);
    assert.equal(body.temperature, 1);
    assert.equal(body.max_tokens, scored ? 3072 : 128);
    if (scored) assert.ok([20260914,20261015,20261116].includes(body.seed));
    else assert.equal(body.seed, 20260913);
    const constrained = Object.hasOwn(body, 'response_format');
    if (constrained) assert.deepEqual(body.response_format, { type: 'json_object' });
    const common = { ...body }; delete common.response_format;
    const family = scored ? JSON.parse(user).skill : user.includes('NOT_JSON_CONFORMANCE') ? 'literal-text' : 'malformed-json';
    const key = [scored ? 'scored' : 'conformance', body.seed, family, constrained].join('/');
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    record({ payloadMatched: true, scope: scored ? 'scored' : 'conformance', modelSeed: body.seed,
      family, arm: constrained ? 'json-object' : 'free-form', attempt, commonBodySha256: hash(common) });
    if (!scored && constrained && ['reject-json','retry-json'].includes(process.env.FORMAT_MOCK_MODE)) {
      return Response.json({ error: { message: 'Mock constrained request rejected' } }, { status: process.env.FORMAT_MOCK_MODE === 'retry-json' ? 503 : 400 });
    }
    if (process.env.FORMAT_MOCK_MODE === 'bad-inference') return new Response('invalid-json', { status: 200 });
    const content = scored ? JSON.stringify({ schema: 'amos.checked-procedure.v1', steps: [{ type: 'return', status: 'completed' }] }) :
      constrained || process.env.FORMAT_MOCK_MODE === 'no-free-failure' ? '{}' : family === 'literal-text' ? 'NOT_JSON_CONFORMANCE' : '{"ok":';
    return Response.json({ choices: [{ message: { role: 'assistant', content },
      finish_reason: !scored && constrained && process.env.FORMAT_MOCK_MODE === 'truncated-json' ? 'length' : 'stop' }],
      usage: { prompt_tokens: 105, completion_tokens: scored ? 20 : 5 } });
  }
  throw new Error('Unexpected mocked URL: ' + path);
};
`;

test('compiler-format CLI gates and accounts for the real core using mocked transport', { timeout: 30_000 }, async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'amos-compiler-format-cli-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  await writeFile(join(scratch, 'mock.mjs'), mockSource);
  await writeFile(join(scratch, 'key'), 'test-only-key');
  const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
  const readCalls = async name => {
    const contents = await readFile(join(scratch, `${name}.calls`), 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return '';
    });
    return contents.trim() ? contents.trim().split('\n').map(JSON.parse) : [];
  };
  function dispatch(name, mode = 'normal', outputName = name) {
    const output = join(scratch, outputName);
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--import', join(scratch, 'mock.mjs'), cli,
      '--output', output, '--model', 'format-mock-research', '--weights-sha256', 'a'.repeat(64),
      '--manifest-digest', 'b'.repeat(64), '--api-key-file', join(scratch, 'key')], {
      encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, FORMAT_MOCK_MODE: mode, FORMAT_MOCK_CALLS: join(scratch, `${name}.calls`) }
    });
    assert.ifError(result.error);
    return { output, result };
  }
  const normal = dispatch('normal');
  assert.equal(normal.result.status, 0, normal.result.stderr);
  const report = await readJson(join(normal.output, 'report.json'));

  await t.test('four conformance requests are separate from all 36 scored attempts and 12 persisted libraries', async () => {
    assert.equal(report.conformance.passed, true);
    assert.equal(report.conformance.rows.length, 4);
    assert.equal(report.conformance.scoredRequestsDispatchedBeforeGate, 0);
    assert.ok(report.conformance.rows.every(row => row.modelSeed === 20260913));
    assert.deepEqual(report.modelSeeds, [20260914, 20261015, 20261116]);
    assert.deepEqual(report.inferenceAccounting.counts, { conformance: 4, scored: 36 });
    assert.equal(report.logicalCompilerRequests, 36);
    assert.equal(report.runs.length, 12);
    assert.ok(report.runs.every(run => run.requests.length === 3 && !run.acquisition.admitted));
    assert.equal(report.persistedLibraries.length, 12);
    assert.equal(new Set(report.persistedLibraries.map(row => row.filename)).size, 12);
    for (const item of report.persistedLibraries) assert.equal((await readJson(join(normal.output, item.filename))).digest, item.digest);
    assert.equal(report.inferenceAccounting.byScope.conformance.knownOutputTokens, 20);
    assert.equal(report.inferenceAccounting.byScope.scored.knownOutputTokens, 720);
    assert.equal(report.transport.unresolvedAttemptCost, false);
    const completed = await readJson(join(normal.output, 'completed.json'));
    assert.equal(completed.reportSha256, hash(await readFile(join(normal.output, 'report.json'))));
    assert.equal(report.dispatchManifestSha256, hash(await readFile(join(normal.output, 'manifest.json'))));
    assert.equal(report.sourceHashes[cli], hash(await readFile(cli)));
    assert.match(report.conformance.interpretation, /not proof/);
  });

  await t.test('paired actual request bodies differ only by response_format on all first attempts and conformance pairs', async () => {
    const calls = (await readCalls('normal')).filter(row => row.payloadMatched);
    assert.equal(calls.length, 40);
    const first = calls.filter(row => row.attempt === 1);
    const pairs = new Map();
    for (const row of first) {
      const key = `${row.scope}/${row.modelSeed}/${row.family}`;
      if (!pairs.has(key)) pairs.set(key, []);
      pairs.get(key).push(row);
    }
    assert.equal(pairs.size, 8);
    for (const pair of pairs.values()) {
      assert.equal(pair.length, 2);
      assert.deepEqual(new Set(pair.map(row => row.arm)), new Set(['free-form', 'json-object']));
      assert.equal(pair[0].commonBodySha256, pair[1].commonBodySha256);
    }
    assert.ok(report.inferenceAccounting.logicalRequests.every(row => row.status === 'returned' &&
      row.promptTokenCheck.delta === 5 && row.promptTokenCheck.exactMatch === false &&
      JSON.stringify(row.responseFormatApplied) === JSON.stringify(row.responseFormat)));
    const inferenceTransport = report.transport.attempts.filter(row => row.scope !== 'probe');
    assert.equal(inferenceTransport.length, calls.length);
    for (const [index, row] of inferenceTransport.entries()) {
      assert.equal(row.requestWithoutResponseFormatSha256, calls[index].commonBodySha256);
      assert.equal(row.seed, calls[index].modelSeed);
      assert.equal(row.temperature, 1);
      assert.equal(row.max_tokens, row.scope === 'scored' ? 3072 : 128);
    }
    assert.equal(report.tokenizer.count, 40);
    assert.equal(report.tokenizer.includedInInferenceTransportAttempts, false);
    const tokenizerLog = await readFile(join(normal.output, 'tokenizer.jsonl'), 'utf8');
    assert.ok(!tokenizerLog.includes('test-only-key'));
    assert.ok(!tokenizerLog.includes('NOT_JSON_CONFORMANCE'));
  });

  for (const mode of ['no-free-failure', 'truncated-json', 'reject-json']) {
    await t.test(`${mode} conformance stops scoring without response-format fallback`, async () => {
      const run = dispatch(mode, mode);
      assert.equal(run.result.status, 1);
      const stopped = await readJson(join(run.output, 'report.json'));
      assert.equal(stopped.status, 'conformance-inconclusive');
      assert.equal(stopped.conformance.passed, false);
      assert.deepEqual(stopped.inferenceAccounting.counts, { conformance: 4, scored: 0 });
      assert.deepEqual(stopped.runs, []);
      await readJson(join(run.output, 'conformance-inconclusive.json'));
      await readJson(join(run.output, 'failed.json'));
      await assert.rejects(readFile(join(run.output, 'completed.json')), { code: 'ENOENT' });
      const calls = (await readCalls(mode)).filter(row => row.payloadMatched);
      assert.equal(calls.length, 4);
      assert.equal(calls.filter(row => row.arm === 'free-form').length, 2);
      assert.equal(calls.filter(row => row.arm === 'json-object').length, 2);
      assert.ok(calls.every(row => row.scope === 'conformance'));
    });
  }

  await t.test('the worker retains its four-attempt transport cap without unconstrained fallback', async () => {
    const run = dispatch('retry-json', 'retry-json');
    assert.equal(run.result.status, 1);
    const stopped = await readJson(join(run.output, 'report.json'));
    const logical = stopped.inferenceAccounting.logicalRequests;
    assert.equal(logical.filter(row => row.arm === 'json-object').length, 2);
    assert.ok(logical.filter(row => row.arm === 'json-object').every(row => row.transportAttempts === 4 && row.status === 'failed'));
    assert.ok(logical.filter(row => row.arm === 'free-form').every(row => row.transportAttempts === 1));
    assert.equal(stopped.tokenizer.count, 4);
    assert.equal(stopped.transport.unresolvedAttemptCost, true);
    assert.equal(stopped.inferenceAccounting.byScope.conformance.incomplete, true);
    const calls = (await readCalls('retry-json')).filter(row => row.payloadMatched);
    assert.equal(calls.length, 10);
    assert.equal(calls.filter(row => row.arm === 'free-form').length, 2);
    for (const family of ['literal-text', 'malformed-json']) {
      const retries = calls.filter(row => row.family === family && row.arm === 'json-object');
      assert.equal(retries.length, 4);
      assert.equal(new Set(retries.map(row => row.commonBodySha256)).size, 1);
    }
  });

  await t.test('oversized scored prompts exhaust logical caps while dispatching no scored inference', async () => {
    const run = dispatch('oversized-scored', 'oversized-scored');
    assert.equal(run.result.status, 0, run.result.stderr);
    const stopped = await readJson(join(run.output, 'report.json'));
    assert.deepEqual(stopped.inferenceAccounting.counts, { conformance: 4, scored: 36 });
    assert.equal(stopped.tokenizer.count, 40);
    const scored = stopped.inferenceAccounting.logicalRequests.filter(row => row.scope === 'scored');
    assert.equal(scored.length, 36);
    assert.ok(scored.every(row => row.status === 'rejected-before-inference' && row.transportAttempts === 0 && !row.inferenceDispatched));
    assert.equal(stopped.inferenceAccounting.byScope.scored.requestsDispatchedForInference, 0);
    assert.equal(stopped.inferenceAccounting.byScope.scored.incomplete, false);
    assert.equal(stopped.transport.unresolvedAttemptCost, false);
    assert.equal((await readCalls('oversized-scored')).filter(row => row.payloadMatched && row.scope === 'scored').length, 0);
  });

  await t.test('malformed tokenizer fails the gate without unknown GPU cost; malformed inference preserves unknown cost', async () => {
    for (const mode of ['malformed-tokenizer', 'bad-inference']) {
      const run = dispatch(mode, mode);
      assert.equal(run.result.status, 1);
      const stopped = await readJson(join(run.output, 'report.json'));
      assert.equal(stopped.inferenceAccounting.counts.scored, 0);
      assert.equal(stopped.tokenizer.count, 4);
      assert.equal(stopped.transport.unresolvedAttemptCost, mode === 'bad-inference');
      assert.equal(stopped.inferenceAccounting.byScope.conformance.incomplete, mode === 'bad-inference');
      const calls = (await readCalls(mode)).filter(row => row.path === '/v1/chat/completions');
      assert.equal(calls.length, mode === 'bad-inference' ? 4 : 0);
    }
  });

  await t.test('existing output cannot be silently resumed or overwritten', async () => {
    const before = await readFile(join(normal.output, 'report.json'));
    const duplicate = dispatch('duplicate', 'normal', 'normal');
    assert.equal(duplicate.result.status, 1);
    assert.match(duplicate.result.stderr, /EEXIST/);
    assert.deepEqual(await readFile(join(normal.output, 'report.json')), before);
    assert.deepEqual(await readCalls('duplicate'), []);
  });
});
