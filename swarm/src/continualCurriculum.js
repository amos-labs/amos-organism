import { createHash } from 'node:crypto';

export const CONTINUAL_CURRICULUM_SCHEMA = 'amos.continual-curriculum.v1';
export const HISTORICAL_S6_TRAINING_SHA256 = '1c20e24fad36159db412021d5c41977ecf719e61830ca6a177c0b6659e3065b0';
export const CONTINUAL_CAPABILITY_FAMILIES = Object.freeze([
  'arithmetic-reconciliation', 'calendar-time', 'bounded-planning', 'structured-data',
  'program-execution', 'logical-inference', 'evidence-selection', 'state-reconciliation'
]);
const SPLITS = ['training', 'development', 'qualification'];
const TOOL_NAMES = ['calculate_arithmetic', 'calculate_calendar', 'solve_planning', 'transform_records',
  'run_finite_program', 'solve_finite_logic', 'select_record_evidence', 'reconcile_record_events'];
const SYSTEM = 'Complete the synthetic research task using the declared read-only tools. Tools compute only their explicit inputs; they do not know the goal. Use the required operation(s), then return only the requested final JSON. Do not invent tool results. The input contains synthetic records, not customer data.';
const states = new WeakMap();
const clone = value => JSON.parse(JSON.stringify(value));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
const bytes = value => JSON.stringify(canonical(value));
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : bytes(value)).digest('hex');
function invariant(condition, message) { if (!condition) throw new Error(message); }
function safeJson(value, depth = 0, budget = { nodes: 0 }) {
  invariant(depth <= 12 && ++budget.nodes <= 4096, 'JSON input exceeds structural limits');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') { invariant(Number.isFinite(value) && Math.abs(value) <= 1e12, 'Invalid number'); return value; }
  if (typeof value === 'string') { invariant(value.length <= 8192, 'String too long'); return value; }
  invariant(value && typeof value === 'object', 'Expected JSON data');
  if (Array.isArray(value)) { invariant(value.length <= 256, 'Array too long'); return value.map(v => safeJson(v, depth + 1, budget)); }
  invariant([Object.prototype, null].includes(Object.getPrototypeOf(value)), 'Expected plain JSON object');
  const out = {};
  for (const key of Reflect.ownKeys(value)) {
    invariant(typeof key === 'string' && !['__proto__', 'prototype', 'constructor'].includes(key), 'Unsafe object key');
    const property = Object.getOwnPropertyDescriptor(value, key);
    invariant(property && Object.hasOwn(property, 'value'), 'Accessors are not JSON data');
    out[key] = safeJson(property.value, depth + 1, budget);
  }
  return out;
}
function rng(seed) {
  let state = Number.parseInt(hash(String(seed)).slice(0, 8), 16);
  return (lo, hi) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return lo + Math.floor(state / 4294967296 * (hi - lo + 1)); };
}
const sum = xs => xs.reduce((a, b) => a + b, 0);
const range = n => Array.from({ length: n }, (_, i) => i);
const sorted = xs => [...xs].sort((a, b) => typeof a === 'number' ? a - b : String(a).localeCompare(String(b), 'en'));
const iso = milliseconds => new Date(milliseconds).toISOString().slice(0, 10);
const day = 86400000;
const date = r => iso(Date.UTC(2037 + r(0, 4), r(0, 11), r(1, 20)));
function dateMs(value) { invariant(/^\d{4}-\d{2}-\d{2}$/.test(value), 'Expected ISO date'); const n = Date.parse(`${value}T00:00:00Z`); invariant(iso(n) === value, 'Invalid date'); return n; }
function subsets(items) { invariant(items.length <= 12, 'Too many candidates'); return range(2 ** items.length).map(mask => items.filter((_, i) => mask & 2 ** i)); }
function compareLists(a, b) { for (let i = 0; i < Math.min(a.length, b.length); i++) { const order = String(a[i]).localeCompare(String(b[i]), 'en'); if (order) return order; } return a.length - b.length; }
function best(items, valid, score) {
  const candidates = subsets(items).filter(valid).map(values => ({ values, score: score(values), ids: sorted(values.map(x => x.id)) }));
  candidates.sort((a, b) => b.score - a.score || compareLists(a.ids, b.ids));
  return candidates[0];
}
function shapeMatches(value, template) {
  if (Array.isArray(template)) return Array.isArray(value) && value.length <= 64 && value.every(x => !template.length || shapeMatches(x, template[0]));
  if (template && typeof template === 'object') return value && typeof value === 'object' && !Array.isArray(value) &&
    bytes(Object.keys(value).sort()) === bytes(Object.keys(template).sort()) && Object.keys(template).every(k => shapeMatches(value[k], template[k]));
  return typeof value === typeof template && (typeof value !== 'number' || Number.isSafeInteger(value));
}
const programs = [];
function define(familyIndex, id, description, make, run, outputFields, release = null) {
  programs.push({ family: CONTINUAL_CAPABILITY_FAMILIES[familyIndex], tool: TOOL_NAMES[familyIndex], id,
    lineageId: `continual-v1/${id}`, description, make, run, outputFields, release, shape: make(rng(`shape:${id}`)) });
}

// Each define is a distinct authored operation/checker, not an identifier for a numeric variant.
define(0, 'signed-ledger', 'Sum signed ledger entries; report final balance and minimum running balance from the opening balance.',
  r => ({ opening: r(20, 100), changes: range(6).map(() => r(-40, 50)) }),
  x => { let balance = x.opening, minimum = balance; for (const n of x.changes) { balance += n; minimum = Math.min(minimum, balance); } return { balance, minimum }; }, ['balance', 'minimum']);
define(0, 'integer-apportionment', 'Distribute integer units proportional to positive weights: floor exact shares, then assign remaining units by largest fractional remainder, lower index first on ties.',
  r => ({ units: r(20, 80), weights: range(4).map(() => r(1, 9)) }),
  x => { const total = sum(x.weights); invariant(total > 0 && x.weights.every(n => n > 0) && x.units >= 0, 'Positive weights and nonnegative units required'); const allocations = x.weights.map(w => Math.floor(x.units * w / total)); const order = range(x.weights.length).sort((a, b) => (x.units * x.weights[b] % total) - (x.units * x.weights[a] % total) || a - b); for (let j = 0, left = x.units - sum(allocations); j < left; j++) allocations[order[j]]++; return { allocations, total: sum(allocations) }; }, ['allocations']);
define(0, 'tiered-charge', 'Compute a cumulative tiered charge: first threshold units at firstRate, remaining units at laterRate, plus fixedFee. All amounts are integer cents.',
  r => ({ units: r(10, 90), threshold: r(15, 40), firstRate: r(2, 8), laterRate: r(9, 15), fixedFee: r(1, 12) }),
  x => { invariant(x.units >= 0 && x.threshold >= 0, 'Nonnegative quantities required'); return { chargeCents: Math.min(x.units, x.threshold) * x.firstRate + Math.max(0, x.units - x.threshold) * x.laterRate + x.fixedFee }; }, ['chargeCents']);

define(1, 'calendar-day-shift', 'Add a signed number of calendar days to an ISO date using UTC.',
  r => ({ date: date(r), days: r(-40, 50) }), x => ({ date: iso(dateMs(x.date) + x.days * day) }), ['date']);
