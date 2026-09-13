import { acquireSequentialSkill, buildSequentialDemonstrations, sequentialEvidenceHash } from './sequentialSkillLearning.js';
import { emptySkillLibrary } from './persistentSkillLibrary.js';
import { validateCheckedProcedure } from './checkedProcedure.js';
import { createSequentialSkillFixture } from '../evals/sequentialSkillFixture.js';

const ARMS = ['guide-only', 'worked-example'];
const FAMILIES = ['reserve-order', 'invoice-order'];
const MODEL_SEEDS = [20260916, 20261017, 20261118];
const TEMPERATURE = 1;
const MAX_OUTPUT_TOKENS = 3072;
const MAX_LOGICAL_REQUESTS = 36;
const clone = value => structuredClone(value);
const hash = sequentialEvidenceHash;

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

// Dedicated teaching world, disjoint from every TRAIN/validation/evaluation split.
// Its two orders are open; only actual inspect_order receipts become model input.
const exampleWorld = createSequentialSkillFixture({ seed: 730_000, split: 'worked-example', family: 'compose', variant: 'ambiguous' });
const EXAMPLE_GOAL = {
  description: 'Read every requested order and check that each is open. Do not change any records. Return completed only after all checks succeed; return needs_reasoning on an inspection error or a different status.',
  orders: exampleWorld.goal.orders.map(({ orderId }) => ({ orderId }))
};
const EXAMPLE = freeze({
  goal: EXAMPLE_GOAL,
  program: validateCheckedProcedure({ schema: 'amos.checked-procedure.v1', steps: [
    { type: 'for_each', items: { $ref: 'goal.orders' }, as: 'target', steps: [
      { type: 'call', tool: 'inspect_order', args: { orderId: { $ref: 'vars.target.orderId' } }, saveAs: 'inspection' },
      { type: 'if', left: { $ref: 'vars.inspection.ok' }, equals: true, then: [
        { type: 'if', left: { $ref: 'vars.inspection.order.status' }, equals: 'open', then: [],
          else: [{ type: 'return', status: 'needs_reasoning' }] }
      ], else: [{ type: 'return', status: 'needs_reasoning' }] }
    ] },
    { type: 'return', status: 'completed' }
  ] }, { toolNames: ['inspect_order'], maxNodes: 512, maxDepth: 8 }),
  publicTrace: EXAMPLE_GOAL.orders.map(({ orderId }) => ({
    name: 'inspect_order', args: { orderId }, result: exampleWorld.execute('inspect_order', { orderId })
  }))
});

/** Detached immutable teaching material. It only checks order state; it contains
 * no reservation, confirmation, invoice creation or annotation procedure. */
export function getWorkedExample() { return freeze(clone(EXAMPLE)); }

/** Add exactly one curriculum field; all original instructions/feedback survive. */
export function buildWorkedExampleMessages({ messages, arm } = {}) {
  if (!ARMS.includes(arm)) throw new Error('Unknown worked-example arm');
  if (!Array.isArray(messages)) throw new Error('Compiler messages must be an array');
  const output = clone(messages);
  const index = output.findLastIndex(message => message.role === 'user');
  if (index < 0 || typeof output[index].content !== 'string') throw new Error('Compiler user message required');
  const user = JSON.parse(output[index].content);
  if (Object.hasOwn(user, 'workedExample')) throw new Error('Worked example must not already be present');
  if (arm === 'worked-example') {
    user.workedExample = getWorkedExample();
    output[index].content = JSON.stringify(user);
  }
  return output;
}


