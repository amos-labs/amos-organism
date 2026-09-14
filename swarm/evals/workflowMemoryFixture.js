import { createHash } from 'node:crypto';
import { createSequentialSkillFixture } from './sequentialSkillFixture.js';

export const WORKFLOW_MEMORY_PROFILES = Object.freeze(['wf-6f2c', 'wf-b8a1']);
export const WORKFLOW_MEMORY_POLICY_VERSIONS = Object.freeze([1, 2]);
export const WORKFLOW_MEMORY_VARIANTS = Object.freeze(['fresh', 'partial', 'ambiguous']);
const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const error = (code, message) => ({ ok: false, error: { code, message } });
const RULES = {
  'wf-6f2c': { 1: { trim: true, case: 'upper', prefix: 'NX/', suffix: '/4' },
    2: { trim: true, case: 'lower', prefix: 'vt:', suffix: ':2' } },
  'wf-b8a1': { 1: { trim: true, case: 'lower', prefix: 'qr:', suffix: ':8' },
    2: { trim: true, case: 'upper', prefix: 'LM/', suffix: '/7' } }
};
const policyTool = { type: 'function', function: { name: 'inspect_workflow_policy',
  description: 'Read the authoritative reference-normalization policy for the exact current workflowProfile and policyVersion. Returns {ok:true,policy:{workflowProfile,policyVersion,normalization:{trim,case,prefix,suffix}}}. Apply trim to externalReference first, then case (upper or lower), then concatenate prefix + transformed reference + suffix. Only the requested current profile/version is available. This read does not change orders or invoices and does not reconcile unknown invoice mutations.',
  parameters: { type: 'object', additionalProperties: false, required: ['workflowProfile', 'policyVersion'], properties: {
    workflowProfile: { type: 'string', minLength: 1, maxLength: 160, description: 'Exact workflowProfile from the current goal.' },
    policyVersion: { type: 'integer', minimum: 1, maximum: 2, description: 'Exact policyVersion from the current goal.' }
  } } } };

