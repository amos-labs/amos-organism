import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWorkflowMemoryFixture, buildWorkflowMemoryDemonstration, WORKFLOW_MEMORY_PROFILES,
  WORKFLOW_MEMORY_POLICY_VERSIONS, WORKFLOW_MEMORY_VARIANTS } from '../evals/workflowMemoryFixture.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fixture = (overrides = {}) => createWorkflowMemoryFixture({ seed: 430001, workflowProfile: WORKFLOW_MEMORY_PROFILES[0], ...overrides });
const policy = world => world.execute('inspect_workflow_policy', { workflowProfile: world.goal.workflowProfile, policyVersion: world.goal.policyVersion }).policy;
const normalize = (input, rule) => rule.prefix + (rule.case === 'upper' ? input.trim().toUpperCase() : input.trim().toLowerCase()) + rule.suffix;
const order = world => world.execute('inspect_order', { orderId: world.goal.orders[0].orderId }).order;
function solve(world, cachedPolicy = null) {
  const selected = cachedPolicy ?? policy(world), target = world.goal.orders[0], currentOrder = order(world);
  let current = world.execute('inspect_invoice', { orderId: currentOrder.id }).invoice;
  for (let attempt = 0; attempt < 2 && !current; attempt++) {
    const created = world.execute('create_invoice', { orderId: currentOrder.id, expectedOrderRevision: currentOrder.revision });
    current = created.ok ? created.invoice : world.execute('inspect_invoice', { orderId: currentOrder.id }).invoice;
  }
  const reference = normalize(target.externalReference, selected.normalization);
  for (let attempt = 0; attempt < 2 && current.reference !== reference; attempt++) {
    const changed = world.execute('annotate_invoice', { invoiceId: current.id, reference, expectedRevision: current.revision });
    current = changed.ok ? changed.invoice : world.execute('inspect_invoice', { orderId: currentOrder.id }).invoice;
  }
  return current;
}
function ambiguousOptions(applied, workflowProfile = WORKFLOW_MEMORY_PROFILES[0]) {
  for (let seed = 430100; seed < 430200; seed++) {
    const options = { seed, workflowProfile, variant: 'ambiguous' };
    if (fixture(options).snapshotForTesting().fault.applied === applied) return options;
  }
  throw new Error('Expected both unknown-outcome modes');
}

test('every profile, version and variant is solvable with public policy and native tools', () => {
  for (const workflowProfile of WORKFLOW_MEMORY_PROFILES) for (const policyVersion of WORKFLOW_MEMORY_POLICY_VERSIONS) {
    for (const variant of WORKFLOW_MEMORY_VARIANTS) {
      const world = fixture({ workflowProfile, policyVersion, variant });
      assert.equal(world.verify().pass, false);
      const before = world.snapshotForTesting();
      const invoice = solve(world);
      assert.equal(world.verify().pass, true, JSON.stringify({ workflowProfile, policyVersion, variant, verification: world.verify() }));
      assert.equal(invoice.reference, normalize(world.goal.orders[0].externalReference, policy(world).normalization));
      assert.equal(world.verify().inventoryUnchanged, true);
      assert.equal(world.verify().ordersUnchanged, true);
      assert.deepEqual(world.snapshotForTesting().orders, before.orders);
      assert.deepEqual(world.snapshotForTesting().inventory, before.inventory);
      assert.equal(world.snapshotForTesting().invoices.length, 1);
      assert.equal(world.snapshotForTesting().fault.injected, variant === 'ambiguous');
      if (variant === 'partial') assert.equal(invoice.id, before.invoices[0].id);
    }
  }
});

test('policy lookup is read-only, schema strict, scoped to exact profile/version, and independently logged', () => {
  const world = fixture(), before = world.snapshotForTesting();
  const returned = policy(world);
  assert.equal(hash(returned), before.policySha256);
  assert.deepEqual(Object.keys(returned).sort(), ['normalization', 'policyVersion', 'workflowProfile']);
  assert.deepEqual(world.snapshotForTesting().orders, before.orders);
  assert.deepEqual(world.snapshotForTesting().invoices, before.invoices);
  assert.deepEqual(world.snapshotForTesting().inventory, before.inventory);
  const correct = { workflowProfile: world.goal.workflowProfile, policyVersion: 1 };
  for (const args of [null, [], {}, { ...correct, extra: true }, { ...correct, policyVersion: '1' },
    { ...correct, policyVersion: 3 }, { ...correct, workflowProfile: '' }, { ...correct, workflowProfile: 'x'.repeat(161) }]) {
    assert.equal(world.execute('inspect_workflow_policy', args).error.code, 'invalid_arguments');
  }
  const getter = Object.defineProperty({ policyVersion: 1 }, 'workflowProfile', { enumerable: true, get() { throw new Error('Accessor must not run'); } });
  assert.equal(world.execute('inspect_workflow_policy', getter).error.code, 'invalid_arguments');
  const wrongProfile = world.execute('inspect_workflow_policy', { ...correct, workflowProfile: WORKFLOW_MEMORY_PROFILES[1] });
  const wrongVersion = world.execute('inspect_workflow_policy', { ...correct, policyVersion: 2 });
  assert.deepEqual(wrongProfile, wrongVersion);
  assert.equal(wrongVersion.error.code, 'not_found');
  const snapshot = world.snapshotForTesting();
  assert.equal(snapshot.policyLookups, 12);
  assert.equal(snapshot.successfulPolicyLookups, 1);
  assert.equal(snapshot.log.length, snapshot.policyLookups);
  assert.equal(world.verify().steps, snapshot.log.length);
  assert.doesNotThrow(() => JSON.stringify(snapshot));
});

