import { buildSequentialDemonstrations, runSequentialTask, sequentialEvidenceHash as hash } from './sequentialSkillLearning.js';
import { emptySkillLibrary } from './persistentSkillLibrary.js';
import { createSequentialSkillFixture } from '../evals/sequentialSkillFixture.js';
import { createObservedExperience, createReplayMemory, validateReplayMemory } from './persistentReplayMemory.js';

export const PROCEDURAL_MEMORY_SCHEMA = 'amos.procedural-memory-experiment.v1';
export const PROCEDURAL_MEMORY_ARMS = Object.freeze(['no-memory', 'procedural-memory']);
export const PROCEDURAL_MEMORY_FAMILIES = Object.freeze(['reserve-order', 'invoice-order']);
export const PROCEDURAL_MEMORY_LIMITS = Object.freeze({ maxLogicalRequests: 194, maxModelCallsPerTask: 12,
  maxToolCallsPerTask: 32, taskTimeoutMs: 120_000, experimentTimeoutMs: 2_400_000,
  acquisitionMaxOutputTokens: 512, executionMaxOutputTokens: 1536, maxMemoryWords: 160 });
const clone = value => structuredClone(value);
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
const identityOf = modelIdentity => emptySkillLibrary({ modelIdentity }).modelIdentity;
const tenantOf = identity => `procedural-memory-${hash(identity).slice(0, 24)}`;
const recordId = family => `procedural-memory-${family}`;
const modelLineage = identity => `model-${hash(identity)}`;
function familyIndex(family) {
  const index = PROCEDURAL_MEMORY_FAMILIES.indexOf(family);
  if (index < 0) throw new Error('Unknown procedural-memory family');
  return index;
}

function ambiguousSeed(family, base, applied) {
  for (let offset = 0; offset < 100; offset++) {
    const seed = base + offset;
    const world = createSequentialSkillFixture({ family, seed, split: 'procedural-memory-evaluation', variant: 'ambiguous' });
    if (world.snapshotForTesting().fault.applied === applied) return seed;
  }
  throw new Error('Could not balance procedural-memory evaluation fault modes');
}

// The complete host-only selection is fixed before any acquisition request.
const CASES = freeze(PROCEDURAL_MEMORY_FAMILIES.flatMap((family, index) => {
  const base = index === 0 ? 260_000 : 270_000;
  return [{ variant: 'fresh', seed: base }, { variant: 'partial', seed: base + 100 },
    ...[true, false].map(applied => ({ variant: 'ambiguous', seed: ambiguousSeed(family, base + 200, applied), ambiguityApplied: applied }))]
    .map((spec, localIndex) => {
      const caseIndex = index * 4 + localIndex;
      const fixture = createSequentialSkillFixture({ ...spec, family, split: 'procedural-memory-evaluation' });
      return { ...spec, family, split: 'procedural-memory-evaluation', caseIndex,
        modelSeed: 20260917 + 101 * caseIndex, fixtureId: fixture.id };
    });
}));
export function getProceduralMemoryCases() { return freeze(clone(CASES)); }

function identifiers(demonstrations) {
  const keys = new Set(['id', 'orderId', 'invoiceId', 'customerId', 'sku', 'invoiceReference', 'reference']);
  const found = new Set();
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (keys.has(key) && typeof item === 'string' && item.trim()) found.add(item);
      else if (item && typeof item === 'object') visit(item);
    }
  };
  for (const demo of demonstrations) { visit(demo.goal); demo.events.forEach(event => visit(event.result)); }
  return [...found].sort();
}

// Reuse the existing teacher and its actual hardcoded TRAIN split. Replaying its
// public actions provides native receipts; this is not a second teaching policy.
function replayDemonstrations({ demonstrations, family, seed }) {
  return demonstrations.map(demo => {
    let world = null, caseSeed = null;
    for (let offset = 0; offset < 1000; offset++) {
      const candidate = createSequentialSkillFixture({ family, seed: seed + offset, split: 'training', variant: 'ambiguous' });
      if (candidate.id === demo.id) { world = candidate; caseSeed = seed + offset; break; }
    }
    if (!world || hash(world.goal) !== hash(demo.goal)) throw new Error('Demonstration identity mismatch');
    for (const event of demo.events) {
      if (hash(world.execute(event.name, event.args)) !== hash(event.result)) throw new Error('Demonstration public receipt mismatch');
    }
    const verification = world.verify();
    if (!verification.pass) throw new Error('Demonstration failed native verification');
    return { fixtureId: world.id, family, seed: caseSeed, split: 'training', variant: 'ambiguous',
      publicEventsSha256: hash(demo.events), verification };
  });
}

function wireIdentity(input) {
  return { modelIdentity: input.modelIdentity, modelSeed: input.modelSeed, temperature: input.temperature,
    maxOutputTokens: input.maxOutputTokens, responseFormat: input.responseFormat, phase: input.phase,
    messages: input.messages, tools: input.tools };
}

