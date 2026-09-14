#!/usr/bin/env node
import { mkdir, readFile, writeFile, appendFile, copyFile, realpath } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { OpenAiResearchWorker } from '../src/openAiResearchWorker.js';
import { buildMemoryAcquisitionInput, createProceduralMemorySnapshot, createEmptyProceduralMemorySnapshot,
  getProceduralMemoryCases, runProceduralMemoryTask } from '../src/proceduralMemoryExperiment.js';
import { loadReplayMemory, saveReplayMemory } from '../src/persistentReplayMemory.js';

const SCRIPT = fileURLToPath(import.meta.url);
const SCHEMA = 'amos.procedural-memory-experiment.v1';
const ARMS = ['no-memory', 'procedural-memory'];
const MAX_REQUESTS = 194, MAX_ATTEMPTS = 4, CONTEXT = 8192, TASK_MS = 120_000;
const hash = value => createHash('sha256').update(value).digest('hex');
const encoded = value => JSON.stringify(value, null, 2) + '\n';
const message = error => String(error?.message ?? error);
const artifact = (directory, name, value) => writeFile(resolve(directory, name), encoded(value), { flag: 'wx', mode: 0o600 });
const append = (directory, name, value) => appendFile(resolve(directory, name), JSON.stringify(value) + '\n', { mode: 0o600 });
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const options = {};
const allowed = new Set(['output', 'model', 'weights-sha256', 'api-key-file', 'manifest-digest', 'base-url', 'max-minutes', 'child-mode', 'input']);
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]?.replace(/^--/, '');
  if (!process.argv[i]?.startsWith('--') || !allowed.has(key) || !process.argv[i + 1] || Object.hasOwn(options, key)) throw new Error('Invalid or repeated CLI argument');
  options[key] = process.argv[i + 1];
}
if (options['child-mode']) {
  if (!['acquire', 'evaluate'].includes(options['child-mode']) || !options.input || Object.keys(options).length !== 2) throw new Error('Invalid child invocation');
  await runChild(options['child-mode'], resolve(options.input));
} else {
  if (options.input) throw new Error('--input is reserved for child invocation');
  await runParent();
}

