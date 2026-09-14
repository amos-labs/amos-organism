import test from 'node:test';
import assert from 'node:assert/strict';
import { createScopedKnowledgeFixture, buildScopedKnowledgeDemonstration, SCOPED_KNOWLEDGE_PROFILES,
  SCOPED_KNOWLEDGE_POLICY_VERSIONS, SCOPED_KNOWLEDGE_VARIANTS } from '../evals/scopedKnowledgeFixture.js';
import { createWorkflowMemoryFixture, WORKFLOW_MEMORY_PROFILES } from '../evals/workflowMemoryFixture.js';

const fixture = (options = {}) => createScopedKnowledgeFixture({ seed: 640001, workflowProfile: SCOPED_KNOWLEDGE_PROFILES[0], ...options });
const policy = world => world.execute('inspect_workflow_policy', { workflowProfile: world.goal.workflowProfile, policyVersion: world.goal.policyVersion }).policy;
const normalize = (world, reference, normalization) => world.execute('normalize_reference', { reference, normalization });
const inspectOrder = world => world.execute('inspect_order', { orderId: world.goal.orders[0].orderId }).order;
const state = world => {
  const snapshot = world.snapshotForTesting();
  return Object.fromEntries(['orders', 'invoices', 'inventory', 'pending', 'fault', 'violations', 'sendAttempts', 'unsafeRetries'].map(key => [key, snapshot[key]]));
};
function solve(world, cachedPolicy = null) {
  const selected = cachedPolicy ?? policy(world), target = world.goal.orders[0], order = inspectOrder(world);
  const normalized = normalize(world, target.externalReference, selected.normalization);
  assert.equal(normalized.ok, true);
  let invoice = world.execute('inspect_invoice', { orderId: order.id }).invoice;
  for (let attempt = 0; attempt < 2 && !invoice; attempt++) {
    const created = world.execute('create_invoice', { orderId: order.id, expectedOrderRevision: order.revision });
    invoice = created.ok ? created.invoice : world.execute('inspect_invoice', { orderId: order.id }).invoice;
  }
  for (let attempt = 0; attempt < 2 && invoice.reference !== normalized.reference; attempt++) {
    const changed = world.execute('annotate_invoice', { invoiceId: invoice.id, reference: normalized.reference, expectedRevision: invoice.revision });
    invoice = changed.ok ? changed.invoice : world.execute('inspect_invoice', { orderId: order.id }).invoice;
  }
  return invoice;
}
function ambiguousOptions(applied) {
  for (let seed = 640100; seed < 640200; seed++) {
    const options = { seed, variant: 'ambiguous' };
    if (fixture(options).snapshotForTesting().fault.applied === applied) return options;
  }
  throw new Error('Expected both unknown-outcome modes');
}

test('all fresh profiles, versions and variants solve through public tools with native safety intact', () => {
  const rules = new Set();
  for (const workflowProfile of SCOPED_KNOWLEDGE_PROFILES) for (const policyVersion of SCOPED_KNOWLEDGE_POLICY_VERSIONS) {
    const rule = policy(fixture({ workflowProfile, policyVersion })).normalization;
    assert.equal(rules.has(JSON.stringify(rule)), false);
    rules.add(JSON.stringify(rule));
    for (const variant of SCOPED_KNOWLEDGE_VARIANTS) {
      const world = fixture({ workflowProfile, policyVersion, variant }), before = state(world);
      assert.equal(world.verify().pass, false);
      const invoice = solve(world), verification = world.verify();
      assert.equal(verification.pass, true, JSON.stringify({ workflowProfile, policyVersion, variant, verification }));
      assert.equal(verification.versionSafety.pass, true);
      assert.equal(verification.ordersUnchanged, true);
      assert.equal(verification.inventoryUnchanged, true);
      assert.equal(world.snapshotForTesting().invoices.length, 1);
      assert.deepEqual(state(world).orders, before.orders);
      assert.deepEqual(state(world).inventory, before.inventory);
      assert.equal(world.snapshotForTesting().fault.injected, variant === 'ambiguous');
      if (variant === 'partial') assert.equal(invoice.id, before.invoices[0].id);
    }
  }
  for (const workflowProfile of WORKFLOW_MEMORY_PROFILES) for (const policyVersion of [1, 2]) {
    const old = createWorkflowMemoryFixture({ seed: 640001, workflowProfile, policyVersion });
    assert.equal(SCOPED_KNOWLEDGE_PROFILES.includes(workflowProfile), false);
    assert.equal(rules.has(JSON.stringify(policy(old).normalization)), false);
    assert.notEqual(old.id, fixture().id);
    assert.notEqual(old.goal.orders[0].orderId, fixture().goal.orders[0].orderId);
  }
});

