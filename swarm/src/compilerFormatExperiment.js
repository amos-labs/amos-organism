import { acquireSequentialSkill, buildSequentialDemonstrations, sequentialEvidenceHash } from './sequentialSkillLearning.js';
import { emptySkillLibrary } from './persistentSkillLibrary.js';

const ARMS = ['free-form', 'json-object'];
const FAMILIES = ['reserve-order', 'invoice-order'];
const MODEL_SEEDS = [20260914, 20261015, 20261116];
const TEMPERATURE = 1;
const MAX_OUTPUT_TOKENS = 3072;
const MAX_LOGICAL_REQUESTS = 36;
const clone = value => structuredClone(value);
const hash = sequentialEvidenceHash;

function checkAbort(signal) {
  if (signal?.aborted) throw new Error('Compiler format experiment aborted');
}

function classifyAttempt(attempt) {
  const content = attempt.response?.message?.content;
  let jsonParseStatus = attempt.response === undefined ? 'missing-response' : typeof content !== 'string' ? 'missing-text' : 'invalid';
  if (typeof content === 'string') {
    try {
      JSON.parse(content.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1'));
      jsonParseStatus = 'valid';
    } catch { /* Malformed candidates remain evidence; there is no host repair. */ }
  }
  const outputTruncated = attempt.response?.providerResponse?.choices?.[0]?.finish_reason === 'length';
  const astStatus = attempt.program !== undefined ? 'accepted'
    : jsonParseStatus === 'valid' && !outputTruncated ? 'rejected' : 'not-checked';
  const validations = attempt.validations ?? [];
  const nativeStatus = attempt.validations !== undefined ? (validations.every(row => row.pass) ? 'passed' : 'failed')
    : astStatus === 'accepted' ? 'incomplete' : 'not-run';
  const failureStage = attempt.admitted ? null : jsonParseStatus === 'missing-response' ? 'request'
    : outputTruncated ? 'output-budget' : jsonParseStatus === 'missing-text' ? 'response'
      : jsonParseStatus === 'invalid' ? 'json' : astStatus === 'rejected' ? 'ast' : 'native';
  const executionStatuses = {};
  for (const row of validations) executionStatuses[row.programResult.status] = (executionStatuses[row.programResult.status] ?? 0) + 1;
  return { jsonParseStatus, outputTruncated, astStatus, nativeStatus, failureStage,
    validationCases: validations.length, passedValidationCases: validations.filter(row => row.pass).length, executionStatuses };
}

function summarize(runs, arm) {
  const selected = runs.filter(run => run.arm === arm);
  const attempts = selected.flatMap(run => run.acquisition.attempts);
  const validations = attempts.flatMap(attempt => attempt.validations ?? []);
  const admitted = selected.filter(run => run.acquisition.admitted).length;
  const firstAttempts = selected.map(run => run.acquisition.attempts[0]);
  return { acquisitions: selected.length, admitted, failedAcquisitions: selected.length - admitted,
    admissionRate: admitted / selected.length,
    logicalCompilerRequests: selected.reduce((count, run) => count + run.requests.length, 0),
    compilationAttempts: attempts.length, attemptsWithResponse: attempts.filter(attempt => attempt.response !== undefined).length,
    parseableResponseAttempts: attempts.filter(attempt => attempt.classification.jsonParseStatus === 'valid').length,
    astValidatedAttempts: attempts.filter(attempt => attempt.program !== undefined).length,
    nativeValidationAttempts: attempts.filter(attempt => attempt.validations !== undefined).length,
    nativeValidationCases: validations.length, nativePassedCases: validations.filter(row => row.pass).length,
    firstAttempt: { acquisitions: firstAttempts.length,
      jsonParsed: firstAttempts.filter(attempt => attempt.classification.jsonParseStatus === 'valid').length,
      astAccepted: firstAttempts.filter(attempt => attempt.classification.astStatus === 'accepted').length,
      nativePassed: firstAttempts.filter(attempt => attempt.classification.nativeStatus === 'passed').length,
      admitted: firstAttempts.filter(attempt => attempt.admitted).length,
      outputTruncated: firstAttempts.filter(attempt => attempt.classification.outputTruncated).length } };
}

/** Compiler-only paired diagnostic. The existing compiler owns all admission and
 * TRAIN feedback; no evaluation task or retained skill from another run is used. */
export async function runCompilerFormatExperiment({ request, modelIdentity, onEvent = async () => {}, signal } = {}) {
  if (typeof request !== 'function') throw new Error('request required');
  if (typeof onEvent !== 'function') throw new Error('onEvent must be a function');
  const identity = emptySkillLibrary({ modelIdentity }).modelIdentity;
  checkAbort(signal);
  const startedAt = new Date().toISOString();
  const runs = [];
  let logicalCompilerRequests = 0;

  for (const [replicate, modelSeed] of MODEL_SEEDS.entries()) {
    for (const [familyIndex, family] of FAMILIES.entries()) {
      checkAbort(signal);
      const demonstrationSeed = (familyIndex === 0 ? 80_000 : 90_000) + replicate * 100;
      const acquisitionSeed = 100_000 + replicate * 100 + familyIndex * 1_000;
      const demonstrations = await buildSequentialDemonstrations({ family, seed: demonstrationSeed });
      const demonstrationsSha256 = hash(demonstrations);
      const arms = (replicate + familyIndex) % 2 ? [...ARMS].reverse() : ARMS;
      const pairedRuns = [];

      for (const arm of arms) {
        checkAbort(signal);
        const responseFormat = arm === 'json-object' ? { type: 'json_object' } : null;
        const tags = { arm, family, replicate, modelSeed };
        const prefix = caseId => `${arm}-${caseId}`;
        const requests = [];
        const inputIdentity = { modelIdentity: identity, family, replicate, modelSeed, demonstrationSeed, acquisitionSeed,
          demonstrationsSha256, temperature: TEMPERATURE, maxOutputTokens: MAX_OUTPUT_TOKENS };
        const run = { ...tags, demonstrationSeed, acquisitionSeed, validationSeedBase: acquisitionSeed + 10_000,
          temperature: TEMPERATURE, maxOutputTokens: MAX_OUTPUT_TOKENS, responseFormat: clone(responseFormat),
          inputIdentity, inputSha256: hash(inputIdentity), demonstrations: clone(demonstrations), demonstrationsSha256,
          firstInputSha256: null, requests };
        const emit = event => onEvent({ ...event, ...tags,
          ...(event.type === 'acquisition-attempt' ? { classification: classifyAttempt(event) } : {}),
          ...(event.caseId ? { sourceCaseId: event.caseId, caseId: prefix(event.caseId) } : {}) });
        await emit({ type: 'compiler-acquisition-start', inputSha256: run.inputSha256, demonstrationsSha256 });

        const acquired = await acquireSequentialSkill({ family, seed: acquisitionSeed, replicate, modelIdentity: identity,
          library: emptySkillLibrary({ modelIdentity: identity }), demonstrations: clone(demonstrations), signal,
          onEvent: emit,
          request: async input => {
            checkAbort(signal);
            if (input.phase !== 'compile') throw new Error('Compiler-only experiment received another request phase');
            if (logicalCompilerRequests >= MAX_LOGICAL_REQUESTS) throw new Error('Compiler logical request budget exhausted');
            const commonInput = { modelIdentity: identity, modelSeed, temperature: TEMPERATURE, maxOutputTokens: MAX_OUTPUT_TOKENS,
              phase: input.phase, messages: clone(input.messages), tools: clone(input.tools) };
            const inputSha256 = hash(commonInput);
            const row = { ...tags, ordinal: ++logicalCompilerRequests, attempt: requests.length + 1,
              phase: 'compile', sourceCaseId: input.caseId, caseId: prefix(input.caseId),
              temperature: TEMPERATURE, maxOutputTokens: MAX_OUTPUT_TOKENS, responseFormat: clone(responseFormat),
              inputSha256, requestSha256: hash({ ...commonInput, responseFormat }), status: 'started' };
            requests.push(row);
            if (run.firstInputSha256 === null) run.firstInputSha256 = inputSha256;
            await onEvent({ type: 'compiler-request-start', ...clone(row) });
            try {
              const response = await request({ ...input, messages: commonInput.messages, tools: commonInput.tools,
                ...tags, caseId: row.caseId, temperature: TEMPERATURE, maxOutputTokens: MAX_OUTPUT_TOKENS,
                inputSha256, firstInputSha256: run.firstInputSha256, requestSha256: row.requestSha256,
                responseFormat: clone(responseFormat) });
              row.status = 'returned';
              return response;
            } catch (error) {
              row.status = 'failed';
              row.error = String(error?.message ?? error);
              throw error;
            } finally {
              await onEvent({ type: 'compiler-request-finished', ...clone(row) });
            }
          }
        });
        // Prefix receipt IDs as well as dispatch/event IDs, preserving the core's
        // originals and its immutable library and validation evidence.
        run.acquisition = { ...acquired, attempts: acquired.attempts.map(attempt => ({ ...attempt,
          sourceCaseId: attempt.caseId, caseId: prefix(attempt.caseId), classification: classifyAttempt(attempt) })) };
        runs.push(run);
        pairedRuns.push(run);
        await emit({ type: 'compiler-acquisition-complete', admitted: acquired.admitted,
          libraryDigest: acquired.library.digest, logicalCompilerRequests: requests.length,
          firstInputSha256: run.firstInputSha256, inputSha256: run.inputSha256 });
      }
      if (pairedRuns[0].inputSha256 !== pairedRuns[1].inputSha256 ||
          pairedRuns[0].firstInputSha256 !== pairedRuns[1].firstInputSha256) {
        throw new Error('Paired compiler inputs differ before treatment');
      }
    }
  }

  const firstAttemptPairs = runs.filter(run => run.arm === 'free-form').map(run => {
    const pair = runs.filter(other => other.replicate === run.replicate && other.family === run.family);
    return { replicate: run.replicate, family: run.family, modelSeed: run.modelSeed, inputSha256: run.firstInputSha256,
      byArm: Object.fromEntries(pair.map(item => [item.arm, { caseId: item.acquisition.attempts[0].caseId,
        admitted: item.acquisition.attempts[0].admitted, ...item.acquisition.attempts[0].classification }])) };
  });
  return { schema: 'amos.compiler-format-experiment.v1', startedAt, completedAt: new Date().toISOString(),
    modelIdentity: identity, modelSeeds: [...MODEL_SEEDS], arms: [...ARMS], families: [...FAMILIES],
    temperature: TEMPERATURE, maxOutputTokens: MAX_OUTPUT_TOKENS,
    maxAttemptsPerAcquisition: 3, trainingValidationCases: 4,
    maxLogicalCompilerRequests: MAX_LOGICAL_REQUESTS, logicalCompilerRequests,
    pairedFirstInputsMatch: true, firstAttemptPairs, runs, byArm: Object.fromEntries(ARMS.map(arm => [arm, summarize(runs, arm)])),
    primaryOutcome: 'Acquisitions admitted within three attempts, denominator six per arm. Retry feedback and realized compute may differ.',
    evaluationTasksRun: 0, weightsChanged: false, neuralRecurrenceTested: false,
    scope: 'Paired frozen-model compiler-format admission diagnostic; equal request caps, actual compute may differ. No held-out execution or retention claim.' };
}