function createClient(config, directory, signal) {
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
      arm: config.arm ?? null, caseIndex: config.caseIndex ?? null, processId: process.pid, processNonce: config.processNonce,
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
    if (!workers.has(key)) workers.set(key, new OpenAiResearchWorker({ controlId: 'procedural-memory-pilot-v1',
      model: config.modelIdentity.model, baseUrl: config.baseUrl, apiKey, dialect: 'qwen', reasoningEffort: 'none',
      temperature, seed, requestTimeoutMs: TASK_MS, fetchImpl: loggedFetch }));
    return workers.get(key);
  }
  async function request(input) {
    const acquisition = config.mode === 'acquire';
    const phase = acquisition ? 'memory-acquisition' : 'execute';
    const expectedSeed = acquisition ? input.family === 'reserve-order' ? 20260917 : input.family === 'invoice-order' ? 20261018 : null : 20260917 + config.caseIndex * 101;
    const temperature = acquisition ? 1 : 0, maxOutputTokens = acquisition ? 512 : 1536;
    if (config.mode === 'parent' || input.phase !== phase || input.modelSeed !== expectedSeed || expectedSeed === null ||
        (input.temperature ?? temperature) !== temperature || (input.maxOutputTokens ?? maxOutputTokens) !== maxOutputTokens || input.responseFormat != null) {
      throw new Error('Inference request settings differ from the fixed protocol');
    }
    if (logicalRequests.length >= (acquisition ? 2 : 12)) throw new Error('Child logical request cap exhausted');
    if (acquisition && logicalRequests.some(row => row.family === input.family)) throw new Error('Summary generation is one shot per family');
    if (signal.aborted || input.signal?.aborted) throw new Error('Child deadline or abort');
    const entry = { id: `${config.processNonce}-${logicalRequests.length + 1}`, phase, caseId: input.caseId, family: input.family ?? null,
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
    const w = await worker(20260917, 0);
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
    const allowedKeys = new Set(['mode', 'modelIdentity', 'apiKeyFile', 'baseUrl', 'manifestDigest', 'processNonce', 'deadlineMs',
      'arm', 'caseIndex', 'snapshotPath', 'snapshotDigest', 'snapshotByteSha256', 'acquisitionExit']);
    if (config.mode !== mode || Object.keys(config).some(key => !allowedKeys.has(key))) throw new Error('Invalid child runtime input');
    if (await realpath(inputPath) !== await realpath(resolve(directory, 'input.json')) || !Number.isFinite(config.deadlineMs) || config.deadlineMs <= Date.now()) throw new Error('Invalid child path or elapsed deadline');
    const signal = AbortSignal.timeout(Math.max(1, Math.min(config.deadlineMs - Date.now(), mode === 'evaluate' ? TASK_MS : TASK_MS * 2 + 10_000)));
    client = createClient(config, directory, signal);
    let result;
    if (mode === 'acquire') {
      const inputs = [];
      for (const family of ['reserve-order', 'invoice-order']) inputs.push(await buildMemoryAcquisitionInput({ family, modelIdentity: config.modelIdentity }));
      await artifact(directory, 'prepared-training.json', { inputs, inputsSha256: hash(encoded(inputs)), preparedBeforeModelRequests: true });
      const acquisitions = [];
      for (const input of inputs) {
        const row = { input };
        try { row.response = await client.request({ ...input, signal: AbortSignal.any([signal, AbortSignal.timeout(TASK_MS)]) }); }
        catch (error) { row.error = message(error); }
        acquisitions.push(row);
      }
      const built = await createProceduralMemorySnapshot({ acquisitions, modelIdentity: config.modelIdentity });
      const snapshotPath = saveReplayMemory(resolve(directory, 'memory'), built.snapshot);
      result = { acquisitions, memories: built.memories, snapshot: { path: snapshotPath, digest: built.snapshot.digest,
        byteSha256: hash(await readFile(snapshotPath)), records: built.snapshot.records.map(row => ({ id: row.id, digest: row.digest, verification: row.verification.status })) } };
    } else {
      if (!ARMS.includes(config.arm) || !Number.isSafeInteger(config.caseIndex) || config.caseIndex < 0 || config.caseIndex > 7 ||
          config.acquisitionExit?.code !== 0 || config.acquisitionExit.processId === process.pid ||
          Date.parse(config.acquisitionExit.exitedAt) > Date.parse(startReceipt.startedAt)) throw new Error('Evaluation requires a completed, different acquisition process');
      if (await realpath(config.snapshotPath) !== await realpath(resolve(directory, basename(config.snapshotPath)))) throw new Error('Snapshot must be staged in this evaluation working directory');
      const before = await readFile(config.snapshotPath);
      if (hash(before) !== config.snapshotByteSha256) throw new Error('Snapshot bytes differ from the staged input binding');
      const loadedMemory = loadReplayMemory(config.snapshotPath, config.snapshotDigest);
      if (config.arm === 'no-memory' && loadedMemory.records.length !== 0) throw new Error('Baseline snapshot must be empty');
      if (loadedMemory.records.some(row => row.example !== null || row.verification.status !== 'unverified')) throw new Error('Evaluation memory must contain only unverified summary records, without TRAIN examples');
      const memoryLoad = { openedAt: new Date().toISOString(), processId: process.pid, path: config.snapshotPath,
        byteSha256: hash(before), snapshotDigest: loadedMemory.digest,
        records: loadedMemory.records.map(row => ({ id: row.id, digest: row.digest, verification: row.verification.status })) };
      await artifact(directory, 'memory-load.json', memoryLoad);
      result = await runProceduralMemoryTask({ request: client.request, modelIdentity: config.modelIdentity, loadedMemory,
        arm: config.arm, caseIndex: config.caseIndex, signal,
        onEvent: event => append(directory, 'events.jsonl', { ...event, processId: process.pid, processNonce: config.processNonce }) });
      const after = await readFile(config.snapshotPath);
      if (hash(after) !== hash(before)) throw new Error('Evaluation mutated its frozen memory snapshot');
      if (result.arm !== config.arm || result.caseIndex !== config.caseIndex) throw new Error('Task result identity differs from its child input');
      result = { ...result, memoryLoad, snapshotAfterSha256: hash(after), acquisitionExit: config.acquisitionExit };
    }
    const report = { schema: 'amos.procedural-memory-child.v1', ...startReceipt, modelIdentity: config.modelIdentity,
      manifestDigest: config.manifestDigest, completedAt: new Date().toISOString(), wallMilliseconds: Math.round(performance.now() - start),
      result, accounting: client.accounting() };
    await artifact(directory, 'report.json', report);
    await artifact(directory, 'completed.json', { processId: process.pid, processNonce: config.processNonce, reportSha256: hash(encoded(report)) });
  } catch (error) {
    await artifact(directory, 'failed.json', { ...startReceipt, failedAt: new Date().toISOString(), error: message(error), accounting: client?.accounting() ?? null });
    process.stderr.write('Procedural-memory child stopped; inspect its journal.\n'); process.exitCode = 1;
  }
}