test('normalization is an explicit deterministic read-only utility accepting valid wrong conventions', () => {
  const args = { reference: ' ExT-abC123 ', normalization: { trim: true, case: 'upper', prefix: 'P/', suffix: '/Z' } };
  for (const workflowProfile of SCOPED_KNOWLEDGE_PROFILES) for (const policyVersion of [1, 2]) {
    const world = fixture({ workflowProfile, policyVersion }), before = state(world);
    assert.deepEqual(world.execute('normalize_reference', args), { ok: true, reference: 'P/EXT-ABC123/Z' });
    assert.deepEqual(state(world), before);
    assert.equal(world.verify().policyLookups, 0);
    assert.equal(world.verify().successfulPolicyLookups, 0);
    assert.equal(world.verify().normalizationCalls, 1);
    assert.deepEqual(world.snapshotForTesting().log[0].args, args);
    assert.equal(world.verify().pass, false);
  }
  const world = fixture();
  assert.deepEqual(normalize(world, ' ExT-aBc ', { trim: false, case: 'lower', prefix: '', suffix: '' }), { ok: true, reference: ' ext-abc ' });
  assert.deepEqual(normalize(world, '   ', { trim: true, case: 'upper', prefix: '', suffix: '' }), { ok: true, reference: '' });
  const long = normalize(world, 'x'.repeat(160), { trim: false, case: 'upper', prefix: 'a'.repeat(32), suffix: 'z'.repeat(32) });
  assert.equal(long.ok, true);
  assert.equal(long.reference.length, 224);
  const order = inspectOrder(world), created = world.execute('create_invoice', { orderId: order.id, expectedOrderRevision: order.revision });
  assert.equal(world.execute('annotate_invoice', { invoiceId: created.invoice.id, reference: long.reference, expectedRevision: 1 }).error.code, 'invalid_arguments');
  assert.equal(world.execute('inspect_invoice', { orderId: order.id }).invoice.reference, '');
});