export async function buildMemoryAcquisitionInput({ family, modelIdentity } = {}) {
  const index = familyIndex(family), identity = identityOf(modelIdentity);
  const seed = index === 0 ? 240_000 : 250_000;
  const demonstrations = await buildSequentialDemonstrations({ family, seed });
  const tools = createSequentialSkillFixture({ family, seed, split: 'training', variant: 'fresh' }).tools;
  const input = { family, modelIdentity: identity, caseId: `memory-acquisition-${family}`, phase: 'memory-acquisition',
    modelSeed: 20260917 + 101 * index, temperature: 1, maxOutputTokens: 512, responseFormat: null, tools: [],
    messages: [{ role: 'system', content: 'Summarize prior verified synthetic experience as reusable procedural advice. Return only plain prose, at most 160 words. Do not return JSON, code, or a program. Do not copy specific entity identifiers or reference values. The summary will be unverified advice; future tools and the current goal remain authoritative.' },
      { role: 'user', content: JSON.stringify({ family, tools, demonstrations,
        task: 'Write a reusable procedure from these verified TRAIN trajectories. Cover preconditions, current revisions, reuse of existing work, unknown-outcome reconciliation, stopping, and forbidden effects. Future tasks use different entities and quantities.' }) }],
    demonstrationSeed: seed, trainingSplit: 'training', demonstrations, demonstrationsSha256: hash(demonstrations),
    trainingReceipts: replayDemonstrations({ demonstrations, family, seed }), entityIdentifiers: identifiers(demonstrations) };
  input.trainingReceiptsSha256 = hash(input.trainingReceipts);
  input.inputSha256 = hash(wireIdentity(input));
  return freeze(input);
}

export function createEmptyProceduralMemorySnapshot({ modelIdentity } = {}) {
  const identity = identityOf(modelIdentity);
  return freeze(createReplayMemory({ tenantId: tenantOf(identity), observations: [] }));
}

/** Availability gate only: the generated summary itself is never marked verified. */
export function createProceduralMemorySnapshot({ acquisitions, modelIdentity } = {}) {
  const identity = identityOf(modelIdentity);
  if (!Array.isArray(acquisitions) || acquisitions.length !== 2 ||
      new Set(acquisitions.map(row => row.input?.family)).size !== 2) throw new Error('Exactly two family acquisition receipts required');
  const memories = [], observations = [];
  for (const family of PROCEDURAL_MEMORY_FAMILIES) {
    const acquired = acquisitions.find(row => row.input?.family === family);
    if (!acquired) throw new Error('Missing family acquisition');
    const { input, response, error } = acquired;
    if (hash(input.modelIdentity) !== hash(identity) || input.inputSha256 !== hash(wireIdentity(input)) ||
        input.demonstrationsSha256 !== hash(input.demonstrations) || input.trainingReceiptsSha256 !== hash(input.trainingReceipts) ||
        input.trainingReceipts.length !== 2 || input.trainingReceipts.some(row => !row.verification.pass) ||
        hash(input.entityIdentifiers) !== hash(identifiers(input.demonstrations))) throw new Error('Acquisition input provenance mismatch');
    const rawText = typeof response?.message?.content === 'string' ? response.message.content : null;
    const text = rawText?.trim() ?? '';
    const wordCount = text ? text.split(/\s+/u).length : 0;
    const copiedIdentifiers = input.entityIdentifiers.filter(id => text.includes(id));
    const rejectionReasons = [];
    if (error != null) rejectionReasons.push('request-error');
    if (!text) rejectionReasons.push('empty-text');
    if (response?.providerResponse?.choices?.[0]?.finish_reason === 'length') rejectionReasons.push('output-truncated');
    if (wordCount > 160) rejectionReasons.push('word-limit');
    if (copiedIdentifiers.length) rejectionReasons.push('copied-training-identifier');
    const responseSha256 = response === undefined ? null : hash(response);
    let record = null;
    if (!rejectionReasons.length) {
      record = createObservedExperience({ id: recordId(family), tenantId: tenantOf(identity), taskFamily: family,
        lineageGroups: [modelLineage(identity), `train-${input.demonstrationsSha256}`], partition: 'training', text,
        source: { kind: 'external-model', modelId: identity.model,
          reference: JSON.stringify({ experiment: PROCEDURAL_MEMORY_SCHEMA, modelIdentity: identity, inputSha256: input.inputSha256,
            demonstrationsSha256: input.demonstrationsSha256, trainingReceiptsSha256: input.trainingReceiptsSha256, responseSha256 }),
          permittedUses: ['memory', 'evaluation'], permissionReference: 'owned-synthetic-procedural-memory-pilot-20260913' },
        verification: { status: 'unverified' } });
      observations.push(record);
    }
    memories.push({ family, available: record !== null, wordCount, rejectionReasons, copiedIdentifiers, rawText,
      response: response === undefined ? null : clone(response), error: error == null ? null : String(error),
      inputSha256: input.inputSha256, demonstrationsSha256: input.demonstrationsSha256,
      trainingReceiptsSha256: input.trainingReceiptsSha256, responseSha256,
      recordId: record?.id ?? null, recordDigest: record?.digest ?? null, textSha256: record ? hash(record.text) : null });
  }
  return freeze({ modelIdentity: identity, snapshot: createReplayMemory({ tenantId: tenantOf(identity), observations }), memories });
}

