#!/usr/bin/env node
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { AsyncLocalStorage } from 'node:async_hooks';
import { OpenAiResearchWorker } from '../src/openAiResearchWorker.js';
import { runSequentialSkillStage } from '../src/sequentialSkillLearning.js';
import { loadSkillLibrary, saveSkillLibrary, validateSkillLibrary } from '../src/persistentSkillLibrary.js';

const BASE_SEED = 20260913;
const MAX_MODEL_CALLS_PER_TASK = 24;
const MAX_TOOL_CALLS_PER_TASK = 64;
const TASK_TIMEOUT_MS = 180_000;
const MAX_COMPILE_REQUESTS = 3;
const MAX_TRANSPORT_ATTEMPTS = 4; // Pinned by the recorded OpenAiResearchWorker source.
const CONTEXT_WINDOW_TOKENS = 8192;
const TOKENIZER_TIMEOUT_MS = 10_000;
const OUTPUT_TOKENS = { compile: 3072, execute: 1536 };
const hash = value => createHash('sha256').update(value).digest('hex');
const encoded = value => JSON.stringify(value, null, 2) + '\n';
const message = error => String(error?.message ?? error);
const options = {};
const allowed = new Set(['stage', 'replicate', 'output', 'prior', 'model', 'weights-sha256',
  'base-url', 'api-key-file', 'manifest-digest', 'max-minutes']);
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]?.replace(/^--/, '');
  if (!process.argv[index]?.startsWith('--') || !allowed.has(key) ||
      !process.argv[index + 1] || Object.hasOwn(options, key)) throw new Error('Invalid or repeated CLI argument');
  options[key] = process.argv[index + 1];
}
for (const key of ['stage', 'replicate', 'output', 'model', 'weights-sha256', 'api-key-file', 'manifest-digest']) {
  if (!options[key]) throw new Error(`--${key} is required`);
}
if (!['A', 'B'].includes(options.stage)) throw new Error('--stage must be A or B');
if (options.stage === 'B' ? !options.prior : Object.hasOwn(options, 'prior')) {
  throw new Error('--prior is required for stage B and forbidden for stage A');
}
for (const key of ['weights-sha256', 'manifest-digest']) {
  if (!/^[a-f0-9]{64}$/.test(options[key])) throw new Error(`--${key} must be a lowercase SHA-256 digest`);
}
function integer(name, fallback, minimum, maximum) {
  const value = Number(options[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid --${name}`);
  return value;
}
const stage = options.stage;
const replicate = integer('replicate', undefined, 0, 2);
const maxMinutes = integer('max-minutes', 30, 1, 240);
const modelSeed = BASE_SEED + replicate * 101;
const directory = resolve(options.output);
const modelIdentity = { model: options.model, weightsSha256: options['weights-sha256'] };
const manifestDigest = options['manifest-digest'];
const executionCases = stage === 'A' ? 6 : 13;
const maximumExecutionRequests = executionCases * MAX_MODEL_CALLS_PER_TASK;
const maximumInferenceAttempts = (MAX_COMPILE_REQUESTS + maximumExecutionRequests) * MAX_TRANSPORT_ATTEMPTS;
const counts = { compile: 0, execute: 0 };
const transport = [];
const tokenizations = [];
const logicalRequests = [];
const context = new AsyncLocalStorage();
let transportOrdinal = 0;
let incompleteInferenceRequest = false;
let manifest = null;
let dispatchManifestSha256 = null;
const startedAt = new Date().toISOString();
const started = performance.now();
const signal = AbortSignal.timeout(maxMinutes * 60_000);
const append = (name, event) => appendFile(resolve(directory, name), JSON.stringify(event) + '\n', { mode: 0o600 });
const artifact = (name, value) => writeFile(resolve(directory, name), encoded(value), { flag: 'wx', mode: 0o600 });

// An existing output directory is a prior dispatch, never an instruction to resume.
await mkdir(directory, { recursive: false, mode: 0o700 });
try {
  let prior = null;
  let priorEvidence = null;
  if (stage === 'B') {
    const priorPath = resolve(options.prior);
    const priorBytes = await readFile(priorPath);
    prior = JSON.parse(priorBytes.toString('utf8'));
    if (prior.stage !== 'A' || prior.replicate !== replicate || prior.seed !== BASE_SEED) {
      throw new Error('Prior report must be stage A from this replicate and seed');
    }
    if (!Number.isSafeInteger(prior.processId) || prior.processId <= 0 || prior.processId === process.pid) {
      throw new Error('Stage B requires a prior report from a different recorded processId');
    }
    if (prior.modelIdentity?.model !== modelIdentity.model || prior.modelIdentity?.weightsSha256 !== modelIdentity.weightsSha256 ||
        prior.manifestDigest !== manifestDigest) throw new Error('Prior report has a different model or experiment manifest');
    const embeddedLibrary = validateSkillLibrary(prior.library);
    const libraryPath = resolve(dirname(priorPath), 'library.json');
    const library = await loadSkillLibrary(libraryPath);
    if (library.digest !== embeddedLibrary.digest || library.modelIdentity.model !== modelIdentity.model ||
        library.modelIdentity.weightsSha256 !== modelIdentity.weightsSha256) throw new Error('Prior persisted library differs from the report or model');
    const completed = JSON.parse(await readFile(resolve(dirname(priorPath), 'completed.json'), 'utf8'));
    if (completed.reportSha256 !== hash(priorBytes)) throw new Error('Prior report is not bound to its completed artifact');
    prior.library = library;
    priorEvidence = { reportPath: priorPath, reportSha256: hash(priorBytes), libraryPath,
      libraryDigest: library.digest, processId: prior.processId, reloadedInProcessId: process.pid };
  }
  const apiKey = (await readFile(options['api-key-file'], 'utf8')).trim();
  if (!apiKey) throw new Error('Empty API key file');
  const sourceHashes = await collectSourceHashes(new URL(import.meta.url));
  if (prior && canonicalHashes(prior.sourceHashes) !== canonicalHashes(sourceHashes)) {
    throw new Error('Stage B source hashes differ from its prior stage A dispatch');
  }
  manifest = {
    schema: 'amos.sequential-skill-stage-dispatch.v1', startedAt, stage, replicate, seed: BASE_SEED,
    processId: process.pid, nodeVersion: process.version, modelIdentity, manifestDigest, prior: priorEvidence,
    maxMinutes, baseUrl: options['base-url'] ?? 'http://127.0.0.1:8001', sourceHashes,
    modelSettings: { compile: { temperature: 1, seed: modelSeed, maxOutputTokens: OUTPUT_TOKENS.compile },
      execute: { temperature: 0, seed: modelSeed, maxOutputTokens: OUTPUT_TOKENS.execute }, thinking: false },
    limits: { maxCompilationRequests: MAX_COMPILE_REQUESTS, executionCases, maxModelCallsPerTask: MAX_MODEL_CALLS_PER_TASK,
      maxToolCallsPerTask: MAX_TOOL_CALLS_PER_TASK, taskTimeoutMs: TASK_TIMEOUT_MS, requestTimeoutMs: 120_000,
      maximumExecutionLogicalRequests: maximumExecutionRequests, maximumTransportAttemptsPerLogicalRequest: MAX_TRANSPORT_ATTEMPTS,
      maximumInferenceTransportAttempts: maximumInferenceAttempts, maximumProbeTransportAttempts: MAX_TRANSPORT_ATTEMPTS,
      servingContextWindowTokens: CONTEXT_WINDOW_TOKENS, promptFitCheckedByCli: true,
      maximumTokenizerRequestsPerLogicalRequest: 1, tokenizerTimeoutMs: TOKENIZER_TIMEOUT_MS,
      maximumTokenizerRequests: MAX_COMPILE_REQUESTS + maximumExecutionRequests },
    requestCapsAreLogical: true, actualGpuTimeMeasured: false, transportTimingsEndAtHeaders: true,
    automaticResume: false, scope: 'Synthetic sequential executable-skill learning and catalog-interference diagnostic; no weight updates, neural recurrence, production tools or promotion',
    servingIdentity: 'Operator-supplied model and adapter identity; bind independently to serving evidence'
  };
  dispatchManifestSha256 = hash(encoded(manifest));
  await artifact('manifest.json', manifest);

  const loggedFetch = async (url, init) => {
    const request = context.getStore();
    if (!request) throw new Error('Transport request lacks dispatch context');
    if (request.transportAttempts >= MAX_TRANSPORT_ATTEMPTS) throw new Error('Transport attempt budget exhausted');
    request.transportAttempts += 1;
    const entry = { ordinal: ++transportOrdinal, logicalRequestId: request.id, stage, replicate,
      phase: request.phase, caseId: request.caseId, requestAttempt: request.transportAttempts,
      path: new URL(url).pathname, startedAt: new Date().toISOString(), requestSha256: init.body ? hash(init.body) : null };
    const began = performance.now();
    await append('transport.jsonl', { ...entry, lifecycle: 'started' });
    try {
      if (request.phase !== 'probe') request.inferenceDispatched = true;
      const response = await fetch(url, init);
      entry.status = response.status;
      return response;
    } catch (error) {
      entry.error = message(error);
      throw error;
    } finally {
      entry.headerWallMilliseconds = Math.round(performance.now() - began);
      transport.push(entry);
      await append('transport.jsonl', { ...entry, lifecycle: 'finished' });
    }
  };
  const worker = phase => new OpenAiResearchWorker({ controlId: `sequential-skill-learning-${phase}-v1`,
    model: modelIdentity.model, baseUrl: manifest.baseUrl, apiKey, dialect: 'qwen', reasoningEffort: 'none',
    temperature: phase === 'compile' ? 1 : 0, seed: modelSeed, requestTimeoutMs: 120_000, fetchImpl: loggedFetch });
  const workers = { compile: worker('compile'), execute: worker('execute') };
  const tokenizerPreflight = async (request, messages, tools, requestSignal) => {
    const body = JSON.stringify({ model: modelIdentity.model, messages,
      ...(tools?.length > 0 ? { tools } : {}), add_generation_prompt: true,
      chat_template_kwargs: { enable_thinking: false } });
    const entry = { logicalRequestId: request.id, phase: request.phase, caseId: request.caseId, stage, replicate,
      startedAt: new Date().toISOString(), requestSha256: hash(body), status: 'started',
      count: null, max_model_len: null, maxOutputTokens: request.maxOutputTokens };
    const began = performance.now();
    tokenizations.push(entry);
    await append('tokenizer.jsonl', { ...entry });
    try {
      let response;
      try {
        response = await fetch(new URL('/tokenize', workers.execute.baseUrl), { method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body,
          redirect: 'error', signal: AbortSignal.any([signal, ...(requestSignal ? [requestSignal] : []),
            AbortSignal.timeout(TOKENIZER_TIMEOUT_MS)]) });
      } catch {
        throw new Error('Tokenizer request failed or was aborted');
      }
      entry.httpStatus = response.status;
      if (!response.ok) throw new Error(`Tokenizer returned HTTP ${response.status}`);
      let payload;
      try { payload = await response.json(); } catch { throw new Error('Tokenizer response was not valid JSON'); }
      if (!Number.isSafeInteger(payload?.count) || payload.count < 0 ||
          !Number.isSafeInteger(payload?.max_model_len) || payload.max_model_len <= 0) {
        throw new Error('Tokenizer response requires integer count and positive integer max_model_len');
      }
      entry.count = payload.count;
      entry.max_model_len = payload.max_model_len;
      entry.effectiveContextWindowTokens = Math.min(CONTEXT_WINDOW_TOKENS, payload.max_model_len);
      if (entry.count + request.maxOutputTokens > entry.effectiveContextWindowTokens) {
        throw new Error(`Context budget exceeded before inference: ${entry.count} prompt + ${request.maxOutputTokens} output > ${entry.effectiveContextWindowTokens}`);
      }
      entry.status = 'passed';
      return entry;
    } catch (error) {
      entry.status = 'rejected';
      entry.error = message(error);
      throw error;
    } finally {
      entry.wallMilliseconds = Math.round(performance.now() - began);
      await append('tokenizer.jsonl', { ...entry });
    }
  };
  const probeContext = { id: 'probe', phase: 'probe', caseId: 'probe', transportAttempts: 0 };
  const probe = await context.run(probeContext, () => workers.execute.probe({ signal }));
  await artifact('probe.json', { ...probe, processId: process.pid, transportAttempts: probeContext.transportAttempts });
  const report = await runSequentialSkillStage({ stage, replicate, seed: BASE_SEED, modelIdentity, prior, signal,
    maxModelCallsPerTask: MAX_MODEL_CALLS_PER_TASK, maxToolCallsPerTask: MAX_TOOL_CALLS_PER_TASK, taskTimeoutMs: TASK_TIMEOUT_MS,
    onEvent: async event => {
      await append('events.jsonl', { ...event, at: new Date().toISOString(), processId: process.pid });
      if (event.type === 'case-result') process.stdout.write(JSON.stringify({ caseId: event.caseId, stage, replicate,
        arm: event.arm, pass: event.pass, termination: event.termination }) + '\n');
    },
    request: async ({ phase, caseId, messages, tools, signal: requestSignal }) => {
      if (!['compile', 'execute'].includes(phase)) throw new Error('Unknown inference request phase');
      const ceiling = phase === 'compile' ? MAX_COMPILE_REQUESTS : maximumExecutionRequests;
      if (counts[phase] >= ceiling) throw new Error(`Stage ${phase} logical request budget exhausted`);
      if (signal.aborted || requestSignal?.aborted) throw new Error('Stage deadline or abort');
      const entry = { id: `${phase}-${++counts[phase]}`, phase, caseId, stage, replicate, transportAttempts: 0,
        startedAt: new Date().toISOString(), temperature: phase === 'compile' ? 1 : 0, seed: modelSeed,
        maxOutputTokens: OUTPUT_TOKENS[phase], inferenceDispatched: false, status: 'started' };
      logicalRequests.push(entry);
      await append('events.jsonl', { type: 'inference-request-start', ...entry });
      const began = performance.now();
      try {
        entry.tokenizer = await tokenizerPreflight(entry, messages, tools, requestSignal);
        const response = await context.run(entry, () => workers[phase].runCase({ caseId, messages, tools,
          signal: requestSignal ? AbortSignal.any([signal, requestSignal]) : signal,
          maxOutputTokens: OUTPUT_TOKENS[phase], dataManifestDigest: manifestDigest }));
        entry.status = 'returned';
        entry.metrics = response.metrics;
        entry.usage = observedUsage(response.providerResponse);
        entry.promptTokenCheck = { tokenizerCount: entry.tokenizer.count, actualPromptTokens: entry.usage.promptTokens,
          delta: entry.usage.promptTokens === null ? null : entry.usage.promptTokens - entry.tokenizer.count,
          exactMatch: entry.usage.promptTokens === null ? null : entry.usage.promptTokens === entry.tokenizer.count };
        await append('events.jsonl', { type: 'inference-response', logicalRequestId: entry.id, stage, replicate, phase, caseId,
          promptTokenCheck: entry.promptTokenCheck, response });
        return response;
      } catch (error) {
        entry.status = entry.inferenceDispatched ? 'failed' : 'rejected-before-inference';
        entry.error = message(error);
        if (entry.inferenceDispatched && !entry.usage) incompleteInferenceRequest = true;
        throw error;
      } finally {
        entry.wallMilliseconds = Math.round(performance.now() - began);
        await append('events.jsonl', { type: 'inference-request-finished', ...entry });
      }
    }
  });
  if (report.stage !== stage || report.replicate !== replicate || report.seed !== BASE_SEED || report.processId !== process.pid) {
    throw new Error('Core report identity differs from this dispatch');
  }
  await saveSkillLibrary(resolve(directory, 'library.json'), report.library);
  const completeReport = { ...report, processId: process.pid, manifestDigest, dispatchManifestSha256, sourceHashes,
    priorReload: priorEvidence, stageWallMilliseconds: Math.round(performance.now() - started),
    inferenceAccounting: { counts, logicalRequests, maximumCompileRequests: MAX_COMPILE_REQUESTS,
      maximumExecutionRequests, usageAvailableOnlyForReturnedResponses: true, actualGpuTimeMeasured: false,
      usage: usageSummary(logicalRequests) },
    tokenizer: { requests: tokenizations, count: tokenizations.length, maximumAttemptsPerLogicalRequest: 1,
      timeoutMs: TOKENIZER_TIMEOUT_MS, includedInInferenceTransportAttempts: false,
      promptTokenAgreementMustBeReadFromReturnedResponses: true },
    transport: { attempts: transport, count: transport.length, maximumAttemptsPerLogicalRequest: MAX_TRANSPORT_ATTEMPTS,
      maximumInferenceAttempts, timingsEndAtHeaders: true,
      unresolvedAttemptCost: incompleteInferenceRequest || transport.some(entry => entry.phase !== 'probe' && (entry.error || entry.status >= 400)) } };
  await artifact('report.json', completeReport);
  await artifact('completed.json', { completedAt: new Date().toISOString(), stage, replicate, processId: process.pid,
    reportSha256: hash(encoded(completeReport)), libraryDigest: report.library.digest, manifestDigest, dispatchManifestSha256 });
  process.stdout.write(JSON.stringify({ completed: true, stage, replicate, processId: process.pid,
    libraryDigest: report.library.digest, results: report.results.length }) + '\n');
} catch (error) {
  await artifact('failed.json', { failedAt: new Date().toISOString(), stage, replicate, processId: process.pid,
    modelIdentity, manifestDigest, dispatchManifestSha256, error: message(error), logicalRequestCounts: counts,
    transportAttempts: transport.length, tokenizerRequests: tokenizations.length,
    incompleteInferenceRequest, restartRequiresReconciliation: true });
  process.stderr.write('Sequential skill stage stopped; inspect its output directory.\n');
  process.exitCode = 1;
}

function observedUsage(payload) {
  const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  return { promptTokens: numeric(payload?.timings?.prompt_n ?? payload?.usage?.prompt_tokens),
    outputTokens: numeric(payload?.timings?.predicted_n ?? payload?.usage?.completion_tokens) };
}

function usageSummary(requests) {
  return Object.fromEntries(['compile', 'execute'].map(phase => {
    const entries = requests.filter(entry => entry.phase === phase);
    const dispatched = entries.filter(entry => entry.inferenceDispatched);
    const known = dispatched.filter(entry => entry.usage?.promptTokens !== null && entry.usage?.promptTokens !== undefined &&
      entry.usage?.outputTokens !== null && entry.usage?.outputTokens !== undefined);
    return [phase, { logicalRequests: entries.length, requestsDispatchedForInference: dispatched.length,
      rejectedBeforeInference: entries.length - dispatched.length, responsesWithKnownUsage: known.length,
      knownPromptTokens: known.reduce((sum, entry) => sum + entry.usage.promptTokens, 0),
      knownOutputTokens: known.reduce((sum, entry) => sum + entry.usage.outputTokens, 0),
      incomplete: known.length !== dispatched.length || dispatched.some(entry => entry.transportAttempts > 1) }];
  }));
}

function canonicalHashes(hashes) {
  if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes) ||
      Object.values(hashes).some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) {
    throw new Error('Recorded source hashes are invalid');
  }
  return JSON.stringify(Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right)));
}

async function collectSourceHashes(entry) {
  const hashes = {};
  const visited = new Set();
  async function visit(url) {
    const path = fileURLToPath(url);
    if (visited.has(path)) return;
    visited.add(path);
    const bytes = await readFile(path);
    hashes[path] = hash(bytes);
    const imports = [...bytes.toString('utf8').matchAll(/(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"](\.[^'"]+)['"]/g)];
    for (const match of imports) await visit(new URL(match[1], url));
  }
  await visit(entry);
  return hashes;
}