async function runParent() {
  for (const key of ['output', 'model', 'weights-sha256', 'api-key-file', 'manifest-digest']) if (!options[key]) throw new Error(`--${key} is required`);
  for (const key of ['weights-sha256', 'manifest-digest']) if (!/^[a-f0-9]{64}$/.test(options[key])) throw new Error(`--${key} must be a lowercase SHA-256 digest`);
  const minutes = Number(options['max-minutes'] ?? 40);
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 40) throw new Error('--max-minutes must be from 1 to 40');
  const directory = resolve(options.output), startedAt = new Date().toISOString(), began = performance.now();
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const config = { mode: 'parent', modelIdentity: { model: options.model, weightsSha256: options['weights-sha256'] },
    apiKeyFile: resolve(options['api-key-file']), baseUrl: options['base-url'] ?? 'http://127.0.0.1:8001',
    manifestDigest: options['manifest-digest'], processNonce: randomUUID(), deadlineMs: Date.now() + minutes * 60_000 };
  const signal = AbortSignal.timeout(minutes * 60_000), children = [], tasks = [];
  let manifest, manifestSha256, client, acquisition;
  try {
    const cases = await getProceduralMemoryCases();
    if (!Array.isArray(cases) || cases.length !== 8) throw new Error('Expected eight frozen evaluation cases');
    manifest = { schema: 'amos.procedural-memory-dispatch.v1', startedAt, processId: process.pid, processNonce: config.processNonce,
      modelIdentity: config.modelIdentity, manifestDigest: config.manifestDigest, sourceHashes: await collectSourceHashes(new URL(import.meta.url)),
      cases, caseManifestSha256: hash(encoded(cases)), baseUrl: config.baseUrl, maxMinutes: minutes,
      limits: { maxSummaryRequests: 2, maxTaskRequests: 12, maxToolCallsPerTask: 32, maxLogicalRequests: MAX_REQUESTS,
        taskTimeoutMs: TASK_MS, maxOutputTokens: { acquisition: 512, execute: 1536 },
        maximumTransportAttemptsPerLogicalRequest: MAX_ATTEMPTS, maximumInferenceTransportAttempts: MAX_REQUESTS * MAX_ATTEMPTS,
        maximumProbeTransportAttempts: MAX_ATTEMPTS, maximumTokenizerRequests: MAX_REQUESTS, tokenizerTimeoutMs: 10_000,
        contextWindowTokens: CONTEXT, promptFitCheckedByCli: true },
      isolation: 'Separate agent processes and evaluation input directories containing only runtime config and summary snapshot; no OS filesystem sandbox is claimed. Frozen model server may remain running.',
      requestCapsAreLogical: true, actualGpuTimeMeasured: false, automaticResume: false, jsonConformanceRequests: 0 };
    manifestSha256 = hash(encoded(manifest)); await artifact(directory, 'manifest.json', manifest);
    client = createClient(config, directory, signal); await artifact(directory, 'probe.json', await client.probe());

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
        arm: extra.arm ?? null, caseIndex: extra.caseIndex ?? null, dispatchedAt: new Date().toISOString() };
      const processResult = await new Promise(resolveResult => {
        // Preserve runtime flags/preloads (including test-only fetch interception), not the parent CLI arguments.
        const processChild = spawn(process.execPath, [...process.execArgv, SCRIPT, '--child-mode', mode, '--input', resolve(runtime, 'input.json')],
          { cwd: runtime, stdio: ['ignore', 'ignore', 'pipe'], env: process.env });
        receipt.processId = processChild.pid ?? null;
        let stderr = '', spawnError = null, timedOut = false, hardKill;
        processChild.stderr.on('data', chunk => { if (stderr.length < 8000) stderr += chunk.toString().slice(0, 8000 - stderr.length); });
        const timer = setTimeout(() => { timedOut = true; processChild.kill('SIGTERM'); hardKill = setTimeout(() => processChild.kill('SIGKILL'), 2000); }, remaining);
        processChild.once('error', error => { spawnError = message(error); });
        processChild.once('close', (code, exitSignal) => { clearTimeout(timer); clearTimeout(hardKill);
          resolveResult({ code, signal: exitSignal, timedOut, spawnError, stderr, exitedAt: new Date().toISOString() }); });
      });
      Object.assign(receipt, processResult); await artifact(runtime, 'process-exit.json', receipt);
      await append(directory, 'processes.jsonl', receipt); children.push(receipt);
      let report = null;
      try {
        const bytes = await readFile(resolve(runtime, 'report.json')), completed = await json(resolve(runtime, 'completed.json'));
        if (completed.reportSha256 !== hash(bytes)) throw new Error('Child report digest mismatch');
        report = JSON.parse(bytes);
        if (report.processId !== receipt.processId || report.processNonce !== receipt.processNonce || report.runtimeInputSha256 !== inputSha256 ||
            report.modelIdentity?.model !== config.modelIdentity.model || report.modelIdentity?.weightsSha256 !== config.modelIdentity.weightsSha256) throw new Error('Child report identity mismatch');
        receipt.reportSha256 = hash(bytes);
      } catch (error) { report = null; receipt.reportError = message(error); }
      return { receipt, report };
    }
    acquisition = await child('acquire', 'acquisition', {}, TASK_MS * 2 + 20_000);
    if (acquisition.receipt.code !== 0 || !acquisition.report) throw new Error('Acquisition process did not finish with an immutable snapshot');
    const snapshotInfo = acquisition.report.result.snapshot;
    const acquiredSnapshot = loadReplayMemory(snapshotInfo.path, snapshotInfo.digest);
    if (hash(await readFile(snapshotInfo.path)) !== snapshotInfo.byteSha256) throw new Error('Acquired memory bytes changed after process exit');
    const empty = await createEmptyProceduralMemorySnapshot({ modelIdentity: config.modelIdentity });
    const emptyPath = saveReplayMemory(resolve(directory, 'baseline-memory'), empty);
    const emptyBytesHash = hash(await readFile(emptyPath));
    const acquisitionExit = { processId: acquisition.receipt.processId, processNonce: acquisition.receipt.processNonce,
      code: acquisition.receipt.code, exitedAt: acquisition.receipt.exitedAt, reportSha256: acquisition.receipt.reportSha256 };
    for (let caseIndex = 0; caseIndex < 8; caseIndex++) for (const arm of caseIndex % 2 ? [...ARMS].reverse() : ARMS) {
      const treatment = arm === 'procedural-memory';
      const run = await child('evaluate', `task-${caseIndex}-${arm}`, { arm, caseIndex, acquisitionExit,
        snapshotPath: treatment ? snapshotInfo.path : emptyPath, snapshotDigest: treatment ? acquiredSnapshot.digest : empty.digest,
        snapshotByteSha256: treatment ? snapshotInfo.byteSha256 : emptyBytesHash }, TASK_MS + 10_000);
      tasks.push({ arm, caseIndex, process: run.receipt, report: run.report,
        pass: run.receipt.code === 0 && run.report?.result?.pass === true });
    }
    if (tasks.length !== 16 || new Set(tasks.map(row => `${row.arm}/${row.caseIndex}`)).size !== 16 ||
        new Set(children.map(row => row.processNonce)).size !== 17) throw new Error('Incomplete or duplicated process/task grid');
    if (hash(await readFile(snapshotInfo.path)) !== snapshotInfo.byteSha256 || hash(await readFile(emptyPath)) !== emptyBytesHash) throw new Error('Parent snapshots changed during evaluation');
    const allAccounting = [acquisition.report.accounting, ...tasks.map(row => row.report?.accounting).filter(Boolean)];
    const accounting = await aggregateAccounting(allAccounting, children, client.accounting());
    if (accounting.logicalRequests.length > MAX_REQUESTS) throw new Error('Aggregate logical request cap exceeded');
    const byArm = Object.fromEntries(ARMS.map(arm => {
      const selected = tasks.filter(row => row.arm === arm), solved = selected.filter(row => row.pass).length;
      const requests = accounting.logicalRequests.filter(row => row.phase === 'execute' && row.arm === arm);
      const endToEndRequests = arm === 'procedural-memory' ? [...accounting.logicalRequests.filter(row => row.phase === 'memory-acquisition'), ...requests] : requests;
      const receiptCounts = rows => {
        const ids = new Set(rows.map(row => row.id));
        return { inferenceTransportAttempts: accounting.transport.filter(row => ids.has(row.logicalRequestId)).length,
          tokenizerRequests: accounting.tokenizer.filter(row => ids.has(row.logicalRequestId)).length };
      };
      const childWallMilliseconds = selected.reduce((sum, row) => sum + Math.max(0, Date.parse(row.process.exitedAt) - Date.parse(row.process.dispatchedAt)), 0);
      const acquisitionWallMilliseconds = Math.max(0, Date.parse(acquisition.receipt.exitedAt) - Date.parse(acquisition.receipt.dispatchedAt));
      return [arm, { intendedTasks: 8, solvedTasks: solved, verifiedCompletionRate: solved / 8,
        evaluationUsage: usageSummary(requests), endToEndUsage: usageSummary(endToEndRequests),
        evaluationReceiptCounts: receiptCounts(requests), endToEndReceiptCounts: receiptCounts(endToEndRequests),
        endToEndLogicalRequestsPerSolvedTask: solved ? endToEndRequests.length / solved : null,
        observedToolCalls: accounting.toolEvents.filter(row => row.arm === arm).length,
        childWallMilliseconds, endToEndChildWallMilliseconds: childWallMilliseconds + (arm === 'procedural-memory' ? acquisitionWallMilliseconds : 0),
        incompleteChildReports: selected.filter(row => !row.report).length }];
    }));
    const report = { schema: SCHEMA, status: 'completed', modelIdentity: config.modelIdentity, manifestDigest: config.manifestDigest,
      dispatchManifestSha256: manifestSha256, sourceHashes: manifest.sourceHashes, startedAt, completedAt: new Date().toISOString(),
      processId: process.pid, processNonce: config.processNonce, wallMilliseconds: Math.round(performance.now() - began),
      caseManifest: cases, acquisition, tasks, byArm, accounting,
      memoryPreservation: { acquiredBeforeSha256: snapshotInfo.byteSha256, acquiredAfterSha256: hash(await readFile(snapshotInfo.path)),
        baselineBeforeSha256: emptyBytesHash, baselineAfterSha256: hash(await readFile(emptyPath)) },
      isolation: manifest.isolation, memoryCreationCostCountedOnce: true, modelServerRestartClaimed: false };
    await artifact(directory, 'report.json', report);
    await artifact(directory, 'completed.json', { completedAt: new Date().toISOString(), reportSha256: hash(encoded(report)),
      manifestSha256, processId: process.pid, processNonce: config.processNonce });
    process.stdout.write(JSON.stringify({ completed: true, tasks: 16, logicalRequests: accounting.logicalRequests.length, byArm }) + '\n');
  } catch (error) {
    const recoveredAccounting = await aggregateAccounting([acquisition?.report?.accounting, ...tasks.map(row => row.report?.accounting)].filter(Boolean), children,
      client?.accounting() ?? { transport: [] });
    await artifact(directory, 'failed.json', { schema: SCHEMA, status: 'failed', error: message(error), modelIdentity: config.modelIdentity,
      manifestDigest: config.manifestDigest, dispatchManifestSha256: manifestSha256 ?? null, sourceHashes: manifest?.sourceHashes ?? null,
      children, tasks, acquisition: acquisition ?? null, accounting: recoveredAccounting,
      parentAccounting: client?.accounting() ?? null, failedAt: new Date().toISOString() });
    process.stderr.write('Procedural-memory pilot stopped; inspect its output directory.\n'); process.exitCode = 1;
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
    const tags = { arm: child.arm, caseIndex: child.caseIndex, processId: child.processId, processNonce: child.processNonce };
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
    const attempts = transport.filter(wire => wire.logicalRequestId === row.id);
    if (attempts.length) { row.inferenceDispatched = true; row.transportAttempts = Math.max(row.transportAttempts ?? 0, ...attempts.map(wire => wire.requestAttempt)); }
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
