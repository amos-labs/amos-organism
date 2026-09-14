import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  listContinualTaskFamilies, listContinualLineages, getContinualTools, createContinualTask,
  createContinualComposition, executeContinualTool, checkContinualAnswer, buildContinualDemonstration,
  buildContinualValidationExample, buildContinualCurriculum, admitContinualCurriculum
} from '../src/continualCurriculum.js';

const copy = value => JSON.parse(JSON.stringify(value));
function invoke(operation, input) {
  const tool = getContinualTools().find(t => t.function.parameters.properties.operation.enum.includes(operation));
  const task = createContinualTask({ lineageId: operation, seed: 71812 });
  const response = executeContinualTool(task, tool.function.name, { operation, input });
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.result;
}
function publicSolver(task) {
  const results = task.spec.components.map(c => {
    const tool = task.tools.find(t => t.function.parameters.properties.operation.enum.includes(c.operation));
    const response = executeContinualTool(task, tool.function.name, { operation: c.operation, input: c.input });
    assert.equal(response.ok, true);
    return Object.fromEntries(c.outputFields.map(key => [key, response.result[key]]));
  });
  return task.spec.composition ? { parts: results } : results[0];
}

test('eight families contain 24 distinct reserve programs plus six withheld target programs', () => {
  assert.equal(listContinualTaskFamilies().length, 8);
  const lineages = listContinualLineages();
  assert.equal(lineages.length, 30);
  assert.equal(new Set(lineages.map(x => x.lineageId)).size, 30);
  assert.equal(new Set(lineages.map(x => x.description)).size, 30);
  for (const family of listContinualTaskFamilies()) assert.equal(lineages.filter(x => x.family === family && x.reserve).length, 3);
  for (let release = 0; release < 3; release++) assert.equal(lineages.filter(x => x.release === release).length, 2);
  lineages[0].description = 'changed';
  assert.notEqual(listContinualLineages()[0].description, 'changed');
});

test('arithmetic semantics have independent hand-calculated results and apportionment conserves units', () => {
  assert.deepEqual(invoke('signed-ledger', { opening: 5, changes: [-9, 7, -1] }), { balance: 2, minimum: -4 });
  assert.deepEqual(invoke('integer-apportionment', { units: 7, weights: [1, 1, 1] }), { allocations: [3, 2, 2], total: 7 });
  assert.deepEqual(invoke('tiered-charge', { units: 12, threshold: 10, firstRate: 3, laterRate: 7, fixedFee: 2 }), { chargeCents: 46 });
  for (let units = 0; units < 25; units++) {
    const weights = [2, 3, 5], actual = invoke('integer-apportionment', { units, weights }).allocations;
    assert.equal(actual.reduce((a, b) => a + b, 0), units);
    for (let i = 0; i < weights.length; i++) assert.ok(actual[i] >= Math.floor(units * weights[i] / 10) && actual[i] <= Math.ceil(units * weights[i] / 10));
  }
});

test('calendar boundaries include leap dates, holidays, offset crossings, and half-open intersections', () => {
  assert.deepEqual(invoke('calendar-day-shift', { date: '2040-02-28', days: 2 }), { date: '2040-03-01' });
  assert.deepEqual(invoke('weekday-delivery', { start: '2037-01-02', days: 1, holidays: ['2037-01-05'] }), { date: '2037-01-06' });
  assert.deepEqual(invoke('fixed-offset-conversion', { local: '2038-01-01T00:15:00', offsetMinutes: 90 }), { utc: '2037-12-31T22:45:00.000Z' });
  assert.deepEqual(invoke('calendar-overlap-days', { intervals: [{ start: '2040-02-28', end: '2040-03-03' }, { start: '2040-02-29', end: '2040-03-01' }] }), { days: 1 });
});

