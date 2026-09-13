import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../scripts/runSkillRepairExperiment.js', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');

// All requests, including unexpected URLs, remain inside this child-process mock.
// Response bodies are synthetic. No fixture oracle or native validation is mocked.
const mockSource = `
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
// Inject only the returned audit artifact after the real experiment has run.
// This exercises the CLI boundary without editing core files or bypassing TRAIN.
if (['wrong-library', 'duplicate-run', 'duplicate-source'].includes(process.env.REPAIR_MOCK_MODE)) {
  registerHooks({ load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.endsWith('/src/skillRepairExperiment.js')) return loaded;
    const source = String(loaded.source);
    assert.ok(source.includes('export async function runSkillRepairExperiment('));
    return { ...loaded, source: source.replace('export async function runSkillRepairExperiment(', 'async function originalSkillRepairExperiment(') +
      '\\nexport async function runSkillRepairExperiment(input) {\\n' +
      '  const report = await originalSkillRepairExperiment(input);\\n' +
      '  if (process.env.REPAIR_MOCK_MODE === "wrong-library") report.runs[0].acquisition.library = emptySkillLibrary({ modelIdentity: { ...input.modelIdentity, weightsSha256: "f".repeat(64) } });\\n' +
      '  if (process.env.REPAIR_MOCK_MODE === "duplicate-run") report.runs[1] = report.runs[0];\\n' +
      '  if (process.env.REPAIR_MOCK_MODE === "duplicate-source") report.sharedInitials[1] = report.sharedInitials[0];\\n' +
      '  return report;\\n}\\n' };
  } });
}
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const record = value => appendFileSync(process.env.REPAIR_MOCK_CALLS, JSON.stringify(value) + '\\n');
const originalTimeout = globalThis.setTimeout;
// Keep the worker's real retry loop and cap; only its backoff waits are shortened.
globalThis.setTimeout = (callback, ms, ...args) => originalTimeout(callback, [750,1500,2250].includes(ms) ? 0 : ms, ...args);
let tokenized;
const attempts = new Map();
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url).pathname;
  record({ path });
  const body = init.body ? JSON.parse(init.body) : null;
  if (path === '/v1/models') return Response.json({ data: [{ id: 'repair-mock-research' }] });
  const user = body?.messages?.at(-1)?.content;
  const scored = !body?.messages?.[0]?.content?.startsWith('This is a response-format conformance probe.');
  if (path === '/tokenize') {
    assert.equal(init.headers.Authorization, 'Bearer test-only-key');
    assert.equal(body.add_generation_prompt, true);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    assert.ok(init.signal instanceof AbortSignal);
    tokenized = body;
    if (process.env.REPAIR_MOCK_MODE === 'malformed-tokenizer') return Response.json({ count: '100', max_model_len: 8192 });
    return Response.json({ count: scored && process.env.REPAIR_MOCK_MODE === 'oversized-scored' ? 6000 : 100, max_model_len: 8192 });
  }
  if (path === '/v1/chat/completions') {
    assert.deepEqual(body.messages, tokenized.messages);
    assert.deepEqual(body.tools, tokenized.tools);
    assert.deepEqual(body.chat_template_kwargs, tokenized.chat_template_kwargs);
    assert.equal(body.model, tokenized.model);
    assert.equal(body.temperature, 1);
    assert.equal(body.max_tokens, scored ? 3072 : 128);
    if (scored) assert.ok([20260915,20261016,20261117].includes(body.seed));
    else assert.equal(body.seed, 20260913);
    const constrained = Object.hasOwn(body, 'response_format');
    if (scored) assert.equal(constrained, true);
    if (constrained) assert.deepEqual(body.response_format, { type: 'json_object' });
    const common = { ...body }; delete common.response_format;
    const family = scored ? 'scored-request' : user.includes('NOT_JSON_CONFORMANCE') ? 'literal-text' : 'malformed-json';
    const key = [scored ? 'scored' : 'conformance', body.seed, family, constrained].join('/');
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    record({ payloadMatched: true, scope: scored ? 'scored' : 'conformance', modelSeed: body.seed,
      family, arm: constrained ? 'json-object' : 'free-form', attempt, commonBodySha256: hash(common) });
    if (!scored && constrained && ['reject-json','retry-json'].includes(process.env.REPAIR_MOCK_MODE)) {
      return Response.json({ error: { message: 'Mock constrained request rejected' } }, { status: process.env.REPAIR_MOCK_MODE === 'retry-json' ? 503 : 400 });
    }
    if (process.env.REPAIR_MOCK_MODE === 'bad-inference') return new Response('invalid-json', { status: 200 });
    const content = scored ? JSON.stringify({ schema: 'amos.checked-procedure.v1', steps: [{ type: 'return', status: 'completed' }] }) :
      constrained || process.env.REPAIR_MOCK_MODE === 'no-free-failure' ? '{}' : family === 'literal-text' ? 'NOT_JSON_CONFORMANCE' : '{"ok":';
    return Response.json({ choices: [{ message: { role: 'assistant', content },
      finish_reason: !scored && constrained && process.env.REPAIR_MOCK_MODE === 'truncated-json' ? 'length' : 'stop' }],
      usage: { prompt_tokens: 105, completion_tokens: scored ? 20 : 5 } });
  }
  throw new Error('Unexpected mocked URL: ' + path);
};
`;