define(1, 'weekday-delivery', 'Advance a positive number of working days after the starting date; skip Saturday, Sunday and the listed ISO holiday dates.',
  r => { const start = date(r); return { start, days: r(1, 12), holidays: [iso(dateMs(start) + r(1, 10) * day)] }; },
  x => { invariant(x.days >= 0 && x.days <= 100, 'Working-day count out of bounds'); let current = dateMs(x.start), left = x.days; const holidays = new Set(x.holidays.map(h => iso(dateMs(h)))); while (left) { current += day; const d = new Date(current).getUTCDay(); if (d !== 0 && d !== 6 && !holidays.has(iso(current))) left--; } return { date: iso(current) }; }, ['date']);
define(1, 'fixed-offset-conversion', 'Convert a local ISO timestamp to UTC by subtracting its explicit fixed offset in minutes. Do not infer daylight-saving rules.',
  r => ({ local: `${date(r)}T${String(r(0, 23)).padStart(2, '0')}:${String(r(0, 59)).padStart(2, '0')}:00`, offsetMinutes: r(-10, 12) * 30 }),
  x => { invariant(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(x.local) && Number.isFinite(Date.parse(`${x.local}Z`)), 'Invalid local timestamp'); return { utc: new Date(Date.parse(`${x.local}Z`) - x.offsetMinutes * 60000).toISOString() }; }, ['utc']);

define(2, 'dependency-order', 'Produce a topological ordering of all named jobs. Repeatedly choose the lexicographically smallest available job. Return null if a cycle prevents completion.',
  r => { const jobs = range(r(5, 8)).map(i => `j${i}`), edges = [[jobs[0], jobs[1]]]; for (let a = 0; a < jobs.length; a++) for (let b = a + 1; b < jobs.length; b++) if (!(a === 0 && b === 1) && r(0, 3) === 0) edges.push([jobs[a], jobs[b]]); if (r(0, 4) === 0) edges.push([jobs[1], jobs[0]]); return { jobs, edges }; },
  x => { invariant(x.jobs.length <= 16 && new Set(x.jobs).size === x.jobs.length && x.edges.every(e => e.length === 2 && e.every(v => x.jobs.includes(v))), 'Invalid dependency graph'); const order = []; while (order.length < x.jobs.length) { const next = sorted(x.jobs.filter(j => !order.includes(j) && x.edges.every(([a, b]) => b !== j || order.includes(a))))[0]; if (next === undefined) return { order: null }; order.push(next); } return { order }; }, ['order']);
define(2, 'budget-subset', 'Select a subset within the capacity that maximizes total value. On equal value choose the lexicographically smallest sorted id list.',
  r => ({ capacity: r(8, 16), items: range(5).map(i => ({ id: `p${i}`, cost: r(2, 7), value: r(2, 12) })) }),
  x => { invariant(x.items.every(i => i.cost >= 0), 'Negative cost'); const choice = best(x.items, a => sum(a.map(i => i.cost)) <= x.capacity, a => sum(a.map(i => i.value))); invariant(choice, 'No feasible subset'); return { ids: choice.ids, value: choice.score }; }, ['ids', 'value']);
define(2, 'nonoverlap-selection', 'Select the greatest number of nonoverlapping half-open intervals [start,end). On a tie choose the lexicographically smallest sorted id list.',
  r => ({ intervals: range(6).map(i => { const start = r(0, 12); return { id: `s${i}`, start, end: start + r(1, 5) }; }) }),
  x => { invariant(x.intervals.every(i => i.end > i.start), 'Invalid interval'); const choice = best(x.intervals, a => a.every((u, i) => a.slice(i + 1).every(v => u.end <= v.start || v.end <= u.start)), a => a.length); return { ids: choice.ids, count: choice.score }; }, ['ids']);

define(3, 'group-totals', 'Group records by category, summing amount. Return category/total records sorted by category.',
  r => ({ records: range(7).map(() => ({ category: ['amber', 'cobalt', 'jade'][r(0, 2)], amount: r(-8, 20) })) }),
  x => { const totals = new Map(); for (const row of x.records) totals.set(row.category, (totals.get(row.category) ?? 0) + row.amount); return { groups: sorted([...totals.keys()]).map(category => ({ category, total: totals.get(category) })) }; }, ['groups']);
define(3, 'latest-record-merge', 'For each key keep the record with greatest revision; on equal revision keep the last input record. Sort retained records by key.',
  r => ({ records: range(8).map(() => ({ key: `k${r(0, 3)}`, revision: r(1, 5), value: r(0, 100) })) }),
  x => { const latest = new Map(); for (const row of x.records) if (!latest.has(row.key) || latest.get(row.key).revision <= row.revision) latest.set(row.key, row); return { records: sorted([...latest.keys()]).map(k => latest.get(k)) }; }, ['records']);
define(3, 'relational-inner-join', 'Inner-join events to owners on ownerId, omitting unmatched events. Return eventId/name pairs sorted by eventId. Owner ids must be unique.',
  r => ({ owners: range(3).map(i => ({ ownerId: `o${i}`, name: ['Aster', 'Birch', 'Cedar'][i] })), events: range(5).map(i => ({ eventId: `e${i}`, ownerId: `o${r(0, 3)}` })) }),
  x => { invariant(new Set(x.owners.map(o => o.ownerId)).size === x.owners.length, 'Duplicate owner'); return { joined: [...x.events].sort((a, b) => a.eventId.localeCompare(b.eventId, 'en')).flatMap(e => { const owner = x.owners.find(o => o.ownerId === e.ownerId); return owner ? [{ eventId: e.eventId, name: owner.name }] : []; }) }; }, ['joined']);

define(4, 'stack-program', 'Execute integer stack tokens: numbers push; add/sub/mul pop right then left and push left op right. Report the final stack.',
  r => ({ tokens: [String(r(1, 9)), String(r(1, 9)), 'add', String(r(1, 5)), 'mul', String(r(1, 9)), 'sub'] }),
  x => { const stack = []; for (const token of x.tokens) { if (/^-?\d+$/.test(token)) stack.push(Number(token)); else { invariant(['add', 'sub', 'mul'].includes(token) && stack.length >= 2, 'Invalid stack instruction'); const b = stack.pop(), a = stack.pop(); stack.push(token === 'add' ? a + b : token === 'sub' ? a - b : a * b); } } return { stack }; }, ['stack']);
define(4, 'conditional-fold', 'Starting at initial, read each integer: add it if even, otherwise subtract twice it. Return final accumulator and count of even inputs.',
  r => ({ initial: r(-10, 10), values: range(6).map(() => r(-5, 10)) }),
  x => ({ accumulator: x.initial + sum(x.values.map(n => n % 2 === 0 ? n : -2 * n)), evenCount: x.values.filter(n => n % 2 === 0).length }), ['accumulator', 'evenCount']);
define(4, 'finite-state-transducer', 'Start in state idle. In idle, a opens state active; in active, b increments count and c closes to idle. Ignore other characters. Report count and final state.',
  r => ({ symbols: range(14).map(() => ['a', 'b', 'c'][r(0, 2)]).join('') }),
  x => { let state = 'idle', count = 0; for (const symbol of x.symbols) { if (state === 'idle' && symbol === 'a') state = 'active'; else if (state === 'active' && symbol === 'b') count++; else if (state === 'active' && symbol === 'c') state = 'idle'; } return { count, state }; }, ['count', 'state']);