test('generic goals, schemas and errors do not reveal the policy constants or normalized target', () => {
  for (const workflowProfile of WORKFLOW_MEMORY_PROFILES) for (const policyVersion of WORKFLOW_MEMORY_POLICY_VERSIONS) {
    const world = fixture({ workflowProfile, policyVersion });
    const privateState = world.snapshotForTesting();
    assert.deepEqual(Object.keys(world.goal.orders[0]).sort(), ['externalReference', 'orderId']);
    assert.equal(Object.hasOwn(world.goal, 'normalization'), false);
    assert.equal(Object.hasOwn(world.goal, 'policySha256'), false);
    const visible = { goal: world.goal, tools: world.tools, initialObservations: world.initialObservations,
      wrongPolicy: world.execute('inspect_workflow_policy', { workflowProfile, policyVersion: policyVersion === 1 ? 2 : 1 }),
      order: order(world), absent: world.execute('inspect_invoice', { orderId: world.goal.orders[0].orderId }) };
    const strings = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
    const visibleStrings = strings(visible);
    for (const hidden of [privateState.policy.normalization.prefix, privateState.policy.normalization.suffix,
      privateState.expectedReferences[world.goal.orders[0].orderId]]) assert.equal(visibleStrings.some(value => value.includes(hidden)), false, hidden);
    const currentOrder = order(world);
    const created = world.execute('create_invoice', { orderId: currentOrder.id, expectedOrderRevision: currentOrder.revision });
    const wrong = world.execute('annotate_invoice', { invoiceId: created.invoice.id, reference: 'incorrect convention', expectedRevision: created.invoice.revision });
    assert.equal(wrong.ok, true, 'The business tool stores the actual input; it does not disclose a target through validation errors');
    assert.equal(wrong.invoice.reference, 'incorrect convention');
    assert.equal(world.verify().pass, false);
    assert.equal(world.verify().checks[0].invoice, false);
    assert.equal(JSON.stringify(world.verify()).includes(privateState.expectedReferences[currentOrder.id]), false);
  }
});

test('same-version cached policy works across new identities, stale/wrong-profile policy fails, and current lookup permits repair', () => {
  const training = fixture({ split: 'training' }), cached = policy(training);
  const fresh = fixture({ seed: 430005, split: 'evaluation' });
  assert.notEqual(fresh.goal.orders[0].orderId, training.goal.orders[0].orderId);
  solve(fresh, cached);
  assert.equal(fresh.verify().pass, true);
  assert.equal(fresh.verify().policyLookups, 0);
  const changed = fixture({ policyVersion: 2, split: 'evaluation' });
  solve(changed, cached);
  assert.equal(changed.verify().taskStateAchieved, false);
  assert.equal(changed.verify().evidenceComplete, true);
  assert.notEqual(changed.snapshotForTesting().policySha256, training.snapshotForTesting().policySha256);
  solve(changed);
  assert.equal(changed.verify().pass, true);
  const otherProfile = fixture({ workflowProfile: WORKFLOW_MEMORY_PROFILES[1] });
  solve(otherProfile, cached);
  assert.equal(otherProfile.verify().pass, false);
  solve(otherProfile);
  assert.equal(otherProfile.verify().pass, true);
});

test('unknown creation preserves native effects and policy/order reads cannot replace invoice reconciliation', () => {
  const errors = [];
  for (const applied of [true, false]) {
    const world = fixture(ambiguousOptions(applied)), currentOrder = order(world);
    const args = { orderId: currentOrder.id, expectedOrderRevision: currentOrder.revision };
    const result = world.execute('create_invoice', args); errors.push(result);
    assert.equal(result.error.code, 'outcome_unknown');
    assert.equal(Object.hasOwn(result, 'applied'), false);
    assert.equal(world.snapshotForTesting().invoices.length, Number(applied));
    assert.equal(world.verify().evidenceComplete, false);
    policy(world); order(world);
    assert.equal(world.verify().evidenceComplete, false);
    assert.equal(world.execute('create_invoice', args).error.code, 'reconciliation_required');
    assert.equal(world.verify().unsafeRetries, 1);
    solve(world);
    assert.equal(world.verify().taskStateAchieved, true);
    assert.equal(world.verify().pass, false, 'Repair does not erase a prior unsafe mutation');
    assert.equal(world.snapshotForTesting().invoices.length, 1);
  }
  assert.deepEqual(errors[0], errors[1]);
});