function selectMemory(loadedMemory, identity, arm, family) {
  const snapshot = validateReplayMemory(loadedMemory);
  if (snapshot.tenantId !== tenantOf(identity)) throw new Error('Memory model identity mismatch');
  if (snapshot.records.length > 2 || snapshot.records.some(record =>
    !PROCEDURAL_MEMORY_FAMILIES.includes(record.taskFamily) || record.id !== recordId(record.taskFamily) ||
    record.verification.status !== 'unverified' || record.example !== null || record.source.kind !== 'external-model' ||
    record.source.modelId !== identity.model || !record.lineageGroups.includes(modelLineage(identity)))) throw new Error('Unexpected procedural-memory record');
  if (arm === 'no-memory' && snapshot.records.length) throw new Error('No-memory arm requires an empty snapshot');
  return { snapshot, record: arm === 'procedural-memory' ? snapshot.records.find(row => row.id === recordId(family)) ?? null : null };
}

/** Process creation and immutable disk reload are owned by the CLI. This function
 * accepts only the loaded snapshot, never acquisition trajectories or feedback. */
export async function runProceduralMemoryTask({ request, modelIdentity, loadedMemory, arm, caseIndex,
  onEvent = async () => {}, signal } = {}) {
  if (typeof request !== 'function' || typeof onEvent !== 'function') throw new Error('request and onEvent must be functions');
  if (!PROCEDURAL_MEMORY_ARMS.includes(arm)) throw new Error('Unknown procedural-memory arm');
  if (!Number.isSafeInteger(caseIndex) || !CASES[caseIndex]) throw new Error('Invalid procedural-memory case index');
  const spec = CASES[caseIndex], identity = identityOf(modelIdentity);
  const { snapshot, record } = selectMemory(loadedMemory, identity, arm, spec.family);
  const fixture = createSequentialSkillFixture(spec);
  const tags = { arm, family: spec.family, caseIndex, modelSeed: spec.modelSeed };
  const caseId = `${arm}-procedural-memory-case-${caseIndex}`;
  const provenance = { memorySnapshotDigest: snapshot.digest, memoryAvailable: record !== null,
    memoryRecordId: record?.id ?? null, memoryRecordDigest: record?.digest ?? null,
    memoryTextSha256: record ? hash(record.text) : null };
  const requests = [];
  const result = await runSequentialTask({ fixture, request: async input => {
    const normalized = clone(input.messages), messages = clone(input.messages);
    const user = JSON.parse(messages.at(-1).content);
    if (user.demonstrations.length || user.learnedSkills.length || Object.hasOwn(user, 'proceduralMemory')) throw new Error('Unexpected actor curriculum');
    if (arm === 'procedural-memory') {
      user.proceduralMemory = record?.text ?? '';
      messages.at(-1).content = JSON.stringify(user);
    }
    const common = { modelIdentity: identity, modelSeed: spec.modelSeed, temperature: 0, maxOutputTokens: 1536,
      responseFormat: null, phase: input.phase, messages: normalized, tools: input.tools };
    const inputSha256 = hash(common), actualInputSha256 = hash({ ...common, messages });
    const row = { ...tags, caseId: input.caseId, phase: 'execute', attempt: requests.length + 1,
      temperature: 0, maxOutputTokens: 1536, responseFormat: null, inputSha256, actualInputSha256,
      messages: clone(messages), tools: clone(input.tools), ...provenance, status: 'started' };
    requests.push(row);
    await onEvent({ type: 'memory-task-request-start', ...clone(row) });
    try {
      const response = await request({ ...input, ...tags, messages, temperature: 0, maxOutputTokens: 1536,
        responseFormat: null, inputSha256, actualInputSha256, ...provenance });
      row.response = clone(response); row.status = 'returned';
      if (response?.providerResponse?.choices?.[0]?.finish_reason === 'length') throw new Error('Actor output budget exhausted; proposed tools were not executed');
      return response;
    } catch (error) {
      row.error = String(error?.message ?? error); row.status = 'failed'; throw error;
    } finally { await onEvent({ type: 'memory-task-request-finished', ...clone(row) }); }
  }, modelIdentity: identity, library: emptySkillLibrary({ modelIdentity: identity }), demonstrations: [], caseId,
  maxModelCallsPerTask: 12, maxToolCallsPerTask: 32, taskTimeoutMs: 120_000, signal,
  onEvent: event => onEvent({ ...event, ...tags, ...provenance }) });
  return { ...result, ...tags, ...provenance, modelIdentity: identity, fixtureSeed: spec.seed,
    variant: spec.variant, split: spec.split, requests, firstInputSha256: requests[0]?.inputSha256 ?? null,
    firstActualInputSha256: requests[0]?.actualInputSha256 ?? null,
    maxLogicalRequests: 194, budgets: clone(PROCEDURAL_MEMORY_LIMITS) };
}
