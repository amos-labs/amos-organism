import { performance } from 'node:perf_hooks';
import { createScopedKnowledgeFixture, buildScopedKnowledgeDemonstration, SCOPED_KNOWLEDGE_PROFILES } from '../evals/scopedKnowledgeFixture.js';
import { runSequentialTask, sequentialEvidenceHash as hash } from './sequentialSkillLearning.js';
import { emptySkillLibrary } from './persistentSkillLibrary.js';
import { createObservedExperience, createReplayMemory, validateReplayMemory } from './persistentReplayMemory.js';

export const SCOPED_KNOWLEDGE_ARMS = Object.freeze(['no-memory', 'exact-policy-cache', 'generated-facts', 'generated-prose']);
const SCHEMA = 'amos.scoped-knowledge-experiment.v1';
const PERMISSION = 'owned-synthetic-scoped-knowledge-20260914';
const PROFILES = SCOPED_KNOWLEDGE_PROFILES;
const clone = value => structuredClone(value);
function freeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
const identityOf = identity => emptySkillLibrary({ modelIdentity: identity }).modelIdentity;
const tenantOf = identity => `scoped-knowledge-${hash(identity).slice(0, 24)}`;
const recordId = (arm, profile) => `knowledge-${arm}-${profile}-v1`;
const lineage = identity => `model-${hash(identity)}`;
const fixtureFor = spec => createScopedKnowledgeFixture({ ...spec, workflowProfile: spec.profileId });

function ambiguousSeed(options, applied) {
  for (let offset = 0; offset < 100; offset++) {
    if (createScopedKnowledgeFixture({ ...options, seed: options.seed + offset }).snapshotForTesting().fault.applied === applied) return options.seed + offset;
  }
  throw new Error('No bounded ambiguity selection');
}
export function createPlan({ modelIdentity } = {}) {
  const identity = identityOf(modelIdentity);
  const cases = PROFILES.flatMap((profileId, index) => {
    const split = 'scoped-knowledge-evaluation', base = 610000 + index * 1000;
    return [{ policyVersion: 1, variant: 'fresh', cohort: 'stable', seed: base },
      { policyVersion: 1, variant: 'ambiguous', cohort: 'stable', ambiguityApplied: false,
        seed: ambiguousSeed({ seed: base + 100, split, workflowProfile: profileId, policyVersion: 1, variant: 'ambiguous' }, false) },
      { policyVersion: 2, variant: 'fresh', cohort: 'changed-version', seed: base + 200 }]
      .map(row => ({ ...row, profileId, split, family: 'invoice-order' }));
  }).map((spec, caseIndex) => {
    const fixture = fixtureFor(spec);
    return { ...spec, caseIndex, tripletId: `scoped-case-${caseIndex}`, fixtureId: fixture.id,
      policySha256: fixture.snapshotForTesting().policySha256, modelSeed: 20261021 + caseIndex * 101 };
  });
  const acquisitions = PROFILES.flatMap((profileId, index) => (index % 2 ? ['generated-prose', 'generated-facts'] : ['generated-facts', 'generated-prose'])
    .map(arm => ({ acquisitionId: `${arm}-${profileId}`, arm, profileId, policyVersion: 1,
      modelSeed: 20261020 + index * 101, temperature: 1, maxOutputTokens: 512 })));
  const tasks = cases.flatMap(spec => Array.from({ length: 4 }, (_, offset) => {
    const arm = SCOPED_KNOWLEDGE_ARMS[(spec.caseIndex + offset) % 4];
    return { ...spec, taskId: `${spec.tripletId}-${arm}`, arm, memoryKey: arm, memoryProfileVersion: 1 };
  }));
  return freeze({ schema: SCHEMA, experimentId: 'scoped-knowledge-20260914', modelIdentity: identity,
    arms: [...SCOPED_KNOWLEDGE_ARMS], acquisitions, tasks, cases,
    limits: { maxLogicalRequests: 438, maxModelCallsPerTask: 12, maxToolCallsPerTask: 32, taskTimeoutMs: 120000,
      maxMinutes: 100, executionMaxOutputTokens: 1536, acquisitionMaxOutputTokens: 512, maxMemoryWords: 160 } });
}

