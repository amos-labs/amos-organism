import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createContinualTask, buildContinualDemonstration } from '../src/continualCurriculum.js';
import { replayContinualTask } from '../src/continualLearningEvaluation.js';

const script = fileURLToPath(new URL('../scripts/evaluateContinualPanel.js', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const exists = async path => { try { await access(path); return true; } catch { return false; } };

test('panel CLI preserves native evidence, consumed output directories and failed-request costs in fresh processes', { timeout: 120000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'continual-panel-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const panel = [1, 2].map(seed => createContinualTask({ lineageId: 'signed-ledger', split: 'training', seed }));
  const replies = panel.map(task => {
    const demo = buildContinualDemonstration(task), call = structuredClone(demo.rows[0].messages.at(-1));
    for (const item of call.tool_calls) if (typeof item.function.arguments !== 'string') item.function.arguments = JSON.stringify(item.function.arguments);
    return [call, demo.rows[1].messages.at(-1)];
  });
  const panelBytes = JSON.stringify(panel), panelPath = join(directory, 'panel.json'), keyPath = join(directory, 'key.txt');
  await writeFile(panelPath, panelBytes); await writeFile(keyPath, 'cpu-test-secret\n');
  const mock = join(directory, 'mock.mjs');
  await writeFile(mock, `import assert from 'node:assert/strict';
const tasks=${JSON.stringify(panel.map(task => ({ messages: task.messages, tools: task.tools })))};
const replies=${JSON.stringify(replies)};
let inference=0;
globalThis.fetch=async(url,init)=>{
  url=new URL(url); assert.equal(url.origin,'http://127.0.0.1:8001');
  assert.equal(init.headers.Authorization,'Bearer cpu-test-secret');
  const body=JSON.parse(init.body), index=Math.floor(inference/2), task=tasks[index];
  assert.deepEqual(body.messages.slice(0,2),task.messages);
  assert.deepEqual(body.tools,task.tools);
  assert.equal(Object.hasOwn(body,'spec'),false);
  assert.equal(Object.hasOwn(body,'expectedAnswer'),false);
  assert.equal(body.chat_template_kwargs.enable_thinking,false);
  if(url.pathname==='/tokenize'){
    return new Response(JSON.stringify({count:process.env.CPU_MODE==='context'&&index===1?8000:12,max_model_len:8192}));
  }
  assert.equal(url.pathname,'/v1/chat/completions');assert.equal(body.temperature,0);assert.equal(body.seed,20260914);assert.equal(body.max_tokens,1536);
  if(process.env.CPU_MODE==='socket'&&index===1)throw new Error('cpu injected socket reset');
  const message=replies[index][inference%2];inference++;
  return new Response(JSON.stringify({model:'cpu-only',choices:[{message,finish_reason:message.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:process.env.CPU_MODE==='drift'&&index===1?13:12,completion_tokens:3}}));
};
`);
  async function run(mode) {
    const output = join(directory, mode), config = { schema: 'amos.continual-panel-config.v1', panelPath,
      panelSha256: digest(panelBytes), output, model: 'cpu-only', weightsSha256: 'a'.repeat(64), apiKeyFile: keyPath,
      baseUrl: 'http://127.0.0.1:8001', maxMinutes: 1, maxModelCalls: panel.length * 4, seed: 20260914 };
    const configPath = join(directory, mode + '-config.json'), bytes = JSON.stringify(config);
    await writeFile(configPath, bytes);
    const invoke = () => spawnSync(process.execPath, ['--import', mock, script, '--config', configPath, '--config-sha256', digest(bytes)],
      { env: { ...process.env, CPU_MODE: mode }, cwd: resolve(directory), encoding: 'utf8', timeout: 10000 });
    return { output, configSha256: digest(bytes), process: invoke(), invoke };
  }
  await t.test('successful CPU replies replay; duplicate output never dispatches', async () => {
    const result = await run('success');
    assert.equal(result.process.status, 0, result.process.stderr);
    const report = await read(join(result.output, 'report.json'));
    assert.equal(report.complete, true); assert.equal(report.nativePasses, 2);
    assert.equal(report.configSha256, result.configSha256);
    assert.equal(report.processId, result.process.pid);
    assert.equal(report.accounting.requests, 4); assert.equal(report.accounting.logicalRequests, 4);
    assert.equal(report.accounting.tokenizerRequests, 4); assert.equal(report.accounting.promptTokens, 48);
    report.results.forEach((row, index) => assert.equal(replayContinualTask(panel[index], row).passed, true));
    const journalPath = join(result.output, 'events.jsonl'), journal = await readFile(journalPath, 'utf8');
    assert.equal(journal.includes('cpu-test-secret'), false);
    const again = result.invoke(); assert.notEqual(again.status, 0); assert.match(again.stderr, /EEXIST/);
    assert.equal(await readFile(journalPath, 'utf8'), journal);
  });
  for (const mode of ['context', 'socket', 'drift']) await t.test(`${mode} failure retains the completed task and accounts the failed slot without completion`, async () => {
    const result = await run(mode); assert.notEqual(result.process.status, 0);
    assert.equal(await exists(join(result.output, 'report.json')), false);
    const failure = await read(join(result.output, 'failure.json'));
    assert.equal(failure.complete, false); assert.equal(failure.completedTasks, 1);
    assert.equal(replayContinualTask(panel[0], failure.results[0]).passed, true);
    assert.equal(failure.accounting.logicalRequests, 3); assert.equal(failure.accounting.tokenizerRequests, 3);
    assert.equal(failure.accounting.requests, mode === 'context' ? 2 : 3);
    assert.equal(failure.accounting.unknownUsageRequests, mode === 'socket' ? 1 : 0);
    assert.equal(failure.accounting.promptTokens, mode === 'drift' ? 37 : 24);
    assert.equal(failure.accounting.integrityFailures, mode === 'drift' ? 1 : 0);
    assert.equal(failure.noAutomaticRetry, true);
    const events = (await readFile(join(result.output, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(events.filter(event => event.type === 'task-completed').length, 1);
    if (mode === 'drift') assert.equal(events.at(-1).providerResponse.usage.prompt_tokens, 13);
  });
});