define(5, 'horn-closure', 'Compute all facts entailed by repeatedly applying rules whose every premise is known. Return facts sorted lexicographically; absence is not negation.',
  r => { const atoms = range(r(5, 9)).map(i => `f${i}`); return { facts: atoms.filter(() => r(0, 2) === 0), rules: range(r(5, 10)).map(() => ({ all: sorted([...new Set(range(r(1, 3)).map(() => atoms[r(0, atoms.length - 1)]))]), then: atoms[r(0, atoms.length - 1)] })) }; },
  x => { const facts = new Set(x.facts); for (let step = 0; step <= x.rules.length; step++) for (const rule of x.rules) if (rule.all.every(p => facts.has(p))) facts.add(rule.then); return { facts: sorted([...facts]) }; }, ['facts']);
define(5, 'exactly-k-subsets', 'List all sorted subsets of labels of size k excluding any subset containing a forbidden pair. Sort the list lexicographically.',
  r => { const labels = range(r(5, 8)).map(i => `l${i}`); return { labels, k: r(1, 4), forbidden: range(r(1, 5)).map(() => { const a = r(0, labels.length - 1), b = (a + r(1, labels.length - 1)) % labels.length; return sorted([labels[a], labels[b]]); }) }; },
  x => ({ subsets: subsets(x.labels.map(id => ({ id }))).map(a => sorted(a.map(i => i.id))).filter(a => a.length === x.k && x.forbidden.every(pair => !pair.every(k => a.includes(k)))).sort((a, b) => bytes(a).localeCompare(bytes(b), 'en')) }), ['subsets']);
define(5, 'directed-reachability', 'Starting from start, follow directed edges any number of steps. Include start, and return reachable labels sorted.',
  r => { const labels = range(r(5, 9)).map(i => `n${i}`); return { start: labels[r(0, labels.length - 1)], edges: range(r(5, 12)).map(() => [labels[r(0, labels.length - 1)], labels[r(0, labels.length - 1)]]) }; },
  x => { const reached = new Set([x.start]); for (let n = 0; n <= x.edges.length; n++) for (const [a, b] of x.edges) if (reached.has(a)) reached.add(b); return { reachable: sorted([...reached]) }; }, ['reachable']);

define(6, 'authoritative-latest', 'Select records for the requested subject that are signed and not revoked. Choose the greatest version; equal greatest versions with different values are a conflict. Return status/value.',
  r => ({ subject: 'target', records: [{ subject: 'target', version: 1, value: r(1, 8), signed: true, revoked: false }, { subject: 'target', version: 2, value: r(10, 20), signed: true, revoked: Boolean(r(0, 1)) }, { subject: 'other', version: 99, value: 99, signed: true, revoked: false }] }),
  x => { const rows = x.records.filter(r => r.subject === x.subject && r.signed && !r.revoked); if (!rows.length) return { status: 'missing', value: null }; const revision = Math.max(...rows.map(r => r.version)); const values = [...new Set(rows.filter(r => r.version === revision).map(r => r.value))]; return values.length === 1 ? { status: 'supported', value: values[0] } : { status: 'conflict', value: null }; }, ['status', 'value']);
define(6, 'cross-source-consensus', 'For each claim require support from at least two distinct source ids and no deny record from any source. Return eligible claim ids sorted. Repeated rows from one source do not add support.',
  r => ({ records: range(r(8, 16)).map(() => ({ claim: `c${r(0, 3)}`, source: `s${r(0, 4)}`, verdict: r(0, 4) === 0 ? 'deny' : 'support' })) }),
  x => ({ claims: sorted([...new Set(x.records.map(r => r.claim))]).filter(c => { const records = x.records.filter(r => r.claim === c); return !records.some(r => r.verdict === 'deny') && new Set(records.filter(r => r.verdict === 'support').map(r => r.source)).size >= 2; }) }), ['claims']);
define(6, 'scoped-evidence-filter', 'Return sorted record ids matching the exact requested scope and valid at time t: start <= t < end. Signed must be true; do not use future, expired or other-scope records.',
  r => ({ scope: 'zone-a', time: r(5, 12), records: range(5).map(i => ({ id: `r${i}`, scope: i % 2 ? 'zone-b' : 'zone-a', start: r(0, 6), end: r(8, 16), signed: i !== 4 })) }),
  x => ({ ids: sorted(x.records.filter(r => r.scope === x.scope && r.signed && r.start <= x.time && x.time < r.end).map(r => r.id)) }), ['ids']);

define(7, 'idempotent-counter', 'Process events in input order. Apply each event id only once; repeated ids must have the same delta or be rejected. Return value and conflicting ids sorted.',
  r => { const n = r(1, 9); return { initial: r(0, 10), events: [{ id: 'x', delta: n }, { id: 'y', delta: -2 }, { id: 'x', delta: r(0, 1) ? n : n + 1 }] }; },
  x => { let value = x.initial; const seen = new Map(), conflicts = new Set(); for (const event of x.events) { if (!seen.has(event.id)) { value += event.delta; seen.set(event.id, event.delta); } else if (seen.get(event.id) !== event.delta) conflicts.add(event.id); } return { value, conflicts: sorted([...conflicts]) }; }, ['value', 'conflicts']);
define(7, 'revision-checked-updates', 'Process updates in order. Apply a replacement only when expectedRevision matches current revision, then increment revision. Return value/revision and rejected update ids in order.',
  r => ({ value: r(0, 9), revision: 2, updates: [{ id: 'u1', expectedRevision: 2, value: r(10, 19) }, { id: 'u2', expectedRevision: r(2, 3), value: r(20, 29) }, { id: 'u3', expectedRevision: 4, value: r(30, 39) }] }),
  x => { let { value, revision } = x; const rejected = []; for (const u of x.updates) if (u.expectedRevision === revision) { value = u.value; revision++; } else rejected.push(u.id); return { value, revision, rejected }; }, ['value', 'revision', 'rejected']);
define(7, 'observed-outcome-reconciliation', 'For each mutation, only a later observation of the same record resolves unknown outcome. Return unresolved mutation ids sorted; unrelated or older observations do not resolve it.',
  r => ({ events: range(r(8, 16)).map(i => ({ type: r(0, 2) === 0 ? 'observe' : 'unknown', id: `event${i}`, record: `record${r(0, 4)}` })) }),
  x => { const pending = new Map(); for (const e of x.events) { invariant(['unknown', 'observe'].includes(e.type), 'Invalid event type'); if (e.type === 'unknown') pending.set(e.id, e.record); else for (const [id, record] of pending) if (record === e.record) pending.delete(id); } return { unresolved: sorted([...pending.keys()]) }; }, ['unresolved']);

// Six target programs are withheld from the general reserve, two per release.
define(2, 'critical-path-duration', 'Compute earliest finish times of acyclic jobs with durations and predecessor ids. Unlimited parallelism; return makespan and finishes sorted by id. Cycles are invalid.',
  r => ({ jobs: range(r(5, 8)).map(i => ({ id: `j${i}`, duration: r(1, 15), after: range(i).filter(() => r(0, 2) === 0).map(k => `j${k}`) })) }),
  x => { const finishes = new Map(); for (let k = 0; k < x.jobs.length; k++) for (const j of x.jobs) if (j.after.every(a => finishes.has(a))) finishes.set(j.id, (j.after.length ? Math.max(...j.after.map(a => finishes.get(a))) : 0) + j.duration); invariant(finishes.size === x.jobs.length, 'Cycle or missing dependency'); return { makespan: Math.max(0, ...finishes.values()), finishes: sorted([...finishes.keys()]).map(id => ({ id, finish: finishes.get(id) })) }; }, ['makespan', 'finishes'], 0);
