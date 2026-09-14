import { mkdir, readFile, open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { evaluateContinualTask, replayContinualTask } from '../src/continualLearningEvaluation.js';
import { createContinualResearchTransport } from '../src/continualResearchTransport.js';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!['--config', '--config-sha256'].includes(key) || args[key] || !process.argv[i + 1]) throw new Error('Invalid arguments');
  args[key] = process.argv[i + 1];
}
const hash = b => createHash('sha256').update(b).digest('hex');
const bytes = await readFile(resolve(args['--config']));
if (hash(bytes) !== args['--config-sha256']) throw new Error('Configuration hash mismatch');
const config = JSON.parse(bytes);
const allowed = ['schema', 'panelPath', 'panelSha256', 'output', 'model', 'weightsSha256', 'apiKeyFile', 'baseUrl', 'maxMinutes', 'maxModelCalls', 'seed'];
if (config.schema !== 'amos.continual-panel-config.v1' || Object.keys(config).length !== allowed.length || Object.keys(config).some(k => !allowed.includes(k)) ||
    typeof config.model !== 'string' || !config.model || !/^[a-f0-9]{64}$/.test(config.panelSha256) ||
    !/^[a-f0-9]{64}$/.test(config.weightsSha256) || !Number.isInteger(config.seed) || !Number.isInteger(config.maxMinutes) || config.maxMinutes < 1 || config.maxMinutes > 600) throw new Error('Invalid panel configuration');
const panelBytes = await readFile(resolve(config.panelPath));
if (hash(panelBytes) !== config.panelSha256) throw new Error('Panel hash mismatch');
const panel = JSON.parse(panelBytes);
if (!Array.isArray(panel) || !panel.length || panel.length > 512 || new Set(panel.map(t => t.id)).size !== panel.length ||
    config.maxModelCalls !== panel.length * 4) throw new Error('Invalid panel or call budget');
const directory = resolve(config.output);
await mkdir(directory); // Existing directory means possibly consumed: never redispatch automatically.
const journal = await open(resolve(directory, 'events.jsonl'), 'ax', 0o600);
async function onEvent(event) {
  await journal.writeFile(JSON.stringify({ recordedAt: new Date().toISOString(), ...event }) + '\n');
  await journal.sync();
}
const results = [];
const startedAt = new Date().toISOString(), configSha256 = hash(bytes);
let transport;
try {
  await writeFile(resolve(directory, 'config.json'), bytes, { flag: 'wx', mode: 0o600 });
  await writeFile(resolve(directory, 'panel.json'), panelBytes, { flag: 'wx', mode: 0o600 });
  const apiKey = (await readFile(config.apiKeyFile, 'utf8')).trim();
  transport = createContinualResearchTransport({ baseUrl: config.baseUrl, model: config.model, apiKey,
    maxRequests: config.maxModelCalls, maxMilliseconds: config.maxMinutes * 60000, onEvent });
  const signal = AbortSignal.timeout(config.maxMinutes * 60000);
  await onEvent({ type: 'panel-start', processId: process.pid, startedAt, configSha256,
    model: config.model, weightsSha256: config.weightsSha256, panelSha256: config.panelSha256,
    note: 'Weight identity supplied by supervising serving proof; this process cannot inspect GPU weights.' });
  for (const task of panel) {
    const result = await evaluateContinualTask({ task, request: transport.request, onEvent, signal, seed: config.seed });
    replayContinualTask(task, result);
    results.push(result);
  }
  signal.throwIfAborted();
  const accounting = transport.accounting();
  if (accounting.stopped || accounting.unknownUsageRequests || accounting.failedRequests || accounting.integrityFailures ||
      accounting.logicalRequests !== accounting.requests || accounting.requests !== results.reduce((sum, result) => sum + result.modelCalls, 0) ||
      accounting.elapsedMilliseconds >= config.maxMinutes * 60000) throw new Error('Panel evidence or budget incomplete');
  const report = { schema: 'amos.continual-panel-result.v1', complete: true, processId: process.pid, startedAt, configSha256, completedAt: new Date().toISOString(),
    model: config.model, weightsSha256: config.weightsSha256, panelSha256: config.panelSha256,
    nativePasses: results.filter(r => r.verdict.passed).length, total: panel.length, accounting, results };
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ complete: true, nativePasses: report.nativePasses, total: panel.length, accounting: report.accounting }));
} catch (error) {
  await writeFile(resolve(directory, 'failure.json'), JSON.stringify({ complete: false, processId: process.pid, startedAt, configSha256,
    panelSha256: config.panelSha256, error: String(error.message), completedTasks: results.length,
    results, accounting: transport?.accounting() ?? null, noAutomaticRetry: true }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  throw error;
} finally { await journal.close(); }