const sourceCache = new Map();
function sourceExperience(profileId) {
  if (!PROFILES.includes(profileId)) throw new Error('Unknown source profile');
  if (sourceCache.has(profileId)) return sourceCache.get(profileId);
  const started = performance.now(), base = 620000 + PROFILES.indexOf(profileId) * 1000, split = 'scoped-knowledge-training';
  const specs = [{ seed: base, variant: 'fresh' }, { variant: 'ambiguous', seed: ambiguousSeed({ workflowProfile: profileId,
    policyVersion: 1, split, variant: 'ambiguous', seed: base + 100 }, false) }]
    .map(row => ({ ...row, workflowProfile: profileId, policyVersion: 1, split }));
  const demonstrations = specs.map(spec => buildScopedKnowledgeDemonstration(spec));
  const receipts = specs.map((spec, index) => {
    const world = createScopedKnowledgeFixture(spec);
    for (const event of demonstrations[index].events) if (hash(world.execute(event.name, event.args)) !== hash(event.result)) throw new Error('Source receipt mismatch');
    const verification = world.verify(); if (!verification.pass) throw new Error('Source verification failed');
    return { ...spec, fixtureId: world.id, verification, eventsSha256: hash(demonstrations[index].events) };
  });
  const source = freeze({ demonstrations, receipts, tools: createScopedKnowledgeFixture(specs[0]).tools });
  sourceCache.set(profileId, source);
  sourceTimings.set(profileId, performance.now() - started);
  return source;
}
const sourceTimings = new Map();
function instanceIdentifiers(demonstrations) {
  const names = new Set(['id', 'orderId', 'invoiceId', 'customerId', 'sku', 'invoiceReference', 'reference', 'externalReference']);
  const found = new Set();
  function visit(value) { if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    if (names.has(key) && typeof item === 'string' && item.trim()) found.add(item.trim());
    else if (item && typeof item === 'object') visit(item);
  } }
  for (const demo of demonstrations) { visit(demo.goal); demo.events.forEach(event => visit(event.result)); }
  return [...found].sort();
}
function wireIdentity(input) { return { modelIdentity: input.modelIdentity, modelSeed: input.modelSeed, temperature: input.temperature,
  maxOutputTokens: input.maxOutputTokens, responseFormat: input.responseFormat, phase: input.phase, messages: input.messages, tools: input.tools }; }

/** Syntactic validity only. Wrong but valid conventions are retained unchanged. */
export function validNormalization(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = ['trim', 'case', 'prefix', 'suffix'], descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value'))) return false;
  return typeof value.trim === 'boolean' && ['upper', 'lower'].includes(value.case) &&
    typeof value.prefix === 'string' && value.prefix.length <= 32 && typeof value.suffix === 'string' && value.suffix.length <= 32;
}

/** Literal copy from publicly observed policy receipts after exact native replay.
 * Private fixture policies/expected targets never supply cache content. */
export function extractReceiptBackedPolicy({ profileId, demonstrations, receipts } = {}) {
  if (!PROFILES.includes(profileId) || demonstrations?.length !== 2 || receipts?.length !== 2) throw new Error('Two source trajectories required');
  const observations = [];
  for (const [index, receipt] of receipts.entries()) {
    const demo = demonstrations[index], world = createScopedKnowledgeFixture(receipt);
    if (receipt.workflowProfile !== profileId || receipt.policyVersion !== 1 || receipt.split !== 'scoped-knowledge-training' ||
      world.id !== receipt.fixtureId || demo.id !== world.id || hash(demo.goal) !== hash(world.goal) || receipt.eventsSha256 !== hash(demo.events)) throw new Error('Cache source identity mismatch');
    for (const event of demo.events) {
      if (hash(world.execute(event.name, event.args)) !== hash(event.result)) throw new Error('Cache source replay mismatch');
      if (event.name === 'inspect_workflow_policy' && event.result.ok) {
        const policy = event.result.policy;
        if (policy?.workflowProfile !== profileId || policy.policyVersion !== 1 || !validNormalization(policy.normalization)) throw new Error('Cache policy receipt mismatch');
        observations.push({ policy, receiptSha256: hash(event) });
      }
    }
    const verification = world.verify();
    if (!verification.pass || hash(verification) !== hash(receipt.verification)) throw new Error('Cache source native verification mismatch');
  }
  if (!observations.length || observations.some(row => hash(row.policy) !== hash(observations[0].policy))) throw new Error('Missing or conflicting policy receipts');
  return freeze({ knowledge: clone(observations[0].policy.normalization), policyReceiptSha256: observations[0].receiptSha256,
    sourcePolicySha256: hash(observations[0].policy), demonstrationsSha256: hash(demonstrations), trainingReceiptsSha256: hash(receipts) });
}