define(5, 'signed-clause-models', 'Enumerate Boolean models satisfying every clause. A literal is a variable or !variable. Return satisfying bit strings in lexical order, variable order as supplied.',
  r => { const variables = range(r(4, 7)).map(i => `v${i}`); return { variables, clauses: range(r(4, 10)).map(() => [...new Set(range(r(1, 3)).map(() => `${r(0, 1) ? '!' : ''}${variables[r(0, variables.length - 1)]}`))]) }; },
  x => { invariant(x.variables.length <= 10 && x.clauses.every(c => c.every(l => x.variables.includes(l.replace(/^!/, '')))), 'Invalid clauses'); const models = range(2 ** x.variables.length).map(n => n.toString(2).padStart(x.variables.length, '0')).filter(bits => x.clauses.every(c => c.some(l => { const value = bits[x.variables.indexOf(l.replace(/^!/, ''))] === '1'; return l.startsWith('!') ? !value : value; }))); return { models }; }, ['models'], 0);
define(1, 'calendar-overlap-days', 'Count calendar dates in the intersection of half-open ISO date intervals [start,end). Return zero when their intersection is empty.',
  r => { const start = dateMs(date(r)); return { intervals: [{ start: iso(start), end: iso(start + r(6, 12) * day) }, { start: iso(start + r(2, 8) * day), end: iso(start + r(9, 16) * day) }] }; },
  x => { invariant(x.intervals.length > 0 && x.intervals.every(i => dateMs(i.end) >= dateMs(i.start)), 'Invalid date interval'); return { days: Math.max(0, (Math.min(...x.intervals.map(i => dateMs(i.end))) - Math.max(...x.intervals.map(i => dateMs(i.start)))) / day) }; }, ['days'], 1);
define(3, 'two-axis-pivot', 'Pivot records by row and column, summing amounts. Return sorted rows and columns with a rectangular value matrix; missing cells are zero.',
  r => ({ records: range(7).map(() => ({ row: ['north', 'south'][r(0, 1)], column: ['first', 'second', 'third'][r(0, 2)], amount: r(-5, 12) })) }),
  x => { const rows = sorted([...new Set(x.records.map(r => r.row))]), columns = sorted([...new Set(x.records.map(r => r.column))]); return { rows, columns, matrix: rows.map(row => columns.map(column => sum(x.records.filter(r => r.row === row && r.column === column).map(r => r.amount)))) }; }, ['rows', 'columns', 'matrix'], 1);
define(4, 'register-program', 'Execute a finite register program. set writes a constant, add adds a constant, copy writes the current value of source into target. Missing registers read as zero. Return registers sorted by name.',
  r => ({ instructions: [{ op: 'set', target: 'a', source: '', value: r(2, 9) }, { op: 'copy', target: 'b', source: 'a', value: 0 }, { op: 'add', target: 'a', source: '', value: r(1, 9) }, { op: 'add', target: 'b', source: '', value: r(-4, 4) }] }),
  x => { const registers = new Map(); for (const i of x.instructions) { invariant(['set', 'add', 'copy'].includes(i.op), 'Invalid register instruction'); registers.set(i.target, i.op === 'set' ? i.value : i.op === 'add' ? (registers.get(i.target) ?? 0) + i.value : (registers.get(i.source) ?? 0)); } return { registers: sorted([...registers.keys()]).map(name => ({ name, value: registers.get(name) })) }; }, ['registers'], 2);
define(7, 'atomic-transfer-log', 'Process balance transfers in order; accept only if source and destination exist, amount is positive and source has enough balance. Reject without partial changes. Return balances sorted by account and rejected ids.',
  r => ({ balances: [{ account: 'a', amount: r(8, 15) }, { account: 'b', amount: r(1, 5) }, { account: 'c', amount: 0 }], transfers: [{ id: 't1', from: 'a', to: 'b', amount: r(3, 8) }, { id: 't2', from: 'b', to: 'c', amount: r(9, 20) }, { id: 't3', from: 'c', to: 'a', amount: 1 }] }),
  x => { const balances = new Map(x.balances.map(b => [b.account, b.amount])), rejected = []; invariant(balances.size === x.balances.length, 'Duplicate account'); for (const t of x.transfers) { if (!balances.has(t.from) || !balances.has(t.to) || t.amount <= 0 || balances.get(t.from) < t.amount) rejected.push(t.id); else { balances.set(t.from, balances.get(t.from) - t.amount); balances.set(t.to, balances.get(t.to) + t.amount); } } return { balances: sorted([...balances.keys()]).map(account => ({ account, amount: balances.get(account) })), rejected }; }, ['balances', 'rejected'], 2);

export function listContinualTaskFamilies() { return [...CONTINUAL_CAPABILITY_FAMILIES]; }
export function listContinualLineages() { return programs.map(({ family, id, lineageId, description, release }) => ({ family, operation: id, lineageId, description, release, reserve: release === null })); }
function getProgram(lineage) { const p = programs.find(p => p.lineageId === lineage || p.id === lineage); invariant(p, `Unknown lineage: ${lineage}`); return p; }
export function getContinualTools() {
  return TOOL_NAMES.map((name, index) => ({ type: 'function', function: { name,
    description: `Read-only explicit-input research utility for ${CONTINUAL_CAPABILITY_FAMILIES[index]}. ${programs.filter(p => p.tool === name).map(p => `${p.id}: ${p.description}`).join(' ')}`,
    parameters: { type: 'object', additionalProperties: false, required: ['operation', 'input'], properties: {
      operation: { type: 'string', enum: programs.filter(p => p.tool === name).map(p => p.id) }, input: { type: 'object', description: 'The explicit input object from the requested operation; no task id or hidden goal lookup.' }
    } }
  } }));
}