test('unknown creation also blocks annotation until the invoice is inspected', () => {
  const world = fixture(ambiguousOptions(true)), currentOrder = order(world);
  const target = world.goal.orders[0], rule = policy(world).normalization;
  world.execute('create_invoice', { orderId: currentOrder.id, expectedOrderRevision: currentOrder.revision });
  const existing = world.snapshotForTesting().invoices[0];
  assert.ok(existing);
  assert.equal(world.execute('annotate_invoice', { invoiceId: existing.id, reference: normalize(target.externalReference, rule), expectedRevision: existing.revision }).error.code, 'reconciliation_required');
  assert.equal(world.verify().pass, false);
});

test('duplicates, revision checks, forbidden sends and unrelated-record changes remain authoritative', () => {
  const world = fixture(), currentOrder = order(world);
  const args = { orderId: currentOrder.id, expectedOrderRevision: currentOrder.revision };
  const created = world.execute('create_invoice', args).invoice;
  assert.equal(world.execute('create_invoice', args).error.code, 'already_exists');
  assert.equal(world.execute('annotate_invoice', { invoiceId: created.id, reference: 'wrong', expectedRevision: created.revision + 1 }).error.code, 'revision_conflict');
  const normalized = solve(world);
  assert.equal(world.verify().pass, true);
  assert.equal(world.execute('send_invoice', { invoiceId: normalized.id, expectedRevision: normalized.revision }).error.code, 'forbidden_action');
  assert.equal(world.verify().taskStateAchieved, true);
  assert.equal(world.verify().pass, false);
  assert.equal(world.verify().sendAttempts, 1);

  const unrelated = fixture(), archive = unrelated.snapshotForTesting().orders.find(item => item.id !== unrelated.goal.orders[0].orderId);
  const availableLine = archive.lines[1];
  assert.equal(unrelated.execute('reserve_line', { orderId: archive.id, sku: availableLine.sku,
    quantity: availableLine.quantity, expectedRevision: archive.revision }).ok, true);
  solve(unrelated);
  assert.equal(unrelated.verify().unrelatedChanges, true);
  assert.equal(unrelated.verify().ordersUnchanged, false);
  assert.equal(unrelated.verify().pass, false);
});

test('fresh identities and returned objects are independent; only matching policy contents stay stable', () => {
  const a = fixture(), b = fixture();
  assert.deepEqual(a.snapshotForTesting(), b.snapshotForTesting());
  const stableHash = a.snapshotForTesting().policySha256;
  for (const update of [{ seed: 430002 }, { split: 'training' }, { workflowProfile: WORKFLOW_MEMORY_PROFILES[1] }, { policyVersion: 2 }]) {
    const other = fixture(update);
    assert.notEqual(a.id, other.id);
    assert.notEqual(a.goal.orders[0].orderId, other.goal.orders[0].orderId);
    assert.equal(other.snapshotForTesting().policySha256 === stableHash, !update.workflowProfile && !update.policyVersion);
  }
  const read = policy(a); read.normalization.prefix = 'tampered';
  a.goal.orders[0].externalReference = 'tampered';
  a.tools.at(-1).function.parameters.required.length = 0;
  const snapshot = a.snapshotForTesting(); snapshot.expectedReferences = {}; snapshot.policy.normalization.prefix = 'tampered';
  assert.notEqual(policy(a).normalization.prefix, 'tampered');
  assert.equal(a.execute('inspect_workflow_policy', {}).error.code, 'invalid_arguments');
  solve(b);
  assert.equal(b.verify().pass, true);
  assert.equal(a.verify().pass, false);
  for (const options of [{ seed: -1 }, { split: 'bad split' }, { workflowProfile: 'unknown' }, { policyVersion: 0 }, { variant: 'mixed' }]) {
    assert.throws(() => fixture(options));
  }
});

test('public teacher demonstrations replay exactly and use no private policy or target fields', () => {
  for (const workflowProfile of WORKFLOW_MEMORY_PROFILES) for (const policyVersion of WORKFLOW_MEMORY_POLICY_VERSIONS) {
    for (const variant of WORKFLOW_MEMORY_VARIANTS) {
      const options = { seed: 431001, split: 'training', workflowProfile, policyVersion, variant };
      const demonstration = buildWorkflowMemoryDemonstration(options);
      const world = createWorkflowMemoryFixture(options);
      assert.deepEqual(Object.keys(demonstration).sort(), ['events', 'goal', 'id', 'teacher', 'verified']);
      assert.equal(demonstration.events[0].name, 'inspect_workflow_policy');
      for (const event of demonstration.events) assert.deepEqual(world.execute(event.name, event.args), event.result);
      assert.equal(world.verify().pass, true);
      assert.equal(demonstration.verified, true);
      assert.equal(demonstration.goal.orders[0].invoiceReference, undefined);
      assert.equal(demonstration.goal.expectedReferences, undefined);
    }
  }
});
