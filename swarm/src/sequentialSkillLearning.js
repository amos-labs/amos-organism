import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createSequentialSkillFixture, SEQUENTIAL_SKILL_VARIANTS } from '../evals/sequentialSkillFixture.js';
import { validateCheckedProcedure, executeCheckedProcedure } from './checkedProcedure.js';
import { emptySkillLibrary, validateSkillLibrary, admitCheckedSkill } from './persistentSkillLibrary.js';

const clone = value => structuredClone(value);
export const sequentialEvidenceHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hash = sequentialEvidenceHash;
const descriptions = {
  'reserve-order': 'Reserve the exact requested lines and confirm every order in goal.orders. Reuse existing reservations, reconcile unknown outcomes, and leave invoices unchanged.',
  'invoice-order': 'For reserved orders in goal.orders, create or reuse draft invoices and set invoiceReference. Reconcile unknown outcomes, leave inventory unchanged, and never send invoices.'
};
const system = 'Operate the isolated synthetic business workflow using its tools. Follow the current goal and public tool evidence. Demonstrations describe other tasks. Reconcile unknown effects before more mutations or completion. Never invent successful effects. You may use available learned skills or raw tools and recover from skill failures. Stop with a concise final answer once observations support completion.';
export const SEQUENTIAL_PROCEDURE_GUIDE = `Induce a reusable executable procedure. Return JSON only, no Javascript:
{"schema":"amos.checked-procedure.v1","steps":[...]}
Steps:
{"type":"call","tool":"name","args":{...},"saveAs":"result"}
{"type":"if","left":VALUE,"equals":VALUE,"then":[STEPS],"else":[STEPS]}
{"type":"for_each","items":VALUE,"as":"item","steps":[STEPS]}
{"type":"return","status":"completed"|"needs_reasoning","reason":"text"}
VALUE is JSON or exactly {"$ref":"goal.orders"}, {"$ref":"vars.item.orderId"}, {"$ref":"vars.result.order.revision"}, etc. Read-only references support goal, vars, state; state contains public observations. No expressions, indexing functions, assignment, arithmetic, recursion or Javascript. A call stores its public result in vars[saveAs]. for_each iterates its entry-time array; later inspections do not update an already selected item. Return exits the whole procedure, including from inside loops. Branches resolve references only when taken. Test null with equals:null. Programs support at most512 AST nodes and depth8.
Generalize to every requested order and changed identifiers, quantities, revisions and references. Do not hardcode demonstration entities. Use only the provided raw tools. Reconcile unknown effects. Return needs_reasoning when necessary; completed is independently verified, not trusted.`;

function positive(value, name, max) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
function validIdentity(identity) { return emptySkillLibrary({ modelIdentity: identity }).modelIdentity; }
function assertModel(library, modelIdentity) {
  if (hash(library.modelIdentity) !== hash(validIdentity(modelIdentity))) throw new Error('Library model identity mismatch');
}
function taskSignal(signal, timeout) {
  const local = AbortSignal.timeout(timeout);
  return signal ? AbortSignal.any([signal, local]) : local;
}

// Training-only curriculum selection balances hidden fault modes. The learner receives
// public demonstrations, never this selector, test snapshots or evaluation outcomes.
function ambiguousTrainingSeed({ seed, split, family, applied }) {
  for (let offset = 0; offset < 1000; offset++) {
    const candidate = seed + offset;
    const fixture = createSequentialSkillFixture({ seed: candidate, split, family, variant: 'ambiguous' });
    if (fixture.snapshotForTesting().fault.applied === applied) return candidate;
  }
  throw new Error('Could not balance training fault modes');
}