function taskFromComponents({ split, seed, release, category, components, composition = false, requiresTools = true }) {
  invariant(SPLITS.includes(split), 'Unknown curriculum split');
  invariant(Number.isSafeInteger(seed) && seed >= 0, 'Seed must be a nonnegative safe integer');
  invariant(release === null || [0, 1, 2].includes(release), 'Invalid release');
  const spec = { split, seed, release, category, composition, requiresTools, components };
  const inputDigest = hash(components.map(({ operation, input, outputFields }) => ({ operation, input, outputFields })));
  const id = `continual-task-${hash(spec).slice(0, 24)}`;
  const primitiveLineageIds = components.map(c => getProgram(c.operation).lineageId);
  const lineageId = composition ? `continual-v1/composition/${split}/${primitiveLineageIds.map(s => s.split('/').at(-1)).join('+')}` : primitiveLineageIds[0];
  const goal = { description: composition ? 'Complete both subproblems. Return {"parts":[first output object,second output object]} in the given order. Each subproblem requires its matching tool operation.' : requiresTools ? 'Complete the subproblem using its matching tool operation. Return only the requested output object.' : 'Answer this self-contained subproblem directly. Tools are optional; use them only if useful. Return only the requested output object.',
    parts: components.map(c => ({ instruction: getProgram(c.operation).description, input: clone(c.input), outputFields: c.outputFields })) };
  const system = requiresTools ? SYSTEM : SYSTEM.replace('Use the required operation(s), then return only the requested final JSON.', 'For self-contained direct-answer tasks, tools are optional. Return only the requested final JSON.');
  const task = { id, goal, messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(goal) }], tools: getContinualTools(),
    metadata: { family: composition ? 'held-out-composition' : getProgram(components[0].operation).family, lineageId, primitiveLineageIds, split, release, category,
      episodeId: id, sourceEpisodeId: id, inputDigest, seed, requiresTools, requiredToolCalls: requiresTools ? components.length : 0, synthetic: true,
      independenceClaim: 'Parameterized synthetic episode; not an independent program or statistical replication.' }, spec };
  states.set(task, { calls: [], successfulInputs: new Set() });
  return task;
}
export function createContinualTask({ lineageId, split = 'development', seed, release = null, category = split, requiresTools = true } = {}) {
  const p = getProgram(lineageId);
  const input = p.make(rng(`${split}:${seed}:${p.id}`));
  invariant(typeof requiresTools === 'boolean', 'requiresTools must be Boolean');
  return taskFromComponents({ split, seed, release, category, requiresTools, components: [{ operation: p.id, input, outputFields: [...p.outputFields] }] });
}
export function createContinualComposition({ lineages, split = 'qualification', seed, release = null, category = split } = {}) {
  invariant(Array.isArray(lineages) && lineages.length === 2 && lineages[0] !== lineages[1], 'Composition needs two different lineages');
  invariant(split !== 'training', 'Held-out compositions cannot enter TRAIN');
  return taskFromComponents({ split, seed, release, category, composition: true, components: lineages.map((lineage, index) => {
    const p = getProgram(lineage); return { operation: p.id, input: p.make(rng(`${split}:${seed}:${index}:${p.id}`)), outputFields: [...p.outputFields] };
  }) });
}
function operationKey(name, args) { return hash({ name, operation: args.operation, input: args.input }); }
function validateTask(task) {
  invariant(task && typeof task === 'object' && task.spec && task.metadata, 'Invalid task');
  const spec = safeJson(task.spec);
  invariant(task.id === `continual-task-${hash(spec).slice(0, 24)}`, 'Task specification identity mismatch');
  invariant(task.metadata.requiresTools === spec.requiresTools && task.metadata.split === spec.split, 'Task metadata mismatch');
  invariant(task.metadata.inputDigest === hash(spec.components.map(({ operation, input, outputFields }) => ({ operation, input, outputFields }))), 'Task content identity mismatch');
  invariant(Array.isArray(spec.components) && spec.components.length === (spec.composition ? 2 : 1), 'Invalid task components');
  for (const c of spec.components) invariant(bytes(c.outputFields) === bytes(getProgram(c.operation).outputFields), 'Task output contract mismatch');
}
function executeExplicitTool(name, args) {
  const safe = safeJson(args);
  invariant(safe && !Array.isArray(safe) && bytes(Object.keys(safe).sort()) === bytes(['input', 'operation']), 'Expected exactly operation and input');
  const p = getProgram(safe.operation);
  invariant(p.tool === name, 'Operation is not supported by this tool');
  invariant(shapeMatches(safe.input, p.shape), 'Input fields/types do not match this operation');
  const result = safeJson(p.run(safe.input));
  return { ok: true, result };
}
export function executeContinualTool(task, name, args) {
  let state = states.get(task); if (!state) { state = { calls: [], successfulInputs: new Set() }; states.set(task, state); }
  let result;
  try { validateTask(task); result = executeExplicitTool(name, args); state.successfulInputs.add(operationKey(name, args)); }
  catch (error) { result = { ok: false, error: { code: 'invalid_arguments', message: error.message } }; }
  state.calls.push({ name: typeof name === 'string' ? name : '[invalid]', result: clone(result) });
  return clone(result);
}
function expectedAnswer(task) {
  const outputs = task.spec.components.map(c => { const p = getProgram(c.operation), result = executeExplicitTool(p.tool, { operation: p.id, input: c.input }).result; return Object.fromEntries(c.outputFields.map(key => [key, result[key]])); });
  return task.spec.composition ? { parts: outputs } : outputs[0];
}
export function checkContinualAnswer(task, answer) {
  const errors = []; let parsed, finalAnswerCorrect = false;
  let valid = false;
  try { validateTask(task); valid = true; parsed = safeJson(typeof answer === 'string' ? JSON.parse(answer) : answer); finalAnswerCorrect = bytes(parsed) === bytes(expectedAnswer(task)); }
  catch (error) { errors.push(error.message); }
  const state = states.get(task);
  const nativeToolRequirementMet = valid && (task.spec.requiresTools === false || Boolean(state && task.spec.components.every(c => state.successfulInputs.has(operationKey(getProgram(c.operation).tool, { operation: c.operation, input: c.input })))));
  if (!finalAnswerCorrect) errors.push('Final JSON does not satisfy the task');
  if (!nativeToolRequirementMet) errors.push('Required successful explicit-input tool execution missing');
  return { passed: finalAnswerCorrect && nativeToolRequirementMet, pass: finalAnswerCorrect && nativeToolRequirementMet, finalAnswerCorrect, nativeToolRequirementMet, errors };
}
export function buildContinualDemonstration(task) {
  validateTask(task);
  invariant(task?.metadata?.split === 'training' && !task.spec.composition, 'Only training episodes may become demonstrations');
  if (task.metadata.requiresTools === false) {
    const messages = [...task.messages, { role: 'assistant', content: JSON.stringify(expectedAnswer(task)) }];
    const receipt = checkContinualAnswer(task, messages.at(-1).content);
    invariant(receipt.passed, 'Direct-answer teacher failed native checker');
    return { episodeId: task.id, receipt, publicTrace: [], rows: [{ messages: clone(messages), tools: clone(task.tools), metadata: {
      ...clone(task.metadata), taskFamily: task.metadata.family, targetKind: 'direct-answer', exampleId: `${task.id}:direct-answer`,
      exampleDigest: hash(messages), source: 'authored-deterministic-synthetic', verification: 'native-final-json' } }] };
  }
  const component = task.spec.components[0], p = getProgram(component.operation), args = { operation: p.id, input: clone(component.input) };
  const result = executeContinualTool(task, p.tool, args);
  invariant(result.ok, 'Teacher tool execution failed');
  const callId = `call-${hash(task.id).slice(0, 16)}`;
  // Qwen's native training chat template iterates arguments.items(); wire responses
  // remain JSON strings, but authored SFT messages must retain the argument mapping.
  const call = { role: 'assistant', content: null, tool_calls: [{ id: callId, type: 'function', function: { name: p.tool, arguments: clone(args) } }] };
  const observation = { role: 'tool', tool_call_id: callId, name: p.tool, content: JSON.stringify(result) };
  const final = { role: 'assistant', content: JSON.stringify(expectedAnswer(task)) };
  const receipt = checkContinualAnswer(task, final.content);
  invariant(receipt.passed, 'Teacher failed the native checker');
  const makeRow = (messages, targetKind) => { const metadata = { ...clone(task.metadata), taskFamily: task.metadata.family, targetKind, exampleId: `${task.id}:${targetKind}`, exampleDigest: hash(messages), source: 'authored-deterministic-synthetic', verification: 'native-explicit-tool-and-final-json' }; return { messages: clone(messages), tools: clone(task.tools), metadata }; };
  return { episodeId: task.id, receipt, publicTrace: [{ name: p.tool, args, result }],
    rows: [makeRow([...task.messages, call], 'tool-choice'), makeRow([...task.messages, call, observation, final], 'post-tool-completion')] };
}