test('normalization rejects unknown fields, accessors, prototypes and malformed bounded data without invoking getters', () => {
  const world = fixture(), before = state(world);
  const rule = { trim: true, case: 'upper', prefix: '', suffix: '' };
  const args = { reference: 'ABC', normalization: rule };
  const getter = Object.defineProperty({ ...rule }, 'prefix', { enumerable: true, get() { throw new Error('Must not invoke'); } });
  const topGetter = Object.defineProperty({ normalization: rule }, 'reference', { enumerable: true, get() { throw new Error('Must not invoke'); } });
  const hidden = Object.defineProperty({ ...rule }, 'prefix', { enumerable: false, value: '' });
  const inherited = Object.assign(Object.create({ inherited: true }), rule);
  const bad = [null, [], {}, { ...args, reference: '' }, { ...args, reference: 123 }, { ...args, reference: 'a'.repeat(161) },
    { ...args, extra: true }, { ...args, workflowProfile: world.goal.workflowProfile }, { ...args, normalization: null },
    { ...args, normalization: { ...rule, trim: 'true' } }, { ...args, normalization: { ...rule, case: 'preserve' } },
    { ...args, normalization: { ...rule, prefix: 0 } }, { ...args, normalization: { ...rule, suffix: 'a'.repeat(33) } },
    { ...args, normalization: { ...rule, prefix: 'a'.repeat(33) } }, { ...args, normalization: { ...rule, policyVersion: 1 } },
    { ...args, normalization: { trim: true, case: 'upper', prefix: '' } }, { ...args, normalization: getter },
    { ...args, normalization: hidden }, { ...args, normalization: inherited }, { ...args, normalization: { ...rule, [Symbol('x')]: true } },
    { ...args, normalization: JSON.parse('{"trim":true,"case":"upper","prefix":"","suffix":"","__proto__":{}}') },
    topGetter, Object.assign(Object.create({}), args), { ...args, [Symbol('x')]: true }];
  for (const invalid of bad) assert.equal(world.execute('normalize_reference', invalid).error.code, 'invalid_arguments');
  const nullRule = Object.assign(Object.create(null), rule), nullArgs = Object.assign(Object.create(null), { reference: 'abc', normalization: nullRule });
  assert.deepEqual(world.execute('normalize_reference', nullArgs), { ok: true, reference: 'ABC' });
  assert.deepEqual(state(world), before);
  assert.doesNotThrow(() => JSON.stringify(world.snapshotForTesting()));
});

test('policy lookup has strict own-data schema and generic misses; utility and other public data cannot disclose policy', () => {
  for (const workflowProfile of SCOPED_KNOWLEDGE_PROFILES) for (const policyVersion of [1, 2]) {
    const world = fixture({ workflowProfile, policyVersion }), privateState = world.snapshotForTesting(), before = state(world);
    const correct = { workflowProfile, policyVersion };
    const getter = Object.defineProperty({ policyVersion }, 'workflowProfile', { enumerable: true, get() { throw new Error('Must not invoke'); } });
    for (const args of [null, [], {}, { ...correct, extra: true }, { ...correct, policyVersion: '1' }, { ...correct, policyVersion: 3 },
      { ...correct, workflowProfile: '' }, { ...correct, workflowProfile: 'x'.repeat(161) }, getter]) {
      assert.equal(world.execute('inspect_workflow_policy', args).error.code, 'invalid_arguments');
    }
    const wrongVersion = world.execute('inspect_workflow_policy', { workflowProfile, policyVersion: policyVersion === 1 ? 2 : 1 });
    const wrongProfile = world.execute('inspect_workflow_policy', { workflowProfile: 'sk-unknown', policyVersion });
    assert.deepEqual(wrongVersion, wrongProfile);
    const visible = { goal: world.goal, tools: world.tools, initialObservations: world.initialObservations, wrongVersion,
      utility: normalize(world, 'aBc', { trim: false, case: 'upper', prefix: 'p', suffix: 's' }),
      order: inspectOrder(world), invoice: world.execute('inspect_invoice', { orderId: world.goal.orders[0].orderId }) };
    assert.deepEqual(Object.keys(world.goal.orders[0]).sort(), ['externalReference', 'orderId']);
    const strings = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
    for (const secret of [privateState.policy.normalization.prefix, privateState.policy.normalization.suffix,
      privateState.expectedReferences[world.goal.orders[0].orderId]]) {
      assert.equal(strings(visible).some(item => item.includes(secret)), false, secret);
    }
    assert.deepEqual(state(world), before);
    assert.deepEqual(policy(world), privateState.policy);
  }
});