test('planning checks cycles, optimal subsets, interval boundaries and critical path parallelism', () => {
  assert.deepEqual(invoke('dependency-order', { jobs: ['b', 'a', 'c'], edges: [['a', 'c']] }), { order: ['a', 'b', 'c'] });
  assert.deepEqual(invoke('dependency-order', { jobs: ['a', 'b'], edges: [['a', 'b'], ['b', 'a']] }), { order: null });
  assert.deepEqual(invoke('budget-subset', { capacity: 5, items: [{ id: 'a', cost: 5, value: 8 }, { id: 'b', cost: 2, value: 5 }, { id: 'c', cost: 3, value: 5 }] }), { ids: ['b', 'c'], value: 10 });
  assert.deepEqual(invoke('budget-subset', { capacity: 5, items: [{ id: 'a', cost: 1, value: 0 }] }), { ids: [], value: 0 });
  assert.deepEqual(invoke('nonoverlap-selection', { intervals: [{ id: 'a', start: 0, end: 2 }, { id: 'b', start: 2, end: 4 }, { id: 'c', start: 1, end: 4 }] }), { ids: ['a', 'b'], count: 2 });
  assert.deepEqual(invoke('critical-path-duration', { jobs: [{ id: 'a', duration: 5, after: [] }, { id: 'b', duration: 3, after: [] }, { id: 'c', duration: 2, after: ['a', 'b'] }] }), { makespan: 7, finishes: [{ id: 'a', finish: 5 }, { id: 'b', finish: 3 }, { id: 'c', finish: 7 }] });
});

test('record transforms handle negative totals, latest tie rules, missing joins and zero pivot cells', () => {
  assert.deepEqual(invoke('group-totals', { records: [{ category: 'b', amount: 2 }, { category: 'a', amount: 5 }, { category: 'a', amount: -7 }] }), { groups: [{ category: 'a', total: -2 }, { category: 'b', total: 2 }] });
  assert.deepEqual(invoke('latest-record-merge', { records: [{ key: 'x', revision: 2, value: 5 }, { key: 'x', revision: 1, value: 99 }, { key: 'x', revision: 2, value: 7 }] }), { records: [{ key: 'x', revision: 2, value: 7 }] });
  assert.deepEqual(invoke('relational-inner-join', { owners: [{ ownerId: 'a', name: 'A' }], events: [{ eventId: 'e1', ownerId: 'missing' }, { eventId: 'e2', ownerId: 'a' }] }), { joined: [{ eventId: 'e2', name: 'A' }] });
  assert.deepEqual(invoke('two-axis-pivot', { records: [{ row: 'b', column: 'x', amount: 3 }, { row: 'a', column: 'y', amount: 4 }, { row: 'b', column: 'x', amount: -1 }] }), { rows: ['a', 'b'], columns: ['x', 'y'], matrix: [[0, 4], [2, 0]] });
});

test('finite program semantics preserve operand order, branches and register copy values', () => {
  assert.deepEqual(invoke('stack-program', { tokens: ['8', '3', 'sub', '2', 'mul'] }), { stack: [10] });
  assert.deepEqual(invoke('conditional-fold', { initial: 4, values: [2, 3, -1] }), { accumulator: 2, evenCount: 1 });
  assert.deepEqual(invoke('finite-state-transducer', { symbols: 'babbbcab' }), { count: 4, state: 'active' });
  assert.deepEqual(invoke('register-program', { instructions: [{ op: 'set', target: 'a', source: '', value: 4 }, { op: 'copy', target: 'b', source: 'a', value: 0 }, { op: 'add', target: 'a', source: '', value: 3 }] }), { registers: [{ name: 'a', value: 7 }, { name: 'b', value: 4 }] });
});

test('logic implements closure, cardinality, reachability and satisfying models without guessed truth', () => {
  assert.deepEqual(invoke('horn-closure', { facts: ['a'], rules: [{ all: ['b'], then: 'c' }, { all: ['a'], then: 'b' }, { all: ['missing'], then: 'x' }] }), { facts: ['a', 'b', 'c'] });
  assert.deepEqual(invoke('exactly-k-subsets', { labels: ['a', 'b', 'c'], k: 2, forbidden: [['a', 'c']] }), { subsets: [['a', 'b'], ['b', 'c']] });
  assert.deepEqual(invoke('directed-reachability', { start: 'a', edges: [['a', 'b'], ['b', 'a'], ['c', 'b']] }), { reachable: ['a', 'b'] });
  assert.deepEqual(invoke('signed-clause-models', { variables: ['a', 'b'], clauses: [['a'], ['!a', 'b']] }), { models: ['11'] });
  assert.deepEqual(invoke('signed-clause-models', { variables: ['a'], clauses: [['a'], ['!a']] }), { models: [] });
});

