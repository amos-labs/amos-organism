import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { makeNativeEvidence, pin, put } from './fixtures/continualNativeEvidence.js';
import { replayExportedNativeEvidence } from '../src/continualLearningEvidence.js';
import { buildArtifactReplayDevelopmentDispatch } from '../src/persistentLearningDevelopmentDispatch.js';
import { createWorkflowAcquisitionWorld } from '../src/continualWorkflowEnvironment.js';
import { createContinualTask, buildContinualDemonstration } from '../src/continualCurriculum.js';

test('exported evidence uses native replay on the existing dispatch journal, with no invented simulator gate', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'continual-evidence-'))); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = await makeNativeEvidence(directory), receipt = replayExportedNativeEvidence(input);
  assert.equal(receipt.comparison.accepted, true); assert.equal(receipt.modelCalls, 0); assert.equal(receipt.trainingStarted, false);
  assert.notEqual(receipt.training.finalAdapterWeightsSha256, receipt.training.checkpointStep128WeightsSha256);
  const events = [], store = { events: () => events.slice(), append: event => { events.push(event); return event; } };
  const observation = { modelId: 'candidate', family: 'native-cpu-test', cohortId: 'one' };
  const first = await buildArtifactReplayDevelopmentDispatch({ store, operatorInput: input }).dispatch('one', observation);
  const second = await buildArtifactReplayDevelopmentDispatch({ store, operatorInput: input }).dispatch('one', observation);
  assert.equal(first.receiptDigest, receipt.receiptDigest); assert.equal(second.reused, true);
  assert.deepEqual(events.map(event => event.payload.state), ['submitted', 'running', 'completed']);
  assert.equal(events.some(event => event.type.includes('simulation')), false);
  const reused = structuredClone(input); reused.evaluations.anchor = reused.evaluations.parent;
  const reuseReceipt = replayExportedNativeEvidence(reused);
  assert.equal(reuseReceipt.evaluationSources.length, 2);
  assert.equal(reuseReceipt.uniqueExportedInferenceTotals.requests, receipt.exportedInferenceAccounting.candidate.requests + receipt.exportedInferenceAccounting.parent.requests);
});

test('missing native/cost/model/export evidence fails before a new dispatch', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'continual-evidence-negative-'))); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = await makeNativeEvidence(directory);
  const cases = [
    ['candidate report claims shell completion only', value => { const ref = value.evaluations.candidate.report; value.evaluations.candidate.report = put(ref.path, { complete: true }); }],
    ['missing usage receipts', value => { const ref = value.evaluations.parent.events; const rows = readFileSync(ref.path, 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.type !== 'inference-completed'); writeFileSync(ref.path, rows.map(row => JSON.stringify(row)).join('\n') + '\n'); value.evaluations.parent.events = pin(ref.path); }],
    ['different cold container after evaluation', value => { const ref = value.evaluations.anchor.servingAfter, proof = JSON.parse(readFileSync(ref.path)); proof.containerId = '0'.repeat(64); value.evaluations.anchor.servingAfter = put(ref.path, proof); }],
    ['changed trained parent', value => { value.checkpoints.parent = { ...value.checkpoints.parent, weightsSha256: '0'.repeat(64) }; }],
    ['changed saved tensor observation', value => { const path = join(value.training.completion.path, '..', 'native-completion.json'); const observed = JSON.parse(readFileSync(path)); observed.savedTensorDigests['adapter/adapter_model.safetensors'] = '0'.repeat(64); put(path, observed); }],
    ['changed adapter bytes', value => { writeFileSync(join(value.training.exportDirectory, 'checkpoint-step-128/adapter_model.safetensors'), 'changed'); }]
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    const fresh = await makeNativeEvidence(join(directory, name.replaceAll(' ', '-'))); mutate(fresh);
    let writes = 0;
    assert.throws(() => buildArtifactReplayDevelopmentDispatch({ store: { events: () => [], append: () => { writes++; } }, operatorInput: fresh }));
    assert.equal(writes, 0);
  });
  assert.equal(replayExportedNativeEvidence(input).comparison.accepted, true);
});

test('an interrupted native receipt append reconciles from the same verified exports without another running dispatch', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'continual-evidence-reconcile-'))); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = await makeNativeEvidence(directory), events = [];
  let interrupted = false;
  const store = { events: () => events.slice(), append: event => {
    if (event.payload.state === 'completed' && !interrupted) { interrupted = true; throw new Error('synthetic interrupted receipt append'); }
    events.push(event); return event;
  } };
  const observation = { modelId: 'candidate', family: 'native-cpu-test', cohortId: 'resume' };
  await assert.rejects(buildArtifactReplayDevelopmentDispatch({ store, operatorInput: input }).dispatch('same-action', observation), /interrupted receipt/);
  const resumed = await buildArtifactReplayDevelopmentDispatch({ store, operatorInput: input }).dispatch('same-action', observation);
  assert.equal(resumed.state, 'completed'); assert.equal(resumed.reused, true);
  assert.deepEqual(events.map(event => event.payload.state), ['submitted', 'running', 'reconciling', 'completed']);
});

