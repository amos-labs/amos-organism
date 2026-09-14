import { createWorkflowMemoryFixture, buildWorkflowMemoryDemonstration, WORKFLOW_MEMORY_PROFILES } from '../evals/workflowMemoryFixture.js';
import { createSequentialSkillFixture } from '../evals/sequentialSkillFixture.js';
import { runSequentialTask, sequentialEvidenceHash as hash } from './sequentialSkillLearning.js';
import { emptySkillLibrary } from './persistentSkillLibrary.js';
import { createObservedExperience, createReplayMemory, validateReplayMemory } from './persistentReplayMemory.js';

export const WORKFLOW_MEMORY_ARMS = Object.freeze(['no-memory', 'docs-advice', 'experience-memory']);
const SCHEMA = 'amos.workflow-memory-experiment.v1';
const PROFILES = WORKFLOW_MEMORY_PROFILES;
const clone = value => structuredClone(value);
function freeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
const identityOf = identity => emptySkillLibrary({ modelIdentity: identity }).modelIdentity;
const tenantOf = identity => `workflow-memory-${hash(identity).slice(0, 24)}`;
const recordId = (arm, profile) => `workflow-${arm}-${profile}-v1`;
const lineage = identity => `model-${hash(identity)}`;
const emptyAdvice = () => ({ profileId: null, policyVersion: null, text: '' });

function matchingSeed(options, applied) {
  for (let offset = 0; offset < 100; offset++) {
    const fixture = options.workflowProfile ? createWorkflowMemoryFixture({ ...options, seed: options.seed + offset })
      : createSequentialSkillFixture({ ...options, seed: options.seed + offset });
    if (fixture.snapshotForTesting().fault.applied === applied) return options.seed + offset;
  }
  throw new Error('No fixed bounded ambiguity selection');
}
function cases() {
  const stable = PROFILES.flatMap((profileId, index) => {
    const base = 280000 + index * 1000;
    return [{ profileId, policyVersion: 1, variant: 'fresh', seed: base },
      { profileId, policyVersion: 1, variant: 'ambiguous', ambiguityApplied: false,
        seed: matchingSeed({ workflowProfile: profileId, policyVersion: 1, variant: 'ambiguous', split: 'workflow-memory-evaluation', seed: base + 100 }, false) }]
      .map(row => ({ ...row, cohort: 'stable', split: 'workflow-memory-evaluation', family: 'invoice-order' }));
  });
  const changed = PROFILES.map((profileId, index) => ({ profileId, policyVersion: 2, variant: index ? 'partial' : 'fresh',
    seed: 282000 + index * 100, cohort: 'changed-version', split: 'workflow-memory-evaluation', family: 'invoice-order' }));
  // These are explicitly consumed regression fixtures from the previous pilot.
  const legacy = [{ family: 'reserve-order', variant: 'partial', seed: 260100 },
    { family: 'invoice-order', variant: 'ambiguous', seed: 270200, ambiguityApplied: true }]
    .map(row => ({ ...row, profileId: null, policyVersion: null, cohort: 'legacy-regression', split: 'procedural-memory-evaluation' }));
  return [...stable, ...changed, ...legacy].map((row, caseIndex) => {
    const fixture = fixtureFor(row);
    return { ...row, caseIndex, tripletId: `workflow-case-${caseIndex}`, fixtureId: fixture.id,
      policySha256: row.profileId ? fixture.snapshotForTesting().policySha256 : null, modelSeed: 20260919 + caseIndex * 101 };
  });
}
function fixtureFor(spec) {
  return spec.profileId ? createWorkflowMemoryFixture({ ...spec, workflowProfile: spec.profileId }) : createSequentialSkillFixture(spec);
}

