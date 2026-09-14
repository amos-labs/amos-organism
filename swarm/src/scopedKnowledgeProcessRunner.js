import { mkdir, readFile, writeFile, appendFile, copyFile, realpath } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { OpenAiResearchWorker } from './openAiResearchWorker.js';
import { loadReplayMemory, saveReplayMemory } from './persistentReplayMemory.js';

const MAX_ATTEMPTS = 4, CONTEXT = 8192;
const MAX_MINUTES = 100;
const ACQUISITION_WATCHDOG_OVERHEAD_MS = 20_000, TASK_WATCHDOG_OVERHEAD_MS = 10_000, KILL_GRACE_MS = 2_000;
export const SCOPED_KNOWLEDGE_RUNNER_PROTOCOL = 'amos.scoped-knowledge-process-runner.v1';

/** Conservative serialized timer envelope; local I/O and wrapper export remain outside this sum. */
export function describeScopedKnowledgeDeadlineBudget({ acquisitionCount, taskCount, taskTimeoutMs, maxMinutes = MAX_MINUTES }) {
  if (![acquisitionCount, taskCount, taskTimeoutMs, maxMinutes].every(value => Number.isSafeInteger(value) && value > 0) ||
      acquisitionCount > 32 || taskCount > 128 || maxMinutes > MAX_MINUTES || taskTimeoutMs > 120_000) throw new Error('Invalid scoped-knowledge deadline budget');
  const nominalRequestDeadlineMilliseconds = (acquisitionCount + taskCount) * taskTimeoutMs;
  const maximumProbeMilliseconds = taskTimeoutMs;
  const acquisitionWatchdogOverheadMilliseconds = ACQUISITION_WATCHDOG_OVERHEAD_MS;
  const evaluationWatchdogOverheadMilliseconds = taskCount * TASK_WATCHDOG_OVERHEAD_MS;
  const maximumForcedTerminationGraceMilliseconds = (taskCount + 1) * KILL_GRACE_MS;
  const knownSerializedEnvelopeMilliseconds = nominalRequestDeadlineMilliseconds + maximumProbeMilliseconds +
    acquisitionWatchdogOverheadMilliseconds + evaluationWatchdogOverheadMilliseconds + maximumForcedTerminationGraceMilliseconds;
  const globalDeadlineMilliseconds = maxMinutes * 60_000;
  return { maxMinutes, globalDeadlineMilliseconds, nominalRequestDeadlineMilliseconds, maximumProbeMilliseconds,
    acquisitionWatchdogOverheadMilliseconds, evaluationWatchdogOverheadMilliseconds, maximumForcedTerminationGraceMilliseconds,
    knownSerializedEnvelopeMilliseconds, marginBeforeUnbudgetedWorkMilliseconds: globalDeadlineMilliseconds - knownSerializedEnvelopeMilliseconds,
    knownEnvelopeFits: globalDeadlineMilliseconds >= knownSerializedEnvelopeMilliseconds, fullCoverageGuaranteed: false,
    globalDeadlineTakesPrecedence: true,
    limitation: 'Timer envelope excludes local preparation, filesystem/report work and outer-wrapper export; the global deadline may leave incomplete coverage. No automatic resume.' };
}
const hash = value => createHash('sha256').update(value).digest('hex');
const encoded = value => JSON.stringify(value, null, 2) + '\n';
const message = error => String(error?.message ?? error);
const artifact = (directory, name, value) => writeFile(resolve(directory, name), encoded(value), { flag: 'wx', mode: 0o600 });
const append = (directory, name, value) => appendFile(resolve(directory, name), JSON.stringify(value) + '\n', { mode: 0o600 });
const json = async path => JSON.parse(await readFile(path, 'utf8'));
/** Versioned scoped-knowledge runner; historical memoryProcessExperimentRunner.js remains frozen.
 * Shared process isolation, immutable artifacts and bounded research transport.
 * The statically imported adapter owns task semantics; it never receives file credentials. */