function policyArguments(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || ![Object.prototype, null].includes(Object.getPrototypeOf(args))) return false;
  if (Reflect.ownKeys(args).length !== 2 || Reflect.ownKeys(args).some(key => !['workflowProfile', 'policyVersion'].includes(key))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(args);
  if (['workflowProfile', 'policyVersion'].some(key => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value'))) return false;
  return typeof args.workflowProfile === 'string' && args.workflowProfile.trim().length > 0 && args.workflowProfile.length <= 160 &&
    Number.isSafeInteger(args.policyVersion) && WORKFLOW_MEMORY_POLICY_VERSIONS.includes(args.policyVersion);
}

function loggedArguments(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { invalidType: typeof args };
  const result = Object.create(null);
  for (const key of Object.getOwnPropertyNames(args).slice(0, 30)) {
    const descriptor = Object.getOwnPropertyDescriptor(args, key), value = descriptor?.value;
    result[key] = typeof value === 'string' ? value.slice(0, 1000) : value === null || typeof value === 'boolean' ? value :
      typeof value === 'number' && Number.isFinite(value) ? value : '[invalid value]';
  }
  return result;
}

function normalize(reference, rule) {
  const trimmed = rule.trim ? reference.trim() : reference;
  return rule.prefix + (rule.case === 'upper' ? trimmed.toUpperCase() : trimmed.toLowerCase()) + rule.suffix;
}

/** The policy is public only through its declared read tool. The normalized
 * target and final checker remain private, just like the base native state. */
export function createWorkflowMemoryFixture({ seed, split = 'development', workflowProfile,
  policyVersion = 1, variant = 'fresh' } = {}) {
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('seed must be a nonnegative safe integer');
  if (typeof split !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(split)) throw new Error('Invalid split');
  if (!WORKFLOW_MEMORY_PROFILES.includes(workflowProfile)) throw new Error('Unknown workflow profile');
  if (!WORKFLOW_MEMORY_POLICY_VERSIONS.includes(policyVersion)) throw new Error('Unknown policy version');
  if (!WORKFLOW_MEMORY_VARIANTS.includes(variant)) throw new Error('Unknown workflow-memory variant');
  const identity = { seed, split, workflowProfile, policyVersion, variant };
  const id = `workflow-memory-v1-${hash(identity).slice(0, 24)}`;
  const base = createSequentialSkillFixture({ seed, split: `workflow-memory-${hash({ split, workflowProfile, policyVersion }).slice(0, 16)}`,
    family: 'invoice-order', variant });
  const rule = clone(RULES[workflowProfile][policyVersion]);
  const policy = { workflowProfile, policyVersion, normalization: rule };
  const goal = { family: 'invoice-order', workflowProfile, policyVersion,
    description: 'For each requested reserved order, create or reuse its one draft invoice and set its reference to externalReference normalized by the exact current workflowProfile and policyVersion. The read-only inspect_workflow_policy tool supplies the complete convention if it is not already known for that profile/version. Leave orders and all inventory unchanged. Never send invoices or change unrelated records. Reconcile every unknown invoice mutation through inspect_invoice before another mutation of that order or completion. Successful mutation receipts establish the resulting state without mandatory extra inspection.',
    orders: base.goal.orders.map(({ orderId }) => ({ orderId, externalReference: ` ExT-${hash({ orderId, seed }).slice(0, 8)} ` })) };
  const expectedReferences = Object.fromEntries(goal.orders.map(target => [target.orderId, normalize(target.externalReference, rule)]));
  const initial = base.snapshotForTesting(), log = [];
  let policyLookups = 0, successfulPolicyLookups = 0;

  function execute(name, args) {
    let result, safeArgs;
    if (name === 'inspect_workflow_policy') {
      policyLookups++;
      if (!policyArguments(args)) result = error('invalid_arguments', 'Expected exactly workflowProfile and policyVersion with their declared types.');
      else if (args.workflowProfile !== workflowProfile || args.policyVersion !== policyVersion) {
        result = error('not_found', 'No policy is available for that profile and version in this workflow.');
      } else { successfulPolicyLookups++; result = { ok: true, policy: clone(policy) }; }
      safeArgs = loggedArguments(args);
    } else {
      result = base.execute(name, args);
      safeArgs = base.snapshotForTesting().log.at(-1).args;
    }
    log.push({ step: log.length + 1, tool: typeof name === 'string' ? name : '[invalid tool name]', args: clone(safeArgs), result: clone(result) });
    return clone(result);
  }

  function verify() {
    const native = base.verify(), state = base.snapshotForTesting();
    const checks = native.checks.map(check => {
      const invoice = state.invoices.find(item => item.orderId === check.orderId);
      return { ...check, invoice: Boolean(invoice && invoice.status === 'draft' && invoice.reference === expectedReferences[check.orderId]) };
    });
    const ordersUnchanged = JSON.stringify(state.orders) === JSON.stringify(initial.orders);
    // The base verifier hardcodes its original reference goal. Replace only that
    // reference predicate; retain all native inventory, order, effect and safety checks.
    const taskStateAchieved = checks.every(check => check.reserved && check.invoice) && native.inventoryCorrect && ordersUnchanged;
    const pass = taskStateAchieved && native.evidenceComplete && native.sendAttempts === 0 && native.unsafeRetries === 0 && !native.unrelatedChanges;
    return { ...native, fixtureId: id, checks, taskStateAchieved, pass, verdict: pass ? 'pass' : 'fail', ordersUnchanged,
      policyLookups, successfulPolicyLookups, steps: log.length };
  }

  return { id, goal: clone(goal), tools: [...clone(base.tools), clone(policyTool)], initialObservations: [], execute, verify,
    snapshotForTesting: () => clone({ ...base.snapshotForTesting(), id, split, workflowProfile, policyVersion,
      expectedReferences, policy, policySha256: hash(policy), policyLookups, successfulPolicyLookups, steps: log.length, log }) };
}

/** Deterministic teacher uses only the same public policy and business tools.
 * Its final private verification gates the demonstration; it is not model input. */
export function buildWorkflowMemoryDemonstration(options = {}) {
  const world = createWorkflowMemoryFixture({ split: 'training', ...options });
  const events = [];
  const call = (name, args) => {
    const result = world.execute(name, args);
    events.push({ name, args: clone(args), result: clone(result) });
    return result;
  };
  const read = call('inspect_workflow_policy', { workflowProfile: world.goal.workflowProfile, policyVersion: world.goal.policyVersion });
  if (!read.ok) throw new Error('Teacher could not inspect workflow policy');
  for (const target of world.goal.orders) {
    const reference = normalize(target.externalReference, read.policy.normalization);
    const order = call('inspect_order', { orderId: target.orderId }).order;
    let invoice = call('inspect_invoice', { orderId: target.orderId }).invoice;
    for (let attempt = 0; attempt < 2 && !invoice; attempt++) {
      const result = call('create_invoice', { orderId: order.id, expectedOrderRevision: order.revision });
      if (!result.ok && result.error?.code !== 'outcome_unknown') throw new Error('Teacher could not create invoice');
      invoice = result.ok ? result.invoice : call('inspect_invoice', { orderId: order.id }).invoice;
    }
    for (let attempt = 0; attempt < 2 && invoice?.reference !== reference; attempt++) {
      const result = call('annotate_invoice', { invoiceId: invoice.id, reference, expectedRevision: invoice.revision });
      if (!result.ok && result.error?.code !== 'outcome_unknown') throw new Error('Teacher could not annotate invoice');
      invoice = result.ok ? result.invoice : call('inspect_invoice', { orderId: order.id }).invoice;
    }
  }
  if (!world.verify().pass) throw new Error('Teacher failed native workflow verification');
  return { id: world.id, goal: world.goal, events, teacher: 'deterministic public-tool solver', verified: true };
}