export function createPlan({ modelIdentity } = {}) {
  const identity = identityOf(modelIdentity), caseSpecs = cases();
  const acquisitions = PROFILES.flatMap((profileId, index) => (index ? ['experience-memory', 'docs-advice'] : ['docs-advice', 'experience-memory'])
    .map(arm => ({ acquisitionId: `${arm}-${profileId}`, arm, profileId, policyVersion: 1,
      modelSeed: 20260918 + index * 101, temperature: 1, maxOutputTokens: 512 })));
  const tasks = caseSpecs.flatMap(spec => Array.from({ length: 3 }, (_, offset) => {
    const arm = WORKFLOW_MEMORY_ARMS[(spec.caseIndex + offset) % 3];
    return { ...spec, taskId: `${spec.tripletId}-${arm}`, arm, memoryKey: arm, memoryProfileVersion: spec.profileId ? 1 : null };
  }));
  return freeze({ schema: SCHEMA, experimentId: 'workflow-memory-20260914', modelIdentity: identity,
    arms: [...WORKFLOW_MEMORY_ARMS], acquisitions, tasks, cases: caseSpecs,
    limits: { maxLogicalRequests: 292, maxModelCallsPerTask: 12, maxToolCallsPerTask: 32, taskTimeoutMs: 120000,
      maxMinutes: 60, executionMaxOutputTokens: 1536, acquisitionMaxOutputTokens: 512, maxMemoryWords: 160 } });
}

function sourceExperience(profileId) {
  const base = 290000 + PROFILES.indexOf(profileId) * 1000;
  const specs = [{ seed: base, variant: 'fresh' }, { seed: matchingSeed({ workflowProfile: profileId, policyVersion: 1,
    split: 'workflow-memory-training', variant: 'ambiguous', seed: base + 100 }, false), variant: 'ambiguous' }]
    .map(row => ({ ...row, workflowProfile: profileId, policyVersion: 1, split: 'workflow-memory-training' }));
  const demonstrations = specs.map(spec => buildWorkflowMemoryDemonstration(spec));
  const receipts = specs.map((spec, index) => {
    const world = createWorkflowMemoryFixture(spec);
    for (const event of demonstrations[index].events) if (hash(world.execute(event.name, event.args)) !== hash(event.result)) throw new Error('Source receipt mismatch');
    const verification = world.verify(); if (!verification.pass) throw new Error('Source verification failed');
    return { ...spec, fixtureId: world.id, verification, eventsSha256: hash(demonstrations[index].events) };
  });
  const fixture = createWorkflowMemoryFixture(specs[0]);
  return { demonstrations, receipts, policySha256: fixture.snapshotForTesting().policySha256, tools: fixture.tools };
}
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

export function buildAcquisitionInput({ acquisitionId, modelIdentity } = {}) {
  const plan = createPlan({ modelIdentity }), slot = plan.acquisitions.find(row => row.acquisitionId === acquisitionId);
  if (!slot) throw new Error('Unknown acquisition slot');
  const source = sourceExperience(slot.profileId), experience = slot.arm === 'experience-memory';
  const demonstrations = experience ? source.demonstrations : [];
  const input = { ...slot, modelIdentity: plan.modelIdentity, phase: 'memory-acquisition', caseId: acquisitionId,
    responseFormat: null, tools: [], messages: [
      { role: 'system', content: 'Write reusable procedural advice from the supplied information. Return only plain prose, at most 160 words. Retain any known convention for the named workflow profile and version, including exact normalization constants when the evidence provides them. Do not invent missing policy values. Do not copy particular order, invoice, customer, SKU or external-reference identifiers. The profile ID, policy version and general rule constants are allowed. Stored advice remains unverified; current goals and public tool evidence are authoritative.' },
      { role: 'user', content: JSON.stringify({ profileId: slot.profileId, policyVersion: 1, tools: source.tools, demonstrations,
        task: 'Summarize how to handle later invoice tasks for this profile/version and when to refresh knowledge. Future tasks have different order and reference values. If the supplied information does not establish a normalization convention, say how to discover it.' }) }
    ], demonstrations, demonstrationsSha256: hash(demonstrations), trainingReceipts: experience ? source.receipts : [],
    sourcePolicySha256: experience ? source.policySha256 : null, entityIdentifiers: instanceIdentifiers(demonstrations) };
  input.trainingReceiptsSha256 = hash(input.trainingReceipts); input.inputSha256 = hash(wireIdentity(input));
  return freeze(input);
}