test('evidence requires authority, independent source ids and exact time/scope', () => {
  assert.deepEqual(invoke('authoritative-latest', { subject: 'a', records: [{ subject: 'a', version: 1, value: 7, signed: true, revoked: false }, { subject: 'a', version: 2, value: 9, signed: false, revoked: false }] }), { status: 'supported', value: 7 });
  assert.deepEqual(invoke('cross-source-consensus', { records: [{ claim: 'a', source: 'x', verdict: 'support' }, { claim: 'a', source: 'x', verdict: 'support' }, { claim: 'b', source: 'x', verdict: 'support' }, { claim: 'b', source: 'y', verdict: 'support' }] }), { claims: ['b'] });
  assert.deepEqual(invoke('scoped-evidence-filter', { scope: 'a', time: 5, records: [{ id: 'expired', scope: 'a', start: 0, end: 5, signed: true }, { id: 'ok', scope: 'a', start: 5, end: 6, signed: true }, { id: 'other', scope: 'b', start: 0, end: 6, signed: true }] }), { ids: ['ok'] });
});

test('state programs reject duplicate effects and partial transfers; later matching observations resolve only prior unknowns', () => {
  assert.deepEqual(invoke('idempotent-counter', { initial: 10, events: [{ id: 'a', delta: 3 }, { id: 'a', delta: 3 }, { id: 'a', delta: 4 }] }), { value: 13, conflicts: ['a'] });
  assert.deepEqual(invoke('revision-checked-updates', { value: 1, revision: 1, updates: [{ id: 'bad', expectedRevision: 2, value: 9 }, { id: 'good', expectedRevision: 1, value: 4 }] }), { value: 4, revision: 2, rejected: ['bad'] });
  assert.deepEqual(invoke('observed-outcome-reconciliation', { events: [{ type: 'observe', id: 'o1', record: 'a' }, { type: 'unknown', id: 'm1', record: 'a' }, { type: 'observe', id: 'o2', record: 'b' }] }), { unresolved: ['m1'] });
  assert.deepEqual(invoke('atomic-transfer-log', { balances: [{ account: 'a', amount: 5 }, { account: 'b', amount: 1 }], transfers: [{ id: 'bad', from: 'a', to: 'b', amount: 6 }, { id: 'good', from: 'a', to: 'b', amount: 3 }] }), { balances: [{ account: 'a', amount: 2 }, { account: 'b', amount: 4 }], rejected: ['bad'] });
});

test('argument validation rejects wrong tool, unknown fields/types, malformed operations and hostile accessors', () => {
  const task = createContinualTask({ lineageId: 'signed-ledger', seed: 9 });
  const args = { operation: 'signed-ledger', input: { opening: 0, changes: [1] } };
  assert.equal(executeContinualTool(task, 'solve_planning', args).ok, false);
  assert.equal(executeContinualTool(task, 'calculate_arithmetic', { ...args, taskId: task.id }).ok, false);
  assert.equal(executeContinualTool(task, 'calculate_arithmetic', { ...args, input: { opening: 0, changes: ['1'] } }).ok, false);
  assert.equal(executeContinualTool(task, 'calculate_arithmetic', { ...args, operation: 'unknown' }).ok, false);
  let accessed = false; const hostile = { get operation() { accessed = true; return 'signed-ledger'; }, input: args.input };
  assert.equal(executeContinualTool(task, 'calculate_arithmetic', hostile).ok, false); assert.equal(accessed, false);
});

test('correct final claims without actual required tool execution fail; unrelated tool input cannot establish completion', () => {
  const task = createContinualTask({ lineageId: 'signed-ledger', seed: 19, split: 'training' });
  const demo = buildContinualDemonstration(task), answer = demo.rows[1].messages.at(-1).content;
  const fresh = copy(task);
  assert.equal(checkContinualAnswer(fresh, answer).passed, false);
  executeContinualTool(fresh, 'calculate_arithmetic', { operation: 'signed-ledger', input: { opening: 0, changes: [1] } });
  assert.equal(checkContinualAnswer(fresh, answer).nativeToolRequirementMet, false);
  publicSolver(fresh);
  assert.equal(checkContinualAnswer(fresh, answer).passed, true);
  assert.equal(checkContinualAnswer(fresh, { balance: -999, minimum: 0 }).passed, false);
  assert.equal(checkContinualAnswer(fresh, '```json\n{}\n```').passed, false);
});

test('direct answers are allowed without tools; task identity edits cannot disable required tools', () => {
  const direct = createContinualTask({ lineageId: 'signed-ledger', seed: 51, split: 'training', requiresTools: false });
  assert.equal(direct.metadata.requiredToolCalls, 0);
  const demo = buildContinualDemonstration(direct);
  assert.equal(demo.rows.length, 1); assert.equal(demo.publicTrace.length, 0);
  assert.equal(checkContinualAnswer(copy(direct), demo.rows[0].messages.at(-1).content).passed, true);
  const required = createContinualTask({ lineageId: 'signed-ledger', seed: 51, split: 'training' });
  required.spec.requiresTools = false; required.metadata.requiresTools = false;
  assert.equal(checkContinualAnswer(required, demo.rows[0].messages.at(-1).content).passed, false);
});