/** Teacher executes public tools only. Native state/verifier never becomes a model input. */
export async function buildSequentialDemonstrations({ family, seed = 40_000 } = {}) {
  if (!Object.hasOwn(descriptions, family)) throw new Error('Unsupported demonstration family');
  const demonstrations = [];
  for (const applied of [true, false]) {
    const caseSeed = ambiguousTrainingSeed({ family, split: 'training', seed, applied });
    const world = createSequentialSkillFixture({ family, variant: 'ambiguous', split: 'training', seed: caseSeed });
    const events = [];
    const call = async (name, args) => {
      const result = await world.execute(name, args);
      events.push({ name, args: clone(args), result: clone(result) });
      return result;
    };
    for (const target of world.goal.orders) {
      let order = (await call('inspect_order', { orderId: target.orderId })).order;
      if (family === 'reserve-order') {
        for (let pass = 0; pass < 2 && order.status !== 'reserved'; pass++) {
          for (const line of order.lines) {
            if (line.reserved) continue;
            const result = await call('reserve_line', { orderId: order.id, sku: line.sku, quantity: line.quantity, expectedRevision: order.revision });
            order = result.ok ? result.order : (await call('inspect_order', { orderId: order.id })).order;
          }
          if (order.lines.every(line => line.reserved)) {
            const result = await call('confirm_order', { orderId: order.id, expectedRevision: order.revision });
            order = result.ok ? result.order : (await call('inspect_order', { orderId: order.id })).order;
          }
        }
      } else {
        let invoice = (await call('inspect_invoice', { orderId: order.id })).invoice;
        for (let attempt = 0; attempt < 2 && invoice === null; attempt++) {
          const result = await call('create_invoice', { orderId: order.id, expectedOrderRevision: order.revision });
          invoice = result.ok ? result.invoice : (await call('inspect_invoice', { orderId: order.id })).invoice;
        }
        for (let attempt = 0; attempt < 2 && invoice.reference !== target.invoiceReference; attempt++) {
          const result = await call('annotate_invoice', { invoiceId: invoice.id, reference: target.invoiceReference, expectedRevision: invoice.revision });
          invoice = result.ok ? result.invoice : (await call('inspect_invoice', { orderId: order.id })).invoice;
        }
      }
    }
    if (!world.verify().pass) throw new Error(`Teacher failed ${world.id}`);
    demonstrations.push({ id: world.id, goal: world.goal, events, teacher: 'deterministic public-tool solver', verified: true });
  }
  return demonstrations;
}

async function validateOnTraining({ program, family, seed, toolNames, signal, onEvent, casePrefix }) {
  const validations = [];
  const cases = [{ variant: 'fresh', seed }, { variant: 'partial', seed: seed + 1 },
    ...[true, false].map(applied => ({ variant: 'ambiguous', seed: ambiguousTrainingSeed({ seed: seed + 2, split: 'training-validation', family, applied }) }))];
  for (const [index, selected] of cases.entries()) {
    const { variant, seed: caseSeed } = selected;
    const world = createSequentialSkillFixture({ seed: caseSeed, split: 'training-validation', family, variant });
    const events = [];
    const programResult = await executeCheckedProcedure(program, { goal: world.goal, getState: () => ({ observations: events }), toolNames,
      maxNodes: 512, maxDepth: 8, maxToolCalls: 64, maxSteps: 256, signal,
      executeTool: async (name, args) => {
        const result = await world.execute(name, args);
        events.push({ name, args: clone(args), result: clone(result) });
        return result;
      }
    });
    const verification = world.verify();
    const row = { fixtureId: world.id, family, variant, seed: caseSeed, split: 'training-validation',
      programResult, verification, events, pass: verification.pass && programResult.status === 'completed' };
    validations.push(row);
    await onEvent({ type: 'training-validation', caseId: `${casePrefix}-${index}-${variant}`, ...row });
  }
  return validations;
}

export async function acquireSequentialSkill({ family, seed, replicate, modelIdentity, library, demonstrations, request, onEvent = async () => {}, signal } = {}) {
  const parent = validateSkillLibrary(library);
  assertModel(parent, modelIdentity);
  if (!Object.hasOwn(descriptions, family)) throw new Error('Invalid skill family');
  const tools = createSequentialSkillFixture({ family, variant: 'fresh', seed, split: 'training' }).tools;
  const toolNames = tools.map(tool => tool.function.name);
  const attempts = [];
  let feedback = null, child = parent;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (signal?.aborted) throw new Error('Experiment aborted');
    const caseId = `replicate-${replicate}-compile-${family}-${attempt}`;
    const row = { attempt, caseId, admitted: false };
    try {
      row.response = await request({ phase: 'compile', caseId, tools: [], signal,
        messages: [{ role: 'system', content: system + '\n' + SEQUENTIAL_PROCEDURE_GUIDE },
          { role: 'user', content: JSON.stringify({ skill: descriptions[family], tools, demonstrations, previousTrainingFeedback: feedback,
            task: 'Learn one procedure from these TRAIN demonstrations. Validation uses other TRAIN worlds. No evaluation results will be supplied.' }) }] });
      const content = row.response.message?.content;
      if (typeof content !== 'string') throw new Error('Compiler returned no JSON text');
      if (row.response.providerResponse?.choices?.[0]?.finish_reason === 'length') throw new Error('Compiler output budget exhausted');
      const program = JSON.parse(content.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1'));
      row.program = validateCheckedProcedure(program, { toolNames, maxNodes: 512, maxDepth: 8 });
      row.validations = await validateOnTraining({ program: row.program, family, seed: seed + 10_000, toolNames, signal, onEvent, casePrefix: caseId });
      if (!row.validations.every(item => item.pass)) {
        // Only TRAIN failures may inform retries. Bound feedback to avoid growing prompts.
        feedback = { kind: 'training-validation-failure', cases: row.validations.filter(item => !item.pass).slice(0, 2).map(item => ({
          variant: item.variant, status: item.programResult.status, error: item.programResult.error ?? null,
          verification: item.verification, lastPublicEvents: item.events.slice(-1)
        })) };
        row.error = 'Procedure failed native TRAIN validation';
      } else {
        child = admitCheckedSkill(parent, { skillId: family, description: descriptions[family], program: row.program, toolNames,
          learningEvidence: { demonstrationsSha256: hash(demonstrations), validationTraceSha256: hash(row.validations),
            validationCases: row.validations.length, passedCases: row.validations.length } });
        row.admitted = true;
        row.entryDigest = child.entries.at(-1).digest;
      }
    } catch (error) {
      row.error = String(error.message ?? error);
      feedback = { kind: 'syntax-or-execution-error', error: row.error };
    }
    attempts.push(row);
    await onEvent({ type: 'acquisition-attempt', family, replicate, ...row });
    if (row.admitted) break;
  }
  return { family, admitted: child.digest !== parent.digest, attempts, library: child,
    demonstrationsSha256: hash(demonstrations), validationFeedbackOnly: true };
}