/** Labels for native trainer diagnostics only. Endpoint qualification stays outside this API. */
export function buildContinualValidationExample(task) {
  validateTask(task);
  invariant(task.metadata.split === 'development', 'Only development tasks may produce validation labels');
  const messages = clone(task.messages), fresh = clone(task);
  if (task.metadata.requiresTools) for (let index = 0; index < task.spec.components.length; index++) {
    const c = task.spec.components[index], p = getProgram(c.operation), args = { operation: p.id, input: clone(c.input) };
    const result = executeContinualTool(fresh, p.tool, args); invariant(result.ok, 'Validation teacher tool failed');
    const id = `validation-${hash({ task: task.id, index }).slice(0, 16)}`;
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: p.tool, arguments: clone(args) } }] },
      { role: 'tool', tool_call_id: id, name: p.tool, content: JSON.stringify(result) });
  }
  const answer = JSON.stringify(expectedAnswer(task)), receipt = checkContinualAnswer(fresh, answer);
  invariant(receipt.passed, 'Validation teacher failed native checker');
  messages.push({ role: 'assistant', content: answer });
  return { messages, tools: clone(task.tools), metadata: { ...clone(task.metadata), taskFamily: task.metadata.family,
    exampleId: `${task.id}:validation-final`, exampleDigest: hash(messages), targetKind: 'validation-final', trainingEligible: false,
    source: 'authored-deterministic-development-only', nativeVerification: receipt } };
}

const HISTORICAL_FAMILIES = [
  'distinguish-proposed-state-from-host-recorded-state', 'integrate-specialists-into-verifiable-result',
  'request-approval-only-at-real-authority-boundaries', 'produce-contract-valid-artifacts'
];
function frozen(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const v of Object.values(value)) frozen(v); }
  return value;
}
function exclusionSets(exclusions = {}) {
  const keys = ['episodeIds', 'sourceEpisodeIds', 'taskIds', 'inputDigests', 'contentDigests', 'lineageIds'];
  invariant(exclusions && typeof exclusions === 'object' && !Array.isArray(exclusions), 'Expected exclusions object');
  for (const key of Object.keys(exclusions)) invariant(keys.includes(key), `Unknown exclusion key: ${key}`);
  return Object.fromEntries(keys.map(key => { const values = exclusions[key] ?? []; invariant(Array.isArray(values) && values.every(v => typeof v === 'string'), `Invalid ${key}`); return [key, new Set(values)]; }));
}
function excluded(task, sets) {
  return sets.episodeIds.has(task.id) || sets.sourceEpisodeIds.has(task.id) || sets.taskIds.has(task.id) ||
    sets.inputDigests.has(task.metadata.inputDigest) || sets.contentDigests.has(task.metadata.inputDigest) ||
    sets.lineageIds.has(task.metadata.lineageId) || task.metadata.primitiveLineageIds.some(id => sets.lineageIds.has(id));
}
function taskContentKeys(task) {
  return [task.metadata.inputDigest, ...task.spec.components.map(c => hash([{ operation: c.operation, input: c.input, outputFields: c.outputFields }]))];
}
function selectHistorical(raw, sets) {
  if (raw === undefined || raw === null) return { available: false, rows: [], reason: 'Exact admitted S6 historical training JSONL was not supplied.' };
  const jsonl = typeof raw === 'string' ? raw : raw.jsonl;
  invariant(typeof jsonl === 'string' && hash(jsonl) === HISTORICAL_S6_TRAINING_SHA256, 'Historical replay must match the exact admitted S6 training bytes');
  const parsed = jsonl.trim().split('\n').map(line => JSON.parse(line));
  invariant(parsed.length === 889, 'Unexpected historical row count');
  const rows = parsed.filter(row => HISTORICAL_FAMILIES.includes(row.metadata?.taskFamily)).map(row => ({
    ...clone(row), metadata: { ...clone(row.metadata), family: row.metadata.taskFamily, lineageId: `historical-contract-family/${row.metadata.taskFamily}`,
      primitiveLineageIds: [`historical-contract-family/${row.metadata.taskFamily}`], split: 'training', category: 'historical-replay',
      source: 'frozen-S6-admitted-corpus', verification: 'imported-historical-admission-not-rechecked-by-new-task-checker' }
  }));
  invariant(rows.length === 883, 'Unexpected historical contract coverage');
  const permitted = rows.filter(row => !sets.sourceEpisodeIds.has(row.metadata.sourceEpisodeId) && !sets.episodeIds.has(row.metadata.sourceEpisodeId) &&
    !sets.taskIds.has(row.metadata.exampleId) && !sets.contentDigests.has(row.metadata.exampleDigest) &&
    !sets.contentDigests.has(hash(row.messages)) && !sets.lineageIds.has(row.metadata.lineageId));
  return { available: true, rows: permitted, sourceSha256: HISTORICAL_S6_TRAINING_SHA256, rawRows: 889, eligibleBeforeExclusions: 883,
    excludedRows: rows.length - permitted.length, lineageScope: 'Conservative historical family groups, not a claim of distinct old program lineages.' };
}
function rowStatistics(rows) {
  const lineages = {}, families = {}, targetKinds = {}, sources = {};
  for (const row of rows) {
    for (const [out, key] of [[lineages, row.metadata.lineageId], [families, row.metadata.family], [targetKinds, row.metadata.targetKind], [sources, row.metadata.source]]) out[key] = (out[key] ?? 0) + 1;
  }
  return { decisions: rows.length, uniqueEpisodes: new Set(rows.map(r => r.metadata.sourceEpisodeId)).size,
    lineages, families, targetKinds, sources, maximumLineageShare: rows.length ? Math.max(...Object.values(lineages)) / rows.length : 0,
    coefficientBasis: 'One microbatch-mean target loss per sampled decision; token counts and gradients are not estimated here.' };
}
function pickEpisodes(pools, ids, count, offset = 0) {
  const picked = []; const positions = new Map(ids.map(id => [id, offset]));
  for (let i = 0; i < count; i++) { const id = ids[i % ids.length], pool = pools.get(id); invariant(pool?.length, `No eligible episodes for ${id}`); const position = positions.get(id); picked.push(pool[position % pool.length]); positions.set(id, position + 1); }
  invariant(new Set(picked.map(task => task.id)).size === picked.length, 'Insufficient distinct episodes for requested sampling');
  return picked;
}

/** All output task instances are synthetic parameterizations of named programs. Qualification
 * holds out program pairings and input content, while openly sharing primitive operations.
 * It is not an unseen-algorithm or statistically independent-lineage evaluation. */