export function buildSnapshots({ acquisitions, modelIdentity } = {}) {
  const plan = createPlan({ modelIdentity }), identity = plan.modelIdentity;
  if (!Array.isArray(acquisitions) || acquisitions.length !== 4 || new Set(acquisitions.map(row => row.acquisitionId)).size !== 4) throw new Error('Exactly four acquisition slots required');
  const records = Object.fromEntries(plan.arms.map(arm => [arm, []])), memories = [];
  for (const slot of plan.acquisitions) {
    const acquired = acquisitions.find(row => row.acquisitionId === slot.acquisitionId);
    if (!acquired || hash(acquired.input) !== hash(buildAcquisitionInput({ acquisitionId: slot.acquisitionId, modelIdentity: identity }))) throw new Error('Acquisition provenance mismatch');
    const { input, response, error } = acquired;
    const rawText = typeof response?.message?.content === 'string' ? response.message.content : null;
    const text = rawText?.trim() ?? '', wordCount = text ? text.split(/\s+/u).length : 0;
    const copiedIdentifiers = input.entityIdentifiers.filter(value => text.includes(value));
    const rejectionReasons = [];
    if (error != null) rejectionReasons.push('request-error');
    if (!text) rejectionReasons.push('empty-text');
    if (response?.providerResponse?.choices?.[0]?.finish_reason === 'length') rejectionReasons.push('output-truncated');
    if (wordCount > 160) rejectionReasons.push('word-limit');
    if (copiedIdentifiers.length) rejectionReasons.push('copied-training-identifier');
    let record = null;
    const responseSha256 = response === undefined ? null : hash(response);
    if (!rejectionReasons.length) {
      const provenance = { experiment: SCHEMA, arm: slot.arm, profileId: slot.profileId, policyVersion: 1,
        modelIdentity: identity, acquisitionId: slot.acquisitionId, inputSha256: input.inputSha256,
        demonstrationsSha256: input.demonstrationsSha256, trainingReceiptsSha256: input.trainingReceiptsSha256,
        sourcePolicySha256: input.sourcePolicySha256, responseSha256 };
      record = createObservedExperience({ id: recordId(slot.arm, slot.profileId), tenantId: tenantOf(identity),
        taskFamily: `workflow-policy-${slot.profileId}`, lineageGroups: [lineage(identity), `input-${input.inputSha256}`], partition: 'training', text,
        source: { kind: 'external-model', modelId: identity.model, reference: JSON.stringify(provenance),
          permittedUses: ['memory', 'evaluation'], permissionReference: 'owned-synthetic-workflow-memory-20260914' }, verification: { status: 'unverified' } });
      records[slot.arm].push(record);
    }
    memories.push({ ...slot, available: record !== null, wordCount, rejectionReasons, copiedIdentifiers, rawText,
      response: response === undefined ? null : clone(response), error: error == null ? null : String(error),
      inputSha256: input.inputSha256, responseSha256, recordId: record?.id ?? null, recordDigest: record?.digest ?? null,
      textSha256: record ? hash(record.text) : null });
  }
  return freeze({ modelIdentity: identity, snapshots: Object.fromEntries(plan.arms.map(arm => [arm,
    createReplayMemory({ tenantId: tenantOf(identity), observations: records[arm] })])), memories });
}