export async function runScopedKnowledgeProcessExperimentCli({ entryUrl, adapter, argv = process.argv.slice(2) }) {
const SCRIPT = fileURLToPath(entryUrl);
const options = {};
const allowed = new Set(['output', 'model', 'weights-sha256', 'api-key-file', 'manifest-digest', 'base-url', 'max-minutes', 'child-mode', 'input']);
for (let i = 0; i < argv.length; i += 2) {
  const key = argv[i]?.replace(/^--/, '');
  if (!argv[i]?.startsWith('--') || !allowed.has(key) || !argv[i + 1] || Object.hasOwn(options, key)) throw new Error('Invalid or repeated CLI argument');
  options[key] = argv[i + 1];
}
if (options['child-mode']) {
  if (!['acquire', 'evaluate'].includes(options['child-mode']) || !options.input || Object.keys(options).length !== 2) throw new Error('Invalid child invocation');
  await runChild(options['child-mode'], resolve(options.input));
} else {
  if (options.input) throw new Error('--input is reserved for child invocation');
  await runParent();
}

function createClient(config, directory, signal, plan) {
  const logicalRequests = [], transport = [], tokenizer = [];
  const context = new AsyncLocalStorage();
  const workers = new Map();
  const appendHere = (name, value) => append(directory, name, value);
  let apiKey;
  async function loggedFetch(url, init) {
    const request = context.getStore();
    if (!request || request.transportAttempts >= MAX_ATTEMPTS) throw new Error('Transport context missing or attempt cap exhausted');
    const body = init.body ? JSON.parse(init.body) : null;
    if (request.phase !== 'probe' && (body.seed !== request.modelSeed || body.temperature !== request.temperature ||
        body.max_tokens !== request.maxOutputTokens || Object.hasOwn(body, 'response_format'))) {
      throw new Error('Actual inference settings differ from the assigned protocol');
    }
    const entry = { ordinal: transport.length + 1, logicalRequestId: request.id, phase: request.phase, caseId: request.caseId,
      arm: request.costOwnerArm ?? config.arm ?? null, caseIndex: config.caseIndex ?? null, taskId: config.taskId ?? null, processId: process.pid, processNonce: config.processNonce,
      requestAttempt: ++request.transportAttempts, path: new URL(url).pathname, startedAt: new Date().toISOString(),
      requestSha256: init.body ? hash(init.body) : null, seed: body?.seed ?? null,
      temperature: body?.temperature ?? null, max_tokens: body?.max_tokens ?? null, responseFormatApplied: body?.response_format ?? null };
    const began = performance.now();
    await appendHere('transport.jsonl', { ...entry, lifecycle: 'started' });
    try {
      if (request.phase !== 'probe') request.inferenceDispatched = true;
      const response = await fetch(url, init); entry.status = response.status; return response;
    } catch (error) { entry.error = message(error); throw error; }
    finally { entry.headerWallMilliseconds = Math.round(performance.now() - began); transport.push(entry); await appendHere('transport.jsonl', { ...entry, lifecycle: 'finished' }); }
  }
  async function worker(seed, temperature) {
    if (apiKey === undefined) apiKey = (await readFile(config.apiKeyFile, 'utf8')).trim();
    if (!apiKey) throw new Error('Empty API key file');
    const key = `${seed}/${temperature}`;
    if (!workers.has(key)) workers.set(key, new OpenAiResearchWorker({ controlId: plan.experimentId,
      model: config.modelIdentity.model, baseUrl: config.baseUrl, apiKey, dialect: 'qwen', reasoningEffort: 'none',
      temperature, seed, requestTimeoutMs: plan.limits.taskTimeoutMs, fetchImpl: loggedFetch }));
    return workers.get(key);
  }
  async function request(input) {
    const acquisition = config.mode === 'acquire';
    const phase = acquisition ? 'memory-acquisition' : 'execute';
    const spec = acquisition ? plan.acquisitions.find(row => row.acquisitionId === input.acquisitionId) : config.taskSpec;
    const expectedSeed = spec?.modelSeed;
    const temperature = acquisition ? spec?.temperature : 0;
    const maxOutputTokens = acquisition ? spec?.maxOutputTokens : plan.limits.executionMaxOutputTokens;
    if (config.mode === 'parent' || !spec || input.phase !== phase || input.modelSeed !== expectedSeed ||
        input.temperature !== temperature || input.maxOutputTokens !== maxOutputTokens || input.responseFormat != null) {
      throw new Error('Inference request settings differ from the fixed protocol');
    }
    if (logicalRequests.length >= (acquisition ? plan.acquisitions.length : plan.limits.maxModelCallsPerTask)) throw new Error('Child logical request cap exhausted');
    if (acquisition && logicalRequests.some(row => row.acquisitionId === input.acquisitionId)) throw new Error('Advice generation is one shot per acquisition slot');
    if (signal.aborted || input.signal?.aborted) throw new Error('Child deadline or abort');
    const entry = { id: `${config.processNonce}-${logicalRequests.length + 1}`, phase, caseId: input.caseId, family: input.family ?? null,
      acquisitionId: acquisition ? spec.acquisitionId : null, costOwnerArm: acquisition ? spec.arm : config.arm, profileId: spec.profileId ?? null,
      arm: config.arm ?? null, caseIndex: config.caseIndex ?? null, modelSeed: expectedSeed, temperature, maxOutputTokens,
      inputSha256: input.inputSha256 ?? null, actualInputSha256: input.actualInputSha256 ?? null,
      processId: process.pid, processNonce: config.processNonce, startedAt: new Date().toISOString(),
      transportAttempts: 0, inferenceDispatched: false, status: 'started' };
    logicalRequests.push(entry);
    await appendHere('events.jsonl', { type: 'inference-request-start', ...entry });
    const began = performance.now();
    try {
      const selectedWorker = await worker(expectedSeed, temperature);
      const body = JSON.stringify({ model: config.modelIdentity.model, messages: input.messages,
        ...(input.tools?.length ? { tools: input.tools } : {}), add_generation_prompt: true, chat_template_kwargs: { enable_thinking: false } });
      const token = { logicalRequestId: entry.id, phase, caseId: entry.caseId, requestSha256: hash(body), count: null,
        max_model_len: null, maxOutputTokens, status: 'started', startedAt: new Date().toISOString() };
      tokenizer.push(token);
      const tokenBegan = performance.now();
      await appendHere('tokenizer.jsonl', { ...token });
      try {
        let response;
        try { response = await fetch(new URL('/tokenize', selectedWorker.baseUrl), { method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body, redirect: 'error',
          signal: AbortSignal.any([signal, ...(input.signal ? [input.signal] : []), AbortSignal.timeout(10_000)]) }); }
        catch { throw new Error('Tokenizer request failed or was aborted'); }
        token.httpStatus = response.status;
        if (!response.ok) throw new Error(`Tokenizer returned HTTP ${response.status}`);
        let value; try { value = await response.json(); } catch { throw new Error('Tokenizer response was not valid JSON'); }
        if (!Number.isSafeInteger(value?.count) || value.count < 0 || !Number.isSafeInteger(value?.max_model_len) || value.max_model_len < 1) throw new Error('Tokenizer response requires integer count and positive integer max_model_len');
        token.count = value.count; token.max_model_len = value.max_model_len;
        if (value.count + maxOutputTokens > Math.min(CONTEXT, value.max_model_len)) throw new Error('Context budget exceeded before inference');
        token.status = 'passed'; entry.tokenizer = { ...token };
      } catch (error) { token.status = 'rejected'; token.error = message(error); throw error; }
      finally { token.wallMilliseconds = Math.round(performance.now() - tokenBegan); await appendHere('tokenizer.jsonl', { ...token }); }
      const response = await context.run(entry, () => selectedWorker.runCase({ caseId: input.caseId, messages: input.messages,
        tools: input.tools ?? [], maxOutputTokens, dataManifestDigest: config.manifestDigest,
        signal: input.signal ? AbortSignal.any([signal, input.signal]) : signal }));
      entry.status = 'returned'; entry.usage = observedUsage(response.providerResponse);
      entry.promptTokenCheck = { tokenizerCount: token.count, actualPromptTokens: entry.usage.promptTokens,
        delta: entry.usage.promptTokens === null ? null : entry.usage.promptTokens - token.count,
        exactMatch: entry.usage.promptTokens === null ? null : entry.usage.promptTokens === token.count };
      await appendHere('events.jsonl', { type: 'inference-response', logicalRequestId: entry.id,
        promptTokenCheck: entry.promptTokenCheck, response });
      return response;
    } catch (error) { entry.status = entry.inferenceDispatched ? 'failed' : 'rejected-before-inference'; entry.error = message(error); throw error; }
    finally { entry.wallMilliseconds = Math.round(performance.now() - began); await appendHere('events.jsonl', { type: 'inference-request-finished', ...entry }); }
  }
  return { request, async probe() {
    const current = { id: `${config.processNonce}-probe`, phase: 'probe', caseId: 'probe', transportAttempts: 0 };
    const w = await worker(plan.tasks[0].modelSeed, 0);
    return context.run(current, () => w.probe({ signal }));
  }, accounting: () => ({ logicalRequests, transport, tokenizer, usage: usageSummary(logicalRequests),
    unresolvedAttemptCost: logicalRequests.some(row => row.inferenceDispatched && !hasKnownUsage(row)) ||
      transport.some(row => row.phase !== 'probe' && (row.error || row.status >= 400)), actualGpuTimeMeasured: false }) };
}

async function runChild(mode, inputPath) {
  const bytes = await readFile(inputPath), config = JSON.parse(bytes);
  const directory = process.cwd(), start = performance.now();
  const startReceipt = { processId: process.pid, parentProcessId: process.ppid, processNonce: config.processNonce,
    mode, startedAt: new Date().toISOString(), workingDirectory: directory, runtimeInputPath: inputPath,
    runtimeInputSha256: hash(bytes), runtimeInputKeys: Object.keys(config).sort() };
  await artifact(directory, 'process-start.json', startReceipt);
  let client;
  try {
    const allowedKeys = new Set(['mode', 'modelIdentity', 'apiKeyFile', 'baseUrl', 'manifestDigest', 'processNonce', 'deadlineMs', 'runnerProtocol',
      'taskId', 'arm', 'caseIndex', 'snapshotPath', 'snapshotDigest', 'snapshotByteSha256', 'memoryKey', 'acquisitionExit', 'planSha256', 'sourceHashesSha256']);
    if (config.mode !== mode || config.runnerProtocol !== SCOPED_KNOWLEDGE_RUNNER_PROTOCOL ||
        Object.keys(config).some(key => !allowedKeys.has(key))) throw new Error('Invalid child runtime input');
    if (await realpath(inputPath) !== await realpath(resolve(directory, 'input.json')) || !Number.isFinite(config.deadlineMs) || config.deadlineMs <= Date.now()) throw new Error('Invalid child path or elapsed deadline');
    if (hash(encoded(await collectSourceHashes(entryUrl))) !== config.sourceHashesSha256) throw new Error('Child source files differ from frozen dispatch');
    const plan = validatePlan(await adapter.createPlan({ modelIdentity: config.modelIdentity }));
    if (hash(encoded(plan)) !== config.planSha256) throw new Error('Child plan differs from frozen parent plan');
    const acquisitionTimeout = plan.acquisitions.length * plan.limits.taskTimeoutMs + 10_000;
    const signal = AbortSignal.timeout(Math.max(1, Math.min(config.deadlineMs - Date.now(), mode === 'evaluate' ? plan.limits.taskTimeoutMs : acquisitionTimeout)));
    const taskSpec = mode === 'evaluate' ? plan.tasks.find(row => row.taskId === config.taskId) : null;
    if (mode === 'evaluate' && (!taskSpec || taskSpec.arm !== config.arm || taskSpec.caseIndex !== config.caseIndex || taskSpec.memoryKey !== config.memoryKey)) throw new Error('Child task differs from frozen plan');
    client = createClient({ ...config, taskSpec }, directory, signal, plan);
    let result;
    if (mode === 'acquire') {
      const inputs = [];
      for (const spec of plan.acquisitions) {
        const input = await adapter.buildAcquisitionInput({ acquisitionId: spec.acquisitionId, modelIdentity: config.modelIdentity });
        if (input.acquisitionId !== spec.acquisitionId || input.phase !== 'memory-acquisition' ||
            input.modelSeed !== spec.modelSeed || input.temperature !== spec.temperature ||
            input.maxOutputTokens !== spec.maxOutputTokens || input.responseFormat != null) throw new Error('Acquisition input identity or settings differ from plan');
        inputs.push(input);
      }
      await artifact(directory, 'prepared-training.json', { inputs, inputsSha256: hash(encoded(inputs)), preparedBeforeModelRequests: true });
      const acquisitions = [];
      for (const input of inputs) {
        const row = { acquisitionId: input.acquisitionId, input };
        try { row.response = await client.request({ ...input, signal: AbortSignal.any([signal, AbortSignal.timeout(plan.limits.taskTimeoutMs)]) }); }
        catch (error) { row.error = message(error); }
        acquisitions.push(row);
      }
      const built = await adapter.buildSnapshots({ acquisitions, modelIdentity: config.modelIdentity });
      const snapshots = {};
      const keys = [...new Set(plan.tasks.map(row => row.memoryKey))].sort();
      if (!built?.snapshots || JSON.stringify(Object.keys(built.snapshots).sort()) !== JSON.stringify(keys)) throw new Error('Snapshot catalog differs from frozen task plan');
      for (const memoryKey of keys) {
        const snapshot = built.snapshots[memoryKey];
        await adapter.validateSnapshot({ snapshot, memoryKey, arm: memoryKey, modelIdentity: config.modelIdentity });
        const path = saveReplayMemory(resolve(directory, 'memory-' + memoryKey), snapshot);
        snapshots[memoryKey] = { path, digest: snapshot.digest, byteSha256: hash(await readFile(path)),
          records: snapshot.records.map(row => ({ id: row.id, digest: row.digest, verification: row.verification.status })) };
      }
      const { snapshots: rawSnapshots, ...details } = built;
      result = { ...details, acquisitions, snapshots };
    } else {
      if (config.acquisitionExit?.code !== 0 || config.acquisitionExit.processId === process.pid ||
          !Number.isFinite(Date.parse(config.acquisitionExit.exitedAt)) || Date.parse(config.acquisitionExit.exitedAt) > Date.parse(startReceipt.startedAt)) throw new Error('Evaluation requires a completed, different acquisition process');
      if (await realpath(config.snapshotPath) !== await realpath(resolve(directory, basename(config.snapshotPath)))) throw new Error('Snapshot must be staged in this evaluation working directory');
      const before = await readFile(config.snapshotPath);
      if (hash(before) !== config.snapshotByteSha256) throw new Error('Snapshot bytes differ from the staged input binding');
      const loadedMemory = loadReplayMemory(config.snapshotPath, config.snapshotDigest);
      await adapter.validateSnapshot({ snapshot: loadedMemory, memoryKey: config.memoryKey, arm: config.arm, modelIdentity: config.modelIdentity });
      const memoryLoad = { openedAt: new Date().toISOString(), processId: process.pid, path: config.snapshotPath,
        memoryKey: config.memoryKey, byteSha256: hash(before), snapshotDigest: loadedMemory.digest,
        records: loadedMemory.records.map(row => ({ id: row.id, digest: row.digest, verification: row.verification.status })) };
      await artifact(directory, 'memory-load.json', memoryLoad);
      result = await adapter.runTask({ request: client.request, modelIdentity: config.modelIdentity, loadedMemory,
        taskId: config.taskId, signal,
        onEvent: event => append(directory, 'events.jsonl', { ...event, processId: process.pid, processNonce: config.processNonce }) });
      const after = await readFile(config.snapshotPath);
      if (hash(after) !== hash(before)) throw new Error('Evaluation mutated its frozen memory snapshot');
      if (result.taskId !== taskSpec.taskId || result.arm !== taskSpec.arm || result.caseIndex !== taskSpec.caseIndex ||
          result.modelCalls > plan.limits.maxModelCallsPerTask || result.toolCalls > plan.limits.maxToolCallsPerTask) throw new Error('Task result identity or resource count differs from its child input');
      await adapter.validateTaskResult?.({ taskSpec, result, modelIdentity: config.modelIdentity });
      result = { ...result, memoryLoad, snapshotAfterSha256: hash(after), acquisitionExit: config.acquisitionExit };
    }
    const report = { schema: 'amos.scoped-knowledge-process-child.v1', runnerProtocol: SCOPED_KNOWLEDGE_RUNNER_PROTOCOL,
      ...startReceipt, modelIdentity: config.modelIdentity,
      manifestDigest: config.manifestDigest, planSha256: config.planSha256, sourceHashesSha256: config.sourceHashesSha256,
      completedAt: new Date().toISOString(), wallMilliseconds: Math.round(performance.now() - start),
      result, accounting: client.accounting() };
    await artifact(directory, 'report.json', report);
    await artifact(directory, 'completed.json', { processId: process.pid, processNonce: config.processNonce, reportSha256: hash(encoded(report)) });
  } catch (error) {
    await artifact(directory, 'failed.json', { ...startReceipt, failedAt: new Date().toISOString(), error: message(error), accounting: client?.accounting() ?? null });
    process.stderr.write('Memory experiment child stopped; inspect its journal.\n'); process.exitCode = 1;
  }
}

async function runParent() {
  for (const key of ['output', 'model', 'weights-sha256', 'api-key-file', 'manifest-digest']) if (!options[key]) throw new Error(`--${key} is required`);
  for (const key of ['weights-sha256', 'manifest-digest']) if (!/^[a-f0-9]{64}$/.test(options[key])) throw new Error(`--${key} must be a lowercase SHA-256 digest`);
  const minutes = Number(options['max-minutes'] ?? MAX_MINUTES);
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES) throw new Error('--max-minutes must be from 1 to 100');
  const directory = resolve(options.output), startedAt = new Date().toISOString(), began = performance.now();
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const config = { mode: 'parent', runnerProtocol: SCOPED_KNOWLEDGE_RUNNER_PROTOCOL,
    modelIdentity: { model: options.model, weightsSha256: options['weights-sha256'] },
    apiKeyFile: resolve(options['api-key-file']), baseUrl: options['base-url'] ?? 'http://127.0.0.1:8001',
    manifestDigest: options['manifest-digest'], processNonce: randomUUID(), deadlineMs: Date.now() + minutes * 60_000 };
  const signal = AbortSignal.timeout(minutes * 60_000), children = [], tasks = [];
  let manifest, manifestSha256, client, acquisition, plan, deadlineBudget;
  try {
    plan = validatePlan(await adapter.createPlan({ modelIdentity: config.modelIdentity }));
    if (minutes > plan.limits.maxMinutes) throw new Error('Requested duration exceeds adapter plan cap');
    deadlineBudget = describeScopedKnowledgeDeadlineBudget({ acquisitionCount: plan.acquisitions.length,
      taskCount: plan.tasks.length, taskTimeoutMs: plan.limits.taskTimeoutMs, maxMinutes: minutes });
    config.planSha256 = hash(encoded(plan));
    manifest = { schema: 'amos.scoped-knowledge-process-dispatch.v1', runnerProtocol: SCOPED_KNOWLEDGE_RUNNER_PROTOCOL,
      deadlineBudget, experimentSchema: plan.schema, startedAt, processId: process.pid, processNonce: config.processNonce,
      modelIdentity: config.modelIdentity, manifestDigest: config.manifestDigest, sourceHashes: await collectSourceHashes(entryUrl),
      plan, planSha256: config.planSha256, baseUrl: config.baseUrl, maxMinutes: minutes,
      limits: { ...plan.limits, maximumTransportAttemptsPerLogicalRequest: MAX_ATTEMPTS,
        maximumInferenceTransportAttempts: plan.limits.maxLogicalRequests * MAX_ATTEMPTS,
        maximumProbeTransportAttempts: MAX_ATTEMPTS, maximumTokenizerRequests: plan.limits.maxLogicalRequests, tokenizerTimeoutMs: 10_000,
        contextWindowTokens: CONTEXT, promptFitCheckedByCli: true },
      isolation: 'Separate agent processes and evaluation input directories containing only runtime config and advice snapshot; no OS filesystem sandbox is claimed. Frozen model server may remain running.',
      requestCapsAreLogical: true, actualGpuTimeMeasured: false, automaticResume: false, jsonConformanceRequests: 0 };
    config.sourceHashesSha256 = hash(encoded(manifest.sourceHashes));
    manifest.sourceHashesSha256 = config.sourceHashesSha256;
    manifestSha256 = hash(encoded(manifest)); await artifact(directory, 'manifest.json', manifest);
    client = createClient(config, directory, signal, plan); await artifact(directory, 'probe.json', await client.probe());

    async function child(mode, name, extra, timeoutMs) {
      if (signal.aborted) throw new Error('Global deadline reached before child dispatch');
      const runtime = resolve(directory, name); await mkdir(runtime, { mode: 0o700 });
      const childConfig = { ...config, mode, processNonce: randomUUID(), ...extra };
      if (mode === 'evaluate') {
        const staged = resolve(runtime, 'snapshot.json'); await copyFile(childConfig.snapshotPath, staged);
        childConfig.snapshotPath = staged;
      }
      await artifact(runtime, 'input.json', childConfig);
      const inputSha256 = hash(await readFile(resolve(runtime, 'input.json')));
      const remaining = Math.max(1, Math.min(timeoutMs, config.deadlineMs - Date.now()));
      const receipt = { mode, directory: runtime, processNonce: childConfig.processNonce, runtimeInputSha256: inputSha256,
        taskId: extra.taskId ?? null, arm: extra.arm ?? null, caseIndex: extra.caseIndex ?? null, dispatchedAt: new Date().toISOString() };
      const processResult = await new Promise(resolveResult => {
        // Preserve runtime flags/preloads (including test-only fetch interception), not the parent CLI arguments.
        const processChild = spawn(process.execPath, [...process.execArgv, SCRIPT, '--child-mode', mode, '--input', resolve(runtime, 'input.json')],
          { cwd: runtime, stdio: ['ignore', 'ignore', 'pipe'], env: process.env });
        receipt.processId = processChild.pid ?? null;
        let stderr = '', spawnError = null, timedOut = false, hardKill;
        processChild.stderr.on('data', chunk => { if (stderr.length < 8000) stderr += chunk.toString().slice(0, 8000 - stderr.length); });
        const timer = setTimeout(() => { timedOut = true; processChild.kill('SIGTERM'); hardKill = setTimeout(() => processChild.kill('SIGKILL'), KILL_GRACE_MS); }, remaining);
        processChild.once('error', error => { spawnError = message(error); });
        processChild.once('close', (code, exitSignal) => { clearTimeout(timer); clearTimeout(hardKill);
          resolveResult({ code, signal: exitSignal, timedOut, spawnError, stderr, exitedAt: new Date().toISOString() }); });
      });
      Object.assign(receipt, processResult); await artifact(runtime, 'process-exit.json', receipt);
      await append(directory, 'processes.jsonl', receipt); children.push(receipt);
      let report = null;
      try {
        const bytes = await readFile(resolve(runtime, 'report.json')), completed = await json(resolve(runtime, 'completed.json'));
        if (completed.reportSha256 !== hash(bytes) || completed.processId !== receipt.processId ||
            completed.processNonce !== receipt.processNonce) throw new Error('Child report digest or completion identity mismatch');
        report = JSON.parse(bytes);
        if (report.runnerProtocol !== SCOPED_KNOWLEDGE_RUNNER_PROTOCOL || report.processId !== receipt.processId ||
            report.processNonce !== receipt.processNonce || report.runtimeInputSha256 !== inputSha256 ||
            report.planSha256 !== config.planSha256 || report.sourceHashesSha256 !== config.sourceHashesSha256 ||
            report.modelIdentity?.model !== config.modelIdentity.model || report.modelIdentity?.weightsSha256 !== config.modelIdentity.weightsSha256) throw new Error('Child report identity mismatch');
        receipt.reportSha256 = hash(bytes);
      } catch (error) { report = null; receipt.reportError = message(error); }
      return { receipt, report };
    }
    acquisition = await child('acquire', 'acquisition', {}, plan.acquisitions.length * plan.limits.taskTimeoutMs + ACQUISITION_WATCHDOG_OVERHEAD_MS);
    if (acquisition.receipt.code !== 0 || !acquisition.report) throw new Error('Acquisition process did not finish with immutable snapshots');
    const snapshots = acquisition.report.result.snapshots;
    for (const [memoryKey, info] of Object.entries(snapshots)) {
      const snapshot = loadReplayMemory(info.path, info.digest);
      await adapter.validateSnapshot({ snapshot, memoryKey, arm: memoryKey, modelIdentity: config.modelIdentity });
      if (hash(await readFile(info.path)) !== info.byteSha256) throw new Error('Acquired memory bytes changed after process exit');
    }
    const acquisitionExit = { processId: acquisition.receipt.processId, processNonce: acquisition.receipt.processNonce,
      code: acquisition.receipt.code, exitedAt: acquisition.receipt.exitedAt, reportSha256: acquisition.receipt.reportSha256 };
    for (const spec of plan.tasks) {
      const info = snapshots[spec.memoryKey];
      const run = await child('evaluate', 'task-' + spec.taskId, { taskId: spec.taskId, arm: spec.arm, caseIndex: spec.caseIndex,
        memoryKey: spec.memoryKey, acquisitionExit, snapshotPath: info.path, snapshotDigest: info.digest,
        snapshotByteSha256: info.byteSha256 }, plan.limits.taskTimeoutMs + TASK_WATCHDOG_OVERHEAD_MS);
      tasks.push({ ...spec, process: run.receipt, report: run.report,
        pass: run.receipt.code === 0 && run.report?.result?.pass === true });
    }
    if (tasks.length !== plan.tasks.length || new Set(tasks.map(row => row.taskId)).size !== plan.tasks.length ||
        new Set(children.map(row => row.processNonce)).size !== plan.tasks.length + 1) throw new Error('Incomplete or duplicated process/task grid');
    const memoryPreservation = {};
    for (const [memoryKey, info] of Object.entries(snapshots)) {
      const afterSha256 = hash(await readFile(info.path));
      if (afterSha256 !== info.byteSha256) throw new Error('Parent snapshot changed during evaluation');
      memoryPreservation[memoryKey] = { beforeSha256: info.byteSha256, afterSha256 };
    }
    const accounting = await aggregateAccounting([acquisition.report.accounting, ...tasks.map(row => row.report?.accounting).filter(Boolean)], children, client.accounting());
    if (accounting.logicalRequests.length > plan.limits.maxLogicalRequests) throw new Error('Aggregate logical request cap exceeded');
    const byArm = Object.fromEntries(plan.arms.map(arm => {
      const selected = tasks.filter(row => row.arm === arm), solved = selected.filter(row => row.pass).length;
      const requests = accounting.logicalRequests.filter(row => row.phase === 'execute' && row.arm === arm);
      const creation = accounting.logicalRequests.filter(row => row.phase === 'memory-acquisition' && row.costOwnerArm === arm);
      const endToEndRequests = [...creation, ...requests];
      const receiptCounts = rows => {
        const ids = new Set(rows.map(row => row.id));
        return { inferenceTransportAttempts: accounting.transport.filter(row => ids.has(row.logicalRequestId)).length,
          tokenizerRequests: accounting.tokenizer.filter(row => ids.has(row.logicalRequestId)).length };
      };
      const childWallMilliseconds = selected.reduce((sum, row) => sum + Math.max(0, Date.parse(row.process.exitedAt) - Date.parse(row.process.dispatchedAt)), 0);
      const acquisitionRequestWallMilliseconds = creation.reduce((sum, row) => sum + (row.wallMilliseconds ?? 0), 0);
      return [arm, { intendedTasks: selected.length, solvedTasks: solved, verifiedCompletionRate: solved / selected.length,
        acquisitionUsage: usageSummary(creation), evaluationUsage: usageSummary(requests), endToEndUsage: usageSummary(endToEndRequests),
        evaluationReceiptCounts: receiptCounts(requests), endToEndReceiptCounts: receiptCounts(endToEndRequests),
        endToEndLogicalRequestsPerSolvedTask: solved ? endToEndRequests.length / solved : null,
        observedToolCalls: accounting.toolEvents.filter(row => row.arm === arm).length,
        childWallMilliseconds, acquisitionRequestWallMilliseconds, endToEndAttributedWallMilliseconds: childWallMilliseconds + acquisitionRequestWallMilliseconds,
        incompleteChildReports: selected.filter(row => !row.report).length }];
    }));
    const report = { schema: plan.schema, runnerProtocol: SCOPED_KNOWLEDGE_RUNNER_PROTOCOL, deadlineBudget,
      status: 'completed', modelIdentity: config.modelIdentity, manifestDigest: config.manifestDigest,
      dispatchManifestSha256: manifestSha256, sourceHashes: manifest.sourceHashes, startedAt, completedAt: new Date().toISOString(),
      processId: process.pid, processNonce: config.processNonce, wallMilliseconds: Math.round(performance.now() - began),
      plan, planSha256: config.planSha256, acquisition, tasks, byArm, accounting, memoryPreservation,
      acquisitionProcessWallMilliseconds: Math.max(0, Date.parse(acquisition.receipt.exitedAt) - Date.parse(acquisition.receipt.dispatchedAt)),
      acquisitionWallAttribution: 'Each arm receives its own generation request wall time; shared acquisition process setup is not attributed to individual arms.',
      isolation: manifest.isolation, memoryCreationCostCountedOnce: true, modelServerRestartClaimed: false };
    await artifact(directory, 'report.json', report);
    await artifact(directory, 'completed.json', { completedAt: new Date().toISOString(), reportSha256: hash(encoded(report)),
      manifestSha256, processId: process.pid, processNonce: config.processNonce });
    process.stdout.write(JSON.stringify({ completed: true, tasks: tasks.length, logicalRequests: accounting.logicalRequests.length, byArm }) + '\n');
  } catch (error) {
    const recoveredAccounting = await aggregateAccounting([acquisition?.report?.accounting, ...tasks.map(row => row.report?.accounting)].filter(Boolean), children,
      client?.accounting() ?? { transport: [] });
    await artifact(directory, 'failed.json', { schema: plan?.schema ?? 'amos.scoped-knowledge-process-experiment.v1',
      runnerProtocol: SCOPED_KNOWLEDGE_RUNNER_PROTOCOL, deadlineBudget: deadlineBudget ?? null,
      status: 'failed', error: message(error), modelIdentity: config.modelIdentity,
      manifestDigest: config.manifestDigest, dispatchManifestSha256: manifestSha256 ?? null, sourceHashes: manifest?.sourceHashes ?? null,
      plan: plan ?? null, planSha256: config.planSha256 ?? null,
      children, tasks, acquisition: acquisition ?? null, accounting: recoveredAccounting,
      parentAccounting: client?.accounting() ?? null, failedAt: new Date().toISOString() });
    process.stderr.write('Memory experiment stopped; inspect its output directory.\n'); process.exitCode = 1;
  }
}