test('all authored programs generate native-valid action and result targets with no answer in task messages', () => {
  for (const lineage of listContinualLineages()) {
    const task = createContinualTask({ lineageId: lineage.lineageId, seed: 8312, split: 'training', release: lineage.release });
    assert.equal(Object.hasOwn(task, 'expectedAnswer'), false);
    assert.equal(task.messages.some(m => m.role === 'assistant' || m.role === 'tool'), false);
    const demo = buildContinualDemonstration(task);
    assert.deepEqual(demo.rows.map(r => r.metadata.targetKind), ['tool-choice', 'post-tool-completion']);
    assert.equal(demo.rows[0].messages.at(-1).tool_calls.length, 1);
    assert.equal(typeof demo.rows[0].messages.at(-1).tool_calls[0].function.arguments, 'object');
    assert.deepEqual(demo.rows[0].messages.at(-1).tool_calls[0].function.arguments.input, task.spec.components[0].input);
    assert.equal(demo.rows[1].messages.at(-2).role, 'tool');
    const fresh = copy(task), answer = publicSolver(fresh);
    assert.equal(checkContinualAnswer(fresh, answer).passed, true, lineage.lineageId);
  }
});

test('development validation labels preserve split and qualification can never become training/validation targets', () => {
  const dev = createContinualTask({ lineageId: 'critical-path-duration', seed: 71, split: 'development' });
  const row = buildContinualValidationExample(dev);
  assert.equal(row.metadata.split, 'development'); assert.equal(row.metadata.trainingEligible, false);
  assert.equal(row.metadata.nativeVerification.passed, true);
  assert.equal(typeof row.messages.find(m => m.tool_calls).tool_calls[0].function.arguments, 'object');
  assert.throws(() => buildContinualDemonstration(dev), /Only training/);
  const qualification = createContinualComposition({ lineages: ['critical-path-duration', 'horn-closure'], seed: 72 });
  assert.throws(() => buildContinualDemonstration(qualification), /Only training/);
  assert.throws(() => buildContinualValidationExample(qualification), /Only development/);
  assert.equal(qualification.metadata.requiredToolCalls, 2);
  assert.equal(checkContinualAnswer(qualification, publicSolver(qualification)).passed, true);
  assert.throws(() => createContinualComposition({ lineages: ['critical-path-duration', 'horn-closure'], seed: 73, split: 'training' }), /cannot enter TRAIN/);
});

test('new program inputs vary structurally; seeds and numeric variants are not promoted to lineages', () => {
  for (const operation of ['dependency-order', 'horn-closure', 'observed-outcome-reconciliation', 'signed-clause-models']) {
    const tasks = Array.from({ length: 100 }, (_, seed) => createContinualTask({ lineageId: operation, seed: 8000 + seed, split: 'training' }));
    assert.ok(new Set(tasks.map(t => t.metadata.inputDigest)).size >= 64, operation);
    assert.equal(new Set(tasks.map(t => t.metadata.lineageId)).size, 1);
    assert.match(tasks[0].metadata.independenceClaim, /not an independent program/);
  }
});

let generated;
function corpus() { return generated ??= buildContinualCurriculum({ seed: 71234 }); }
test('three paired releases and broad replay satisfy real row, episode, lineage and modality counts', () => {
  const result = corpus();
  assert.equal(result.manifest.admitted, false);
  assert.deepEqual(result.manifest.admissionGaps, ['Exact admitted S6 historical training JSONL was not supplied.']);
  assert.equal(result.cycles.length, 3);
  for (const cycle of result.cycles) {
    assert.equal(cycle.arms.broad.length, 1024);
    assert.equal(cycle.arms.narrow.length, 0);
    assert.equal(cycle.statistics.new.uniqueEpisodes, 128);
    assert.equal(cycle.statistics.new.decisions, 256);
    assert.equal(Object.keys(cycle.statistics.new.lineages).length, 2);
    assert.equal(cycle.statistics.cumulative.decisions, 128);
    assert.equal(Math.max(...Object.values(cycle.statistics.cumulative.lineages)), 16);
    assert.equal(Object.keys(cycle.statistics.broadReplay.families).length, 8);
    assert.equal(Object.keys(cycle.statistics.broadReplay.lineages).length, 24);
    assert.deepEqual(cycle.statistics.broadReplay.targetKinds, { 'tool-choice': 160, 'post-tool-completion': 160, 'direct-answer': 320 });
    assert.ok(cycle.statistics.broadReplay.maximumLineageShare <= 0.05);
    assert.equal(cycle.statistics.new.maximumLineageShare * 256 / 1024, 0.125);
    assert.ok(Object.isFrozen(cycle.newRows));
  }
  const firstNew = new Set(result.newTasksByRelease[0].map(t => t.id));
  assert.ok(result.cycles[1].cumulativeRows.some(r => firstNew.has(r.metadata.sourceEpisodeId)));
});