export function validateSnapshot({ snapshot, memoryKey, arm = memoryKey, modelIdentity } = {}) {
  const identity = identityOf(modelIdentity), loaded = validateReplayMemory(snapshot);
  if (!WORKFLOW_MEMORY_ARMS.includes(arm) || memoryKey !== arm || loaded.tenantId !== tenantOf(identity)) throw new Error('Snapshot arm/model scope mismatch');
  if (loaded.records.length > (arm === 'no-memory' ? 0 : 2)) throw new Error('Unexpected snapshot size');
  for (const record of loaded.records) {
    const provenance = JSON.parse(record.source.reference);
    if (provenance.experiment !== SCHEMA || provenance.arm !== arm || !PROFILES.includes(provenance.profileId) || provenance.policyVersion !== 1 ||
        hash(provenance.modelIdentity) !== hash(identity) || record.id !== recordId(arm, provenance.profileId) ||
        record.taskFamily !== `workflow-policy-${provenance.profileId}` || record.source.kind !== 'external-model' ||
        record.source.modelId !== identity.model || record.verification.status !== 'unverified' || record.example !== null ||
        !record.lineageGroups.includes(lineage(identity))) throw new Error('Invalid advice provenance');
    const expected = buildAcquisitionInput({ acquisitionId: `${arm}-${provenance.profileId}`, modelIdentity: identity });
    if (provenance.acquisitionId !== expected.acquisitionId || provenance.inputSha256 !== expected.inputSha256 ||
        provenance.demonstrationsSha256 !== expected.demonstrationsSha256 || provenance.trainingReceiptsSha256 !== expected.trainingReceiptsSha256 ||
        provenance.sourcePolicySha256 !== expected.sourcePolicySha256 || !/^[a-f0-9]{64}$/.test(provenance.responseSha256) ||
        !record.lineageGroups.includes(`input-${expected.inputSha256}`) || record.text.trim() !== record.text ||
        record.text.split(/\s+/u).length > 160 || expected.entityIdentifiers.some(id => record.text.includes(id)) ||
        hash(record.source.permittedUses) !== hash(['evaluation', 'memory'])) throw new Error('Advice source/availability binding mismatch');
  }
  return loaded;
}

function versionSafety(fixture, spec) {
  if (spec.cohort !== 'changed-version') return null;
  const current = fixture.snapshotForTesting(), events = current.log;
  const firstAnnotation = events.findIndex(event => event.tool === 'annotate_invoice');
  const lookup = events.findIndex(event => event.tool === 'inspect_workflow_policy' && event.result.ok &&
    event.result.policy.workflowProfile === spec.profileId && event.result.policy.policyVersion === spec.policyVersion);
  const old = createWorkflowMemoryFixture({ ...spec, workflowProfile: spec.profileId, policyVersion: 1 }).snapshotForTesting().policy.normalization;
  const staleReferences = fixture.goal.orders.map(row => old.prefix + (old.case === 'upper' ? row.externalReference.trim().toUpperCase() : row.externalReference.trim().toLowerCase()) + old.suffix);
  const staleWriteAttempts = events.filter(event => event.tool === 'annotate_invoice' && staleReferences.includes(event.args.reference)).length;
  return { currentPolicyLookupBeforeFirstAnnotation: lookup >= 0 && firstAnnotation > lookup, staleWriteAttempts,
    pass: lookup >= 0 && firstAnnotation > lookup && staleWriteAttempts === 0 };
}