test('skill-repair CLI gates and accounts for the real core using mocked transport', { timeout: 30_000 }, async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'amos-skill-repair-cli-'));
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
      '--output', output, '--model', 'repair-mock-research', '--weights-sha256', 'a'.repeat(64),
      '--manifest-digest', 'b'.repeat(64), '--api-key-file', join(scratch, 'key')], {
      encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, REPAIR_MOCK_MODE: mode, REPAIR_MOCK_CALLS: join(scratch, `${name}.calls`) }
    });
    assert.ifError(result.error);
    return { output, result };
  }
  const normal = dispatch('normal');
  assert.equal(normal.result.status, 0, normal.result.stderr);
  const report = await readJson(join(normal.output, 'report.json'));

  await t.test('six shared generations and 36 repairs are counted once alongside four conformance probes', async () => {
    assert.equal(report.conformance.passed, true);
    assert.equal(report.conformance.rows.length, 4);
    assert.equal(report.conformance.scoredRequestsDispatchedBeforeGate, 0);
    assert.ok(report.conformance.rows.every(row => row.modelSeed === 20260913));
    assert.deepEqual(report.modelSeeds, [20260915, 20261016, 20261117]);
    assert.deepEqual(report.inferenceAccounting.counts, { conformance: 4, scored: 42 });
    assert.deepEqual(report.inferenceAccounting.scoredGenerationCounts, { sharedInitial: 6, repair: 36 });
    assert.equal(report.logicalCompilerRequests, 42);
    assert.equal(report.sharedInitials.length, 6);
    assert.equal(report.runs.length, 18);
    assert.ok(report.runs.every(run => run.requests.length === 3 && !run.acquisition.admitted));
    assert.equal(report.persistedLibraries.length, 18);
    assert.equal(new Set(report.persistedLibraries.map(row => row.filename)).size, 18);
    for (const item of report.persistedLibraries) assert.equal((await readJson(join(normal.output, item.filename))).digest, item.digest);
    assert.equal(report.inferenceAccounting.byScope.conformance.knownOutputTokens, 20);
    assert.equal(report.inferenceAccounting.byScope.scored.knownOutputTokens, 840);
    assert.equal(report.inferenceAccounting.byGeneration.sharedInitial.knownOutputTokens, 120);
    assert.equal(report.inferenceAccounting.byGeneration.repair.knownOutputTokens, 720);
    const shared = report.inferenceAccounting.logicalRequests.filter(row => row.arm === 'shared-initial');
    assert.equal(shared.length, 6);
    assert.equal(new Set(shared.map(row => `${row.family}/${row.replicate}`)).size, 6);
    const repairs = report.inferenceAccounting.logicalRequests.filter(row => row.generation === 'repair');
    const repairGroups = new Map();
    for (const row of repairs) {
      const key = `${row.arm}/${row.family}/${row.replicate}`;
      repairGroups.set(key, (repairGroups.get(key) ?? 0) + 1);
    }
    assert.equal(repairGroups.size, 18);
    assert.ok([...repairGroups.values()].every(count => count === 2));
    assert.equal(report.transport.unresolvedAttemptCost, false);
    const completed = await readJson(join(normal.output, 'completed.json'));
    assert.equal(completed.reportSha256, hash(await readFile(join(normal.output, 'report.json'))));
    assert.equal(report.dispatchManifestSha256, hash(await readFile(join(normal.output, 'manifest.json'))));
    assert.equal(report.sourceHashes[cli], hash(await readFile(cli)));
    assert.match(report.conformance.interpretation, /not proof/);
  });

  await t.test('wire receipts bind actual JSON requests and conformance pairs differ only by response_format', async () => {
    const calls = (await readCalls('normal')).filter(row => row.payloadMatched);
    assert.equal(calls.length, 46);
    const first = calls.filter(row => row.scope === 'conformance');
    const pairs = new Map();
    for (const row of first) {
      const key = `${row.scope}/${row.modelSeed}/${row.family}`;
      if (!pairs.has(key)) pairs.set(key, []);
      pairs.get(key).push(row);
    }
    assert.equal(pairs.size, 2);
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
    assert.ok(report.transport.attempts.filter(row => row.scope === 'scored').every(row =>
      row.responseFormatApplied?.type === 'json_object' && [20260915, 20261016, 20261117].includes(row.seed)));
    assert.equal(report.tokenizer.count, 46);
    assert.equal(report.tokenizer.includedInInferenceTransportAttempts, false);
    const tokenizerLog = await readFile(join(normal.output, 'tokenizer.jsonl'), 'utf8');
    assert.ok(!tokenizerLog.includes('test-only-key'));
    assert.ok(!tokenizerLog.includes('NOT_JSON_CONFORMANCE'));
  });

  await t.test('all three branches replay each exact shared response and revalidate without another model call', async () => {
    for (const shared of report.sharedInitials) {
      const branches = report.runs.filter(run => run.family === shared.family && run.replicate === shared.replicate);
      assert.equal(branches.length, 3);
      assert.deepEqual(new Set(branches.map(run => run.arm)), new Set(['feedback-only', 'diagnostics', 'candidate-diagnostics']));
      const actualDispatches = report.inferenceAccounting.logicalRequests.filter(row => row.caseId === shared.caseId);
      assert.equal(actualDispatches.length, 1);
      for (const run of branches) {
        assert.equal(run.requests[0].replay, true);
        assert.equal(run.requests[0].sharedCaseId, shared.caseId);
        assert.equal(run.requests[0].sharedResponseSha256, shared.responseSha256);
        assert.equal(run.requests[0].inputSha256, shared.inputSha256);
        assert.deepEqual(run.acquisition.attempts[0].response, shared.response);
        assert.equal(run.acquisition.attempts[0].validations.length, 4);
        assert.ok(run.acquisition.attempts[0].validations.every(row => !row.pass));
        assert.ok(run.requests.slice(1).every(row => row.replay === false));
      }
    }
    assert.equal(report.runs.reduce((sum, run) => sum + run.requests.length, 0), 54);
    assert.equal(report.inferenceAccounting.counts.scored, 42);
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
    assert.deepEqual(stopped.inferenceAccounting.counts, { conformance: 4, scored: 42 });
    assert.deepEqual(stopped.inferenceAccounting.scoredGenerationCounts, { sharedInitial: 6, repair: 36 });
    assert.equal(stopped.tokenizer.count, 46);
    const scored = stopped.inferenceAccounting.logicalRequests.filter(row => row.scope === 'scored');
    assert.equal(scored.length, 42);
    assert.ok(scored.every(row => row.status === 'rejected-before-inference' && row.transportAttempts === 0 && !row.inferenceDispatched));
    assert.equal(stopped.inferenceAccounting.byScope.scored.requestsDispatchedForInference, 0);
    assert.equal(stopped.inferenceAccounting.byScope.scored.incomplete, false);
    assert.equal(stopped.transport.unresolvedAttemptCost, false);
    assert.ok(stopped.sharedInitials.every(row => row.status === 'failed'));
    assert.ok(stopped.runs.every(run => run.requests[0].replay && run.requests[0].status === 'failed' &&
      run.requests[0].sharedResponseSha256 === null && run.requests.length === 3));
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

  await t.test('wrong-model libraries and incomplete unique result grids cannot receive completion receipts', async () => {
    for (const [mode, expected] of [['wrong-library', /library model identity differs/],
      ['duplicate-run', /result grid is invalid or duplicated/], ['duplicate-source', /shared-source grid is invalid or duplicated/]]) {
      const run = dispatch(mode, mode);
      assert.equal(run.result.status, 1);
      const failed = await readJson(join(run.output, 'failed.json'));
      assert.match(failed.error, expected);
      assert.deepEqual(failed.logicalRequestCounts, { conformance: 4, scored: 42 });
      await assert.rejects(readFile(join(run.output, 'completed.json')), { code: 'ENOENT' });
      await assert.rejects(readFile(join(run.output, 'report.json')), { code: 'ENOENT' });
    }
  });

  await t.test('CLI refuses a requested duration beyond the fixed 30-minute ceiling', async () => {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--import', join(scratch, 'mock.mjs'), cli,
      '--output', join(scratch, 'overlong'), '--model', 'repair-mock-research', '--weights-sha256', 'a'.repeat(64),
      '--manifest-digest', 'b'.repeat(64), '--api-key-file', join(scratch, 'key'), '--max-minutes', '31'], {
      encoding: 'utf8', timeout: 10_000, env: { ...process.env, REPAIR_MOCK_MODE: 'normal', REPAIR_MOCK_CALLS: join(scratch, 'overlong.calls') }
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /integer from 1 to 30/);
    assert.deepEqual(await readCalls('overlong'), []);
    await assert.rejects(readFile(join(scratch, 'overlong', 'manifest.json')), { code: 'ENOENT' });
  });
});