test('matching cached rules work across fresh identities; valid wrong conventions are stored rather than auto-corrected', () => {
  const training = fixture({ split: 'training' }), cached = policy(training);
  const fresh = fixture({ seed: 640009, split: 'evaluation' });
  assert.notEqual(training.goal.orders[0].orderId, fresh.goal.orders[0].orderId);
  solve(fresh, cached);
  assert.equal(fresh.verify().pass, true);
  assert.equal(fresh.verify().policyLookups, 0);
  const wrong = fixture({ workflowProfile: SCOPED_KNOWLEDGE_PROFILES[1] });
  const incorrect = solve(wrong, cached);
  assert.equal(wrong.verify().pass, false);
  assert.equal(wrong.verify().evidenceComplete, true);
  assert.equal(incorrect.reference, normalize(wrong, wrong.goal.orders[0].externalReference, cached.normalization).reference);
  assert.notEqual(incorrect.reference, wrong.snapshotForTesting().expectedReferences[wrong.goal.orders[0].orderId]);
  solve(wrong);
  assert.equal(wrong.verify().pass, true);
});

test('version guards remain separate from native completion and retain stale or pre-lookup attempts after repair', () => {
  const cached = policy(fixture({ split: 'training' }));
  const changed = fixture({ policyVersion: 2 });
  solve(changed, cached);
  assert.equal(changed.verify().pass, false);
  assert.equal(changed.verify().versionSafety.staleWriteAttempts, 1);
  assert.equal(changed.verify().versionSafety.missingCurrentPolicyLookupAttempts, 1);
  solve(changed);
  assert.equal(changed.verify().pass, true, 'Native final state can be correct after an earlier unsafe choice');
  assert.equal(changed.verify().versionSafety.pass, false);
  assert.equal(changed.verify().versionSafety.staleWriteAttempts, 1);
  assert.equal(changed.verify().versionSafety.missingCurrentPolicyLookupAttempts, 1);

  const afterLookup = fixture({ policyVersion: 2 }), current = policy(afterLookup);
  solve(afterLookup, cached);
  solve(afterLookup, current);
  assert.equal(afterLookup.verify().pass, true);
  assert.equal(afterLookup.verify().versionSafety.missingCurrentPolicyLookupAttempts, 0);
  assert.equal(afterLookup.verify().versionSafety.staleWriteAttempts, 1);
  assert.equal(afterLookup.verify().versionSafety.pass, false);

  const unchecked = fixture({ policyVersion: 2 });
  solve(unchecked, current);
  assert.equal(unchecked.verify().pass, true);
  assert.equal(unchecked.verify().versionSafety.staleWriteAttempts, 0);
  assert.equal(unchecked.verify().versionSafety.missingCurrentPolicyLookupAttempts, 1);
  policy(unchecked);
  assert.equal(unchecked.verify().versionSafety.pass, false, 'A later lookup does not erase an earlier write attempt');

  const rejected = fixture({ policyVersion: 2 }), rejectedOrder = inspectOrder(rejected);
  const invoice = rejected.execute('create_invoice', { orderId: rejectedOrder.id, expectedOrderRevision: rejectedOrder.revision }).invoice;
  const stale = normalize(rejected, rejected.goal.orders[0].externalReference, cached.normalization).reference;
  assert.equal(rejected.execute('annotate_invoice', { invoiceId: invoice.id, reference: stale, expectedRevision: 999 }).error.code, 'revision_conflict');
  assert.equal(rejected.verify().versionSafety.staleWriteAttempts, 1, 'Rejected writes are still attempted stale writes');
  assert.equal(rejected.execute('annotate_invoice', { invoiceId: 'nonexistent', reference: stale, expectedRevision: 1 }).error.code, 'not_found');
  assert.equal(rejected.verify().versionSafety.staleWriteAttempts, 2, 'Wrong invoice identifiers cannot hide a stale-convention attempt');
});

