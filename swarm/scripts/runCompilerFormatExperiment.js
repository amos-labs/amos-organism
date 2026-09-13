#!/usr/bin/env node
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { AsyncLocalStorage } from 'node:async_hooks';
import { OpenAiResearchWorker } from '../src/openAiResearchWorker.js';
import { runCompilerFormatExperiment } from '../src/compilerFormatExperiment.js';
import { saveSkillLibrary } from '../src/persistentSkillLibrary.js';

const BASE_SEED = 20260914;
const CONFORMANCE_SEED = 20260913;
const MAX_SCORED_REQUESTS = 36;
const MAX_CONFORMANCE_REQUESTS = 4;
const MAX_TRANSPORT_ATTEMPTS = 4;
const CONTEXT_WINDOW_TOKENS = 8192;
const TOKENIZER_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 120_000;
const OUTPUT_TOKENS = { conformance: 128, scored: 3072 };
const ARMS = ['free-form', 'json-object'];
const hash = value => createHash('sha256').update(value).digest('hex');
const encoded = value => JSON.stringify(value, null, 2) + '\n';
const message = error => String(error?.message ?? error);
const options = {};
const allowed = new Set(['output', 'model', 'weights-sha256', 'api-key-file', 'manifest-digest', 'base-url', 'max-minutes']);
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]?.replace(/^--/, '');
  if (!process.argv[index]?.startsWith('--') || !allowed.has(key) ||
      !process.argv[index + 1] || Object.hasOwn(options, key)) throw new Error('Invalid or repeated CLI argument');
  options[key] = process.argv[index + 1];
}
for (const key of ['output', 'model', 'weights-sha256', 'api-key-file', 'manifest-digest']) {
  if (!options[key]) throw new Error(`--${key} is required`);
}
for (const key of ['weights-sha256', 'manifest-digest']) {
  if (!/^[a-f0-9]{64}$/.test(options[key])) throw new Error(`--${key} must be a lowercase SHA-256 digest`);
}
const maxMinutes = Number(options['max-minutes'] ?? 30);
if (!Number.isSafeInteger(maxMinutes) || maxMinutes < 1 || maxMinutes > 240) throw new Error('Invalid --max-minutes');
const directory = resolve(options.output);
const modelIdentity = { model: options.model, weightsSha256: options['weights-sha256'] };
const manifestDigest = options['manifest-digest'];
const signal = AbortSignal.timeout(maxMinutes * 60_000);
const context = new AsyncLocalStorage();
const counts = { conformance: 0, scored: 0 };
const groupCounts = new Map();
const transport = [], tokenizations = [], logicalRequests = [];
const append = (name, event) => appendFile(resolve(directory, name), JSON.stringify(event) + '\n', { mode: 0o600 });
const artifact = (name, value) => writeFile(resolve(directory, name), encoded(value), { flag: 'wx', mode: 0o600 });
const startedAt = new Date().toISOString(), started = performance.now();
let manifest = null, dispatchManifestSha256 = null, conformance = null, incompleteInferenceRequest = false;

