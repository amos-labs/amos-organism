// Hard tier: reuse the Organism's checked procedure interpreter and native verifier.
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { acquireSequentialSkill, buildSequentialDemonstrations } from '../../src/sequentialSkillLearning.js';
import { emptySkillLibrary } from '../../src/persistentSkillLibrary.js';

const { values } = parseArgs({ options: Object.fromEntries(
  ['base-url', 'model', 'weights-sha256', 'seed', 'output', 'max-output-tokens'].map(name => [name, { type: 'string' }])
) });
for (const name of ['base-url', 'model', 'weights-sha256', 'seed', 'output']) {
  if (!values[name]) throw new Error('Missing --' + name);
}
const maxOutputTokens = Number(values['max-output-tokens'] ?? 3072);
if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 16384) {
  throw new Error('--max-output-tokens must be an integer between 1 and 16384');
}
const endpoint = new URL(values['base-url'].replace(/\/$/, '') + '/chat/completions');
if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(endpoint.hostname))) {
  throw new Error('Use HTTPS or loopback HTTP');
}
const identity = { model: values.model, weightsSha256: values['weights-sha256'] };
const headers = { 'Content-Type': 'application/json' };
if (process.env.AMOS_BENCH_API_KEY) headers.Authorization = 'Bearer ' + process.env.AMOS_BENCH_API_KEY;
const output = await open(values.output, 'wx');
try {
  for (const family of ['reserve-order', 'invoice-order']) {
    const seed = createHash('sha256').update(values.seed + '/' + family).digest().readUInt32BE(0) % 900_000;
    const demonstrations = await buildSequentialDemonstrations({ family, seed });
    const library = emptySkillLibrary({ modelIdentity: identity });
    const started = performance.now();
    let invalid = null;
    const request = async ({ messages }) => {
      if (invalid) throw new Error(invalid);
      try {
        const response = await fetch(endpoint, {
          method: 'POST', redirect: 'error', headers, signal: AbortSignal.timeout(180_000),
          body: JSON.stringify({model: values.model, messages, response_format: {type: 'json_object'},
            reasoning_effort: 'low', temperature: 0, seed: 17, max_tokens: maxOutputTokens}),
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const result = await response.json();
        if (result.model !== values.model) throw new Error('Unexpected model identity');
        return { message: result.choices[0].message, providerResponse: result };
      } catch (error) {
        invalid = String(error.message);
        throw error;
      }
    };
    const acquisition = await acquireSequentialSkill({ family, seed: seed + 1000, replicate: 0,
      modelIdentity: identity, library, demonstrations, request,
      onEvent: async event => {
        if (event.type === 'acquisition-attempt') {
          console.log(identity.model, family, 'attempt', event.attempt, event.error ?? 'accepted');
        }
      } });
    const attempts = acquisition.attempts.map(row => ({
      attempt: row.attempt, admitted: row.admitted, parseAndStructurePassed: Boolean(row.program),
      worldsPassed: row.validations?.filter(v => v.pass).length ?? 0,
      worldsChecked: row.validations?.length ?? 0, error: row.error ?? null,
      validation: (row.validations ?? []).map(v => ({
        variant: v.variant, completion: v.programResult.status, taskStateAchieved: v.verification.taskStateAchieved,
        evidenceComplete: v.verification.evidenceComplete, unsafeRetries: v.verification.unsafeRetries,
        sendAttempts: v.verification.sendAttempts, unrelatedChanges: v.verification.unrelatedChanges,
      })),
      usage: row.response?.providerResponse?.usage ?? null,
    }));
    const result = { family, model: identity.model, weightsSha256: identity.weightsSha256, seed: values.seed, maxOutputTokens,
      demonstrationsSha256: acquisition.demonstrationsSha256, attempts, invalid,
      admitted: invalid ? null : acquisition.admitted, seconds: (performance.now() - started) / 1000 };
    await output.writeFile(JSON.stringify(result) + '\n');
    console.log(identity.model, family, invalid ?? acquisition.admitted);
  }
} finally {
  await output.close();
}
