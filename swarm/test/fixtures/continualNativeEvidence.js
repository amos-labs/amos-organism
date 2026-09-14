// Synthetic CPU receipts for integration tests; these are not model-quality observations.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContinualTask, buildContinualDemonstration } from '../../src/continualCurriculum.js';
import { evaluateContinualTask } from '../../src/continualLearningEvaluation.js';
import { createContinualResearchTransport } from '../../src/continualResearchTransport.js';
import { digestResearchValue as digest } from '../../src/experimentProtocol.js';

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const pin = path => ({ path, sha256: hash(readFileSync(path)) });
export function put(path, value) { writeFileSync(path, JSON.stringify(value, null, 2) + '\n'); return pin(path); }
export const ANCHOR = { modelId: 'pilot-060909-r32-s20260909', weightsSha256: '36fd8741c18e1a1478629473c7701584e8e9bc92f890eeedf3effff5d3638528', configSha256: 'edf24b93506b19ea31631fe10020918185b5efca36800084879694e651deb352' };

export async function makeNativeEvidence(directory, { cycle = 1, arm = 'broad', parent = ANCHOR, accepted = true, fullPanel = false, complianceOnlyFailure = false } = {}) {
  mkdirSync(directory, { recursive: true });
  const training = join(directory, 'training'); mkdirSync(training);
  const candidateBytes = Buffer.from(`synthetic-CPU-only-adapter-${arm}-${cycle}`), configBytes = Buffer.from('{}\n');
  const candidate = { modelId: `synthetic-${arm}-candidate-${cycle}`, weightsSha256: hash(candidateBytes), configSha256: hash(configBytes) };
  const body = { id: `synthetic-training-${arm}-${cycle}`, recipe: { seed: 14, initialization: { mode: 'parent', optimizer: 'reset', parent: { adapterWeightsSha256: parent.weightsSha256, adapterConfigSha256: parent.configSha256 } },
    optimization: { epochs: 1, microBatchSize: 1, gradientAccumulationSteps: 8, learningRate: 0.0001 }, adapter: { rank: 32 }, developmentCheckpoints: [32, 64, 128] },
    dataset: { trainingFile: { rows: 1024 } }, execution: { outputUri: `s3://synthetic-test-only/${arm}-${cycle}` } };
  const contract = { ...body, digest: digest(body) }, contractRef = put(join(training, 'training-contract.json'), contract);
  const artifact = path => { const bytes = readFileSync(join(training, path)); return { path, bytes: bytes.length, sha256: hash(bytes) }; };
  const proof = { trainingContractSha256: contract.digest, parentWeightSha256: parent.weightsSha256, parentConfigSha256: parent.configSha256,
    optimizerUpdates: 128, optimizer: 'reset', baseUnchanged: true, savedReloadExact: true,
    expectedParentTensorSha256: '1'.repeat(64), loadedInitialTensorSha256: '1'.repeat(64),
    finalTensorSha256: '2'.repeat(64), reloadedTensorSha256: '2'.repeat(64), childWeightSha256: candidate.weightsSha256 };
  const checkpoints = [];
  for (const step of [32, 64, 128]) {
    const name = `checkpoint-step-${step}`; mkdirSync(join(training, name));
    // Synthetic serialization bytes deliberately differ; the native tensor receipt binds equal endpoint tensors.
    writeFileSync(join(training, name, 'adapter_model.safetensors'), step === 128 ? Buffer.concat([candidateBytes, Buffer.from('-checkpoint-serialization')]) : Buffer.from(`synthetic-${step}`));
    writeFileSync(join(training, name, 'adapter_config.json'), configBytes);
    const files = ['adapter_model.safetensors', 'adapter_config.json'].map(path => ({ ...artifact(`${name}/${path}`), path }));
    checkpoints.push({ epoch: 1, optimizerSteps: step, adapterSha256: files[0].sha256, adapterTensorSha256: step === 128 ? proof.finalTensorSha256 : '3'.repeat(64), files });
  }
  mkdirSync(join(training, 'adapter')); writeFileSync(join(training, 'adapter/adapter_model.safetensors'), candidateBytes); writeFileSync(join(training, 'adapter/adapter_config.json'), configBytes);
  const native = { contractDigest: contract.digest, status: 'parent-adapter-built-awaiting-observed-parent-proof', qualityClaimAllowed: false, promotionAllowed: false, parentInitializationReceipt: proof,
    adapterFiles: ['adapter_model.safetensors', 'adapter_config.json'].map(path => ({ ...artifact(`adapter/${path}`), path })) };
  put(join(training, 'stage0-result.json'), { ...native, digest: digest(native) });
  put(join(training, 'development-checkpoints-manifest.json'), { schema: 'amos.development-checkpoints-manifest.v1', seed: 14, trainingContractSha256: contract.digest, checkpoints });
  const paths = ['training-contract.json', 'stage0-result.json', 'development-checkpoints-manifest.json', 'adapter/adapter_model.safetensors', 'adapter/adapter_config.json',
    ...checkpoints.flatMap(row => row.files.map(file => `checkpoint-step-${row.optimizerSteps}/${file.path}`))];
  const artifacts = paths.map(artifact);
  const trainingCompletion = { schema: 'amos.continual-training-completion.v1', status: 'completed-exported', cycle, arm,
    contractDigest: contract.digest, configSha256: 'a'.repeat(64), trainerSha256: 'b'.repeat(64), runtimeManifestSha256: 'c'.repeat(64),
    promotionAllowed: false, trainingRerun: false, artifacts, exports: artifacts.map(row => ({ ...row, verified: true, s3Uri: `${body.execution.outputUri}/${row.path}` })),
    parentProof: proof, checkpoints: checkpoints.map(row => ({ ...row, path: `/synthetic/checkpoint-step-${row.optimizerSteps}` })) };
  const nativeCompletion = put(join(directory, 'native-completion.json'), { configSha256: trainingCompletion.configSha256, artifacts,
    parentProof: proof, checkpoints: trainingCompletion.checkpoints,
    savedTensorDigests: Object.fromEntries([...checkpoints.map(row => [`checkpoint-step-${row.optimizerSteps}/adapter_model.safetensors`, row.adapterTensorSha256]), ['adapter/adapter_model.safetensors', proof.finalTensorSha256]]) });
  trainingCompletion.controllerExports = [{ path: 'native-completion.json', sha256: nativeCompletion.sha256,
    bytes: readFileSync(nativeCompletion.path).length, verified: true, s3Uri: `${body.execution.outputUri}/controller/native-completion.json` }];
  const counts = fullPanel ? [16, 48, 16, 16] : [2, 1, 1, 1], categories = ['acquisition', 'general-retention', 'prior-skill-retention', 'composition-transfer'];
  const panel = counts.flatMap((count, index) => Array.from({ length: count }, (_, n) => createContinualTask({ lineageId: 'signed-ledger', split: 'training', seed: cycle * 10000 + index * 100 + n, category: categories[index] })));
  const panelRef = put(join(directory, 'panel.json'), panel), evaluations = {};
  for (const [role, identity] of Object.entries({ candidate, parent, anchor: ANCHOR })) {
    const output = join(directory, role); mkdirSync(output);
    const config = { schema: 'amos.continual-panel-config.v1', panelPath: panelRef.path, panelSha256: panelRef.sha256, output,
      model: identity.modelId, weightsSha256: identity.weightsSha256, apiKeyFile: '/synthetic/not-read', baseUrl: 'http://127.0.0.1:8001', maxMinutes: 1, maxModelCalls: panel.length * 4, seed: 14 };
    const configRef = put(join(output, 'config.json'), config), events = [], started = new Date(Date.now() - 1000).toISOString();
    const onEvent = async event => events.push({ recordedAt: new Date().toISOString(), ...event });
    let messages;
    const transport = createContinualResearchTransport({ baseUrl: config.baseUrl, model: identity.modelId, apiKey: 'synthetic-not-used', maxRequests: config.maxModelCalls, maxMilliseconds: 60000, onEvent,
      fetchImpl: async url => {
        if (url.pathname === '/tokenize') return new Response(JSON.stringify({ count: 12, max_model_len: 8192 }));
        const message = messages.shift();
        return new Response(JSON.stringify({ model: identity.modelId, choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3 } }));
      } });
    await onEvent({ type: 'panel-start', processId: process.pid, startedAt: started, configSha256: configRef.sha256, model: identity.modelId, weightsSha256: identity.weightsSha256, panelSha256: panelRef.sha256 });
    const results = [];
    for (const [index, task] of panel.entries()) {
      const demo = buildContinualDemonstration(task), call = structuredClone(demo.rows[0].messages.at(-1));
      for (const item of call.tool_calls) if (typeof item.function.arguments !== 'string') item.function.arguments = JSON.stringify(item.function.arguments);
      messages = index < 2 && (role !== 'candidate' || !accepted)
        ? [complianceOnlyFailure ? demo.rows[1].messages.at(-1) : { role: 'assistant', content: 'synthetic incorrect answer' }]
        : [call, demo.rows[1].messages.at(-1)];
      results.push(await evaluateContinualTask({ task, request: transport.request, onEvent, seed: 14 }));
    }
    const report = { schema: 'amos.continual-panel-result.v1', complete: true, processId: process.pid, startedAt: started,
      completedAt: new Date().toISOString(), configSha256: configRef.sha256, model: identity.modelId, weightsSha256: identity.weightsSha256,
      panelSha256: panelRef.sha256, nativePasses: results.filter(row => row.verdict.passed).length, total: panel.length, accounting: transport.accounting(), results };
    const proof = { schema: 'amos.continual-serving-proof.v1', instanceId: 'i-0d4ab3ea27f5443ad', containerId: hash(identity.modelId),
      imageId: 'sha256:c2f3b1b964e47809b722b5e75b61b1e7b39a50f70388cf2bf2418f16a9f31da2', containerStartedAt: '2026-09-01T00:00:00.000Z',
      model: identity.modelId, weightsSha256: identity.weightsSha256, configSha256: identity.configSha256, adapterPath: '/synthetic/read-only', adapterReadOnlyMounted: true,
      modelListed: true, activeInference: ['vllm:num_requests_running{model="synthetic"} 0', 'vllm:num_requests_waiting{model="synthetic"} 0'] };
    writeFileSync(join(output, 'events.jsonl'), events.map(row => JSON.stringify(row)).join('\n') + '\n');
    evaluations[role] = { report: put(join(output, 'report.json'), report), events: pin(join(output, 'events.jsonl')), config: configRef,
      servingBefore: put(join(output, 'serving-before.json'), { ...proof, observedAt: started }),
      servingAfter: put(join(output, 'serving-after.json'), { ...proof, observedAt: report.completedAt }) };
  }
  return { schema: 'amos.exported-native-evidence.v1', cycleId: `continual-${arm}-cycle-${cycle}`, cycle, arm,
    checkpoints: { candidate, parent, anchor: ANCHOR }, training: { completion: put(join(directory, 'training-completed.json'), trainingCompletion), contract: contractRef, exportDirectory: training }, panel: panelRef, evaluations };
}