function observedUsage(payload) {
  const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  return { promptTokens: numeric(payload?.timings?.prompt_n ?? payload?.usage?.prompt_tokens),
    outputTokens: numeric(payload?.timings?.predicted_n ?? payload?.usage?.completion_tokens) };
}
function usageSummary(rows) {
  const dispatched = rows.filter(row => row.inferenceDispatched), known = dispatched.filter(hasKnownUsage);
  return { logicalRequests: rows.length, dispatchedRequests: dispatched.length, rejectedBeforeInference: rows.length - dispatched.length,
    responsesWithKnownUsage: known.length, promptTokens: known.reduce((sum, row) => sum + row.usage.promptTokens, 0),
    outputTokens: known.reduce((sum, row) => sum + row.usage.outputTokens, 0),
    incomplete: known.length !== dispatched.length || dispatched.some(row => row.transportAttempts > 1) };
}
function hasKnownUsage(row) { return row.usage?.promptTokens != null && row.usage?.outputTokens != null; }
async function aggregateAccounting(reports, children, parent) {
  const logical = new Map(reports.flatMap(row => row.logicalRequests).map(row => [row.id, { ...row }]));
  const wires = new Map(), tokens = new Map(), toolEvents = [];
  async function journal(directory, name) {
    const text = await readFile(resolve(directory, name), 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return ''; });
    return text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  }
  for (const child of children) {
    const tags = { arm: child.arm, caseIndex: child.caseIndex, taskId: child.taskId, processId: child.processId, processNonce: child.processNonce };
    for (const event of await journal(child.directory, 'events.jsonl')) {
      if (event.type === 'inference-request-start' || event.type === 'inference-request-finished') {
        logical.set(event.id, { ...(logical.get(event.id) ?? {}), ...event, ...tags });
      } else if (event.type === 'inference-response' && logical.has(event.logicalRequestId)) {
        const row = logical.get(event.logicalRequestId);
        row.usage = observedUsage(event.response?.providerResponse); row.status = 'returned'; row.inferenceDispatched = true;
      } else if (event.type === 'tool') toolEvents.push({ ...event, ...tags });
    }
    for (const row of await journal(child.directory, 'transport.jsonl')) {
      const key = `${child.processNonce}/${row.logicalRequestId}/${row.requestAttempt}`;
      wires.set(key, { ...(wires.get(key) ?? {}), ...row, ...tags });
    }
    for (const row of await journal(child.directory, 'tokenizer.jsonl')) tokens.set(row.logicalRequestId, { ...row, ...tags });
  }
  const logicalRequests = [...logical.values()], transport = [...parent.transport, ...wires.values()], tokenizer = [...tokens.values()];
  for (const row of logicalRequests) {
    if (row.phase === 'memory-acquisition') row.arm = row.costOwnerArm;
    const attempts = transport.filter(wire => wire.logicalRequestId === row.id);
    if (attempts.length) { row.inferenceDispatched = true; row.transportAttempts = Math.max(row.transportAttempts ?? 0, ...attempts.map(wire => wire.requestAttempt)); }
  }
  for (const entry of [...transport, ...tokenizer]) {
    const owner = logical.get(entry.logicalRequestId);
    if (owner) { entry.arm = owner.arm; entry.costOwnerArm = owner.costOwnerArm; entry.acquisitionId = owner.acquisitionId; }
  }
  return { logicalRequests, transport, tokenizer, usage: usageSummary(logicalRequests),
    toolEvents, toolCountsAreObservedJournalEvents: true, incompleteChildReports: children.filter(row => row.code !== 0 || row.reportError).length,
    unresolvedAttemptCost: reports.some(row => row.unresolvedAttemptCost) || logicalRequests.some(row => row.inferenceDispatched && !hasKnownUsage(row)) ||
      transport.some(row => row.phase !== 'probe' && (row.error || row.status >= 400 || row.lifecycle === 'started')),
    actualGpuTimeMeasured: false, probeCallsSeparate: true };
}
async function collectSourceHashes(entry) {
  const hashes = {}, seen = new Set();
  async function visit(url) {
    const path = fileURLToPath(url); if (seen.has(path)) return; seen.add(path);
    const bytes = await readFile(path); hashes[path] = hash(bytes);
    for (const match of bytes.toString('utf8').matchAll(/(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"](\.[^'"]+)['"]/g)) await visit(new URL(match[1], url));
  }
  await visit(entry); return hashes;
}

function validatePlan(value) {
  const plan = structuredClone(value);
  const safeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value);
  const bounded = (value, maximum) => Number.isSafeInteger(value) && value > 0 && value <= maximum;
  if (!safeId(plan?.experimentId) || typeof plan.schema !== 'string' || !Array.isArray(plan.arms) ||
      plan.arms.length < 2 || plan.arms.length > 8 || plan.arms.some(arm => !safeId(arm)) || new Set(plan.arms).size !== plan.arms.length ||
      !Array.isArray(plan.acquisitions) || !bounded(plan.acquisitions.length, 32) ||
      !Array.isArray(plan.tasks) || !bounded(plan.tasks.length, 128)) throw new Error('Invalid experiment plan structure');
  const limits = plan.limits;
  if (!limits || !bounded(limits.maxModelCallsPerTask, 64) || !bounded(limits.maxToolCallsPerTask, 128) ||
      !bounded(limits.taskTimeoutMs, 120_000) || !bounded(limits.maxMinutes, MAX_MINUTES) ||
      !bounded(limits.executionMaxOutputTokens, 1536) ||
      limits.maxLogicalRequests !== plan.acquisitions.length + plan.tasks.length * limits.maxModelCallsPerTask) throw new Error('Invalid compositional experiment limits');
  if (new Set(plan.acquisitions.map(row => row.acquisitionId)).size !== plan.acquisitions.length ||
      plan.acquisitions.some(row => !safeId(row.acquisitionId) || !plan.arms.includes(row.arm) || !Number.isSafeInteger(row.modelSeed) ||
        row.temperature !== 1 || !bounded(row.maxOutputTokens, 512))) throw new Error('Invalid acquisition slots');
  if (new Set(plan.tasks.map(row => row.taskId)).size !== plan.tasks.length ||
      plan.tasks.some(row => !safeId(row.taskId) || !plan.arms.includes(row.arm) || row.memoryKey !== row.arm ||
        !Number.isSafeInteger(row.caseIndex) || row.caseIndex < 0 || !Number.isSafeInteger(row.modelSeed) ||
        row.tripletId == null || typeof row.cohort !== 'string')) throw new Error('Invalid task slots');
  const cases = new Map();
  for (const row of plan.tasks) {
    const members = cases.get(row.caseIndex) ?? []; members.push(row); cases.set(row.caseIndex, members);
  }
  for (const members of cases.values()) {
    const common = row => JSON.stringify(['caseIndex', 'tripletId', 'cohort', 'profileId', 'policyVersion', 'modelSeed'].map(key => row[key] ?? null));
    if (members.length !== plan.arms.length || new Set(members.map(row => row.arm)).size !== plan.arms.length ||
        members.some(row => common(row) !== common(members[0]))) throw new Error('Task comparison grid is incomplete or unpaired');
  }
  return plan;
}

}