test('strict tool compliance and final-answer correctness remain separate without changing the native score', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'continual-evidence-outcomes-'))); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = await makeNativeEvidence(directory, { complianceOnlyFailure: true });
  const receipt = replayExportedNativeEvidence(input);
  assert.equal(receipt.outcomeBreakdown.parent.strictNativePassed, 3);
  assert.equal(receipt.outcomeBreakdown.parent.finalAnswerCorrect, 5);
  assert.equal(receipt.outcomeBreakdown.parent.correctAnswerMissingRequiredTool, 2);
  assert.equal(receipt.outcomeBreakdown.parent.finalAnswerIncorrect, 0);
  assert.equal(receipt.comparison.totalParent, 3);
});

test('a packaged mixed panel runs in fresh CLI processes and enters native evidence replay without injected adapters', { timeout: 120000 }, async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'continual-mixed-cli-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = await makeNativeEvidence(directory);
  const runtime = join(directory, 'runtime'), repository = fileURLToPath(new URL('../../', import.meta.url));
  mkdirSync(join(runtime, 'swarm/src'), { recursive: true }); mkdirSync(join(runtime, 'swarm/scripts')); mkdirSync(join(runtime, 'src'));
  put(join(runtime, 'package.json'), { type: 'module' });
  const sourceFiles = ['swarm/scripts/evaluateContinualPanel.js', 'swarm/src/continualLearningEvaluation.js',
    'swarm/src/continualWorkflowEnvironment.js', 'swarm/src/continualCurriculum.js', 'swarm/src/continualResearchTransport.js',
    'swarm/src/continualLearningEvidence.js', 'swarm/src/experimentProtocol.js', 'src/digest.ts'];
  for (const name of sourceFiles) copyFileSync(join(repository, name), join(runtime, name));
  const workflowTasks = ['fresh', 'partial', 'already-complete'].map((variant, index) => createWorkflowAcquisitionWorld({
    family: 'payment-allocation', variant, observationMode: 'provided', seed: 8100 + index, split: 'mixed-cli-test' }).task);
  const genericTasks = ['general-retention', 'prior-skill-retention', 'composition-transfer'].map((category, index) =>
    createContinualTask({ lineageId: 'signed-ledger', split: 'training', seed: 9100 + index, category }));
  const panel = [...workflowTasks, ...genericTasks]; input.panel = put(join(directory, 'mixed-panel.json'), panel);
  const correctReplies = panel.map((task, index) => {
    if (index < 3) {
      const done = { role: 'assistant', content: 'Done.' }; if (index === 2) return [done];
      // Solver derives explicit arguments entirely from authoritative public receipts.
      const { goal, currentAuthoritativeObservations: observations } = JSON.parse(task.messages[1].content);
      const payment = observations.find(row => row.result.payment).result.payment;
      const invoice = observations.find(row => row.result.invoices).result.invoices.find(row =>
        row.customerId === payment.customerId && row.currency === payment.currency && row.reference === payment.invoiceReference);
      const args = { tenantId: goal.tenantId, paymentId: payment.id, invoiceId: invoice.id,
        amountCents: payment.amountCents - payment.allocations.reduce((sum, row) => sum + row.amountCents, 0),
        expectedPaymentRevision: payment.revision, expectedInvoiceRevision: invoice.revision };
      return [{ role: 'assistant', content: null, tool_calls: [{ id: `call-${index}`, type: 'function', function: { name: 'apply_payment', arguments: JSON.stringify(args) } }] }, done];
    }
    const demo = buildContinualDemonstration(task), call = structuredClone(demo.rows[0].messages.at(-1));
    for (const item of call.tool_calls) if (typeof item.function.arguments !== 'string') item.function.arguments = JSON.stringify(item.function.arguments);
    return [call, demo.rows[1].messages.at(-1)];
  });
  const keyPath = join(directory, 'key.txt'); writeFileSync(keyPath, 'cpu-test-secret\n');
  const pids = [], reports = {};
  for (const role of ['candidate', 'parent', 'anchor']) {
    const identity = input.checkpoints[role], output = join(directory, `mixed-${role}`), configPath = join(directory, `mixed-${role}-config.json`);
    const config = { schema: 'amos.continual-panel-config.v1', panelPath: input.panel.path, panelSha256: input.panel.sha256, output,
      model: identity.modelId, weightsSha256: identity.weightsSha256, apiKeyFile: keyPath, baseUrl: 'http://127.0.0.1:8001', maxMinutes: 1,
      maxModelCalls: panel.length * 4, seed: 14 };
    const configRef = put(configPath, config), replies = structuredClone(correctReplies);
    if (role !== 'candidate') for (const index of [0, 1]) replies[index] = [{ role: 'assistant', content: 'Done.' }];
    const mock = join(directory, `mixed-${role}-fetch.mjs`);
    writeFileSync(mock, `import assert from 'node:assert/strict';
const tasks=${JSON.stringify(panel.map(task => ({ messages: task.messages, tools: task.tools })))};
const replies=${JSON.stringify(replies)}, turns=tasks.map(()=>0);
globalThis.fetch=async(url,init)=>{
 const body=JSON.parse(init.body), parsed=new URL(url);
 assert.equal(parsed.origin,'http://127.0.0.1:8001');assert.equal(init.headers.Authorization,'Bearer cpu-test-secret');
 const index=tasks.findIndex(task=>task.messages.every((message,n)=>JSON.stringify(message)===JSON.stringify(body.messages[n])));
 assert(index>=0);assert.deepEqual(body.tools,tasks[index].tools);assert.equal(Object.hasOwn(body,'worldSpec'),false);assert.equal(Object.hasOwn(body,'spec'),false);
 if(parsed.pathname==='/tokenize')return new Response(JSON.stringify({count:12,max_model_len:8192}));
 assert.equal(parsed.pathname,'/v1/chat/completions');assert.equal(body.model,${JSON.stringify(identity.modelId)});assert.equal(body.seed,14);assert.equal(body.temperature,0);assert.equal(body.max_tokens,1536);
 const message=replies[index][turns[index]++];assert(message);
 return new Response(JSON.stringify({model:body.model,choices:[{message,finish_reason:message.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:12,completion_tokens:3}}));
};\n`);
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--import', mock, join(runtime, 'swarm/scripts/evaluateContinualPanel.js'),
      '--config', configPath, '--config-sha256', configRef.sha256], { cwd: runtime, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr); pids.push(child.pid);
    const reportPath = join(output, 'report.json'), report = JSON.parse(readFileSync(reportPath)); reports[role] = report;
    assert.equal(report.processId, child.pid); assert.equal(report.total, 6);
    assert.equal(report.nativePasses, role === 'candidate' ? 6 : 4);
    assert.equal(report.results[2].toolCalls, 0); assert.equal(report.results[2].verdict.passed, true);
    assert.equal(Object.hasOwn(report.results[3], 'environmentId'), false);
    const before = JSON.parse(readFileSync(input.evaluations[role].servingBefore.path));
    input.evaluations[role] = { report: pin(reportPath), events: pin(join(output, 'events.jsonl')), config: pin(join(output, 'config.json')),
      servingBefore: put(join(output, 'serving-before.json'), { ...before, observedAt: report.startedAt }),
      servingAfter: put(join(output, 'serving-after.json'), { ...before, observedAt: report.completedAt }) };
  }
  assert.equal(new Set(pids).size, 3);
  const inputPath = join(directory, 'mixed-native-input.json'); put(inputPath, input);
  const importer = `import {readFileSync} from 'node:fs';import {replayExportedNativeEvidence} from ${JSON.stringify(pathToFileURL(join(runtime, 'swarm/src/continualLearningEvidence.js')).href)};
const result=replayExportedNativeEvidence(JSON.parse(readFileSync(process.argv[1])));console.log(JSON.stringify({processId:process.pid,result}));`;
  const importOnce = () => spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval', importer, inputPath],
    { cwd: runtime, encoding: 'utf8', timeout: 10000 });
  const child = importOnce(); assert.equal(child.status, 0, child.stderr);
  const imported = JSON.parse(child.stdout), receipt = imported.result;
  assert(!pids.includes(imported.processId)); assert.equal(receipt.comparison.accepted, true); assert.equal(receipt.modelCalls, 0);
  assert.equal(receipt.comparison.categories['already-complete-retention'].candidate, 1);
  assert.equal(receipt.uniqueExportedInferenceTotals.requests, 29);
  assert.equal(receipt.outcomeBreakdown.candidate.finalAnswerCorrect, 3); assert.equal(receipt.outcomeBreakdown.candidate.finalAnswerGraded, 3);
  assert.equal(receipt.outcomeBreakdown.candidate.finalAnswerUngraded, 3); assert.equal(receipt.outcomeBreakdown.parent.businessNativePassed, 1);
  const repeated = importOnce(); assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).result.receiptDigest, receipt.receiptDigest);
  // Re-pinning a forged saved verdict does not bypass independent reconstruction.
  reports.candidate.results[0].verdict.outcomeEvidence.taskStateAchieved = false;
  input.evaluations.candidate.report = put(input.evaluations.candidate.report.path, reports.candidate); put(inputPath, input);
  const forged = importOnce(); assert.notEqual(forged.status, 0); assert.match(forged.stderr, /outcome evidence differs/);
});