export function buildAcquisitionInput({ acquisitionId, modelIdentity } = {}) {
  const plan = createPlan({ modelIdentity }), slot = plan.acquisitions.find(row => row.acquisitionId === acquisitionId);
  if (!slot) throw new Error('Unknown acquisition slot');
  const source = sourceExperience(slot.profileId), facts = slot.arm === 'generated-facts';
  const format = facts
    ? 'Return only one JSON object with exactly trim (boolean), case ("upper" or "lower"), prefix (string at most 32 characters), suffix (string at most 32 characters). No markdown or extra keys.'
    : 'Return only plain prose, at most 160 words. Retain useful normalization conventions and refresh instructions.';
  const input = { ...slot, modelIdentity: plan.modelIdentity, phase: 'memory-acquisition', caseId: acquisitionId,
    responseFormat: null, tools: [], messages: [
      { role: 'system', content: `Extract reusable knowledge from the supplied verified source trajectories. ${format} Do not invent missing policy values. Do not copy particular order, invoice, customer, SKU or external-reference identifiers. General convention constants are allowed. The host scopes the result to the supplied profile and version; current goals and public tool evidence remain authoritative. Generated content remains unverified.` },
      { role: 'user', content: JSON.stringify({ profileId: slot.profileId, policyVersion: 1, tools: source.tools,
        demonstrations: source.demonstrations, task: 'Retain knowledge useful for later invoice tasks in this profile. Later tasks have different order/reference values and may explicitly change policy version.' }) }
    ], demonstrations: source.demonstrations, demonstrationsSha256: hash(source.demonstrations), trainingReceipts: source.receipts,
    trainingReceiptsSha256: hash(source.receipts), entityIdentifiers: instanceIdentifiers(source.demonstrations) };
  input.inputSha256 = hash(wireIdentity(input));
  return freeze(input);
}
function recordFor({ arm, profileId, identity, text, provenance, verification, kind }) {
  return createObservedExperience({ id: recordId(arm, profileId), tenantId: tenantOf(identity),
    taskFamily: `scoped-policy-${profileId}`, lineageGroups: [lineage(identity), `source-${provenance.demonstrationsSha256}`], partition: 'training', text,
    source: { kind, modelId: kind === 'external-model' ? identity.model : null, reference: JSON.stringify(provenance),
      permittedUses: ['memory', 'evaluation'], permissionReference: PERMISSION }, verification });
}
function cacheRecord(profileId, identity) {
  const source = sourceExperience(profileId), cached = extractReceiptBackedPolicy({ profileId, ...source });
  const provenance = { experiment: SCHEMA, arm: 'exact-policy-cache', profileId, policyVersion: 1, modelIdentity: identity, ...cached };
  return { cached, record: recordFor({ arm: 'exact-policy-cache', profileId, identity, text: JSON.stringify(cached.knowledge), provenance,
    kind: 'document', verification: { status: 'verified', receiptSha256: hash(cached), verifierId: 'literal-public-policy-replay-v1' } }) };
}
export function buildSnapshots({ acquisitions, modelIdentity } = {}) {
  const plan = createPlan({ modelIdentity }), identity = plan.modelIdentity, started = performance.now();
  if (!Array.isArray(acquisitions) || acquisitions.length !== 6 || new Set(acquisitions.map(row => row.acquisitionId)).size !== 6) throw new Error('Exactly six acquisition slots required');
  const records = Object.fromEntries(plan.arms.map(arm => [arm, []])), memories = [], cacheReceipts = [];
  for (const profileId of PROFILES) {
    const { cached, record } = cacheRecord(profileId, identity);
    records['exact-policy-cache'].push(record); cacheReceipts.push({ profileId, ...cached, recordId: record.id, recordDigest: record.digest });
  }
  for (const slot of plan.acquisitions) {
    const acquired = acquisitions.find(row => row.acquisitionId === slot.acquisitionId);
    if (!acquired || hash(acquired.input) !== hash(buildAcquisitionInput({ acquisitionId: slot.acquisitionId, modelIdentity: identity }))) throw new Error('Acquisition provenance mismatch');
    const { input, response, error } = acquired;
    const rawText = typeof response?.message?.content === 'string' ? response.message.content : null;
    const text = rawText?.trim() ?? '', wordCount = text ? text.split(/\s+/u).length : 0;
    const rejectionReasons = [];
    if (error != null) rejectionReasons.push('request-error');
    if (!text) rejectionReasons.push('empty-text');
    if (response?.providerResponse?.choices?.[0]?.finish_reason === 'length') rejectionReasons.push('output-truncated');
    if (response?.message?.tool_calls?.length) rejectionReasons.push('unexpected-tool-calls');
    if (wordCount > 160) rejectionReasons.push('word-limit');
    let knowledge = text;
    if (slot.arm === 'generated-facts') {
      try { knowledge = JSON.parse(text); if (!validNormalization(knowledge)) throw new Error('Invalid schema'); }
      catch { rejectionReasons.push('invalid-facts-schema'); }
    }
    const storedText = slot.arm === 'generated-facts' ? JSON.stringify(knowledge) : text;
    const decodedValues = knowledge && typeof knowledge === 'object' ? Object.values(knowledge).filter(value => typeof value === 'string') : [];
    const copiedIdentifiers = input.entityIdentifiers.filter(value => text.includes(value) || storedText.includes(value) || decodedValues.some(item => item.includes(value)));
    if (copiedIdentifiers.length) rejectionReasons.push('copied-training-identifier');
    let record = null;
    const responseSha256 = response === undefined ? null : hash(response);
    if (!rejectionReasons.length) {
      const provenance = { experiment: SCHEMA, arm: slot.arm, profileId: slot.profileId, policyVersion: 1,
        modelIdentity: identity, acquisitionId: slot.acquisitionId, inputSha256: input.inputSha256,
        demonstrationsSha256: input.demonstrationsSha256, trainingReceiptsSha256: input.trainingReceiptsSha256, responseSha256 };
      record = recordFor({ arm: slot.arm, profileId: slot.profileId, identity,
        text: storedText, provenance,
        kind: 'external-model', verification: { status: 'unverified' } });
      records[slot.arm].push(record);
    }
    memories.push({ ...slot, available: record !== null, wordCount, rejectionReasons, copiedIdentifiers, rawText,
      response: response === undefined ? null : clone(response), error: error == null ? null : String(error),
      inputSha256: input.inputSha256, responseSha256, recordId: record?.id ?? null, recordDigest: record?.digest ?? null });
  }
  const snapshots = Object.fromEntries(plan.arms.map(arm => [arm, createReplayMemory({ tenantId: tenantOf(identity), observations: records[arm] })]));
  return freeze({ modelIdentity: identity, snapshots, memories, cacheReceipts,
    sourceAccounting: { profiles: PROFILES.map(profileId => ({ profileId, sourceToolEvents: sourceExperience(profileId).demonstrations.reduce((sum, row) => sum + row.events.length, 0),
      sourceConstructionAndReplayWallMilliseconds: sourceTimings.get(profileId) })),
      snapshotConstructionWallMilliseconds: performance.now() - started,
      attribution: 'Synthetic source collection and replay are shared experimental work. Cache copying, memory validation and persistence are CPU work; generation requests are attributed separately by the process runner.' } });
}
export function validateSnapshot({ snapshot, memoryKey, arm = memoryKey, modelIdentity } = {}) {
  const identity = identityOf(modelIdentity), loaded = validateReplayMemory(snapshot);
  if (!SCOPED_KNOWLEDGE_ARMS.includes(arm) || memoryKey !== arm || loaded.tenantId !== tenantOf(identity)) throw new Error('Snapshot arm/model scope mismatch');
  if (loaded.records.length > (arm === 'no-memory' ? 0 : 3) || (arm === 'exact-policy-cache' && loaded.records.length !== 3)) throw new Error('Unexpected snapshot size');
  const profiles = new Set();
  for (const record of loaded.records) {
    const p = JSON.parse(record.source.reference);
    if (profiles.has(p.profileId) || p.experiment !== SCHEMA || p.arm !== arm || !PROFILES.includes(p.profileId) || p.policyVersion !== 1 ||
        hash(p.modelIdentity) !== hash(identity) || record.id !== recordId(arm, p.profileId) || record.taskFamily !== `scoped-policy-${p.profileId}` ||
        record.example !== null || record.partition !== 'training' || record.source.permissionReference !== PERMISSION ||
        hash(record.source.permittedUses) !== hash(['evaluation', 'memory']) || !record.lineageGroups.includes(lineage(identity))) throw new Error('Invalid knowledge provenance');
    profiles.add(p.profileId);
    if (arm === 'exact-policy-cache') {
      if (hash(record) !== hash(cacheRecord(p.profileId, identity).record)) throw new Error('Cache source/receipt binding mismatch');
      continue;
    }
    const expected = buildAcquisitionInput({ acquisitionId: `${arm}-${p.profileId}`, modelIdentity: identity });
    if (record.source.kind !== 'external-model' || record.source.modelId !== identity.model || record.verification.status !== 'unverified' ||
      p.acquisitionId !== expected.acquisitionId || p.inputSha256 !== expected.inputSha256 || p.demonstrationsSha256 !== expected.demonstrationsSha256 ||
      p.trainingReceiptsSha256 !== expected.trainingReceiptsSha256 || !/^[a-f0-9]{64}$/.test(p.responseSha256) ||
      !record.lineageGroups.includes(`source-${expected.demonstrationsSha256}`) || record.text.trim() !== record.text ||
      record.text.split(/\s+/u).length > 160 || expected.entityIdentifiers.some(id => record.text.includes(id))) throw new Error('Knowledge source/availability binding mismatch');
    if (arm === 'generated-facts' && !validNormalization(JSON.parse(record.text))) throw new Error('Invalid stored facts');
  }
  return loaded;
}
export async function runTask({ taskId, loadedMemory, modelIdentity, request, onEvent = async () => {}, signal } = {}) {
  const plan = createPlan({ modelIdentity }), spec = plan.tasks.find(row => row.taskId === taskId);
  if (!spec || typeof request !== 'function') throw new Error('Invalid scoped knowledge task');
  const identity = plan.modelIdentity, memory = validateSnapshot({ snapshot: loadedMemory, memoryKey: spec.memoryKey, arm: spec.arm, modelIdentity: identity });
  const record = memory.records.find(row => row.id === recordId(spec.arm, spec.profileId)) ?? null;
  const knowledge = record ? (spec.arm === 'generated-prose' ? record.text : JSON.parse(record.text)) : null;
  const memoryKnowledge = { profileId: spec.profileId, policyVersion: 1, knowledge };
  const fixture = fixtureFor(spec), requests = [];
  const provenance = { memorySnapshotDigest: memory.digest, storedMemoryRecordCount: memory.records.length, memoryAvailable: record !== null, memoryExposed: record !== null,
    memoryRecordId: record?.id ?? null, memoryRecordDigest: record?.digest ?? null, memoryTextSha256: record ? hash(record.text) : null,
    memoryProfileVersion: 1, adviceScope: { profileId: spec.profileId, policyVersion: 1 } };
  const tags = { taskId, arm: spec.arm, caseIndex: spec.caseIndex, tripletId: spec.tripletId, cohort: spec.cohort,
    profileId: spec.profileId, policyVersion: spec.policyVersion, modelSeed: spec.modelSeed };
  const result = await runSequentialTask({ fixture, modelIdentity: identity, library: emptySkillLibrary({ modelIdentity: identity }), demonstrations: [],
    caseId: taskId, maxModelCallsPerTask: 12, maxToolCallsPerTask: 32, taskTimeoutMs: 120000, signal,
    onEvent: event => onEvent({ ...event, ...tags, ...provenance }), request: async input => {
      const messages = clone(input.messages);
      messages[0].content += ' Stored memoryKnowledge is scoped to a workflow profile and policy version; it may be absent or incorrect. You may use a remembered convention for the exact matching scope without lookup, or inspect when uncertain. If its version differs from the current goal, successfully inspect the exact current workflow policy before any reference mutation. Current goals and public tool evidence are authoritative. The optional normalize_reference tool transforms only its explicit arguments; it cannot discover the convention or update business records.';
      const user = JSON.parse(messages.at(-1).content);
      if (user.demonstrations.length || user.learnedSkills.length || Object.hasOwn(user, 'memoryKnowledge')) throw new Error('Unexpected actor curriculum');
      user.memoryKnowledge = { ...memoryKnowledge, knowledge: null }; messages.at(-1).content = JSON.stringify(user);
      const normalized = clone(messages);
      user.memoryKnowledge = memoryKnowledge; messages.at(-1).content = JSON.stringify(user);
      const base = { modelIdentity: identity, modelSeed: spec.modelSeed, temperature: 0, maxOutputTokens: 1536,
        responseFormat: null, phase: input.phase, messages: normalized, tools: input.tools };
      const row = { ...tags, phase: 'execute', caseId: input.caseId, attempt: requests.length + 1, temperature: 0,
        maxOutputTokens: 1536, responseFormat: null, inputSha256: hash(base), actualInputSha256: hash({ ...base, messages }),
        messages, tools: clone(input.tools), ...provenance, status: 'started' };
      requests.push(row); await onEvent({ type: 'scoped-task-request-start', ...clone(row) });
      try {
        const response = await request({ ...input, ...tags, messages, temperature: 0, maxOutputTokens: 1536,
          responseFormat: null, inputSha256: row.inputSha256, actualInputSha256: row.actualInputSha256, ...provenance });
        row.response = clone(response); row.status = 'returned';
        if (response?.providerResponse?.choices?.[0]?.finish_reason === 'length') throw new Error('Actor output budget exhausted; proposed tools were not executed');
        return response;
      } catch (error) { row.error = String(error?.message ?? error); row.status = 'failed'; throw error; }
      finally { await onEvent({ type: 'scoped-task-request-finished', ...clone(row) }); }
    } });
  return { ...result, ...tags, ...provenance, modelIdentity: identity, fixtureSeed: spec.seed, variant: spec.variant, split: spec.split,
    requests, firstInputSha256: requests[0]?.inputSha256 ?? null, firstActualInputSha256: requests[0]?.actualInputSha256 ?? null,
    versionSafety: spec.cohort === 'changed-version' ? fixture.snapshotForTesting().versionSafety : null,
    policyLookups: fixture.verify().policyLookups ?? 0, budgets: plan.limits };
}
export function validateTaskResult({ taskSpec, result, modelIdentity } = {}) {
  if (result.taskId !== taskSpec.taskId || result.arm !== taskSpec.arm || result.caseIndex !== taskSpec.caseIndex ||
      result.cohort !== taskSpec.cohort || result.modelSeed !== taskSpec.modelSeed || hash(result.modelIdentity) !== hash(identityOf(modelIdentity))) throw new Error('Task result identity mismatch');
}