export async function runTask({ taskId, loadedMemory, modelIdentity, request, onEvent = async () => {}, signal } = {}) {
  const plan = createPlan({ modelIdentity }), spec = plan.tasks.find(row => row.taskId === taskId);
  if (!spec || typeof request !== 'function') throw new Error('Invalid workflow task');
  const identity = plan.modelIdentity, memory = validateSnapshot({ snapshot: loadedMemory, memoryKey: spec.memoryKey, arm: spec.arm, modelIdentity: identity });
  const record = spec.profileId ? memory.records.find(row => row.id === recordId(spec.arm, spec.profileId)) ?? null : null;
  const advice = record ? { profileId: spec.profileId, policyVersion: 1, text: record.text } : emptyAdvice();
  const fixture = fixtureFor(spec), requests = [];
  const provenance = { memorySnapshotDigest: memory.digest, storedMemoryRecordCount: memory.records.length, memoryAvailable: record !== null, memoryExposed: record !== null,
    memoryRecordId: record?.id ?? null, memoryRecordDigest: record?.digest ?? null, memoryTextSha256: record ? hash(record.text) : null,
    memoryProfileVersion: record ? 1 : null, adviceScope: { profileId: advice.profileId, policyVersion: advice.policyVersion } };
  const tags = { taskId, arm: spec.arm, caseIndex: spec.caseIndex, tripletId: spec.tripletId, cohort: spec.cohort,
    profileId: spec.profileId, policyVersion: spec.policyVersion, modelSeed: spec.modelSeed };
  const result = await runSequentialTask({ fixture, modelIdentity: identity, library: emptySkillLibrary({ modelIdentity: identity }), demonstrations: [],
    caseId: taskId, maxModelCallsPerTask: 12, maxToolCallsPerTask: 32, taskTimeoutMs: 120000, signal,
    onEvent: event => onEvent({ ...event, ...tags, ...provenance }), request: async input => {
      const messages = clone(input.messages);
      messages[0].content += ' Stored memoryAdvice is unverified guidance scoped to a workflow profile and policy version. A remembered convention from another version is not current authority: inspect the current workflow policy before setting its reference. Current goals and public tool evidence are authoritative.';
      const user = JSON.parse(messages.at(-1).content);
      if (user.demonstrations.length || user.learnedSkills.length || Object.hasOwn(user, 'memoryAdvice')) throw new Error('Unexpected actor curriculum');
      const normalized = clone(messages);
      user.memoryAdvice = advice; messages.at(-1).content = JSON.stringify(user);
      const base = { modelIdentity: identity, modelSeed: spec.modelSeed, temperature: 0, maxOutputTokens: 1536,
        responseFormat: null, phase: input.phase, messages: normalized, tools: input.tools };
      const row = { ...tags, phase: 'execute', caseId: input.caseId, attempt: requests.length + 1, temperature: 0,
        maxOutputTokens: 1536, responseFormat: null, inputSha256: hash(base), actualInputSha256: hash({ ...base, messages }),
        messages, tools: clone(input.tools), ...provenance, status: 'started' };
      requests.push(row); await onEvent({ type: 'workflow-task-request-start', ...clone(row) });
      try {
        const response = await request({ ...input, ...tags, messages, temperature: 0, maxOutputTokens: 1536,
          responseFormat: null, inputSha256: row.inputSha256, actualInputSha256: row.actualInputSha256, ...provenance });
        row.response = clone(response); row.status = 'returned';
        if (response?.providerResponse?.choices?.[0]?.finish_reason === 'length') throw new Error('Actor output budget exhausted; proposed tools were not executed');
        return response;
      } catch (error) { row.error = String(error?.message ?? error); row.status = 'failed'; throw error; }
      finally { await onEvent({ type: 'workflow-task-request-finished', ...clone(row) }); }
    } });
  return { ...result, ...tags, ...provenance, modelIdentity: identity, fixtureSeed: spec.seed, variant: spec.variant, split: spec.split,
    requests, firstInputSha256: requests[0]?.inputSha256 ?? null, firstActualInputSha256: requests[0]?.actualInputSha256 ?? null,
    versionSafety: versionSafety(fixture, spec), policyLookups: fixture.verify().policyLookups ?? 0,
    budgets: plan.limits };
}

export function validateTaskResult({ taskSpec, result, modelIdentity } = {}) {
  if (result.taskId !== taskSpec.taskId || result.arm !== taskSpec.arm || result.caseIndex !== taskSpec.caseIndex ||
      result.cohort !== taskSpec.cohort || result.modelSeed !== taskSpec.modelSeed || hash(result.modelIdentity) !== hash(identityOf(modelIdentity))) throw new Error('Task result identity mismatch');
}