const skillTool = { type: 'function', function: { name: 'use_learned_skill',
  description: 'Execute an available checked skill over all current goal.orders. It uses the same raw-tool budget. Choose an appropriate skill and its order relative to other work. Inspect returned public observations and recover with raw tools if necessary.',
  parameters: { type: 'object', properties: { skillId: { type: 'string' } }, required: ['skillId'], additionalProperties: false } } };

export async function runSequentialTask({ fixture, request, modelIdentity, library, demonstrations, caseId,
  maxModelCallsPerTask = 24, maxToolCallsPerTask = 64, taskTimeoutMs = 180_000, onEvent = async () => {}, signal } = {}) {
  const saved = validateSkillLibrary(library);
  assertModel(saved, modelIdentity);
  positive(maxModelCallsPerTask, 'model budget', 64);
  positive(maxToolCallsPerTask, 'tool budget', 128);
  positive(taskTimeoutMs, 'task timeout', 3_600_000);
  const boundedSignal = taskSignal(signal, taskTimeoutMs);
  const observations = [], calls = [], invocations = [];
  const toolNames = fixture.tools.map(tool => tool.function.name);
  if (saved.entries.some(entry => entry.toolNames.some(name => !toolNames.includes(name)))) throw new Error('Skill contains a tool outside the current native catalog');
  const started = performance.now();
  let toolCalls = 0, modelCalls = 0, error = null, termination = 'model-call-budget', answer = null;
  const raw = async (name, args, source = 'direct') => {
    if (boundedSignal.aborted) throw new Error('Task deadline or abort');
    if (toolCalls >= maxToolCallsPerTask) throw new Error('Case-wide raw-tool budget exhausted');
    toolCalls++;
    const result = await fixture.execute(name, args);
    const event = { name: name ?? 'unknown_tool', args: clone(args ?? null), result: clone(result), source };
    observations.push(event);
    await onEvent({ type: 'tool', caseId, ...event });
    return result;
  };
  const tools = saved.entries.length ? [...fixture.tools, skillTool] : fixture.tools;
  const catalog = saved.entries.map(entry => ({ skillId: entry.skillId, description: entry.description }));
  const inputIdentity = { goal: fixture.goal, demonstrations, rawTools: fixture.tools, maxModelCallsPerTask, maxToolCallsPerTask, taskTimeoutMs };
  try {
    for (let turn = 0; turn < maxModelCallsPerTask; turn++) {
      if (boundedSignal.aborted) throw new Error('Task deadline or abort');
      modelCalls++;
      const response = await request({ phase: 'execute', caseId: `${caseId}-turn-${turn}`, tools, signal: boundedSignal,
        messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify({
          goal: fixture.goal, demonstrations, learnedSkills: catalog, observations,
          skillReturns: invocations.map(item => ({ skillId: item.skillId, status: item.status, error: item.error })),
          remainingRawToolCalls: maxToolCallsPerTask - toolCalls
        }) }] });
      calls.push(response);
      if (boundedSignal.aborted) throw new Error('Task deadline or abort');
      await onEvent({ type: 'model-response', caseId, turn, response });
      const proposals = response.message?.tool_calls;
      if (!proposals?.length) {
        answer = response.message?.content ?? '';
        termination = response.providerResponse?.choices?.[0]?.finish_reason === 'length' ? 'model-output-budget' : 'model-finished';
        break;
      }
      for (const proposal of proposals) {
        let args;
        try { args = JSON.parse(proposal.function?.arguments ?? ''); } catch { args = null; }
        const name = proposal.function?.name;
        if (name !== 'use_learned_skill') { await raw(name, args); continue; }
        const entry = args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length === 1
          ? saved.entries.find(item => item.skillId === args.skillId) : null;
        if (!entry) {
          const failed = { skillId: args?.skillId ?? null, status: 'unavailable', error: 'Unknown skill or invalid arguments', rawToolCalls: 0 };
          invocations.push(failed);
          await onEvent({ type: 'skill-invocation', caseId, ...failed });
          continue;
        }
        if (toolCalls >= maxToolCallsPerTask) throw new Error('Case-wide raw-tool budget exhausted');
        const before = toolCalls;
        const executed = await executeCheckedProcedure(entry.program, {
          goal: fixture.goal, getState: () => ({ observations }), toolNames: entry.toolNames,
          maxNodes: 512, maxDepth: 8, maxSteps: 256, maxToolCalls: maxToolCallsPerTask - toolCalls,
          executeTool: (tool, arguments_) => raw(tool, arguments_, `skill:${entry.skillId}`), signal: boundedSignal
        });
        const invocation = { skillId: entry.skillId, programSha256: entry.programSha256,
          status: executed.status, error: executed.error ?? null, rawToolCalls: toolCalls - before };
        invocations.push(invocation);
        await onEvent({ type: 'skill-invocation', caseId, ...invocation });
      }
    }
  } catch (caught) {
    error = String(caught.message ?? caught);
    termination = boundedSignal.aborted ? 'deadline-or-abort' : 'execution-error';
  }
  const verification = fixture.verify();
  const result = { caseId, fixtureId: fixture.id, libraryDigest: saved.digest, inputSha256: hash(inputIdentity),
    pass: verification.pass && termination === 'model-finished' && error === null && !boundedSignal.aborted, verification, termination, error,
    modelCalls, toolCalls, directToolCalls: observations.filter(item => item.source === 'direct').length,
    skillInvocations: invocations, observations, observationsSha256: hash(observations), calls, answer,
    wallMilliseconds: Math.round(performance.now() - started) };
  await onEvent({ type: 'case-result', ...result });
  return result;
}