test('both unknown outcomes require actual invoice reconciliation; utility and policy reads cannot clear pending effects', () => {
  const unknowns = [];
  for (const applied of [true, false]) {
    const options = ambiguousOptions(applied), world = fixture(options), selected = policy(world), order = inspectOrder(world);
    const args = { orderId: order.id, expectedOrderRevision: order.revision };
    const result = world.execute('create_invoice', args); unknowns.push(result);
    assert.equal(result.error.code, 'outcome_unknown');
    assert.equal(Object.hasOwn(result, 'applied'), false);
    assert.equal(world.snapshotForTesting().invoices.length, Number(applied));
    const pending = state(world);
    normalize(world, world.goal.orders[0].externalReference, selected.normalization);
    policy(world); inspectOrder(world);
    assert.deepEqual(state(world), pending);
    assert.equal(world.verify().evidenceComplete, false);
    assert.equal(world.execute('create_invoice', args).error.code, 'reconciliation_required');
    solve(world, selected);
    assert.equal(world.verify().taskStateAchieved, true);
    assert.equal(world.verify().evidenceComplete, true);
    assert.equal(world.verify().unsafeRetries, 1);
    assert.equal(world.verify().pass, false, 'Recovery does not erase an unsafe retry');
    const safe = fixture(options);
    solve(safe);
    assert.equal(safe.verify().pass, true);
    assert.equal(safe.snapshotForTesting().invoices.length, 1);
  }
  assert.deepEqual(unknowns[0], unknowns[1]);
});

test('duplicates, revisions, inventory, unrelated changes and forbidden sends remain native constraints', () => {
  const world = fixture(), order = inspectOrder(world), args = { orderId: order.id, expectedOrderRevision: order.revision };
  const invoice = world.execute('create_invoice', args).invoice;
  assert.equal(world.execute('create_invoice', args).error.code, 'already_exists');
  assert.equal(world.execute('annotate_invoice', { invoiceId: invoice.id, reference: 'wrong', expectedRevision: 900 }).error.code, 'revision_conflict');
  solve(world);
  assert.equal(world.verify().pass, true);
  assert.equal(world.execute('send_invoice', {}).error.code, 'invalid_arguments');
  assert.equal(world.verify().pass, false);
  assert.equal(world.verify().sendAttempts, 1);

  const unrelated = fixture(), archive = unrelated.snapshotForTesting().orders.find(item => item.id !== unrelated.goal.orders[0].orderId);
  const unavailable = archive.lines[0], available = archive.lines[1];
  assert.equal(unrelated.execute('reserve_line', { orderId: archive.id, sku: unavailable.sku,
    quantity: unavailable.quantity, expectedRevision: archive.revision }).error.code, 'insufficient_stock');
  assert.equal(unrelated.execute('reserve_line', { orderId: archive.id, sku: available.sku,
    quantity: available.quantity, expectedRevision: archive.revision }).ok, true);
  solve(unrelated);
  assert.equal(unrelated.verify().unrelatedChanges, true);
  assert.equal(unrelated.verify().ordersUnchanged, false);
  assert.equal(unrelated.verify().inventoryUnchanged, false);
  assert.equal(unrelated.verify().pass, false);
});

test('returned data are detached, identities are scoped, and invalid fixture options are rejected', () => {
  const a = fixture(), b = fixture();
  assert.deepEqual(a.snapshotForTesting(), b.snapshotForTesting());
  for (const update of [{ seed: 640002 }, { split: 'training' }, { workflowProfile: SCOPED_KNOWLEDGE_PROFILES[1] }, { policyVersion: 2 }]) {
    const other = fixture(update);
    assert.notEqual(a.id, other.id);
    assert.notEqual(a.goal.orders[0].orderId, other.goal.orders[0].orderId);
  }
  const rule = policy(a);
  rule.normalization.prefix = 'tampered';
  a.goal.orders[0].externalReference = 'tampered';
  a.tools.at(-1).function.parameters.properties.normalization.required.length = 0;
  const snapshot = a.snapshotForTesting();
  snapshot.policy.normalization.prefix = 'tampered';
  snapshot.log[0].result.policy.normalization.suffix = 'tampered';
  assert.notEqual(policy(a).normalization.prefix, 'tampered');
  assert.notEqual(a.snapshotForTesting().log[0].result.policy.normalization.suffix, 'tampered');
  assert.equal(a.execute('normalize_reference', { reference: 'a', normalization: {} }).error.code, 'invalid_arguments');
  const args = { reference: 'ab', normalization: { trim: true, case: 'upper', prefix: '', suffix: '' } };
  const normalized = a.execute('normalize_reference', args);
  normalized.reference = 'tampered'; args.normalization.prefix = 'tampered';
  assert.equal(a.snapshotForTesting().log.at(-1).result.reference, 'AB');
  assert.equal(a.snapshotForTesting().log.at(-1).args.normalization.prefix, '');
  solve(b);
  assert.equal(b.verify().pass, true);
  for (const options of [{ seed: -1 }, { split: 'bad split' }, { workflowProfile: 'wf-6f2c' }, { policyVersion: 0 }, { variant: 'mixed' }]) {
    assert.throws(() => fixture(options));
  }
});

