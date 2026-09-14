import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, readdir, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { describeScopedKnowledgeDeadlineBudget, SCOPED_KNOWLEDGE_RUNNER_PROTOCOL } from '../src/scopedKnowledgeProcessRunner.js';

const runnerPath = fileURLToPath(new URL('../src/scopedKnowledgeProcessRunner.js', import.meta.url));
const memoryPath = fileURLToPath(new URL('../src/persistentReplayMemory.js', import.meta.url));
const historicalPath = fileURLToPath(new URL('../src/memoryProcessExperimentRunner.js', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('100-minute policy reports the full known timer envelope without promising completion', () => {
  const budget = describeScopedKnowledgeDeadlineBudget({ acquisitionCount: 6, taskCount: 36, taskTimeoutMs: 120_000 });
  assert.equal(budget.maxMinutes, 100);
  assert.equal(budget.nominalRequestDeadlineMilliseconds, 84 * 60_000);
  assert.equal(budget.acquisitionWatchdogOverheadMilliseconds, 20_000);
  assert.equal(budget.evaluationWatchdogOverheadMilliseconds, 36 * 10_000);
  assert.equal(budget.maximumForcedTerminationGraceMilliseconds, 37 * 2_000);
  assert.equal(budget.maximumProbeMilliseconds, 120_000);
  assert.equal(budget.knownSerializedEnvelopeMilliseconds, (93 * 60 + 34) * 1000);
  assert.equal(budget.marginBeforeUnbudgetedWorkMilliseconds, (6 * 60 + 26) * 1000);
  assert.equal(budget.knownEnvelopeFits, true);
  assert.equal(budget.fullCoverageGuaranteed, false);
  assert.equal(budget.globalDeadlineTakesPrecedence, true);
  assert.match(budget.limitation, /filesystem.*export.*incomplete/);
  const shorter = describeScopedKnowledgeDeadlineBudget({ acquisitionCount: 6, taskCount: 36, taskTimeoutMs: 120_000, maxMinutes: 90 });
  assert.equal(shorter.knownEnvelopeFits, false);
  assert.equal(shorter.marginBeforeUnbudgetedWorkMilliseconds, -214_000);
  assert.throws(() => describeScopedKnowledgeDeadlineBudget({ acquisitionCount: 6, taskCount: 36, taskTimeoutMs: 120_000, maxMinutes: 101 }), /Invalid/);
});

// This adapter tests process/transport contracts without instantiating or consuming
// any research fixture. It has one synthetic acquisition and one two-arm comparison.
const adapterSource = memoryImport => `
import { createReplayMemory, validateReplayMemory } from ${JSON.stringify(memoryImport)};
const arms = ['no-memory', 'test-advice'];
export function createPlan({modelIdentity}) {
  return {schema:'amos.scoped-runner-test.v1', experimentId:'scoped-runner-cpu-test',modelIdentity,arms,
    acquisitions:[{acquisitionId:'test-advice-unit',arm:'test-advice',profileId:'test-unit',modelSeed:123,temperature:1,maxOutputTokens:512}],
    tasks:arms.map((arm,caseIndex)=>({taskId:'unit-'+arm,arm,memoryKey:arm,caseIndex:0,tripletId:'unit',cohort:'synthetic-test',modelSeed:456,profileId:null,policyVersion:null})),
    limits:{maxModelCallsPerTask:2,maxToolCallsPerTask:32,taskTimeoutMs:120000,maxMinutes:process.env.SCOPED_RUNNER_TEST_MODE==='bad-plan-cap'?101:100,
      maxLogicalRequests:5,executionMaxOutputTokens:1536}};
}
export function buildAcquisitionInput({acquisitionId,modelIdentity}) {
  return {...createPlan({modelIdentity}).acquisitions[0],modelIdentity,phase:'memory-acquisition',caseId:acquisitionId,responseFormat:null,
    messages:[{role:'system',content:'CPU-only process contract test.'},{role:'user',content:'Return test advice.'}],tools:[]};
}
export function buildSnapshots({acquisitions,modelIdentity}) {
  return {modelIdentity,acquisitions,snapshots:Object.fromEntries(arms.map(arm=>[arm,createReplayMemory({tenantId:'scoped-runner-cpu-test',observations:[]})]))};
}
export function validateSnapshot({snapshot}) {return validateReplayMemory(snapshot);}
export async function runTask({taskId,loadedMemory,modelIdentity,request,signal}) {
  const spec=createPlan({modelIdentity}).tasks.find(row=>row.taskId===taskId);
  const count=process.env.SCOPED_RUNNER_TEST_MODE==='request-cap'?3:1;
  let answer;
  for(let i=0;i<count;i++) answer=await request({...spec,phase:'execute',caseId:taskId+'-'+i,
    temperature:0,maxOutputTokens:1536,responseFormat:null,signal,
    messages:[{role:'system',content:'CPU-only process contract test.'},{role:'user',content:'Return done.'}],tools:[]});
  return {...spec,modelIdentity,modelCalls:count,toolCalls:0,pass:answer.message.content==='done',loadedDigest:loadedMemory.digest};
}
export function validateTaskResult({result,taskSpec,modelIdentity}) {
  if(result.taskId!==taskSpec.taskId || result.modelIdentity.model!==modelIdentity.model) throw Error('Test result identity mismatch');
}
`;

const mockSource = `
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const mode=process.env.SCOPED_RUNNER_TEST_MODE;
const inputIndex=process.argv.indexOf('--input');
const runtime=inputIndex<0?null:JSON.parse(readFileSync(process.argv[inputIndex+1],'utf8'));
const record=row=>appendFileSync(process.env.SCOPED_RUNNER_TEST_LOG,JSON.stringify({...row,pid:process.pid,cwd:process.cwd()})+'\\n');
if(runtime?.mode==='evaluate' && mode==='wrong-child-protocol' && runtime.arm==='test-advice') {
  writeFileSync(process.argv[inputIndex+1],JSON.stringify({...runtime,runnerProtocol:'forged-runner.v1'}));
}
if(runtime?.mode==='evaluate' && mode==='changed-source' && runtime.arm==='no-memory') {
  appendFileSync(process.env.SCOPED_RUNNER_TEST_ADAPTER,'\\n// changed after frozen parent hashing\\n');
}
const realTimeout=AbortSignal.timeout;
const globalAbort=new AbortController();
if(mode==='global-deadline' && !runtime) AbortSignal.timeout=milliseconds=>milliseconds===100*60000?globalAbort.signal:realTimeout(milliseconds);
let tokenized;
globalThis.fetch=async(url,init={})=>{
  const path=new URL(url).pathname,body=init.body?JSON.parse(init.body):null;
  record({path,arm:runtime?.arm??null,phase:runtime?.mode??'parent'});
  if(path==='/v1/models') {
    assert.equal(runtime,null);
    if(mode==='probe-failure') return Response.json({data:[{id:'wrong-model'}]});
    if(mode==='global-deadline') globalAbort.abort(new Error('Simulated global deadline'));
    return Response.json({data:[{id:'scoped-runner-test-model'}]});
  }
  if(path==='/tokenize') {
    assert.equal(init.headers.Authorization,'Bearer local-mock-key');
    assert.deepEqual(body.chat_template_kwargs,{enable_thinking:false});
    tokenized=body;
    return Response.json({count:mode==='context-rejection' && runtime.mode==='acquire'?8192:100,max_model_len:8192});
  }
  assert.equal(path,'/v1/chat/completions');
  assert.equal(body.model,'scoped-runner-test-model');
  assert.deepEqual(body.messages,tokenized.messages);
  assert.deepEqual(body.tools,tokenized.tools);
  assert.equal(Object.hasOwn(body,'response_format'),false);
  assert.deepEqual(body.chat_template_kwargs,{enable_thinking:false});
  const acquisition=runtime.mode==='acquire';
  assert.equal(body.seed,acquisition?123:456);
  assert.equal(body.temperature,acquisition?1:0);
  assert.equal(body.max_tokens,acquisition?512:1536);
  if(mode==='killed-task' && runtime.mode==='evaluate' && runtime.arm==='no-memory') process.exit(23);
  if(mode==='transport-cap' && acquisition) return Response.json({error:'mock gateway unavailable'},{status:503});
  return Response.json({choices:[{message:{role:'assistant',content:acquisition?'synthetic advice':'done'},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:7}});
};
`;

test('versioned runner preserves lifecycle, caps, source binding and failed costs in real subprocesses', { timeout: 60_000 }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'amos-scoped-runner-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keyPath = join(directory, 'mock-key'), mockPath = join(directory, 'mock.mjs');
  await writeFile(keyPath, 'local-mock-key'); await writeFile(mockPath, mockSource);
  const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
  const importedFrom = (origin, target) => {
    const path = relative(dirname(origin), target).split('\\').join('/');
    return path.startsWith('.') ? path : './' + path;
  };
  async function dispatch(name, { mode = 'normal', minutes, extra = [] } = {}) {
    const entryPath = join(directory, name + '-entry.mjs'), adapterPath = join(directory, name + '-adapter.mjs');
    const logPath = join(directory, name + '.calls'), outputPath = join(directory, name + '-out');
    await writeFile(adapterPath, adapterSource(importedFrom(adapterPath, memoryPath)));
    await writeFile(entryPath, `import {runScopedKnowledgeProcessExperimentCli} from ${JSON.stringify(importedFrom(entryPath, runnerPath))};\n` +
      `import * as adapter from ${JSON.stringify(importedFrom(entryPath, adapterPath))};\nawait runScopedKnowledgeProcessExperimentCli({entryUrl:import.meta.url,adapter});\n`);
    const args = ['--experimental-strip-types', '--import', mockPath, entryPath, '--output', outputPath,
      '--model', 'scoped-runner-test-model', '--weights-sha256', 'a'.repeat(64), '--manifest-digest', 'b'.repeat(64), '--api-key-file', keyPath,
      ...(minutes === undefined ? [] : ['--max-minutes', String(minutes)]), ...extra];
    const process = spawnSync(processExec, args, { encoding: 'utf8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
      env: { ...processEnv, SCOPED_RUNNER_TEST_MODE: mode, SCOPED_RUNNER_TEST_LOG: logPath, SCOPED_RUNNER_TEST_ADAPTER: adapterPath } });
    assert.ifError(process.error);
    const calls = await readFile(logPath, 'utf8').then(value => value.trim().split('\n').filter(Boolean).map(JSON.parse)).catch(error => {
      if (error.code === 'ENOENT') return []; throw error;
    });
    return { process, calls, outputPath, logPath, report: await readJson(join(outputPath, 'report.json')).catch(() => null),
      failure: await readJson(join(outputPath, 'failed.json')).catch(() => null) };
  }
  const processExec = process.execPath, processEnv = process.env;
  const normal = await dispatch('normal');
  assert.equal(normal.process.status, 0, normal.process.stderr);
  const report = normal.report, manifest = await readJson(join(normal.outputPath, 'manifest.json'));

  await t.test('default100 is bound to child protocols, immutable reload and actual wire settings', async () => {
    assert.equal(manifest.maxMinutes, 100);
    assert.equal(manifest.runnerProtocol, SCOPED_KNOWLEDGE_RUNNER_PROTOCOL);
    assert.equal(report.runnerProtocol, SCOPED_KNOWLEDGE_RUNNER_PROTOCOL);
    assert.deepEqual(report.deadlineBudget, manifest.deadlineBudget);
    assert.ok(Object.hasOwn(manifest.sourceHashes, runnerPath));
    assert.equal(report.tasks.length, 2);
    const acquisition = report.acquisition.receipt;
    assert.equal(acquisition.code, 0);
    assert.equal(new Set([acquisition.processId, ...report.tasks.map(row => row.process.processId)]).size, 3);
    for (const task of report.tasks) {
      assert.equal(task.pass, true);
      assert.equal(task.report.runnerProtocol, SCOPED_KNOWLEDGE_RUNNER_PROTOCOL);
      assert.ok(Date.parse(task.report.startedAt) >= Date.parse(acquisition.exitedAt));
      const input = await readJson(join(task.process.directory, 'input.json'));
      assert.equal(input.runnerProtocol, SCOPED_KNOWLEDGE_RUNNER_PROTOCOL);
      assert.equal(Object.hasOwn(input, 'acquisitions'), false);
      assert.equal(Object.hasOwn(input, 'demonstrations'), false);
      assert.ok(!(await readdir(task.process.directory)).some(name => name.includes('training')));
      assert.equal(task.report.result.memoryLoad.byteSha256, hash(await readFile(task.report.result.memoryLoad.path)));
      assert.equal(task.report.result.memoryLoad.byteSha256, task.report.result.snapshotAfterSha256);
      const completed = await readJson(join(task.process.directory, 'completed.json'));
      assert.equal(completed.reportSha256, hash(await readFile(join(task.process.directory, 'report.json'))));
    }
    assert.equal(report.accounting.logicalRequests.length, 3);
    assert.equal(report.accounting.tokenizer.length, 3);
    assert.equal(report.accounting.transport.length, 4);
    assert.equal(report.accounting.unresolvedAttemptCost, false);
    assert.equal(report.byArm['test-advice'].acquisitionUsage.logicalRequests, 1);
    assert.equal(report.byArm['no-memory'].acquisitionUsage.logicalRequests, 0);
    assert.ok(report.accounting.logicalRequests.every(row => row.promptTokenCheck.exactMatch));
  });

  await t.test('smaller global budgets are honored and invalid caps fail before any network request', async () => {
    const shorter = await dispatch('shorter', { minutes: 61 });
    assert.equal(shorter.process.status, 0, shorter.process.stderr);
    const chosen = await readJson(join(shorter.outputPath, 'manifest.json'));
    assert.equal(chosen.maxMinutes, 61);
    assert.equal(chosen.deadlineBudget.globalDeadlineMilliseconds, 61 * 60_000);
    for (const minutes of [0, 101, 100.5]) {
      const bad = await dispatch('bad-cli-' + minutes, { minutes });
      assert.equal(bad.process.status, 1);
      assert.match(bad.process.stderr, /from 1 to 100/);
      assert.equal(bad.calls.length, 0);
      await assert.rejects(access(bad.outputPath));
    }
    const badPlan = await dispatch('bad-plan', { mode: 'bad-plan-cap' });
    assert.equal(badPlan.process.status, 1);
    assert.match(badPlan.failure.error, /compositional experiment limits/);
    assert.equal(badPlan.calls.length, 0);
  });

  await t.test('startup and global-deadline failures dispatch no child or scored inference', async () => {
    for (const mode of ['probe-failure', 'global-deadline']) {
      const failed = await dispatch(mode, { mode });
      assert.equal(failed.process.status, 1);
      assert.equal(failed.failure.runnerProtocol, SCOPED_KNOWLEDGE_RUNNER_PROTOCOL);
      assert.equal(failed.failure.children.length, 0);
      assert.equal(failed.failure.accounting.logicalRequests.length, 0);
      assert.equal(failed.calls.length, 1);
      assert.equal(failed.calls[0].path, '/v1/models');
      if (mode === 'global-deadline') assert.match(failed.failure.error, /Global deadline/);
    }
  });

  await t.test('child protocol or changed source rejects execution without hiding its fixed failed slot', async () => {
    const protocol = await dispatch('wrong-protocol', { mode: 'wrong-child-protocol' });
    assert.equal(protocol.process.status, 0, protocol.process.stderr);
    const rejected = protocol.report.tasks.find(row => row.arm === 'test-advice');
    assert.equal(rejected.pass, false);
    assert.equal(rejected.report, null);
    const failure = await readJson(join(rejected.process.directory, 'failed.json'));
    assert.match(failure.error, /Invalid child runtime input/);
    assert.equal(protocol.report.accounting.logicalRequests.length, 2);
    assert.equal(protocol.report.accounting.incompleteChildReports, 1);
    const changed = await dispatch('changed-source', { mode: 'changed-source' });
    assert.equal(changed.process.status, 0, changed.process.stderr);
    assert.ok(changed.report.tasks.every(row => !row.pass && !row.report));
    assert.equal(changed.report.accounting.logicalRequests.length, 1);
    for (const task of changed.report.tasks) {
      const failed = await readJson(join(task.process.directory, 'failed.json'));
      assert.match(failed.error, /source files differ/);
    }
  });

  await t.test('death after dispatch retains unknown cost and the unaffected remaining task', async () => {
    const killed = await dispatch('killed-task', { mode: 'killed-task' });
    assert.equal(killed.process.status, 0, killed.process.stderr);
    assert.equal(killed.report.tasks.length, 2);
    const failed = killed.report.tasks.find(row => row.arm === 'no-memory');
    assert.equal(failed.process.code, 23);
    assert.equal(failed.report, null);
    assert.equal(failed.pass, false);
    assert.equal(killed.report.tasks.find(row => row.arm === 'test-advice').pass, true);
    assert.equal(killed.report.accounting.logicalRequests.length, 3);
    assert.equal(killed.report.accounting.transport.length, 4);
    assert.equal(killed.report.accounting.unresolvedAttemptCost, true);
    assert.equal(killed.report.byArm['no-memory'].endToEndUsage.incomplete, true);
  });

  await t.test('context rejection is charged logically and four transport attempts never become a new generation', async () => {
    const rejected = await dispatch('context-rejection', { mode: 'context-rejection' });
    assert.equal(rejected.process.status, 0, rejected.process.stderr);
    assert.equal(rejected.report.accounting.logicalRequests.length, 3);
    assert.equal(rejected.report.accounting.usage.dispatchedRequests, 2);
    assert.equal(rejected.report.accounting.tokenizer.length, 3);
    assert.equal(rejected.report.accounting.transport.length, 3);
    assert.equal(rejected.report.accounting.unresolvedAttemptCost, false);
    const retry = await dispatch('transport-cap', { mode: 'transport-cap' });
    assert.equal(retry.process.status, 0, retry.process.stderr);
    const creation = retry.report.accounting.logicalRequests.filter(row => row.phase === 'memory-acquisition');
    assert.equal(creation.length, 1);
    assert.equal(creation[0].transportAttempts, 4);
    assert.equal(creation[0].status, 'failed');
    assert.equal(retry.report.accounting.transport.filter(row => row.phase === 'memory-acquisition').length, 4);
    assert.equal(retry.report.accounting.unresolvedAttemptCost, true);
    assert.equal(retry.report.byArm['test-advice'].endToEndUsage.incomplete, true);
  });

  await t.test('per-child request caps compose into the unchanged aggregate logical bound', async () => {
    const capped = await dispatch('request-cap', { mode: 'request-cap' });
    assert.equal(capped.process.status, 0, capped.process.stderr);
    assert.equal(capped.report.accounting.logicalRequests.length, 5);
    assert.equal(capped.report.accounting.tokenizer.length, 5);
    assert.ok(capped.report.tasks.every(row => !row.pass && !row.report));
    for (const task of capped.report.tasks) {
      const failure = await readJson(join(task.process.directory, 'failed.json'));
      assert.match(failure.error, /logical request cap/);
      assert.equal(failure.accounting.logicalRequests.length, 2);
    }
  });

  assert.equal(hash(await readFile(historicalPath)), '886fa87d57c7fd48fe7e6b44f1aa5eb22daf910b24b240069614bd20ac51a059',
    'The historical runner must remain byte-for-byte unchanged');
});
