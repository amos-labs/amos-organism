import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeNativeEvidence, pin, put } from './fixtures/continualNativeEvidence.js';
import { replayExportedNativeEvidence } from '../src/continualLearningEvidence.js';
import { buildArtifactReplayDevelopmentDispatch } from '../src/persistentLearningDevelopmentDispatch.js';

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
