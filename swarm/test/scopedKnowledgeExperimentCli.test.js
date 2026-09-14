import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const cli = fileURLToPath(new URL('../scripts/runScopedKnowledgeExperiment.js', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const evidenceHash = value => hash(JSON.stringify(value));
const arms = ['no-memory', 'exact-policy-cache', 'generated-facts', 'generated-prose'];
// Every fetch is intercepted in the parent and all actual child processes.
// Actors deliberately stop without solving: this is process/receipt evidence,
// not model quality or a measurement of the value of any memory condition.
const mock = String.raw`
import assert from 'node:assert/strict';
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
const inputIndex = process.argv.indexOf('--input');
const runtime = inputIndex < 0 ? null : JSON.parse(readFileSync(process.argv[inputIndex + 1], 'utf8'));
const mode = process.env.SCOPED_KNOWLEDGE_MOCK_MODE;
const record = row => appendFileSync(process.env.SCOPED_KNOWLEDGE_MOCK_LOG,
  JSON.stringify({ ...row, pid: process.pid, processNonce: runtime?.processNonce ?? null, cwd: process.cwd() }) + '\n');
if (runtime?.mode === 'evaluate' && mode === 'snapshot-corruption' && runtime.arm === 'exact-policy-cache' && runtime.caseIndex === 0) {
  writeFileSync(runtime.snapshotPath, '{}\n');
}
function acquisitionInput(body) {
  const prepared = JSON.parse(readFileSync(resolve(process.cwd(), 'prepared-training.json'), 'utf8'));
  const input = prepared.inputs.find(row => JSON.stringify(row.messages) === JSON.stringify(body.messages));
  assert.ok(input, 'wire messages must match the archived acquisition input');
  const manifest = JSON.parse(readFileSync(resolve(process.cwd(), '..', 'manifest.json'), 'utf8'));
  const spec = manifest.plan.acquisitions.find(row => row.acquisitionId === input.acquisitionId);
  assert.ok(spec);
  return { input, spec, profileIndex: manifest.plan.cases.filter(row => row.cohort === 'changed-version').findIndex(row => row.profileId === spec.profileId) };
}
let tokenized;
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url).pathname, body = init.body ? JSON.parse(init.body) : null;
  record({ path, phase: runtime?.mode ?? 'parent', arm: runtime?.arm ?? null, requestSha256: init.body ? hash(init.body) : null });
  if (path === '/v1/models') {
    assert.equal(runtime, null, 'only the parent may probe');
    return Response.json({ data: [{ id: 'scoped-knowledge-mock-research' }] });
  }
  if (path === '/tokenize') {
    assert.equal(init.headers.Authorization, 'Bearer scoped-knowledge-test-key');
    assert.equal(body.add_generation_prompt, true);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    tokenized = body;
    const acquired = runtime.mode === 'acquire' ? acquisitionInput(body) : null;
    if (mode === 'tokenizer-failure' && acquired?.spec.arm === 'generated-facts') {
      if (acquired.profileIndex === 0) return Response.json({ count: '100', max_model_len: 8192 });
      if (acquired.profileIndex === 1) return Response.json({ count: 8192, max_model_len: 8192 });
      return Response.json({ error: 'mock unavailable' }, { status: 503 });
    }
    return Response.json({ count: 100, max_model_len: 8192 });
  }
  if (path !== '/v1/chat/completions') throw new Error('Unexpected endpoint; real network is disabled');
  assert.deepEqual(body.messages, tokenized.messages);
  assert.deepEqual(body.tools, tokenized.tools);
  assert.equal(Object.hasOwn(body, 'response_format'), false);
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
  const acquisition = runtime.mode === 'acquire';
  assert.equal(body.temperature, acquisition ? 1 : 0);
  assert.equal(body.max_tokens, acquisition ? 512 : 1536);
  let content;
  if (acquisition) {
    const { input, spec } = acquisitionInput(body);
    assert.equal(body.seed, spec.modelSeed);
    // The mock copies a PUBLIC policy receipt supplied in the actual prompt.
    // It never reads private fixture state or expected reference targets.
    const source = JSON.parse(body.messages.at(-1).content);
    const policy = source.demonstrations[0].events.find(event => event.name === 'inspect_workflow_policy' && event.result.ok).result.policy;
    const normalization = policy.normalization;
    content = spec.arm === 'generated-facts' ? JSON.stringify(normalization) :
      'Apply this normalization: ' + JSON.stringify(normalization) + '. Inspect the current policy before using it for a changed version.';
    if (mode === 'invalid-facts' && spec.arm === 'generated-facts') content = '{"trim":"yes","case":"upper","prefix":"","suffix":""}';
    record({ acquisition: true, acquisitionId: input.acquisitionId, arm: spec.arm, profileId: spec.profileId,
      normalization, requestSha256: hash(init.body), seed: body.seed, temperature: body.temperature, max_tokens: body.max_tokens });
  } else {
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), '..', 'manifest.json'), 'utf8'));
    const spec = manifest.plan.tasks.find(row => row.taskId === runtime.taskId);
    assert.equal(body.seed, spec.modelSeed);
    const payload = JSON.parse(body.messages.at(-1).content);
    assert.deepEqual(payload.demonstrations, []);
    assert.deepEqual(payload.learnedSkills, []);
    assert.deepEqual(payload.observations, []);
    assert.deepEqual(Object.keys(payload.memoryKnowledge).sort(), ['knowledge', 'policyVersion', 'profileId']);
    const normalizedMessages = structuredClone(body.messages);
    normalizedMessages[normalizedMessages.length - 1].content = JSON.stringify({
      ...payload, memoryKnowledge: { ...payload.memoryKnowledge, knowledge: null }
    });
    record({ actor: true, taskId: runtime.taskId, caseIndex: runtime.caseIndex, arm: runtime.arm,
      memoryKnowledge: payload.memoryKnowledge, normalizedMessages, tools: body.tools,
      requestSha256: hash(init.body), seed: body.seed, temperature: body.temperature, max_tokens: body.max_tokens });
    content = 'Done.';
  }
  return Response.json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: acquisition ? 50 : 10 } });
};
`;

test('scoped-knowledge CLI preserves four-arm process, provenance and accounting evidence', { timeout: 120_000 }, async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'amos-scoped-knowledge-cli-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const mockPath = join(scratch, 'mock.mjs'), keyPath = join(scratch, 'key');
  await writeFile(mockPath, mock); await writeFile(keyPath, 'scoped-knowledge-test-key');
  const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
  async function calls(name) { return (await readFile(join(scratch, name + '.calls'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  function dispatch(name, mode = 'normal', outputName = name) {
    const directory = join(scratch, outputName);
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--import', mockPath, cli,
      '--output', directory, '--model', 'scoped-knowledge-mock-research', '--weights-sha256', 'a'.repeat(64),
      '--manifest-digest', 'b'.repeat(64), '--api-key-file', keyPath], { encoding: 'utf8', timeout: 45_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, SCOPED_KNOWLEDGE_MOCK_MODE: mode, SCOPED_KNOWLEDGE_MOCK_LOG: join(scratch, name + '.calls') } });
    assert.ifError(result.error);
    return { directory, result };
  }
  async function completed(run) {
    if (run.result.status !== 0) {
      const failure = await readJson(join(run.directory, 'failed.json')).catch(() => null);
      const children = await Promise.all((failure?.children ?? []).map(row => readJson(join(row.directory, 'failed.json')).catch(() => null)));
      assert.fail(JSON.stringify({ stderr: run.result.stderr, error: failure?.error, children }));
    }
    return readJson(join(run.directory, 'report.json'));
  }
  const normal = dispatch('normal'), report = await completed(normal);

  await t.test('six generations exit before 36 fresh actors reload immutable, source-bound snapshots', async () => {
    assert.equal(report.schema, 'amos.scoped-knowledge-experiment.v1');
    assert.equal(report.runnerProtocol, 'amos.scoped-knowledge-process-runner.v1');
    assert.equal(report.plan.acquisitions.length, 6);
    assert.equal(report.tasks.length, 36);
    assert.equal(report.plan.limits.maxLogicalRequests, 438);
    assert.equal(report.plan.limits.maxMinutes, 100);
    assert.equal(new Set(report.tasks.map(row => row.process.processId)).size, 36);
    assert.equal(new Set(report.tasks.map(row => row.process.processNonce)).size, 36);
    const manifestBytes = await readFile(join(normal.directory, 'manifest.json')), manifest = JSON.parse(manifestBytes);
    assert.equal(report.dispatchManifestSha256, hash(manifestBytes));
    assert.equal(manifest.sourceHashesSha256, hash(JSON.stringify(report.sourceHashes, null, 2) + '\n'));
    assert.ok(Object.keys(report.sourceHashes).some(path => path.endsWith('/scopedKnowledgeFixture.js')));
    assert.ok(Object.keys(report.sourceHashes).some(path => path.endsWith('/scopedKnowledgeProcessRunner.js')));
    for (const [path, expected] of Object.entries(report.sourceHashes)) assert.equal(hash(await readFile(path)), expected);
    const acquired = report.acquisition.receipt;
    assert.equal(acquired.code, 0);
    for (const task of report.tasks) {
      assert.equal(task.process.code, 0);
      assert.notEqual(task.process.processId, acquired.processId);
      assert.notEqual(task.process.processId, report.processId);
      assert.notEqual(task.process.processNonce, acquired.processNonce);
      assert.ok(Date.parse(task.report.startedAt) >= Date.parse(acquired.exitedAt));
      const inputBytes = await readFile(join(task.process.directory, 'input.json')), input = JSON.parse(inputBytes);
      assert.equal(hash(inputBytes), task.process.runtimeInputSha256);
      assert.equal(task.report.runtimeInputSha256, hash(inputBytes));
      assert.equal(input.processNonce, task.process.processNonce);
      assert.equal(input.planSha256, report.planSha256);
      assert.equal(input.sourceHashesSha256, manifest.sourceHashesSha256);
      assert.equal(task.report.sourceHashesSha256, manifest.sourceHashesSha256);
      assert.equal(Object.hasOwn(input, 'demonstrations'), false);
      assert.equal(Object.hasOwn(input, 'acquisitions'), false);
      assert.ok(!(await readdir(task.process.directory)).some(name => name.includes('training')));
      const load = task.report.result.memoryLoad;
      assert.equal(load.processId, task.process.processId);
      assert.equal(load.path, join(task.process.directory, 'snapshot.json'));
      assert.equal(load.byteSha256, hash(await readFile(load.path)));
      assert.equal(load.byteSha256, task.report.result.snapshotAfterSha256);
      assert.equal(load.snapshotDigest, report.acquisition.report.result.snapshots[task.arm].digest);
      assert.equal(load.records.length, task.arm === 'no-memory' ? 0 : 3);
      assert.ok(load.records.every(row => row.verification === (task.arm === 'exact-policy-cache' ? 'verified' : 'unverified')));
      const receipt = await readJson(join(task.process.directory, 'completed.json'));
      assert.equal(receipt.reportSha256, hash(await readFile(join(task.process.directory, 'report.json'))));
      assert.equal(receipt.processNonce, task.process.processNonce);
      assert.equal(task.pass, false, 'The mock stop response must not imply native task success');
    }
    assert.ok(Object.values(report.memoryPreservation).every(row => row.beforeSha256 === row.afterSha256));
    assert.match(report.isolation, /no OS filesystem sandbox/);
    assert.equal(report.modelServerRestartClaimed, false);
  });

  await t.test('cache records bind public receipts; generated records retain distinct unverified provenance', async () => {
    const creation = report.acquisition.report.result;
    const cached = await readJson(creation.snapshots['exact-policy-cache'].path);
    assert.equal(cached.records.length, 3);
    for (const record of cached.records) {
      const provenance = JSON.parse(record.source.reference);
      const input = creation.acquisitions.find(row => row.input.profileId === provenance.profileId).input;
      const event = input.demonstrations[0].events.find(row => row.name === 'inspect_workflow_policy' && row.result.ok);
      assert.deepEqual(JSON.parse(record.text), event.result.policy.normalization);
      assert.equal(provenance.policyReceiptSha256, evidenceHash(event));
      assert.equal(provenance.demonstrationsSha256, evidenceHash(input.demonstrations));
      assert.equal(provenance.trainingReceiptsSha256, evidenceHash(input.trainingReceipts));
      assert.equal(record.source.kind, 'document');
      assert.equal(record.source.modelId, null);
      assert.equal(record.verification.status, 'verified');
      assert.match(record.verification.receiptSha256, /^[a-f0-9]{64}$/);
      assert.equal(record.verification.verifierId, 'literal-public-policy-replay-v1');
      assert.equal(record.example, null);
    }
    for (const arm of ['generated-facts', 'generated-prose']) {
      const snapshot = await readJson(creation.snapshots[arm].path);
      assert.equal(snapshot.records.length, 3);
      for (const record of snapshot.records) {
        const provenance = JSON.parse(record.source.reference);
        const acquired = creation.acquisitions.find(row => row.acquisitionId === provenance.acquisitionId);
        assert.equal(record.source.kind, 'external-model');
        assert.equal(record.source.modelId, report.modelIdentity.model);
        assert.equal(record.verification.status, 'unverified');
        assert.equal(record.verification.receiptSha256, null);
        assert.equal(record.example, null);
        assert.equal(provenance.responseSha256, evidenceHash(acquired.response));
        assert.equal(provenance.inputSha256, acquired.input.inputSha256);
      }
    }
  });

  await t.test('nine quartets share actual inputs except knowledge and pay exact per-arm creation costs', async () => {
    const observed = await calls('normal');
    assert.equal(observed.filter(row => row.path === '/v1/models').length, 1);
    assert.equal(observed.filter(row => row.path === '/v1/chat/completions').length, 42);
    assert.equal(observed.filter(row => row.path === '/tokenize').length, 42);
    const generated = observed.filter(row => row.acquisition);
    assert.equal(generated.length, 6);
    assert.ok(generated.every(row => ['generated-facts', 'generated-prose'].includes(row.arm)));
    for (let caseIndex = 0; caseIndex < 9; caseIndex++) {
      const quartet = observed.filter(row => row.actor && row.caseIndex === caseIndex);
      assert.equal(quartet.length, 4);
      assert.deepEqual(quartet.map(row => row.arm).sort(), [...arms].sort());
      assert.equal(new Set(quartet.map(row => JSON.stringify(row.normalizedMessages))).size, 1);
      assert.equal(new Set(quartet.map(row => JSON.stringify(row.tools))).size, 1);
      assert.equal(new Set(quartet.map(row => row.seed)).size, 1);
      assert.ok(quartet.every(row => row.temperature === 0 && row.max_tokens === 1536));
      assert.equal(quartet.find(row => row.arm === 'no-memory').memoryKnowledge.knowledge, null);
      assert.ok(quartet[0].tools.some(row => row.function.name === 'normalize_reference'));
      assert.equal(new Set(report.tasks.filter(row => row.caseIndex === caseIndex).map(row => row.report.result.firstInputSha256)).size, 1);
    }
    for (const arm of arms) {
      const generationCalls = arm.startsWith('generated-') ? 3 : 0;
      assert.equal(report.byArm[arm].intendedTasks, 9);
      assert.equal(report.byArm[arm].solvedTasks, 0);
      assert.equal(report.byArm[arm].acquisitionUsage.logicalRequests, generationCalls);
      assert.equal(report.byArm[arm].evaluationUsage.logicalRequests, 9);
      assert.equal(report.byArm[arm].endToEndUsage.logicalRequests, 9 + generationCalls);
      assert.deepEqual(report.byArm[arm].endToEndReceiptCounts,
        { inferenceTransportAttempts: 9 + generationCalls, tokenizerRequests: 9 + generationCalls });
    }
    assert.equal(report.accounting.logicalRequests.length, 42);
    assert.equal(report.accounting.transport.length, 43);
    assert.equal(report.accounting.tokenizer.length, 42);
    assert.equal(report.accounting.unresolvedAttemptCost, false);
    assert.ok(report.accounting.logicalRequests.every(row => row.promptTokenCheck.exactMatch));
    for (const wire of report.accounting.transport.filter(row => row.phase !== 'probe')) {
      const actual = observed.find(row => (row.actor || row.acquisition) && row.requestSha256 === wire.requestSha256);
      assert.ok(actual, 'wire journal must hash the actual fetch payload');
      assert.equal(wire.seed, actual.seed); assert.equal(wire.temperature, actual.temperature); assert.equal(wire.max_tokens, actual.max_tokens);
    }
    for (const receipt of report.accounting.tokenizer) assert.ok(observed.some(row => row.path === '/tokenize' && row.requestSha256 === receipt.requestSha256));
  });

  await t.test('invalid generated facts retain every generation cost and actor slot but produce no records', async () => {
    const failed = await completed(dispatch('invalid-facts', 'invalid-facts'));
    assert.equal(failed.tasks.length, 36);
    assert.equal(failed.acquisition.report.result.snapshots['generated-facts'].records.length, 0);
    assert.equal(failed.acquisition.report.result.snapshots['generated-prose'].records.length, 3);
    assert.equal(failed.acquisition.report.result.snapshots['exact-policy-cache'].records.length, 3);
    const facts = failed.acquisition.report.result.memories.filter(row => row.arm === 'generated-facts');
    assert.equal(facts.length, 3);
    assert.ok(facts.every(row => !row.available && row.rejectionReasons.includes('invalid-facts-schema')));
    assert.ok(failed.tasks.filter(row => row.arm === 'generated-facts').every(row => row.report.result.memoryAvailable === false && row.report.result.modelCalls === 1));
    assert.equal(failed.byArm['generated-facts'].intendedTasks, 9);
    assert.equal(failed.byArm['generated-facts'].acquisitionUsage.logicalRequests, 3);
    assert.equal(failed.byArm['generated-facts'].endToEndUsage.logicalRequests, 12);
    assert.equal(failed.accounting.logicalRequests.length, 42);
    assert.equal(failed.accounting.unresolvedAttemptCost, false);
  });

  await t.test('tokenizer rejection counts logical failures without dispatching or inventing GPU cost', async () => {
    const failed = await completed(dispatch('tokenizer-failure', 'tokenizer-failure'));
    assert.equal(failed.tasks.length, 36);
    assert.equal(failed.accounting.logicalRequests.length, 42);
    assert.equal(failed.accounting.usage.dispatchedRequests, 39);
    assert.equal(failed.accounting.usage.rejectedBeforeInference, 3);
    assert.equal(failed.accounting.unresolvedAttemptCost, false);
    assert.equal(failed.acquisition.report.result.snapshots['generated-facts'].records.length, 0);
    assert.equal(failed.byArm['generated-facts'].intendedTasks, 9);
    assert.equal(failed.byArm['generated-facts'].endToEndUsage.logicalRequests, 12);
    assert.equal(failed.byArm['generated-facts'].endToEndUsage.incomplete, false);
    assert.deepEqual(failed.byArm['generated-facts'].endToEndReceiptCounts, { inferenceTransportAttempts: 9, tokenizerRequests: 12 });
    const rejected = failed.accounting.tokenizer.filter(row => row.status === 'rejected');
    assert.equal(rejected.length, 3);
    assert.ok(rejected.every(row => row.arm === 'generated-facts'));
    assert.ok(rejected.some(row => row.error.includes('integer count')));
    assert.ok(rejected.some(row => row.error.includes('Context budget exceeded')));
    assert.ok(rejected.some(row => row.error.includes('HTTP 503')));
    const observed = await calls('tokenizer-failure');
    assert.equal(observed.filter(row => row.path === '/v1/chat/completions').length, 39);
  });

  await t.test('corrupt staged cache prevents inference and preserves the intended failed actor slot', async () => {
    const corrupt = await completed(dispatch('snapshot-corruption', 'snapshot-corruption'));
    const task = corrupt.tasks.find(row => row.caseIndex === 0 && row.arm === 'exact-policy-cache');
    assert.equal(task.process.code, 1); assert.equal(task.report, null); assert.equal(task.pass, false);
    assert.equal(corrupt.tasks.length, 36);
    assert.equal(corrupt.byArm['exact-policy-cache'].intendedTasks, 9);
    assert.equal(corrupt.byArm['exact-policy-cache'].incompleteChildReports, 1);
    assert.equal(corrupt.byArm['exact-policy-cache'].endToEndUsage.logicalRequests, 8);
    assert.equal(corrupt.accounting.logicalRequests.length, 41);
    assert.equal(corrupt.accounting.unresolvedAttemptCost, false);
    const failure = await readJson(join(task.process.directory, 'failed.json'));
    assert.match(failure.error, /Snapshot bytes differ/);
    assert.ok(Object.values(corrupt.memoryPreservation).every(row => row.beforeSha256 === row.afterSha256));
    const observed = await calls('snapshot-corruption');
    assert.equal(observed.some(row => row.actor && row.taskId === task.taskId), false);
  });

  await t.test('exclusive output refuses duplicate dispatch without overwriting evidence', async () => {
    const before = await readFile(join(normal.directory, 'report.json'));
    const duplicate = dispatch('duplicate', 'normal', 'normal');
    assert.equal(duplicate.result.status, 1); assert.match(duplicate.result.stderr, /EEXIST/);
    assert.deepEqual(await readFile(join(normal.directory, 'report.json')), before);
  });
});
