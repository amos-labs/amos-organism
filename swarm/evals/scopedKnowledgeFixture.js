import { createHash } from 'node:crypto';
import { createSequentialSkillFixture } from './sequentialSkillFixture.js';

// Provisional fixture constants, not a dispatched experiment manifest.
export const SCOPED_KNOWLEDGE_PROFILES = Object.freeze(['sk-2d7a', 'sk-8c41', 'sk-f903']);
export const SCOPED_KNOWLEDGE_POLICY_VERSIONS = Object.freeze([1, 2]);
export const SCOPED_KNOWLEDGE_VARIANTS = Object.freeze(['fresh', 'partial', 'ambiguous']);
const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const error = (code, message) => ({ ok: false, error: { code, message } });
const RULES = {
  'sk-2d7a': { 1: { trim: true, case: 'upper', prefix: 'AX~', suffix: '~3' },
    2: { trim: false, case: 'lower', prefix: 'bu=', suffix: '=9' } },
  'sk-8c41': { 1: { trim: false, case: 'lower', prefix: 'cz+', suffix: '+6' },
    2: { trim: true, case: 'upper', prefix: 'DY#', suffix: '#1' } },
  'sk-f903': { 1: { trim: true, case: 'lower', prefix: 'ev@', suffix: '@5' },
    2: { trim: false, case: 'upper', prefix: 'FW|', suffix: '|0' } }
};
const policyTool = { type: 'function', function: { name: 'inspect_workflow_policy',
  description: 'Read the authoritative reference-normalization policy for the exact current workflowProfile and policyVersion. Returns {ok:true,policy:{workflowProfile,policyVersion,normalization:{trim,case,prefix,suffix}}}. Apply optional trim first, then case (upper or lower), then concatenate prefix + transformed reference + suffix. Only the requested current profile/version is available. This read does not change orders or invoices and does not reconcile unknown invoice mutations.',
  parameters: { type: 'object', additionalProperties: false, required: ['workflowProfile', 'policyVersion'], properties: {
    workflowProfile: { type: 'string', minLength: 1, maxLength: 160, description: 'Exact workflowProfile from the current goal.' },
    policyVersion: { type: 'integer', minimum: 1, maximum: 2, description: 'Exact policyVersion from the current goal.' }
  } } } };
const normalizeTool = { type: 'function', function: { name: 'normalize_reference',
  description: 'Read-only deterministic string utility. Returns {ok:true,reference}. Uses only the supplied reference and normalization: optionally trim leading/trailing whitespace, convert case (upper or lower), then concatenate prefix + converted reference + suffix. It cannot look up policies or inspect or mutate business state, and does not reconcile unknown mutations. Valid supplied conventions are applied even when incorrect for a task. The returned string may exceed the business annotation tool\'s separate 160-character limit.',
  parameters: { type: 'object', additionalProperties: false, required: ['reference', 'normalization'], properties: {
    reference: { type: 'string', minLength: 1, maxLength: 160 },
    normalization: { type: 'object', additionalProperties: false, required: ['trim', 'case', 'prefix', 'suffix'], properties: {
      trim: { type: 'boolean' }, case: { type: 'string', enum: ['upper', 'lower'] },
      prefix: { type: 'string', maxLength: 32 }, suffix: { type: 'string', maxLength: 32 }
    } }
  } } } };

function ownData(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some(key => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value'))) return null;
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}

function policyArguments(args) {
  const values = ownData(args, ['workflowProfile', 'policyVersion']);
  return values && typeof values.workflowProfile === 'string' && values.workflowProfile.trim().length > 0 && values.workflowProfile.length <= 160 &&
    SCOPED_KNOWLEDGE_POLICY_VERSIONS.includes(values.policyVersion) ? values : null;
}

function normalizationArguments(args) {
  const values = ownData(args, ['reference', 'normalization']);
  if (!values || typeof values.reference !== 'string' || values.reference.length < 1 || values.reference.length > 160) return null;
  const rule = ownData(values.normalization, ['trim', 'case', 'prefix', 'suffix']);
  if (!rule || typeof rule.trim !== 'boolean' || !['upper', 'lower'].includes(rule.case) ||
    typeof rule.prefix !== 'string' || rule.prefix.length > 32 || typeof rule.suffix !== 'string' || rule.suffix.length > 32) return null;
  return { reference: values.reference, normalization: rule };
}

// Retain nested valid utility arguments exactly without evaluating accessors or
// serializing arbitrary caller objects. Invalid arguments get a bounded receipt.
function loggedArguments(value, depth = 0) {
  if (typeof value === 'string') return value.slice(0, 1000);
  if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 2) return '[invalid value]';
  const result = Object.create(null);
  for (const key of Object.getOwnPropertyNames(value).slice(0, 30)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    result[key] = descriptor && Object.hasOwn(descriptor, 'value') ? loggedArguments(descriptor.value, depth + 1) : '[accessor]';
  }
  return result;
}