// Output directories are exclusive dispatch journals. There is no implicit resume.
await mkdir(directory, { recursive: false, mode: 0o700 });
try {
  const apiKey = (await readFile(options['api-key-file'], 'utf8')).trim();
  if (!apiKey) throw new Error('Empty API key file');
  const sourceHashes = await collectSourceHashes(new URL(import.meta.url));
  manifest = {
    schema: 'amos.compiler-format-dispatch.v1', startedAt, processId: process.pid, nodeVersion: process.version,
    modelIdentity, manifestDigest, sourceHashes, baseUrl: options['base-url'] ?? 'http://127.0.0.1:8001', maxMinutes,
    modelSettings: { temperature: 1, thinking: false, seedBase: BASE_SEED, replicateSeedStride: 101, conformanceSeed: CONFORMANCE_SEED,
      maxOutputTokens: OUTPUT_TOKENS, responseFormats: { 'free-form': null, 'json-object': { type: 'json_object' } } },
    limits: { maximumScoredLogicalRequests: MAX_SCORED_REQUESTS, maximumScoredRequestsPerArmFamilyReplicate: 3,
      maximumConformanceLogicalRequests: MAX_CONFORMANCE_REQUESTS,
      maximumTransportAttemptsPerLogicalRequest: MAX_TRANSPORT_ATTEMPTS,
      maximumScoredInferenceTransportAttempts: MAX_SCORED_REQUESTS * MAX_TRANSPORT_ATTEMPTS,
      maximumConformanceInferenceTransportAttempts: MAX_CONFORMANCE_REQUESTS * MAX_TRANSPORT_ATTEMPTS,
      maximumProbeTransportAttempts: MAX_TRANSPORT_ATTEMPTS, requestTimeoutMs: REQUEST_TIMEOUT_MS,
      servingContextWindowTokens: CONTEXT_WINDOW_TOKENS, promptFitCheckedByCli: true,
      maximumTokenizerRequestsPerLogicalRequest: 1, maximumTokenizerRequests: MAX_SCORED_REQUESTS + MAX_CONFORMANCE_REQUESTS,
      tokenizerTimeoutMs: TOKENIZER_TIMEOUT_MS },
    conformanceRequirement: 'Both constrained outputs parse as JSON objects without length termination; at least one free-form output fails raw JSON parsing',
    conformanceInterpretation: 'Observed behavior on two paired probes; not proof that the backend enforces a hard decoding constraint',
    requestCapsAreLogical: true, actualGpuTimeMeasured: false, transportTimingsEndAtHeaders: true,
    automaticResume: false, responseFormatFallback: false,
    scope: 'Synthetic compiler-format comparison with independent checked libraries; no weight updates, production tools or promotion',
    servingIdentity: 'Operator-supplied model and adapter identity; bind independently to serving evidence'
  };
  dispatchManifestSha256 = hash(encoded(manifest));
  await artifact('manifest.json', manifest);

  const loggedFetch = async (url, init) => {
    const request = context.getStore();
    if (!request) throw new Error('Transport request lacks dispatch context');
    if (request.transportAttempts >= MAX_TRANSPORT_ATTEMPTS) throw new Error('Transport attempt budget exhausted');
    const body = init.body ? JSON.parse(init.body) : null;
    if (request.scope !== 'probe') {
      request.responseFormatApplied = body?.response_format ?? null;
      if (JSON.stringify(request.responseFormatApplied) !== JSON.stringify(request.responseFormat)) {
        throw new Error('Actual inference response_format differs from the assigned arm');
      }
    }
    request.transportAttempts += 1;
    const bodyWithoutResponseFormat = body ? { ...body } : null;
    if (bodyWithoutResponseFormat) delete bodyWithoutResponseFormat.response_format;
    const entry = { ordinal: transport.length + 1, logicalRequestId: request.id, scope: request.scope,
      arm: request.arm, family: request.family, replicate: request.replicate, caseId: request.caseId,
      requestAttempt: request.transportAttempts, path: new URL(url).pathname, startedAt: new Date().toISOString(),
      requestSha256: init.body ? hash(init.body) : null,
      requestWithoutResponseFormatSha256: bodyWithoutResponseFormat ? hash(JSON.stringify(bodyWithoutResponseFormat)) : null,
      seed: body?.seed ?? null, temperature: body?.temperature ?? null, max_tokens: body?.max_tokens ?? null,
      responseFormatApplied: request.responseFormatApplied ?? null };
    const began = performance.now();
    await append('transport.jsonl', { ...entry, lifecycle: 'started' });
    try {
      if (request.scope !== 'probe') request.inferenceDispatched = true;
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
  const workers = new Map();
  const worker = modelSeed => {
    if (!workers.has(modelSeed)) workers.set(modelSeed, new OpenAiResearchWorker({ controlId: 'compiler-format-comparison-v1',
      model: modelIdentity.model, baseUrl: manifest.baseUrl, apiKey, dialect: 'qwen', reasoningEffort: 'none',
      temperature: 1, seed: modelSeed, requestTimeoutMs: REQUEST_TIMEOUT_MS, fetchImpl: loggedFetch }));
    return workers.get(modelSeed);
  };
  const initialWorker = worker(CONFORMANCE_SEED); // Validates the loopback endpoint before any fetch.
  const probeContext = { id: 'probe', scope: 'probe', caseId: 'probe', transportAttempts: 0 };
  const probe = await context.run(probeContext, () => initialWorker.probe({ signal }));
  await artifact('probe.json', { ...probe, processId: process.pid, transportAttempts: probeContext.transportAttempts });

  const tokenizerPreflight = async (request, messages, tools, requestSignal) => {
    const body = JSON.stringify({ model: modelIdentity.model, messages, ...(tools?.length ? { tools } : {}),
      add_generation_prompt: true, chat_template_kwargs: { enable_thinking: false } });
    const entry = { logicalRequestId: request.id, scope: request.scope, arm: request.arm, family: request.family,
      replicate: request.replicate, caseId: request.caseId, startedAt: new Date().toISOString(),
      requestSha256: hash(body), status: 'started', count: null, max_model_len: null, maxOutputTokens: request.maxOutputTokens };
    const began = performance.now();
    tokenizations.push(entry);
    await append('tokenizer.jsonl', { ...entry });
    try {
      let response;
      try {
        response = await fetch(new URL('/tokenize', initialWorker.baseUrl), { method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body, redirect: 'error',
          signal: AbortSignal.any([signal, ...(requestSignal ? [requestSignal] : []), AbortSignal.timeout(TOKENIZER_TIMEOUT_MS)]) });
      } catch { throw new Error('Tokenizer request failed or was aborted'); }
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
      entry.status = 'rejected'; entry.error = message(error); throw error;
    } finally {
      entry.wallMilliseconds = Math.round(performance.now() - began);
      await append('tokenizer.jsonl', { ...entry });
    }
  };

  const request = async ({ scope = 'scored', arm, family = null, replicate, modelSeed, responseFormat = null,
    phase, messages, tools = [], caseId, signal: requestSignal, temperature = 1, maxOutputTokens = OUTPUT_TOKENS[scope] }) => {
    if (!Object.hasOwn(counts, scope) || phase !== 'compile' || !ARMS.includes(arm)) throw new Error('Invalid compiler request scope, phase or arm');
    if (!Number.isSafeInteger(replicate) || replicate < 0 || replicate > 2 ||
        modelSeed !== (scope === 'conformance' ? CONFORMANCE_SEED : BASE_SEED + replicate * 101) ||
        temperature !== 1 || maxOutputTokens !== OUTPUT_TOKENS[scope]) throw new Error('Compiler request settings differ from the fixed protocol');
    const expectedFormat = arm === 'json-object' ? { type: 'json_object' } : null;
    if (JSON.stringify(responseFormat) !== JSON.stringify(expectedFormat)) throw new Error('Compiler response format differs from its arm');
    if (scope === 'scored' && !['reserve-order', 'invoice-order'].includes(family)) throw new Error('Unknown compiler workflow family');
    if (signal.aborted || requestSignal?.aborted) throw new Error('Stage deadline or abort');
    if (counts[scope] >= (scope === 'scored' ? MAX_SCORED_REQUESTS : MAX_CONFORMANCE_REQUESTS)) throw new Error(`${scope} logical request budget exhausted`);
    const groupKey = `${arm}/${family}/${replicate}`;
    if (scope === 'scored' && (groupCounts.get(groupKey) ?? 0) >= 3) throw new Error('Compiler arm/family/replicate request budget exhausted');
    if (scope === 'scored') groupCounts.set(groupKey, (groupCounts.get(groupKey) ?? 0) + 1);
    const entry = { id: `${scope}-${++counts[scope]}`, scope, arm, family, replicate, modelSeed, phase, caseId,
      responseFormat, temperature, maxOutputTokens, transportAttempts: 0, inferenceDispatched: false,
      startedAt: new Date().toISOString(), status: 'started' };
    logicalRequests.push(entry);
    await append('events.jsonl', { type: 'inference-request-start', ...entry });
    const began = performance.now();
    try {
      entry.tokenizer = await tokenizerPreflight(entry, messages, tools, requestSignal);
      const response = await context.run(entry, () => worker(modelSeed).runCase({ caseId, messages, tools,
        signal: requestSignal ? AbortSignal.any([signal, requestSignal]) : signal, maxOutputTokens,
        responseFormat, dataManifestDigest: manifestDigest }));
      entry.status = 'returned'; entry.metrics = response.metrics; entry.usage = observedUsage(response.providerResponse);
      entry.promptTokenCheck = { tokenizerCount: entry.tokenizer.count, actualPromptTokens: entry.usage.promptTokens,
        delta: entry.usage.promptTokens === null ? null : entry.usage.promptTokens - entry.tokenizer.count,
        exactMatch: entry.usage.promptTokens === null ? null : entry.usage.promptTokens === entry.tokenizer.count };
      await append('events.jsonl', { type: 'inference-response', logicalRequestId: entry.id, scope, arm, family, replicate, caseId,
        responseFormatApplied: entry.responseFormatApplied, promptTokenCheck: entry.promptTokenCheck, response });
      return response;
    } catch (error) {
      entry.status = entry.inferenceDispatched ? 'failed' : 'rejected-before-inference'; entry.error = message(error);
      if (entry.inferenceDispatched && !entry.usage) incompleteInferenceRequest = true;
      throw error;
    } finally {
      entry.wallMilliseconds = Math.round(performance.now() - began);
      await append('events.jsonl', { type: 'inference-request-finished', ...entry });
    }
  };

  const probes = [
    { id: 'literal-text', prompt: 'The word JSON appears only as a protocol marker. Reply with exactly NOT_JSON_CONFORMANCE and no other characters.' },
    { id: 'malformed-json', prompt: 'For a JSON syntax conformance test, output exactly {"ok": and stop. Do not repair or complete it.' }
  ];
  const rows = [];
  for (const [index, testCase] of probes.entries()) {
    const messages = [{ role: 'system', content: 'This is a response-format conformance probe. Follow the user\'s requested output precisely.' },
      { role: 'user', content: testCase.prompt }];
    for (const arm of index === 0 ? ARMS : [...ARMS].reverse()) {
      const row = { probeId: testCase.id, arm, modelSeed: CONFORMANCE_SEED, rawJsonParseFailure: false, jsonObject: false, lengthTerminated: null };
      try {
        row.response = await request({ scope: 'conformance', arm, replicate: 0, modelSeed: CONFORMANCE_SEED, phase: 'compile',
          responseFormat: arm === 'json-object' ? { type: 'json_object' } : null, messages, tools: [],
          caseId: `conformance-${testCase.id}-${arm}`, maxOutputTokens: OUTPUT_TOKENS.conformance });
        row.lengthTerminated = row.response.providerResponse?.choices?.[0]?.finish_reason === 'length';
        try {
          const parsed = JSON.parse(row.response.message?.content);
          row.jsonObject = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
        } catch { row.rawJsonParseFailure = true; }
      } catch (error) { row.error = message(error); }
      rows.push(row);
      await append('events.jsonl', { type: 'conformance-result', ...row });
    }
  }
  conformance = { passed: rows.filter(row => row.arm === 'json-object').every(row => !row.error && row.jsonObject && !row.lengthTerminated) &&
      rows.some(row => row.arm === 'free-form' && !row.error && row.rawJsonParseFailure), rows,
    interpretation: manifest.conformanceInterpretation, scoredRequestsDispatchedBeforeGate: counts.scored };
  await artifact('conformance.json', conformance);

  const accounting = () => ({ inferenceAccounting: { counts, logicalRequests, byScope: usageSummary(logicalRequests),
    actualGpuTimeMeasured: false, usageAvailableOnlyForReturnedResponses: true },
  tokenizer: { requests: tokenizations, count: tokenizations.length, includedInInferenceTransportAttempts: false,
    maximumAttemptsPerLogicalRequest: 1, timeoutMs: TOKENIZER_TIMEOUT_MS, promptTokenAgreementMustBeReadFromReturnedResponses: true },
  transport: { attempts: transport, count: transport.length, maximumAttemptsPerLogicalRequest: MAX_TRANSPORT_ATTEMPTS,
    timingsEndAtHeaders: true, unresolvedAttemptCost: incompleteInferenceRequest ||
      transport.some(entry => entry.scope !== 'probe' && (entry.error || entry.status >= 400)) } });
  const identity = { modelIdentity, processId: process.pid, manifestDigest, dispatchManifestSha256, sourceHashes };
  if (!conformance.passed) {
    await artifact('conformance-inconclusive.json', { ...identity, conformance, ...accounting() });
    await artifact('report.json', { schema: 'amos.compiler-format-experiment.v1', status: 'conformance-inconclusive',
      ...identity, conformance, runs: [], stageWallMilliseconds: Math.round(performance.now() - started), ...accounting() });
    throw new Error('Observed response-format conformance is inconclusive; scored experiment was not dispatched');
  }
  const report = await runCompilerFormatExperiment({ modelIdentity, signal, request: input => request({ ...input, scope: 'scored' }),
    onEvent: async event => {
      await append('events.jsonl', { ...event, at: new Date().toISOString(), processId: process.pid });
    } });
  if (report.logicalCompilerRequests !== counts.scored || report.maxLogicalCompilerRequests !== MAX_SCORED_REQUESTS || !Array.isArray(report.runs)) {
    throw new Error('Core report request accounting differs from this dispatch');
  }
  const persistedLibraries = [];
  for (const run of report.runs) {
    if (!ARMS.includes(run.arm) || !['reserve-order', 'invoice-order'].includes(run.family) ||
        !Number.isSafeInteger(run.replicate) || run.replicate < 0 || run.replicate > 2) throw new Error('Invalid result library identity');
    const filename = `library-${run.replicate}-${run.family}-${run.arm}.json`;
    await saveSkillLibrary(resolve(directory, filename), run.acquisition.library);
    persistedLibraries.push({ arm: run.arm, family: run.family, replicate: run.replicate, filename, digest: run.acquisition.library.digest });
  }
  const completeReport = { ...report, status: 'completed', ...identity, conformance, persistedLibraries,
    stageWallMilliseconds: Math.round(performance.now() - started), ...accounting() };
  await artifact('report.json', completeReport);
  await artifact('completed.json', { completedAt: new Date().toISOString(), ...identity,
    reportSha256: hash(encoded(completeReport)), persistedLibraries });
  process.stdout.write(JSON.stringify({ completed: true, processId: process.pid, scoredRequests: counts.scored,
    conformanceRequests: counts.conformance, runs: report.runs.length }) + '\n');
} catch (error) {
  await artifact('failed.json', { failedAt: new Date().toISOString(), processId: process.pid, modelIdentity, manifestDigest,
    dispatchManifestSha256, sourceHashes: manifest?.sourceHashes ?? null, error: message(error), logicalRequestCounts: counts,
    inferenceAccounting: usageSummary(logicalRequests), transportAttempts: transport.length, tokenizerRequests: tokenizations.length,
    incompleteInferenceRequest, conformancePassed: conformance?.passed ?? null, restartRequiresReconciliation: true });
  process.stderr.write('Compiler format experiment stopped; inspect its output directory.\n');
  process.exitCode = 1;
}

function observedUsage(payload) {
  const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  return { promptTokens: numeric(payload?.timings?.prompt_n ?? payload?.usage?.prompt_tokens),
    outputTokens: numeric(payload?.timings?.predicted_n ?? payload?.usage?.completion_tokens) };
}
function usageSummary(requests) {
  return Object.fromEntries(['conformance', 'scored'].map(scope => {
    const entries = requests.filter(entry => entry.scope === scope), dispatched = entries.filter(entry => entry.inferenceDispatched);
    const known = dispatched.filter(entry => entry.usage?.promptTokens != null && entry.usage?.outputTokens != null);
    return [scope, { logicalRequests: entries.length, requestsDispatchedForInference: dispatched.length,
      rejectedBeforeInference: entries.length - dispatched.length, responsesWithKnownUsage: known.length,
      knownPromptTokens: known.reduce((sum, entry) => sum + entry.usage.promptTokens, 0),
      knownOutputTokens: known.reduce((sum, entry) => sum + entry.usage.outputTokens, 0),
      incomplete: known.length !== dispatched.length || dispatched.some(entry => entry.transportAttempts > 1) }];
  }));
}
async function collectSourceHashes(entry) {
  const hashes = {}, visited = new Set();
  async function visit(url) {
    const path = fileURLToPath(url);
    if (visited.has(path)) return;
    visited.add(path);
    const bytes = await readFile(path);
    hashes[path] = hash(bytes);
    for (const match of bytes.toString('utf8').matchAll(/(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"](\.[^'"]+)['"]/g)) {
      await visit(new URL(match[1], url));
    }
  }
  await visit(entry);
  return hashes;
}