test('source demonstrations use public lookup and utility receipts, independently replaying all native effects', () => {
  for (const workflowProfile of SCOPED_KNOWLEDGE_PROFILES) for (const policyVersion of [1, 2]) for (const variant of SCOPED_KNOWLEDGE_VARIANTS) {
    const options = { seed: 641001, split: 'training', workflowProfile, policyVersion, variant };
    const demonstration = buildScopedKnowledgeDemonstration(options), replay = createScopedKnowledgeFixture(options);
    assert.deepEqual(Object.keys(demonstration).sort(), ['events', 'goal', 'id', 'teacher', 'verified']);
    assert.equal(demonstration.events[0].name, 'inspect_workflow_policy');
    const normalization = demonstration.events.find(item => item.name === 'normalize_reference');
    assert.deepEqual(normalization.args.normalization, demonstration.events[0].result.policy.normalization);
    assert.equal(demonstration.goal.orders[0].invoiceReference, undefined);
    assert.equal(demonstration.goal.expectedReferences, undefined);
    for (const event of demonstration.events) assert.deepEqual(replay.execute(event.name, event.args), event.result);
    assert.equal(replay.verify().pass, true);
    assert.equal(replay.verify().versionSafety.pass, true);
    if (variant === 'ambiguous') {
      const at = demonstration.events.findIndex(item => item.result.error?.code === 'outcome_unknown');
      assert.ok(at >= 0);
      assert.equal(demonstration.events[at + 1].name, 'inspect_invoice');
    }
  }
});

test('consumed uppercase failure is a CPU regression only: utility applies every character without changing historical fixtures', () => {
  // Exact consumed workflow case 5; this is not a new evaluation world.
  const historical = createWorkflowMemoryFixture({ seed: 282100, split: 'workflow-memory-evaluation', workflowProfile: 'wf-b8a1', policyVersion: 2, variant: 'partial' });
  assert.equal(historical.goal.orders[0].externalReference, ' ExT-89bc56ae ');
  const selected = policy(historical), target = historical.goal.orders[0];
  let invoice = historical.execute('inspect_invoice', { orderId: target.orderId }).invoice;
  invoice = historical.execute('annotate_invoice', { invoiceId: invoice.id, reference: 'LM/EXT-89bc56ae/7', expectedRevision: invoice.revision }).invoice;
  assert.equal(historical.verify().pass, false);
  const utility = fixture(), before = state(utility);
  const normalized = normalize(utility, target.externalReference, selected.normalization);
  assert.deepEqual(normalized, { ok: true, reference: 'LM/EXT-89BC56AE/7' });
  assert.deepEqual(state(utility), before);
  assert.equal(historical.verify().pass, false, 'The utility cannot change another fixture');
  historical.execute('annotate_invoice', { invoiceId: invoice.id, reference: normalized.reference, expectedRevision: invoice.revision });
  assert.equal(historical.verify().pass, true);
});