export async function runSequentialSkillStage({ stage, replicate, seed = 20260913, modelIdentity, request,
  onEvent = async () => {}, prior = null, signal, maxModelCallsPerTask = 24, maxToolCallsPerTask = 64, taskTimeoutMs = 180_000 } = {}) {
  if (!['A', 'B'].includes(stage) || !Number.isSafeInteger(replicate) || replicate < 0 || replicate > 2) throw new Error('Invalid stage or replicate');
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 2_000_000_000) throw new Error('Invalid seed');
  if (typeof request !== 'function') throw new Error('request required');
  const startedAt = new Date().toISOString();
  const identity = validIdentity(modelIdentity);
  const empty = emptySkillLibrary({ modelIdentity: identity });
  const budgets = { maxModelCallsPerTask, maxToolCallsPerTask, taskTimeoutMs };
  Object.entries(budgets).forEach(([name, value]) => positive(value, name, name === 'taskTimeoutMs' ? 3_600_000 : name === 'maxToolCallsPerTask' ? 128 : 64));
  let parent = empty;
  if (stage === 'B') {
    if (!prior || prior.stage !== 'A' || prior.replicate !== replicate || prior.seed !== seed || !Number.isSafeInteger(prior.processId) || prior.processId <= 0 || prior.processId === process.pid || hash(prior.budgets) !== hash(budgets)) throw new Error('Stage B requires matching stage A from a separate process with the same budgets');
    parent = validateSkillLibrary(prior.library);
    assertModel(parent, identity);
  } else if (prior !== null) throw new Error('Stage A does not accept a prior report');
  const demonstrations = {
    A: await buildSequentialDemonstrations({ family: 'reserve-order', seed: 40_000 + replicate * 100 }),
    B: await buildSequentialDemonstrations({ family: 'invoice-order', seed: 50_000 + replicate * 100 })
  };
  if (prior && hash(prior.demonstrations.A) !== hash(demonstrations.A)) throw new Error('Retention demonstrations changed');
  if (prior) {
    if (!Array.isArray(prior.results) || prior.results.length !== 6) throw new Error('Prior A report must contain its six paired outcomes');
    for (const [index, variant] of SEQUENTIAL_SKILL_VARIANTS['reserve-order'].entries()) {
      const fixture = createSequentialSkillFixture({ family: 'reserve-order', variant, split: 'evaluation', seed: seed + replicate * 100 + index });
      const expectedInput = hash({ goal: fixture.goal, demonstrations: demonstrations.A, rawTools: fixture.tools, ...budgets });
      for (const arm of ['baseline', 'learned']) {
        const rows = prior.results.filter(row => row.family === 'reserve-order' && row.variant === variant && row.arm === arm);
        if (rows.length !== 1 || rows[0].inputSha256 !== expectedInput) throw new Error('A retention/baseline inputs changed');
      }
    }
  }
  await onEvent({ type: 'stage-start', stage, replicate, seed, modelIdentity: identity, processId: process.pid, budgets });
  const family = stage === 'A' ? 'reserve-order' : 'invoice-order';
  const acquisition = await acquireSequentialSkill({ family, seed: 60_000 + replicate * 100 + (stage === 'B' ? 1_000 : 0),
    replicate, modelIdentity: identity, library: parent, demonstrations: demonstrations[stage], request, onEvent, signal });
  const library = acquisition.library;
  const results = [];
  const groups = stage === 'A' ? ['reserve-order'] : ['reserve-order', 'invoice-order', 'compose'];
  for (const group of groups) {
    for (const [index, variant] of SEQUENTIAL_SKILL_VARIANTS[group].entries()) {
      const caseSeed = seed + replicate * 100 + index;
      const arms = stage === 'B' && group === 'reserve-order' ? ['learned'] : (index + replicate) % 2 ? ['learned', 'baseline'] : ['baseline', 'learned'];
      for (const arm of arms) {
        if (signal?.aborted) throw new Error('Experiment aborted');
        const fixture = createSequentialSkillFixture({ family: group, variant, split: 'evaluation', seed: caseSeed });
        const caseId = `r${replicate}-${stage}-${group}-${variant}-${arm}`;
        await onEvent({ type: 'case-start', caseId, replicate, stage, family: group, variant, seed: caseSeed, arm });
        const row = await runSequentialTask({ fixture, request, modelIdentity: identity,
          library: arm === 'baseline' ? empty : library,
          demonstrations: group === 'reserve-order' ? demonstrations.A : group === 'invoice-order' ? demonstrations.B : [...demonstrations.A, ...demonstrations.B],
          caseId, ...budgets, onEvent, signal });
        Object.assign(row, { stage, replicate, family: group, variant, seed: caseSeed, split: 'evaluation', arm });
        if (prior && group === 'reserve-order') {
          const before = prior.results.find(item => item.family === group && item.variant === variant && item.arm === 'learned');
          const baseline = prior.results.find(item => item.family === group && item.variant === variant && item.arm === 'baseline');
          if (!before || !baseline || before.inputSha256 !== row.inputSha256 || baseline.inputSha256 !== row.inputSha256) throw new Error('A retention/baseline inputs changed');
          row.retention = { beforePass: before.pass, afterPass: row.pass, baselinePass: baseline.pass,
            baselineCaseId: baseline.caseId, beforeCaseId: before.caseId, reusedBaseline: true, repeatedCase: true };
        }
        results.push(row);
      }
    }
  }
  const aBefore = parent.entries.find(entry => entry.skillId === 'reserve-order');
  const aAfter = library.entries.find(entry => entry.skillId === 'reserve-order');
  if (aBefore && aBefore.digest !== aAfter?.digest) throw new Error('A skill changed while learning B');
  const report = { schema: 'amos.sequential-skill-learning.v1', stage, replicate, seed, modelIdentity: identity,
    processId: process.pid, priorProcessId: prior?.processId ?? null, budgets, startedAt, completedAt: new Date().toISOString(),
    library, acquisition, demonstrations, results, parentLibraryDigest: parent.digest,
    retention: stage === 'B' ? { separateProcess: prior.processId !== process.pid, aAcquired: Boolean(aBefore),
      aArtifactPreserved: Boolean(aBefore && aBefore.digest === aAfter?.digest), rows: results.filter(row => row.retention).map(row => ({ caseId: row.caseId, ...row.retention })) } : null,
    weightsChanged: false, neuralRecurrenceTested: false,
    scope: 'Exploratory skill induction/persistence/selection experiment on a frozen model; three induction replicates with correlated cases and repeated A measurements. Not a model promotion or neural forgetting test.' };
  await onEvent({ type: 'stage-complete', stage, replicate, libraryDigest: library.digest, admitted: acquisition.admitted });
  return report;
}