test('generated input components are disjoint across partitions and qualification pairs are held out from development', () => {
  const result = corpus(), seen = new Set();
  const all = [...result.reserveTasks, ...result.newTasksByRelease.flat(), ...result.developmentTasks, ...result.qualificationTasksByRelease.flat()];
  for (const task of all) for (const c of task.spec.components) {
    const key = JSON.stringify({ operation: c.operation, input: c.input });
    assert.equal(seen.has(key), false, task.id); seen.add(key);
  }
  const developmentPairs = new Set(result.developmentTasks.filter(t => t.spec.composition).map(t => JSON.stringify(t.metadata.primitiveLineageIds)));
  for (const task of result.qualificationTasksByRelease.flat()) assert.equal(developmentPairs.has(JSON.stringify(task.metadata.primitiveLineageIds)), false);
  assert.equal(result.manifest.checks.primitiveOperationsSharedWithQualification, true);
});

test('content/lineage exclusions are enforced and inadequate supply is an admission gap, not fake instances', () => {
  const excluded = corpus().newTasksByRelease[0][0].metadata.inputDigest;
  const filtered = buildContinualCurriculum({ seed: 71234, exclusions: { inputDigests: [excluded] } });
  assert.equal(filtered.newTasksByRelease.flat().some(t => t.metadata.inputDigest === excluded), false);
  const missing = buildContinualCurriculum({ seed: 71234, exclusions: { lineageIds: ['continual-v1/signed-clause-models'] } });
  assert.equal(missing.manifest.admitted, false);
  assert.ok(missing.manifest.admissionGaps.some(s => s.includes('signed-clause-models')));
  assert.equal(missing.cycles.length, 0);
});

test('historical provenance cannot be supplied by a self-attested digest or altered training text', () => {
  assert.throws(() => buildContinualCurriculum({ historicalReplay: '{"messages":[]}\n' }), /exact admitted S6/);
  assert.throws(() => buildContinualCurriculum({ historicalReplay: { jsonl: '{}', sha256: '1c20e24fad36159db412021d5c41977ecf719e61830ca6a177c0b6659e3065b0' } }), /exact admitted S6/);
  const receipt = admitContinualCurriculum(corpus());
  assert.equal(receipt.admitted, false);
  assert.ok(receipt.errors.some(e => e.includes('narrow: expected 1024')));
});

test('admission detects target tampering, split poisoning and modality changes', () => {
  const result = copy(corpus());
  result.cycles[0].arms.broad[0].messages.at(-1).tool_calls[0].function.arguments = '{}';
  result.cycles[1].arms.broad[0].metadata.split = 'qualification';
  result.cycles[2].replayRows.broad[0].metadata.targetKind = 'direct-answer';
  result.cycles[2].arms.broad[384].metadata.targetKind = 'direct-answer';
  const checked = admitContinualCurriculum(result);
  assert.equal(checked.admitted, false);
  assert.ok(checked.errors.some(e => e.includes('target or provenance changed')));
  assert.ok(checked.errors.some(e => e.includes('Non-TRAIN row')));
  assert.ok(checked.errors.some(e => e.includes('invalid reserve coverage/modality')));
});

test('exact private S6 corpus admits complete matched arms when explicitly supplied', { skip: !process.env.AMOS_TEST_HISTORICAL_REPLAY }, () => {
  const historicalReplay = readFileSync(process.env.AMOS_TEST_HISTORICAL_REPLAY, 'utf8');
  const result = buildContinualCurriculum({ seed: 71234, historicalReplay });
  assert.equal(result.manifest.admitted, true);
  for (const cycle of result.cycles) {
    assert.equal(cycle.arms.narrow.length, 1024);
    assert.deepEqual(cycle.arms.broad.slice(0, 384), cycle.arms.narrow.slice(0, 384));
    assert.deepEqual(Object.values(cycle.statistics.narrowReplay.families), [160, 160, 160, 160]);
  }
  assert.equal(admitContinualCurriculum(result, { historicalReplay }).admitted, true);
});