function checkAbort(signal) {
  if (signal?.aborted) throw new Error('Worked-example experiment aborted');
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
export async function runWorkedExampleExperiment({ request, modelIdentity, onEvent = async () => {}, signal } = {}) {
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
      const demonstrationSeed = (familyIndex === 0 ? 160_000 : 170_000) + replicate * 100;
      const acquisitionSeed = 180_000 + replicate * 100 + familyIndex * 1_000;
      const demonstrations = await buildSequentialDemonstrations({ family, seed: demonstrationSeed });
      const demonstrationsSha256 = hash(demonstrations);
      const arms = (replicate + familyIndex) % 2 ? [...ARMS].reverse() : ARMS;
      const pairedRuns = [];

      for (const arm of arms) {
        checkAbort(signal);
        const responseFormat = { type: 'json_object' };
        const workedExampleSha256 = arm === 'worked-example' ? hash(EXAMPLE) : null;
        const tags = { arm, family, replicate, modelSeed };
        const prefix = caseId => `${arm}-${caseId}`;
        const requests = [];
        const inputIdentity = { modelIdentity: identity, family, replicate, modelSeed, demonstrationSeed, acquisitionSeed,
          demonstrationsSha256, temperature: TEMPERATURE, maxOutputTokens: MAX_OUTPUT_TOKENS };
        const run = { ...tags, demonstrationSeed, acquisitionSeed, validationSeedBase: acquisitionSeed + 10_000,
          temperature: TEMPERATURE, maxOutputTokens: MAX_OUTPUT_TOKENS, responseFormat: clone(responseFormat),
          inputIdentity, inputSha256: hash(inputIdentity), demonstrations: clone(demonstrations), demonstrationsSha256,
          firstInputSha256: null, firstActualInputSha256: null, workedExampleSha256, requests };
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
            const normalizedMessages = buildWorkedExampleMessages({ messages: input.messages, arm: 'guide-only' });
            const messages = buildWorkedExampleMessages({ messages: input.messages, arm });
            const commonInput = { modelIdentity: identity, modelSeed, temperature: TEMPERATURE, maxOutputTokens: MAX_OUTPUT_TOKENS,
              phase: input.phase, messages: normalizedMessages, tools: clone(input.tools), responseFormat };
            const inputSha256 = hash(commonInput);
            const actualInputSha256 = hash({ ...commonInput, messages });
            const row = { ...tags, ordinal: ++logicalCompilerRequests, attempt: requests.length + 1,
              phase: 'compile', sourceCaseId: input.caseId, caseId: prefix(input.caseId),
              temperature: TEMPERATURE, maxOutputTokens: MAX_OUTPUT_TOKENS, responseFormat: clone(responseFormat),
              inputSha256, actualInputSha256, requestSha256: actualInputSha256, workedExampleSha256, status: 'started' };
            requests.push(row);
            if (run.firstInputSha256 === null) {
              run.firstInputSha256 = inputSha256;
              run.firstActualInputSha256 = actualInputSha256;
            }
            await onEvent({ type: 'compiler-request-start', ...clone(row) });
            try {
              const response = await request({ ...input, messages: clone(messages), tools: commonInput.tools,
                ...tags, caseId: row.caseId, temperature: TEMPERATURE, maxOutputTokens: MAX_OUTPUT_TOKENS,
                inputSha256, actualInputSha256, firstInputSha256: run.firstInputSha256,
                requestSha256: row.requestSha256, workedExampleSha256,
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
          firstInputSha256: run.firstInputSha256, firstActualInputSha256: run.firstActualInputSha256, inputSha256: run.inputSha256 });
      }
      if (pairedRuns[0].inputSha256 !== pairedRuns[1].inputSha256 ||
          pairedRuns[0].firstInputSha256 !== pairedRuns[1].firstInputSha256) {
        throw new Error('Paired compiler inputs differ before treatment');
      }
    }
  }

  const firstAttemptPairs = runs.filter(run => run.arm === 'guide-only').map(run => {
    const pair = runs.filter(other => other.replicate === run.replicate && other.family === run.family);
    return { replicate: run.replicate, family: run.family, modelSeed: run.modelSeed, inputSha256: run.firstInputSha256,
      byArm: Object.fromEntries(pair.map(item => [item.arm, { caseId: item.acquisition.attempts[0].caseId,
        actualInputSha256: item.firstActualInputSha256, workedExampleSha256: item.workedExampleSha256,
        admitted: item.acquisition.attempts[0].admitted, ...item.acquisition.attempts[0].classification }])) };
  });
  return { schema: 'amos.worked-example-experiment.v1', startedAt, completedAt: new Date().toISOString(),
    modelIdentity: identity, modelSeeds: [...MODEL_SEEDS], arms: [...ARMS], families: [...FAMILIES],
    temperature: TEMPERATURE, maxOutputTokens: MAX_OUTPUT_TOKENS, responseFormat: { type: 'json_object' },
    workedExample: getWorkedExample(), workedExampleSha256: hash(EXAMPLE),
    maxAttemptsPerAcquisition: 3, trainingValidationCases: 4,
    maxLogicalCompilerRequests: MAX_LOGICAL_REQUESTS, logicalCompilerRequests,
    pairedFirstInputsMatch: true, pairingInterpretation: 'First inputs match after removing only the workedExample field; actual treated prompts differ.', firstAttemptPairs, runs, byArm: Object.fromEntries(ARMS.map(arm => [arm, summarize(runs, arm)])),
    primaryOutcome: 'Acquisitions admitted within three attempts, denominator six per arm. Retry feedback and realized compute may differ.',
    evaluationTasksRun: 0, weightsChanged: false, neuralRecurrenceTested: false,
    scope: 'Paired frozen-model worked-example curriculum diagnostic; equal request caps, extra example tokens and adaptive feedback may change actual compute. No held-out execution or retention claim.' };
}