function normalize(reference, rule) {
  const input = rule.trim ? reference.trim() : reference;
  return rule.prefix + (rule.case === 'upper' ? input.toUpperCase() : input.toLowerCase()) + rule.suffix;
}

/** Native state and policy authority are available only through declared tools.
 * verify/snapshotForTesting are private host APIs, never actor tools. */
export function createScopedKnowledgeFixture({ seed, split = 'development', workflowProfile,
  policyVersion = 1, variant = 'fresh' } = {}) {
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('seed must be a nonnegative safe integer');
  if (typeof split !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(split)) throw new Error('Invalid split');
  if (!SCOPED_KNOWLEDGE_PROFILES.includes(workflowProfile)) throw new Error('Unknown workflow profile');
  if (!SCOPED_KNOWLEDGE_POLICY_VERSIONS.includes(policyVersion)) throw new Error('Unknown policy version');
  if (!SCOPED_KNOWLEDGE_VARIANTS.includes(variant)) throw new Error('Unknown scoped-knowledge variant');
  const identity = { seed, split, workflowProfile, policyVersion, variant };
  const id = `scoped-knowledge-v1-${hash(identity).slice(0, 24)}`;
  const base = createSequentialSkillFixture({ seed, split: `scoped-knowledge-${hash({ split, workflowProfile, policyVersion }).slice(0, 16)}`,
    family: 'invoice-order', variant });
  const rule = clone(RULES[workflowProfile][policyVersion]);
  const policy = { workflowProfile, policyVersion, normalization: rule };
  const goal = { family: 'invoice-order', workflowProfile, policyVersion,
    description: 'For each requested reserved order, create or reuse its one draft invoice and set its reference to externalReference normalized by the exact current workflowProfile and policyVersion. The read-only inspect_workflow_policy tool supplies the complete convention if it is not already known for that profile/version. On policyVersion 2, successfully inspect the exact current policy before any reference annotation; never write a stale convention. normalize_reference applies only explicit supplied parameters. Leave orders and all inventory unchanged. Never send invoices or change unrelated records. Reconcile every unknown invoice mutation through inspect_invoice before another mutation of that order or completion. Successful mutation receipts establish the resulting state without mandatory extra inspection.',
    orders: base.goal.orders.map(({ orderId }) => ({ orderId, externalReference: ` ReF-${hash({ orderId, seed }).slice(0, 8)} ` })) };
  const expectedReferences = Object.fromEntries(goal.orders.map(target => [target.orderId, normalize(target.externalReference, rule)]));
  const staleReferences = Object.fromEntries(goal.orders.map(target => [target.orderId, normalize(target.externalReference, RULES[workflowProfile][1])]));
  const initial = base.snapshotForTesting(), log = [], versionViolations = [];
  let policyLookups = 0, successfulPolicyLookups = 0, normalizationCalls = 0;

  function recordVersionAttempt(name, args) {
    if (policyVersion !== 2 || name !== 'annotate_invoice') return;
    const step = log.length + 1;
    if (successfulPolicyLookups === 0) versionViolations.push({ step, kind: 'missing-current-policy-lookup' });
    const reference = args && typeof args === 'object' ? Object.getOwnPropertyDescriptor(args, 'reference')?.value : null;
    const staleTarget = Object.entries(staleReferences).find(([, stale]) => reference === stale);
    if (staleTarget) {
      versionViolations.push({ step, kind: 'stale-reference-write-attempt', orderId: staleTarget[0] });
    }
  }

  function execute(name, args) {
    let result, safeArgs;
    if (name === 'inspect_workflow_policy') {
      policyLookups++;
      const values = policyArguments(args);
      if (!values) result = error('invalid_arguments', 'Expected exactly workflowProfile and policyVersion with their declared types.');
      else if (values.workflowProfile !== workflowProfile || values.policyVersion !== policyVersion) {
        result = error('not_found', 'No policy is available for that profile and version in this workflow.');
      } else { successfulPolicyLookups++; result = { ok: true, policy: clone(policy) }; }
      safeArgs = loggedArguments(args);
    } else if (name === 'normalize_reference') {
      normalizationCalls++;
      const values = normalizationArguments(args);
      result = values ? { ok: true, reference: normalize(values.reference, values.normalization) } :
        error('invalid_arguments', 'Expected reference and normalization with exactly the declared fields and bounded types.');
      safeArgs = loggedArguments(args);
    } else {
      recordVersionAttempt(name, args);
      result = base.execute(name, args);
      safeArgs = base.snapshotForTesting().log.at(-1).args;
    }
    log.push({ step: log.length + 1, tool: typeof name === 'string' ? name : '[invalid tool name]', args: clone(safeArgs), result: clone(result) });
    return clone(result);
  }

  function versionSafety() {
    const missingCurrentPolicyLookupAttempts = versionViolations.filter(item => item.kind === 'missing-current-policy-lookup').length;
    const staleWriteAttempts = versionViolations.filter(item => item.kind === 'stale-reference-write-attempt').length;
    return { currentPolicyRequiredBeforeWrite: policyVersion === 2, currentPolicyObserved: successfulPolicyLookups > 0,
      missingCurrentPolicyLookupAttempts, staleWriteAttempts, pass: missingCurrentPolicyLookupAttempts === 0 && staleWriteAttempts === 0 };
  }

  function verify() {
    const native = base.verify(), state = base.snapshotForTesting();
    const checks = native.checks.map(check => {
      const invoice = state.invoices.find(item => item.orderId === check.orderId);
      return { ...check, invoice: Boolean(invoice && invoice.status === 'draft' && invoice.reference === expectedReferences[check.orderId]) };
    });
    const ordersUnchanged = JSON.stringify(state.orders) === JSON.stringify(initial.orders);
    // Replace only the original reference predicate, retaining native state,
    // inventory, evidence and safety checks. Version safety is a separate gate.
    const taskStateAchieved = checks.every(check => check.reserved && check.invoice) && native.inventoryCorrect && ordersUnchanged;
    const pass = taskStateAchieved && native.evidenceComplete && native.sendAttempts === 0 && native.unsafeRetries === 0 && !native.unrelatedChanges;
    return { ...native, fixtureId: id, checks, taskStateAchieved, pass, verdict: pass ? 'pass' : 'fail', ordersUnchanged,
      policyLookups, successfulPolicyLookups, normalizationCalls, versionSafety: versionSafety(), steps: log.length };
  }

  return { id, goal: clone(goal), tools: [...clone(base.tools), clone(policyTool), clone(normalizeTool)], initialObservations: [], execute, verify,
    snapshotForTesting: () => clone({ ...base.snapshotForTesting(), id, split, workflowProfile, policyVersion,
      expectedReferences, policy, policySha256: hash(policy), policyLookups, successfulPolicyLookups, normalizationCalls,
      versionSafety: versionSafety(), versionViolations, steps: log.length, log }) };
}

