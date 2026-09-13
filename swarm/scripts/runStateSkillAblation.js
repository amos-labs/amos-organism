#!/usr/bin/env node
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { OpenAiResearchWorker } from '../src/openAiResearchWorker.js';
import { runStateSkillExperiment } from '../src/stateSkillExperiment.js';

const options = {};
const allowed = new Set(['base-url', 'model', 'weights-sha256', 'api-key-file', 'output', 'seed', 'repetitions', 'deadline-minutes', 'max-output-tokens']);
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]?.replace(/^--/, '');
  if (!process.argv[i]?.startsWith('--') || !allowed.has(key) || !process.argv[i + 1] || key in options) throw new Error('Invalid or repeated CLI argument');
  options[key] = process.argv[i + 1];
}
for (const key of ['base-url', 'model', 'weights-sha256', 'api-key-file', 'output']) if (!options[key]) throw new Error(`--${key} is required`);
const digest = (text) => createHash('sha256').update(text).digest('hex');
const integer = (name, fallback, max) => {
  const value = Number(options[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid --${name}`);
  return value;
};
const seed = integer('seed', 20260913, 2_147_470_000);
const repetitions = integer('repetitions', 1, 16);
const deadlineMinutes = integer('deadline-minutes', 60, 240);
const maxOutputTokens = integer('max-output-tokens', 2048, 8192);
const directory = resolve(options.output);
const apiKey = (await readFile(options['api-key-file'], 'utf8')).trim();
if (!apiKey) throw new Error('Empty API key file');
const modelIdentity = { model: options.model, weightsSha256: options['weights-sha256'], source: 'Operator-supplied identity; bind independently to serving evidence before interpreting results' };
const signal = AbortSignal.timeout(deadlineMinutes * 60_000);
const attempts = [];
let activeRequest = { phase: 'probe', caseId: 'probe', arm: null };
let incompleteInferenceRequest = false;
const sourcePaths = ['./runStateSkillAblation.js', '../src/stateSkillExperiment.js', '../src/checkedProcedure.js', '../src/observedTaskState.js', '../evals/stateSkillFixture.js', '../src/openAiResearchWorker.js', '../src/experimentProtocol.js', '../../src/digest.ts'];
const sourceHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [path, digest(await readFile(new URL(path, import.meta.url)))])));
let requestOrdinal = 0;
const worker = new OpenAiResearchWorker({ controlId: 'state-skill-ablation-v1', model: options.model, baseUrl: options['base-url'], apiKey, dialect: 'qwen', reasoningEffort: 'none', temperature: 0, seed, requestTimeoutMs: 120_000,
  fetchImpl: async (url, init) => {
    const ordinal = ++requestOrdinal;
    const started = performance.now();
    const entry = { ordinal, ...activeRequest, path: new URL(url).pathname, startedAt: new Date().toISOString(), requestSha256: init.body ? digest(init.body) : null };
    await appendFile(resolve(directory, 'transport.jsonl'), JSON.stringify({ ...entry, phase: 'started' }) + '\n');
    try {
      const response = await fetch(url, init);
      entry.status = response.status;
      return response;
    } catch (error) {
      entry.error = String(error.message ?? error);
      throw error;
    } finally {
      entry.headerWallMilliseconds = Math.round(performance.now() - started);
      attempts.push(entry);
      await appendFile(resolve(directory, 'transport.jsonl'), JSON.stringify({ ...entry, phase: 'finished' }) + '\n');
    }
  }
});
// Exclusive directory creation is intentional: an interrupted run must be reconciled,
// not silently repeated under the same identity. This CLI is a bounded experiment tool.
await mkdir(directory, { recursive: false });
const manifest = { schema: 'amos.state-skill-ablation-dispatch.v1', startedAt: new Date().toISOString(), modelIdentity, seed, repetitions, deadlineMinutes, maxOutputTokens, temperature: 0, thinking: false, nodeVersion: process.version, sourceHashes, scope: 'Synthetic development diagnostic only; no live business tools', automaticResume: false, requestCapsAreLogical: true, maximumTransportAttemptsPerLogicalRequest: 4, maximumLogicalRequestsPerArmIncludingCompilation: 16 * 7 * repetitions, maximumInferenceTransportAttemptsPerArm: 4 * 16 * 7 * repetitions, transportTimingsEndAtHeaders: true };
await writeFile(resolve(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const eventsFile = resolve(directory, 'events.jsonl');
try {
  const probe = await worker.probe({ signal });
  await writeFile(resolve(directory, 'probe.json'), JSON.stringify(probe, null, 2) + '\n');
  const report = await runStateSkillExperiment({ modelIdentity, seed, repetitions, signal,
    onEvent: async (event) => {
      await appendFile(eventsFile, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
      if (event.type === 'case-result') process.stdout.write(JSON.stringify({ caseId: event.caseId, arm: event.arm, pass: event.pass, termination: event.termination }) + '\n');
    },
    request: async ({ caseId, messages, tools, phase, signal: requestSignal }) => {
      activeRequest = { caseId, phase, arm: phase === 'compile' ? caseId.split('-')[1] : caseId.match(/-([ABCD])-turn-/)?.[1] ?? null };
      try {
        return await worker.runCase({ caseId, messages, tools, signal: requestSignal, maxOutputTokens, dataManifestDigest: digest(JSON.stringify(manifest)) });
      } catch (error) {
        incompleteInferenceRequest = true;
        throw error;
      }
    },
  });
  report.transport = { attempts, count: attempts.length, successfulResponseUsageOnly: true, maximumAttemptsPerLogicalRequest: 4, unresolvedAttemptCost: incompleteInferenceRequest || attempts.some((entry) => entry.error || entry.status >= 500) };
  report.sourceHashes = sourceHashes;
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(resolve(directory, 'completed.json'), JSON.stringify({ completedAt: new Date().toISOString(), reportSha256: digest(JSON.stringify(report, null, 2) + '\n'), byArm: report.byArm }, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ completed: true, byArm: report.byArm }) + '\n');
} catch (error) {
  await writeFile(resolve(directory, 'failed.json'), JSON.stringify({ failedAt: new Date().toISOString(), error: String(error.message ?? error), transportAttempts: attempts.length, restartRequiresReconciliation: true }, null, 2) + '\n');
  process.stderr.write('State/skill diagnostic stopped; inspect the private result directory.\n');
  process.exitCode = 1;
}