export function buildContinualCurriculum({ seed = 20260915, historicalReplay, exclusions = {} } = {}) {
  invariant(Number.isSafeInteger(seed) && seed >= 0 && seed <= 1e9, 'Curriculum seed out of bounds');
  const sets = exclusionSets(exclusions), usedContent = new Set(), gaps = [], selection = [], pools = new Map(), directPools = new Map();
  const reserve = programs.filter(p => p.release === null), targeted = programs.filter(p => p.release !== null);
  const select = (create, count, label) => {
    const tasks = []; let rejectedDuplicate = 0, rejectedExclusion = 0;
    for (let attempt = 0; tasks.length < count && attempt < count * 100; attempt++) {
      const task = create(attempt), keys = taskContentKeys(task);
      if (excluded(task, sets)) { rejectedExclusion++; continue; }
      if (keys.some(k => usedContent.has(k))) { rejectedDuplicate++; continue; }
      for (const key of keys) usedContent.add(key); tasks.push(task);
    }
    selection.push({ label, requested: count, selected: tasks.length, rejectedDuplicate, rejectedExclusion });
    if (tasks.length !== count) gaps.push(`${label}: selected ${tasks.length}/${count} distinct nonexcluded inputs`);
    return tasks;
  };
  for (const p of reserve) pools.set(p.id, select(a => createContinualTask({ lineageId: p.id, split: 'training', seed: seed + a, category: 'reserve' }), 32, `reserve:${p.id}`));
  for (const p of reserve) directPools.set(p.id, select(a => createContinualTask({ lineageId: p.id, split: 'training', seed: seed + 50000 + a, category: 'reserve', requiresTools: false }), 32, `direct-reserve:${p.id}`));
  for (const p of targeted) pools.set(p.id, select(a => createContinualTask({ lineageId: p.id, split: 'training', seed: seed + 100000 + p.release * 10000 + a, release: p.release, category: 'acquisition' }), 64, `release:${p.release}:${p.id}`));
  const reserveTasks = reserve.flatMap(p => [...pools.get(p.id), ...directPools.get(p.id)]);
  const newTasksByRelease = range(3).map(release => targeted.filter(p => p.release === release).flatMap(p => pools.get(p.id)));
  const developmentTasks = [], qualificationTasksByRelease = [[], [], []];
  for (let release = 0; release < 3; release++) {
    const current = targeted.filter(p => p.release === release);
    for (let index = 0; index < current.length; index++) {
      const p = current[index];
      developmentTasks.push(...select(a => createContinualTask({ lineageId: p.id, split: 'development', seed: seed + 200000 + release * 10000 + index * 1000 + a, release, category: 'acquisition' }), 6, `development:${release}:${p.id}`));
      // Development and qualification use different reserve partners, not just different ids.
      const devPartner = reserve[(release * 2 + index) % reserve.length];
      developmentTasks.push(...select(a => createContinualComposition({ lineages: [p.id, devPartner.id], split: 'development', seed: seed + 300000 + release * 10000 + index * 1000 + a, release, category: 'composition-transfer' }), 2, `development-composition:${release}:${p.id}`));
      for (let partner = 0; partner < 4; partner++) {
        const q = reserve[(12 + release * 4 + index * 4 + partner) % reserve.length];
        qualificationTasksByRelease[release].push(...select(a => createContinualComposition({ lineages: [p.id, q.id], split: 'qualification', seed: seed + 400000 + release * 10000 + index * 1000 + partner * 100 + a, release, category: 'composition-transfer' }), 2, `qualification:${release}:${p.id}+${q.id}`));
      }
    }
  }
  const historical = selectHistorical(historicalReplay, sets);
  if (!historical.available) gaps.push(historical.reason);
  const demos = new Map();
  const rowsFor = tasks => tasks.flatMap(task => { if (!demos.has(task.id)) demos.set(task.id, buildContinualDemonstration(task)); return demos.get(task.id).rows; });
  const cycles = [];
  if (!selection.some(s => s.selected !== s.requested)) for (let release = 0; release < 3; release++) {
    const newRows = rowsFor(newTasksByRelease[release]);
    const previous = targeted.filter(p => p.release < release).map(p => p.id);
    const cumulativeLineages = [...previous, ...reserve.map(p => p.id).filter(id => !previous.includes(id))].slice(0, 8);
    const cumulativeTasks = cumulativeLineages.flatMap(id => pickEpisodes(pools, [id], 8, release * 8));
    const cumulativeRows = rowsFor(cumulativeTasks);
    const broadTasks = pickEpisodes(pools, reserve.map(p => p.id), 160, release * 7);
    // Cumulative and broad samples must not duplicate a decision within a cycle.
    const cumulativeIds = new Set(cumulativeTasks.map(t => t.id));
    const replacementPools = new Map(reserve.map(p => [p.id, pools.get(p.id).filter(t => !cumulativeIds.has(t.id))]));
    const broadUniqueTasks = broadTasks.some(t => cumulativeIds.has(t.id)) ? pickEpisodes(replacementPools, reserve.map(p => p.id), 160, release * 3) : broadTasks;
    const broadDirectTasks = pickEpisodes(directPools, reserve.map(p => p.id), 320, release * 7);
    const broadRows = rowsFor([...broadUniqueTasks, ...broadDirectTasks]);
    const narrowRows = [];
    if (historical.available) for (const family of HISTORICAL_FAMILIES) {
      const familyRows = historical.rows.filter(row => row.metadata.family === family);
      if (familyRows.length < 160) { gaps.push(`Historical ${family}: only ${familyRows.length}/160 eligible rows`); continue; }
      narrowRows.push(...range(160).map(i => familyRows[(i + release * 37) % familyRows.length]));
    }
    const broad = [...newRows, ...cumulativeRows, ...broadRows], narrow = narrowRows.length === 640 ? [...newRows, ...cumulativeRows, ...narrowRows] : [];
    const statistics = { new: rowStatistics(newRows), cumulative: rowStatistics(cumulativeRows), broadReplay: rowStatistics(broadRows), narrowReplay: rowStatistics(narrowRows) };
    invariant(newRows.length === 256 && cumulativeRows.length === 128 && broadRows.length === 640, 'Cycle size mismatch');
    invariant(statistics.broadReplay.maximumLineageShare <= 0.05, 'Replay lineage exceeds 5% coefficient cap');
    invariant(Math.max(...Object.values(statistics.cumulative.lineages)) <= 16, 'Cumulative lineage exceeds 16 decisions');
    invariant(Math.max(...Object.values(statistics.new.lineages)) / 1024 <= 0.125, 'New program exceeds 12.5% whole-batch coefficient cap');
    invariant(new Set(broad.map(row => row.metadata.exampleId)).size === broad.length, 'Repeated broad decision within cycle');
    cycles.push({ release, newRows, cumulativeRows, arms: { broad, narrow }, replayRows: { broad: broadRows, narrow: narrowRows }, statistics,
      commonNewSha256: hash(newRows), commonCumulativeSha256: hash(cumulativeRows), broadSha256: hash(broad), narrowSha256: narrow.length ? hash(narrow) : null });
  }
  const manifest = {
    schema: CONTINUAL_CURRICULUM_SCHEMA, seed, sourceType: 'authored-deterministic-synthetic-plus-explicit-historical-replay',
    admitted: gaps.length === 0, admissionGaps: gaps, sourceFamilies: listContinualTaskFamilies(), authoredReservePrograms: reserve.length,
    reservedNewPrograms: targeted.length, releases: 3, intendedDecisionsPerCycle: 1024, intendedNewEpisodesPerRelease: 128,
    mixture: { new: 256, cumulative: 128, replay: 640, broadReplayDirectAnswers: 320, broadReplayToolDecisions: 320 },
    coefficientCaps: { broadReplayLineageShareWithinReplay: 0.05, cumulativeDecisionsPerLineage: 16, targetedLineageShareWholeBatch: 0.125,
      protocolRevision: 'Targeted acquisition uses two real programs per release; 5% applies to broad replay, not the two 12.5% target programs.' },
    historical: { ...historical, rows: undefined }, exclusionDigest: hash(exclusions), exclusionCounts: Object.fromEntries(Object.entries(sets).map(([k, s]) => [k, s.size])),
    selection, decisionsWithNativeTeacherReceipts: [...demos.values()].reduce((n, d) => n + d.rows.length, 0),
    checks: { distinctInputContentAcrossPartitions: true, noTrainCompositionTargets: true, primitiveOperationsSharedWithQualification: true,
      generatedTenantData: false, generatedExternalData: false, modelQualityQualified: false, tokenizerQualified: false },
    limitations: ['Episode ids and distinct parameters are not independent algorithms or statistical replications.',
      'Qualification contains held-out pairs of known primitive programs; it does not measure unseen-algorithm generalization.',
      'Native checks validate bounded synthetic task semantics, not broad generalist or production performance.',
      'Historical narrow rows retain prior admission provenance; the new checker does not independently regrade that old corpus.',
      'Exact supplied exclusions and generated-content separation are enforced; completeness of an external consumed-case registry is not inferred.',
      'Task headroom, tokenizer fit, actual loss exposure and model benefit require separate qualification.']
  };
  const result = { manifest, cycles, reserveTasks, newTasksByRelease, developmentTasks, qualificationTasksByRelease,
    teacherReceipts: [...demos.values()].map(({ episodeId, receipt, publicTrace }) => ({ episodeId, receipt, publicTrace })) };
  manifest.digest = hash({ ...manifest, cycleDigests: cycles.map(c => ({ release: c.release, new: c.commonNewSha256, cumulative: c.commonCumulativeSha256, broad: c.broadSha256, narrow: c.narrowSha256 })) });
  return frozen(result);
}

