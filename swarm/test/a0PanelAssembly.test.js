import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleA0Panel, fixturesForA0Package } from '../src/a0PanelAssembly.js';
import { a0FamilyAdapters as adapters } from '../src/a0FamilyAdapters.js';

const seed = '4242424242'; // Synthetic integration only; actual study admission is separate.
const exclusionEntries = [{type: 'case-id', value: 'synthetic-excluded-case'}];
const build = entries => assembleA0Panel({adapters, seed, exclusionEntries: entries ?? exclusionEntries});

test('all 96 native bindings compose deterministically with honest signature coverage', () => {
  const a = build(), b = build();
  assert.equal(a.panel.panelSha256, b.panel.panelSha256);
  assert.equal(a.specsSha256, b.specsSha256);
  const fixtures = fixturesForA0Package(a, adapters);
  assert.equal(fixtures.length, 96);
  assert.equal(new Set(fixtures.map(f => f.fixture.id)).size, 96);
  for (const f of fixtures) assert.equal(typeof f.verify, 'function');
  for (const c of Object.values(a.coverage)) assert.equal(c.selected, 12);
  assert.equal(a.coverage['async-code'].signatureCoverage, 'not checked');
  assert.equal(a.coverage['constrained-planning'].signatureCoverage, 'not checked');
  assert.equal(a.coverage['reuse-first-tool-selection'].signatureCoverage, 'all selected cases');
  assert.equal(a.modelCalls, 0);
});

test('known excluded reuse decision is skipped without touching any outcomes', () => {
  const adapter = adapters.get('reuse-first-tool-selection');
  const key = adapter.project(adapter.generate(seed, 0)).decisionKeys[0];
  const pkg = build([...exclusionEntries, {type: 'decision-key', value: key}]);
  assert.equal(pkg.coverage[adapter.FAMILY].excludedCollisions, 1);
  assert.ok(pkg.specs.filter(s => s.family === adapter.FAMILY).every(s => !adapter.project(s.body).decisionKeys.includes(key)));
  assert.equal(pkg.panel.panelVersusInventory.disjoint, true);
});

test('intra-panel decision duplicates cannot inflate 12-case coverage', () => {
  const map = new Map(adapters);
  const original = map.get('reuse-first-tool-selection');
  map.set(original.FAMILY, {...original, generate(s, index) { return {...original.generate(s, 0), index}; }});
  assert.throws(() => assembleA0Panel({adapters: map, seed, exclusionEntries, maxCandidatesPerFamily: 12}), /candidate bound exhausted/);
});

test('missing adapters, empty exclusions, native identity mismatch and mutated packages fail', () => {
  const missing = new Map(adapters); missing.delete('date-time');
  assert.throws(() => assembleA0Panel({adapters: missing, seed, exclusionEntries}), /eight/);
  assert.throws(() => build([]), /nonempty/);
  const bad = new Map(adapters), original = bad.get('date-time');
  bad.set('date-time', {...original, createFixture(body) { const f = original.createFixture(body); f.fixture.id = 'wrong'; return f; }});
  assert.throws(() => assembleA0Panel({adapters: bad, seed, exclusionEntries}), /native fixture/);
  const pkg = build(); pkg.specs[0].body.index += 100;
  assert.throws(() => fixturesForA0Package(pkg, adapters), /digest mismatch/);
});

test('fresh native worlds retain effect checks; correct prose alone cannot fake a refund', async () => {
  const pkg = build();
  const spec = pkg.specs.find(s => s.family === 'governed-context-dependent-state' && s.body.facts.status === 'eligible');
  const adapter = adapters.get(spec.family);
  const one = adapter.createFixture(spec.body), two = adapter.createFixture(spec.body);
  assert.equal(one.verify({answer: 'approved'}).outcome, 'fail');
  await one.tools.find(t => t.name === 'get_order_status').handler({id: spec.body.facts.orderId});
  await one.tools.find(t => t.name === 'approve_refund').handler({id: spec.body.facts.orderId});
  assert.equal(one.verify({answer: 'approved'}).outcome, 'pass');
  assert.equal(two.verify({answer: 'approved'}).outcome, 'fail');
});
