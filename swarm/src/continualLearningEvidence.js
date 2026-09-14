import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { compareContinualPanels, replayContinualTask } from './continualLearningEvaluation.js';
import { digestResearchValue as digest } from './experimentProtocol.js';

export const NATIVE_EVIDENCE_SCHEMA = 'amos.exported-native-evidence.v1';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const requireThat = (value, message) => { if (!value) throw new Error(message); };
const same = (actual, expected, message) => requireThat(digest(actual) === digest(expected), message);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function keys(value, expected, label) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  same(Object.keys(value).sort(), [...expected].sort(), `${label} fields differ`);
}
function regular(path) {
  requireThat(typeof path === 'string' && isAbsolute(path) && resolve(path) === path, 'Canonical absolute evidence path required');
  for (let current = path; ; current = dirname(current)) {
    requireThat(!lstatSync(current).isSymbolicLink(), 'Evidence symlinks are forbidden');
    if (dirname(current) === current) break;
  }
  const stat = lstatSync(path); requireThat(stat.isFile(), 'Evidence must be a regular file'); return stat;
}
export function readPinnedEvidence(ref, maximum = 64 * 1024 * 1024) {
  keys(ref, ['path', 'sha256'], 'Evidence reference');
  requireThat(sha(ref.sha256) && regular(ref.path).size <= maximum, 'Evidence hash or byte limit invalid');
  const bytes = readFileSync(ref.path);
  requireThat(bytes.length <= maximum && hash(bytes) === ref.sha256, 'Pinned evidence bytes changed');
  return bytes;
}
const json = ref => JSON.parse(readPinnedEvidence(ref));
function checkpoint(value) {
  keys(value, ['modelId', 'weightsSha256', 'configSha256'], 'Checkpoint');
  requireThat(typeof value.modelId === 'string' && value.modelId.length > 0 && sha(value.weightsSha256) && sha(value.configSha256), 'Invalid checkpoint identity');
}
function fileReceipt(root, row) {
  requireThat(typeof row.path === 'string' && !isAbsolute(row.path) && row.path.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe export artifact path');
  requireThat(Number.isSafeInteger(row.bytes) && row.bytes >= 0 && row.bytes <= 5 * 1024 ** 3 && sha(row.sha256), 'Invalid export artifact');
  const path = join(root, row.path);
  requireThat(path.startsWith(root + sep) && regular(path).size === row.bytes, 'Exported artifact size differs');
  const fd = openSync(path, 'r'), h = createHash('sha256'), buffer = Buffer.alloc(8 * 1024 * 1024);
  try { for (let n; (n = readSync(fd, buffer, 0, buffer.length, null)) > 0;) h.update(buffer.subarray(0, n)); }
  finally { closeSync(fd); }
  requireThat(h.digest('hex') === row.sha256, 'Exported artifact hash differs');
}

function verifyTraining(input) {
  const { training, checkpoints } = input;
  keys(training, ['completion', 'contract', 'exportDirectory'], 'Training evidence');
  requireThat(typeof training.exportDirectory === 'string' && isAbsolute(training.exportDirectory) && resolve(training.exportDirectory) === training.exportDirectory, 'Canonical export directory required');
  const completed = json(training.completion), contract = json(training.contract);
  requireThat(completed.schema === 'amos.continual-training-completion.v1' && completed.status === 'completed-exported' &&
    completed.cycle === input.cycle && completed.arm === input.arm && completed.promotionAllowed === false && completed.trainingRerun === false &&
    sha(completed.configSha256) && sha(completed.trainerSha256) && sha(completed.runtimeManifestSha256), 'Incomplete or mismatched training completion');
  const { digest: contractDigest, ...contractBody } = contract;
  requireThat(sha(contractDigest) && digest(contractBody) === contractDigest && completed.contractDigest === contractDigest, 'Training contract digest differs');
  const parent = contract.recipe?.initialization?.parent, proof = completed.parentProof;
  requireThat(contract.recipe?.initialization?.mode === 'parent' && parent?.adapterWeightsSha256 === checkpoints.parent.weightsSha256 &&
    parent.adapterConfigSha256 === checkpoints.parent.configSha256, 'Training contract parent differs');
  const optimization = contract.recipe.optimization;
  requireThat(optimization?.epochs === 1 && optimization.microBatchSize === 1 && optimization.gradientAccumulationSteps === 8 &&
    optimization.learningRate === 0.0001 && contract.dataset?.trainingFile?.rows === 1024 && contract.recipe.adapter?.rank === 32,
  'Training dose differs from the study');
  same(contract.recipe.developmentCheckpoints, [32, 64, 128], 'Training checkpoint recipe differs');
  requireThat(proof?.trainingContractSha256 === contractDigest && proof.parentWeightSha256 === checkpoints.parent.weightsSha256 &&
    proof.parentConfigSha256 === checkpoints.parent.configSha256 && proof.optimizerUpdates === 128 && proof.optimizer === 'reset' &&
    proof.baseUnchanged === true && proof.savedReloadExact === true && sha(proof.expectedParentTensorSha256) &&
    proof.expectedParentTensorSha256 === proof.loadedInitialTensorSha256 && sha(proof.finalTensorSha256) &&
    proof.finalTensorSha256 === proof.reloadedTensorSha256 && proof.finalTensorSha256 !== proof.loadedInitialTensorSha256, 'Training parent/tensor update proof incomplete');
  const checkpointsList = completed.checkpoints;
  requireThat(Array.isArray(checkpointsList) && checkpointsList.length === 3, 'Training checkpoints incomplete');
  same(checkpointsList.map(row => row.optimizerSteps), [32, 64, 128], 'Training checkpoint dose differs');
  const endpoint = checkpointsList[2];
  requireThat(proof.childWeightSha256 === checkpoints.candidate.weightsSha256 && endpoint.adapterTensorSha256 === proof.finalTensorSha256,
    'Candidate is not the verified final 128-update adapter');
  const artifacts = completed.artifacts;
  requireThat(Array.isArray(artifacts) && artifacts.length > 0 && artifacts.length <= 64 && new Set(artifacts.map(row => row.path)).size === artifacts.length, 'Export catalog incomplete or duplicate');
  requireThat(artifacts.reduce((sum, row) => sum + row.bytes, 0) <= 5 * 1024 ** 3, 'Training evidence exceeds the bounded four-adapter export size');
  requireThat(Array.isArray(completed.exports) && completed.exports.length === artifacts.length, 'Export receipts incomplete');
  for (const row of artifacts) {
    fileReceipt(training.exportDirectory, row);
    const exported = completed.exports.filter(item => item.path === row.path);
    requireThat(exported.length === 1 && exported[0].verified === true && exported[0].sha256 === row.sha256 && exported[0].bytes === row.bytes &&
      exported[0].s3Uri === contract.execution.outputUri.replace(/\/$/, '') + '/' + row.path, 'Artifact export receipt differs');
  }
  for (const [path, expected] of [['checkpoint-step-128/adapter_model.safetensors', endpoint.adapterSha256],
    ['adapter/adapter_config.json', checkpoints.candidate.configSha256], ['adapter/adapter_model.safetensors', proof.childWeightSha256],
    ['training-contract.json', training.contract.sha256]]) requireThat(artifacts.find(row => row.path === path)?.sha256 === expected, 'Required exported training artifact differs');
  const document = path => {
    const row = artifacts.find(item => item.path === path); requireThat(row, 'Required training document missing');
    return json({ path: join(training.exportDirectory, path), sha256: row.sha256 });
  };
  const native = document('stage0-result.json'), { digest: nativeDigest, ...nativeBody } = native;
  requireThat(nativeDigest === digest(nativeBody) && native.contractDigest === contractDigest &&
    native.status === 'parent-adapter-built-awaiting-observed-parent-proof' && native.qualityClaimAllowed === false && native.promotionAllowed === false,
  'Native training result differs');
  same(native.parentInitializationReceipt, proof, 'Completion parent proof differs from native artifact');
  for (const [path, expected] of [['adapter_model.safetensors', checkpoints.candidate.weightsSha256], ['adapter_config.json', checkpoints.candidate.configSha256]]) {
    const rows = native.adapterFiles?.filter(row => row.path === path);
    requireThat(rows?.length === 1 && rows[0].sha256 === expected, 'Native final adapter identity differs');
  }
  const checkpointManifest = document('development-checkpoints-manifest.json');
  requireThat(checkpointManifest.schema === 'amos.development-checkpoints-manifest.v1' && checkpointManifest.trainingContractSha256 === contractDigest &&
    checkpointManifest.seed === contract.recipe.seed && checkpointManifest.checkpoints?.length === 3, 'Native checkpoint manifest differs');
  for (const [index, saved] of checkpointsList.entries()) {
    const { path: _hostPath, ...entry } = saved;
    same(checkpointManifest.checkpoints[index], entry, 'Completion checkpoint differs from native manifest');
    for (const item of entry.files) {
      const row = artifacts.find(file => file.path === `checkpoint-step-${entry.optimizerSteps}/${item.path}`);
      requireThat(row?.sha256 === item.sha256 && row?.bytes === item.bytes, 'Checkpoint file catalog differs');
    }
  }
  const observations = completed.controllerExports?.filter(row => row.path === 'native-completion.json');
  requireThat(observations?.length === 1 && observations[0].verified === true && sha(observations[0].sha256) &&
    observations[0].s3Uri === contract.execution.outputUri.replace(/\/$/, '') + '/controller/native-completion.json', 'Independent saved-tensor observation export missing');
  const nativeCompletionPath = join(dirname(training.completion.path), 'native-completion.json');
  requireThat(regular(nativeCompletionPath).size === observations[0].bytes, 'Independent tensor observation byte count differs');
  const observed = json({ path: nativeCompletionPath, sha256: observations[0].sha256 });
  requireThat(observed.configSha256 === completed.configSha256, 'Independent tensor observation config differs');
  same(observed.artifacts, artifacts, 'Independent tensor observation artifact catalog differs');
  same(observed.parentProof, proof, 'Independent tensor observation parent proof differs');
  same(observed.checkpoints, checkpointsList, 'Independent tensor observation checkpoints differ');
  same(observed.savedTensorDigests, Object.fromEntries([
    ...checkpointsList.map(row => [`checkpoint-step-${row.optimizerSteps}/adapter_model.safetensors`, row.adapterTensorSha256]),
    ['adapter/adapter_model.safetensors', proof.finalTensorSha256]
  ]), 'Independently observed saved tensors differ');
  return { completionSha256: training.completion.sha256, contractDigest, candidateStep: 128, parentProof: proof,
    nativeCompletionSha256: observations[0].sha256,
    finalAdapterWeightsSha256: checkpoints.candidate.weightsSha256, checkpointStep128WeightsSha256: endpoint.adapterSha256,
    savedEndpointTensorSha256: endpoint.adapterTensorSha256,
    artifactCount: artifacts.length, trainingExecutedExternally: true, replayExecutedTraining: false };
}

function verifyPanel(role, input, panel) {
  const refs = input.evaluations[role], identity = input.checkpoints[role];
  keys(refs, ['report', 'events', 'config', 'servingBefore', 'servingAfter'], `${role} evaluation`);
  const report = json(refs.report), config = json(refs.config);
  requireThat(report.schema === 'amos.continual-panel-result.v1' && report.complete === true && report.model === identity.modelId &&
    report.weightsSha256 === identity.weightsSha256 && report.panelSha256 === input.panel.sha256 && report.configSha256 === refs.config.sha256 &&
    report.total === panel.length && Array.isArray(report.results) && report.results.length === panel.length, `${role} panel incomplete or identity differs`);
  requireThat(config.schema === 'amos.continual-panel-config.v1' && config.model === identity.modelId && config.weightsSha256 === identity.weightsSha256 &&
    config.panelSha256 === input.panel.sha256 && config.maxModelCalls === panel.length * 4 && Number.isSafeInteger(config.seed) &&
    Number.isSafeInteger(config.maxMinutes) && config.maxMinutes >= 1 && config.maxMinutes <= 600, `${role} evaluation configuration differs`);
  const started = Date.parse(report.startedAt), finished = Date.parse(report.completedAt);
  requireThat(Number.isFinite(started) && Number.isFinite(finished) && finished >= started && finished - started < config.maxMinutes * 60000, 'Evaluation timing exceeds bound');
  const before = json(refs.servingBefore), after = json(refs.servingAfter);
  for (const proof of [before, after]) {
    requireThat(proof.schema === 'amos.continual-serving-proof.v1' && proof.instanceId === 'i-0d4ab3ea27f5443ad' && sha(proof.containerId) &&
      proof.imageId === 'sha256:c2f3b1b964e47809b722b5e75b61b1e7b39a50f70388cf2bf2418f16a9f31da2' &&
      proof.model === identity.modelId && proof.weightsSha256 === identity.weightsSha256 && proof.configSha256 === identity.configSha256 &&
      proof.adapterReadOnlyMounted === true && proof.modelListed === true && typeof proof.adapterPath === 'string' && isAbsolute(proof.adapterPath), 'Cold serving identity proof differs');
    requireThat(Array.isArray(proof.activeInference) && proof.activeInference.every(line =>
      typeof line === 'string' && /^vllm:num_requests_(running|waiting|swapped)(?:\{[^\n]*\})?\s+0(?:\.0+)?$/.test(line)) &&
      ['running', 'waiting'].every(kind => proof.activeInference.some(line => line.startsWith(`vllm:num_requests_${kind}`))), 'Serving proof is not idle');
    requireThat(Date.parse(proof.containerStartedAt) <= Date.parse(proof.observedAt), 'Cold serving start proof invalid');
  }
  same([before.containerId, before.containerStartedAt, before.adapterPath], [after.containerId, after.containerStartedAt, after.adapterPath], 'Serving container changed across evaluation');
  requireThat(Date.parse(before.observedAt) <= started && Date.parse(after.observedAt) >= finished, 'Serving observations do not bracket evaluation');
  const events = readPinnedEvidence(refs.events, 256 * 1024 * 1024).toString('utf8').trim().split('\n').map(line => JSON.parse(line));
  requireThat(events.every(event => Date.parse(event.recordedAt) >= started && Date.parse(event.recordedAt) <= finished && !['inference-failed', 'request-failed', 'tokenizer-failed'].includes(event.type)), 'Failed or out-of-window evaluation evidence');
  const unique = type => {
    const list = events.filter(event => event.type === type), map = new Map(list.map(event => [event.requestId, event]));
    requireThat(map.size === list.length, `Duplicate ${type} receipt`); return map;
  };
  const logical = unique('logical-request-start'), tokens = unique('tokenizer-passed'), tokenStarts = unique('tokenizer-start');
  const dispatched = unique('inference-start'), responses = unique('inference-completed');
  let calls = 0, promptTokens = 0, outputTokens = 0;
  const modelEvents = events.filter(event => event.type === 'model-response');
  for (const [index, task] of panel.entries()) {
    const result = report.results[index];
    replayContinualTask(task, result);
    let messages = structuredClone(task.messages);
    for (const [turnIndex, turn] of result.trace.entries()) {
      const id = `${task.id}:${++calls}`, start = dispatched.get(id), done = responses.get(id), token = tokens.get(id), tokenStart = tokenStarts.get(id);
      requireThat(logical.get(id)?.taskId === task.id && start && done && token && tokenStart, 'Missing inference/tokenizer lifecycle receipt');
      const expected = { model: identity.modelId, messages, ...(task.tools.length ? { tools: task.tools, parallel_tool_calls: false } : {}), stream: false,
        temperature: 0, seed: config.seed, max_tokens: 1536, enable_thinking: false, chat_template_kwargs: { enable_thinking: false } };
      same(start.body, expected, 'Actual model prompt/settings differ from native task history');
      requireThat(start.requestSha256 === hash(JSON.stringify(start.body)), 'Inference wire hash differs');
      const tokenBody = { model: identity.modelId, messages, ...(task.tools.length ? { tools: task.tools } : {}), add_generation_prompt: true, chat_template_kwargs: { enable_thinking: false } };
      requireThat(tokenStart.requestSha256 === hash(JSON.stringify(tokenBody)) && token.requestSha256 === tokenStart.requestSha256 &&
        Number.isSafeInteger(token.count) && token.count >= 0 && Number.isSafeInteger(token.maximum) && token.count + 1536 <= Math.min(8192, token.maximum), 'Tokenizer evidence differs');
      const response = done.result, raw = done.providerRawText;
      requireThat(done.responseStatus === 200 && response && done.promptCountDelta === 0, 'Inference completion invalid');
      const payload = response.providerResponse;
      if (raw !== null) same(JSON.parse(raw), payload, 'Raw provider response differs');
      requireThat(done.providerResponseSha256 === hash(raw ?? JSON.stringify(payload)), 'Provider response hash differs');
      requireThat(payload.model === undefined || payload.model === identity.modelId, 'Provider model identity differs');
      requireThat(Array.isArray(payload.choices) && payload.choices.length === 1 && response.promptTokens === token.count &&
        response.promptTokens === payload.usage?.prompt_tokens && response.outputTokens === payload.usage?.completion_tokens &&
        Number.isSafeInteger(response.outputTokens) && response.outputTokens >= 0 && response.outputTokens <= 1536, 'Provider usage differs');
      same(response.message, payload.choices[0].message, 'Normalized provider message differs');
      requireThat(response.finishReason === payload.choices[0].finish_reason && ['stop', 'tool_calls', 'length'].includes(response.finishReason), 'Provider finish reason differs');
      same(turn.message, response.message, 'Native trace differs from provider output');
      requireThat(turn.finishReason === response.finishReason, 'Native trace finish reason differs');
      const observed = modelEvents[calls - 1];
      requireThat(observed?.taskId === task.id && observed.call === turnIndex + 1, 'Model response attribution differs');
      same(observed.observation, response, 'Model event response differs');
      promptTokens += response.promptTokens; outputTokens += response.outputTokens;
      if (turn.tools.length) {
        messages.push({ role: 'assistant', content: turn.message.content ?? null, tool_calls: turn.message.tool_calls });
        for (const tool of turn.tools) messages.push({ role: 'tool', tool_call_id: tool.id, content: JSON.stringify(tool.result) });
      }
    }
  }
  for (const map of [logical, tokens, tokenStarts, dispatched, responses]) requireThat(map.size === calls, 'Extra/missing inference lifecycle rows');
  requireThat(modelEvents.length === calls, 'Extra/missing model response rows');
  const completed = events.filter(event => event.type === 'task-completed');
  same(completed.map(event => event.result), report.results, 'Completed task journal differs');
  const panelStart = events.filter(event => event.type === 'panel-start');
  requireThat(panelStart.length === 1 && panelStart[0].configSha256 === refs.config.sha256 && panelStart[0].processId === report.processId &&
    Number.isSafeInteger(report.processId) && report.processId > 0, 'Panel process/config binding differs');
  const accounting = report.accounting;
  for (const [key, value] of Object.entries({ requests: calls, logicalRequests: calls, tokenizerRequests: calls, promptTokens, outputTokens,
    unknownUsageRequests: 0, failedRequests: 0, integrityFailures: 0, stopped: false })) requireThat(accounting?.[key] === value, `Panel ${key} accounting differs`);
  requireThat(Number.isFinite(accounting.elapsedMilliseconds) && accounting.elapsedMilliseconds >= 0 && accounting.elapsedMilliseconds < config.maxMinutes * 60000, 'Panel duration differs');
  requireThat(report.nativePasses === report.results.filter(result => result.verdict.passed).length, 'Panel score differs');
  return { report, config, accounting };
}

/** CPU-only evidence verification. It never trains, loads weights, calls a model, or changes serving. */
export function replayExportedNativeEvidence(input) {
  keys(input, ['schema', 'cycleId', 'cycle', 'arm', 'checkpoints', 'training', 'panel', 'evaluations'], 'Native evidence input');
  requireThat(input.schema === NATIVE_EVIDENCE_SCHEMA && Number.isInteger(input.cycle) && input.cycle >= 1 && input.cycle <= 3 &&
    ['broad', 'narrow'].includes(input.arm) && typeof input.cycleId === 'string' && input.cycleId.length > 0, 'Invalid study cycle');
  keys(input.checkpoints, ['candidate', 'parent', 'anchor'], 'Checkpoint identities');
  keys(input.evaluations, ['candidate', 'parent', 'anchor'], 'Evaluations');
  Object.values(input.checkpoints).forEach(checkpoint);
  const training = verifyTraining(input), panel = json(input.panel);
  requireThat(Array.isArray(panel) && panel.length > 0 && panel.length <= 512, 'Panel must be bounded');
  const panels = Object.fromEntries(['candidate', 'parent', 'anchor'].map(role => [role, verifyPanel(role, input, panel)]));
  same(panels.candidate.config.seed, panels.parent.config.seed, 'Paired seeds differ');
  same(panels.candidate.config.seed, panels.anchor.config.seed, 'Anchor seed differs');
  same(panels.candidate.config.maxMinutes, panels.parent.config.maxMinutes, 'Paired time budgets differ');
  same(panels.candidate.config.maxMinutes, panels.anchor.config.maxMinutes, 'Anchor time budget differs');
  const comparison = compareContinualPanels({ panel, candidate: panels.candidate.report.results, parent: panels.parent.report.results, anchor: panels.anchor.report.results });
  const sources = new Map();
  for (const [role, value] of Object.entries(panels)) {
    const refs = input.evaluations[role], key = refs.report.sha256;
    const found = sources.get(key);
    if (found) {
      same([found.eventsSha256, found.configSha256], [refs.events.sha256, refs.config.sha256], 'Reused evaluation has different evidence');
      found.roles.push(role);
    } else sources.set(key, { roles: [role], reportSha256: key, eventsSha256: refs.events.sha256, configSha256: refs.config.sha256, accounting: value.accounting });
  }
  const evaluationSources = [...sources.values()];
  const uniqueExportedInferenceTotals = Object.fromEntries(['requests', 'logicalRequests', 'tokenizerRequests', 'promptTokens', 'outputTokens'].map(key =>
    [key, evaluationSources.reduce((sum, value) => sum + value.accounting[key], 0)]));
  const outcomeBreakdown = Object.fromEntries(Object.entries(panels).map(([role, value]) => {
    const rows = value.report.results;
    const business = rows.filter(row => row.environmentId === 'workflow-acquisition-v2');
    const answerGraded = rows.filter(row => row.environmentId !== 'workflow-acquisition-v2');
    return [role, {
      total: rows.length,
      strictNativePassed: rows.filter(row => row.verdict.passed).length,
      finalAnswerCorrect: answerGraded.filter(row => row.verdict.finalAnswerCorrect).length,
      nativeToolRequirementMet: answerGraded.filter(row => row.verdict.nativeToolRequirementMet).length,
      correctAnswerMissingRequiredTool: answerGraded.filter(row => row.verdict.finalAnswerCorrect && !row.verdict.nativeToolRequirementMet).length,
      finalAnswerIncorrect: answerGraded.filter(row => !row.verdict.finalAnswerCorrect).length,
      ...(business.length ? {
        finalAnswerGraded: answerGraded.length, finalAnswerUngraded: business.length,
        businessTasks: business.length, businessNativePassed: business.filter(row => row.verdict.passed).length,
        businessOutcomeEvidencePresent: business.filter(row => typeof row.verdict.outcomeEvidence?.passed === 'boolean').length,
        businessStatePassedInVerdict: business.filter(row => row.verdict.outcomeEvidence?.passed === true).length,
        interpretation: 'Workflow final prose has no rubric and its compatibility booleans are excluded from answer/tool-requirement counts. Terminal failures can omit business outcome evidence; native pass is not a complete state census.'
      } : {})
    }];
  }));
  const receipt = { schema: 'amos.continual-native-evidence-replay.v1', cycleId: input.cycleId, cycle: input.cycle, arm: input.arm,
    inputSha256: digest(input), panelSha256: input.panel.sha256, checkpoints: input.checkpoints, training, comparison,
    exportedInferenceAccounting: Object.fromEntries(Object.entries(panels).map(([role, value]) => [role, value.accounting])),
    evaluationSources, uniqueExportedInferenceTotals, outcomeBreakdown,
    status: 'passed', modelCalls: 0, trainingStarted: false, servingChanged: false,
    interpretation: 'This CPU receipt verifies exported external training and inference evidence. Its completion alone is not an accepted research child.' };
  return { ...receipt, receiptDigest: digest(receipt) };
}