/** Recheck persisted training decisions against deterministic authored teachers and exact
 * historical bytes. This is data admission, never model or tokenizer qualification. */
export function admitContinualCurriculum(corpus, { historicalReplay, exclusions = {} } = {}) {
  const errors = [], sets = exclusionSets(exclusions), verified = new Set();
  let historical;
  try { historical = selectHistorical(historicalReplay, sets); }
  catch (error) { errors.push(error.message); historical = { available: false, rows: [] }; }
  const historicalRows = new Map(historical.rows.map(row => [row.metadata.exampleId, row]));
  const inspectRow = row => {
    try {
      const fingerprint = hash(row); if (verified.has(fingerprint)) return;
      const m = row.metadata;
      invariant(m.split === 'training' && m.trainingEligible !== false, 'Non-TRAIN row in training view');
      if (m.source === 'frozen-S6-admitted-corpus') {
        invariant(historical.available && historicalRows.has(m.exampleId), 'Unbound historical row');
        invariant(bytes(row) === bytes(historicalRows.get(m.exampleId)), 'Historical row changed');
      } else {
        invariant(m.source === 'authored-deterministic-synthetic', 'Unknown row provenance');
        const task = createContinualTask({ lineageId: m.lineageId, split: m.split, seed: m.seed, release: m.release, category: m.category, requiresTools: m.requiresTools });
        invariant(!excluded(task, sets), 'Excluded synthetic row');
        const original = buildContinualDemonstration(task).rows.find(r => r.metadata.targetKind === m.targetKind);
        invariant(original && bytes(row) === bytes(original), 'Synthetic target or provenance changed');
      }
      verified.add(fingerprint);
    } catch (error) { errors.push(`row ${row?.metadata?.exampleId ?? '[missing]'}: ${error.message}`); }
  };
  if (corpus?.manifest?.schema !== CONTINUAL_CURRICULUM_SCHEMA || corpus?.cycles?.length !== 3) errors.push('Incomplete curriculum structure');
  for (const cycle of corpus?.cycles ?? []) {
    for (const arm of ['broad', 'narrow']) {
      const rows = cycle.arms?.[arm] ?? [];
      if (rows.length !== 1024) errors.push(`cycle ${cycle.release} ${arm}: expected 1024 decisions`);
      if (new Set(rows.map(r => r.metadata?.exampleId)).size !== rows.length) errors.push(`cycle ${cycle.release} ${arm}: duplicate decisions`);
      if (bytes(rows.slice(0, 256)) !== bytes(cycle.newRows) || bytes(rows.slice(256, 384)) !== bytes(cycle.cumulativeRows)) errors.push(`cycle ${cycle.release} ${arm}: shared targets changed`);
      if (bytes(rows.slice(384)) !== bytes(cycle.replayRows?.[arm] ?? [])) errors.push(`cycle ${cycle.release} ${arm}: replay view differs from actual arm`);
      if (rows.length && hash(rows) !== cycle[`${arm}Sha256`]) errors.push(`cycle ${cycle.release} ${arm}: data digest mismatch`);
      rows.forEach(inspectRow);
    }
    if (hash(cycle.newRows) !== cycle.commonNewSha256 || hash(cycle.cumulativeRows) !== cycle.commonCumulativeSha256) errors.push(`cycle ${cycle.release}: common input digest mismatch`);
    const s = { new: rowStatistics(cycle.newRows ?? []), cumulative: rowStatistics(cycle.cumulativeRows ?? []), broad: rowStatistics(cycle.arms?.broad?.slice(384) ?? []) };
    if (s.new.decisions !== 256 || s.new.uniqueEpisodes !== 128 || Object.keys(s.new.lineages).length !== 2 || Math.max(...Object.values(s.new.lineages)) > 128) errors.push(`cycle ${cycle.release}: invalid new exposure`);
    if (s.cumulative.decisions !== 128 || Math.max(...Object.values(s.cumulative.lineages)) > 16) errors.push(`cycle ${cycle.release}: invalid cumulative exposure`);
    if (s.broad.decisions !== 640 || Object.keys(s.broad.families).length !== 8 || Object.keys(s.broad.lineages).length !== 24 || s.broad.maximumLineageShare > 0.05 || s.broad.targetKinds['direct-answer'] !== 320 || s.broad.targetKinds['tool-choice'] !== 160 || s.broad.targetKinds['post-tool-completion'] !== 160) errors.push(`cycle ${cycle.release}: invalid reserve coverage/modality`);
  }
  const contentBySplit = new Map(), episodes = new Set();
  const tasks = [...(corpus?.reserveTasks ?? []), ...(corpus?.newTasksByRelease ?? []).flat(), ...(corpus?.developmentTasks ?? []), ...(corpus?.qualificationTasksByRelease ?? []).flat()];
  for (const task of tasks) try {
    validateTask(task); invariant(!excluded(task, sets), 'Excluded task'); invariant(!episodes.has(task.id), 'Duplicate generated episode'); episodes.add(task.id);
    for (const key of new Set(taskContentKeys(task))) { invariant(!contentBySplit.has(key), `Repeated input content in ${task.metadata.split}; first seen in ${contentBySplit.get(key)}`); contentBySplit.set(key, task.metadata.split); }
    invariant(task.metadata.split !== 'training' || !task.spec.composition, 'TRAIN composition leakage');
  } catch (error) { errors.push(`task ${task?.id}: ${error.message}`); }
  return { schema: 'amos.continual-curriculum-admission.v1', admitted: errors.length === 0, errors: [...new Set(errors)], verifiedDistinctRows: verified.size,
    generatedEpisodes: episodes.size, historicalSourceSha256: historical.available ? HISTORICAL_S6_TRAINING_SHA256 : null,
    modelQualityQualified: false, tokenizerQualified: false };
}