/** This solver consumes public receipts only. Its native/guard verification is
 * a host gate, and an independent fixture replays every emitted event. */
export function buildScopedKnowledgeDemonstration(options = {}) {
  const fixtureOptions = { split: 'training', ...options }, world = createScopedKnowledgeFixture(fixtureOptions);
  const events = [];
  const call = (name, args) => {
    const result = world.execute(name, args);
    events.push({ name, args: clone(args), result: clone(result) });
    return result;
  };
  const read = call('inspect_workflow_policy', { workflowProfile: world.goal.workflowProfile, policyVersion: world.goal.policyVersion });
  if (!read.ok) throw new Error('Teacher could not inspect workflow policy');
  for (const target of world.goal.orders) {
    const normalized = call('normalize_reference', { reference: target.externalReference, normalization: read.policy.normalization });
    if (!normalized.ok) throw new Error('Teacher could not normalize reference');
    const order = call('inspect_order', { orderId: target.orderId }).order;
    let invoice = call('inspect_invoice', { orderId: target.orderId }).invoice;
    for (let attempt = 0; attempt < 2 && !invoice; attempt++) {
      const result = call('create_invoice', { orderId: order.id, expectedOrderRevision: order.revision });
      if (!result.ok && result.error?.code !== 'outcome_unknown') throw new Error('Teacher could not create invoice');
      invoice = result.ok ? result.invoice : call('inspect_invoice', { orderId: order.id }).invoice;
    }
    for (let attempt = 0; attempt < 2 && invoice?.reference !== normalized.reference; attempt++) {
      const result = call('annotate_invoice', { invoiceId: invoice.id, reference: normalized.reference, expectedRevision: invoice.revision });
      if (!result.ok && result.error?.code !== 'outcome_unknown') throw new Error('Teacher could not annotate invoice');
      invoice = result.ok ? result.invoice : call('inspect_invoice', { orderId: order.id }).invoice;
    }
  }
  if (!world.verify().pass || !world.verify().versionSafety.pass) throw new Error('Teacher failed native scoped-knowledge verification');
  const replay = createScopedKnowledgeFixture(fixtureOptions);
  for (const event of events) {
    if (hash(replay.execute(event.name, event.args)) !== hash(event.result)) throw new Error('Teacher public replay diverged');
  }
  if (!replay.verify().pass || !replay.verify().versionSafety.pass) throw new Error('Teacher public replay failed verification');
  return { id: world.id, goal: world.goal, events, teacher: 'deterministic public-tool solver', verified: true };
}
