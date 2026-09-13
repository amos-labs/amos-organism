import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { createStateSkillFixture, STATE_SKILL_VARIANTS } from '../evals/stateSkillFixture.js';
import { validateCheckedProcedure, executeCheckedProcedure } from './checkedProcedure.js';
import { formatObservedContext } from './observedTaskState.js';

export const STATE_SKILL_ARMS = Object.freeze([
  { id: 'A', state: 'history', skill: false },
  { id: 'B', state: 'typed', skill: false },
  { id: 'C', state: 'history', skill: true },
  { id: 'D', state: 'typed', skill: true },
]);

export const PROCEDURE_GUIDE = `Return JSON only: {"schema":"amos.checked-procedure.v1","steps":[...]}. No Javascript.
Steps:
{"type":"call","tool":"name","args":{...},"saveAs":"result"}
{"type":"if","left":VALUE,"equals":VALUE,"then":[STEPS],"else":[STEPS]}
{"type":"for_each","items":VALUE,"as":"item","steps":[STEPS]}
{"type":"return","status":"completed"|"needs_reasoning","reason":"text"}
VALUE is JSON or exactly {"$ref":"goal.sites"}, {"$ref":"vars.item.slug"}, {"$ref":"vars.result.site.id"}, etc.
References are read-only lookups under goal, vars, or state. state is the supplied public observation view, refreshed after each tool.
Use only provided tools. A call's public result is stored at vars[saveAs]. Null is a literal; testing whether an entity exists is an if with equals:null. Resolve references only in branches where they exist.
Reuse the program for changed goals; do not hardcode demonstration names, ids or headlines. Inspect before deciding. Failed/unknown effects require reconciliation, not an assumed success. Return needs_reasoning when the program cannot establish the next step. A completed return is independently graded against the sandbox, not trusted as proof.`;

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
const initialEvents = (fixture) => fixture.initialObservations.map(({ tool, ...event }) => ({ ...event, name: event.name ?? tool }));
const system = `You operate an isolated synthetic business workflow. Complete the supplied goal using the provided tools. The goal, tool contracts and public observations are all the evidence available. Do not invent successful effects. Reconcile unknown outcomes before retrying. Never publish. Use tools directly for work you can perform. Stop when the requested outcome is supported by observations. All demonstrations are development examples, not the current task.`;

function positive(value, name, max) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`invalid ${name}`);
  return value;
}

/** A deterministic teacher generates development demonstrations, supplied identically to all arms. */
export async function buildStateSkillDemonstrations({ seed = 10_000 } = {}) {
  const demonstrations = [];
  for (const [index, variant] of ['fresh', 'timeout-applied', 'timeout-unapplied'].entries()) {
    const fixture = createStateSkillFixture({ seed: seed + index, split: 'development', variant });
    const events = clone(initialEvents(fixture));
    const call = async (name, args) => {
      const result = await fixture.execute(name, args);
      events.push({ name, args: clone(args), result: clone(result) });
      return result;
    };
    for (const target of fixture.goal.sites) {
      let collection = (await call('inspect_collection', { name: target.collectionName })).collection;
      if (!collection) collection = (await call('create_collection', { name: target.collectionName })).collection;
      let site = (await call('inspect_site', { slug: target.slug })).site;
      if (!site) site = (await call('create_site', { slug: target.slug })).site;
      const args = () => ({ siteId: site.id, expectedRevision: site.revision, headline: target.headline, theme: target.theme, collectionId: collection.id });
      const result = await call('update_site', args());
      if (!result.ok) {
        site = (await call('inspect_site', { slug: target.slug })).site;
        if (site.headline !== target.headline || site.theme !== target.theme || site.collectionId !== collection.id) await call('update_site', args());
      }
    }
    const verification = fixture.verify();
    if (verification.pass !== true && verification.verdict !== 'pass') throw new Error(`Development teacher failed: ${fixture.id}`);
    demonstrations.push({ id: fixture.id, goal: clone(fixture.goal), events, teacher: 'deterministic sandbox solver', verified: true });
  }
  return demonstrations;
}

function parseProgram(content) {
  if (typeof content !== 'string') throw new Error('Compiler did not return text');
  const text = content.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1');
  return JSON.parse(text);
}

/** request({messages, tools, phase, caseId, signal}) must record all transport attempts and usage. */
export async function runStateSkillExperiment({
  request, modelIdentity, seed = 20260913, variants = STATE_SKILL_VARIANTS,
  repetitions = 1, maxModelCallsPerTask = 16, maxToolCallsPerTask = 32,
  taskTimeoutMs = 180_000, onEvent = async () => {}, signal,
} = {}) {
  if (typeof request !== 'function') throw new Error('request callback required');
  if (!modelIdentity?.model || !/^[a-f0-9]{64}$/.test(modelIdentity?.weightsSha256 ?? '')) throw new Error('Exact model and weights identity required');
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 2_147_470_000) throw new Error('invalid seed');
  positive(repetitions, 'repetitions', 16);
  positive(maxModelCallsPerTask, 'model calls', 64);
  positive(maxToolCallsPerTask, 'tool calls', 128);
  positive(taskTimeoutMs, 'task timeout', 3_600_000);
  if (!Array.isArray(variants) || !variants.length || new Set(variants).size !== variants.length || variants.some((variant) => !STATE_SKILL_VARIANTS.includes(variant))) throw new Error('invalid variants');
  const startedAt = new Date().toISOString();
  const demonstrations = await buildStateSkillDemonstrations();
  const fixture = createStateSkillFixture({ seed, split: 'development', variant: variants[0] });
  const toolNames = fixture.tools.map((tool) => tool.function.name);
  const identity = { schema: 'amos.state-skill-ablation.v1', modelIdentity, seed, variants, repetitions, maxModelCallsPerTask, maxToolCallsPerTask, taskTimeoutMs, demonstrationsSha256: hash(demonstrations), arms: STATE_SKILL_ARMS };
  await onEvent({ type: 'experiment-start', startedAt, identity });
  const compiled = {};
  const compilation = [];
  const armRequestBudget = maxModelCallsPerTask * repetitions * variants.length;
  const armRequests = Object.fromEntries(STATE_SKILL_ARMS.map((arm) => [arm.id, 0]));
  const boundedRequest = async (arm, args, onDispatch = () => {}) => {
    if (armRequests[arm.id] >= armRequestBudget) throw new Error('Arm model-request budget exhausted (including compilation)');
    await onEvent({ type: 'model-request-start', arm: arm.id, ordinal: armRequests[arm.id] + 1, phase: args.phase, caseId: args.caseId });
    armRequests[arm.id]++;
    onDispatch();
    return request(args);
  };
  for (const arm of STATE_SKILL_ARMS.filter((item) => item.skill)) {
    let error = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (signal?.aborted) throw new Error('Experiment aborted');
      const entry = { arm: arm.id, attempt, valid: false, dispatched: false };
      try {
        const response = await boundedRequest(arm, { phase: 'compile', caseId: `compile-${arm.id}-${attempt}`, tools: [], signal,
          messages: [{ role: 'system', content: system + '\n' + PROCEDURE_GUIDE }, { role: 'user', content: JSON.stringify({ task: 'Induce one reusable procedure from these development demonstrations. The procedure will be frozen before fresh evaluation; no evaluation feedback is supplied.', tools: fixture.tools, demonstrations, stateViewExample: formatObservedContext(demonstrations[0].events, arm.state), previousSyntaxError: error }) }] }, () => { entry.dispatched = true; });
        entry.response = response;
        const program = parseProgram(response.message?.content);
        compiled[arm.id] = validateCheckedProcedure(program, { toolNames, maxNodes: 512 });
        entry.valid = true;
        entry.programSha256 = hash(compiled[arm.id]);
        entry.program = compiled[arm.id];
      } catch (caught) {
        error = String(caught.message ?? caught);
        entry.error = error;
      }
      compilation.push(entry);
      await onEvent({ type: 'compilation', ...entry });
      if (entry.valid) break;
    }
  }

  const results = [];
  const order = [];
  // Rotate the arm order across paired cases, with fresh private fixtures each time.
  for (let repetition = 0; repetition < repetitions; repetition++) {
    for (const [index, variant] of variants.entries()) {
      const offset = (index + repetition) % STATE_SKILL_ARMS.length;
      const arms = [...STATE_SKILL_ARMS.slice(offset), ...STATE_SKILL_ARMS.slice(0, offset)];
      for (const arm of arms) {
        if (signal?.aborted) throw new Error('Experiment aborted');
        const caseSeed = seed + repetition * variants.length + index;
        const world = createStateSkillFixture({ seed: caseSeed, split: 'evaluation', variant });
        const caseId = `${world.id}-${arm.id}`;
        order.push(caseId);
        await onEvent({ type: 'case-start', caseId, arm: arm.id, variant, repetition });
        const localSignal = AbortSignal.timeout(taskTimeoutMs);
        const caseSignal = signal ? AbortSignal.any([signal, localSignal]) : localSignal;
        const started = performance.now();
        const events = clone(initialEvents(world));
        const calls = [];
        let modelAttempts = 0;
        let toolCalls = 0;
        let answer = null;
        let programResult = null;
        let error = null;
        let termination = 'model-call-budget';
        const invokeTool = async (name, args) => {
          if (caseSignal.aborted) throw new Error('Task deadline or abort');
          if (toolCalls >= maxToolCallsPerTask) throw new Error('Task tool budget exhausted');
          toolCalls++;
          const result = await world.execute(name, args);
          const event = { name: typeof name === 'string' ? name : 'unknown_tool', args: clone(args && typeof args === 'object' && !Array.isArray(args) ? args : { invalidArguments: args ?? null }), result: clone(result) };
          events.push(event);
          await onEvent({ type: 'tool', caseId, ...event });
          return result;
        };
        try {
          if (arm.skill) {
            if (!compiled[arm.id]) {
              termination = 'compilation-failed';
            } else {
              programResult = await executeCheckedProcedure(compiled[arm.id], { goal: world.goal, getState: () => formatObservedContext(events, arm.state), executeTool: invokeTool, toolNames, maxNodes: 512, maxToolCalls: maxToolCallsPerTask, maxSteps: 128, signal: caseSignal });
              if (programResult.status === 'completed') termination = 'program-completed';
              else termination = 'program-returned-to-model';
            }
          }
          if (!arm.skill || (compiled[arm.id] && programResult?.status !== 'completed')) {
            for (let turn = 0; turn < maxModelCallsPerTask; turn++) {
              if (caseSignal.aborted) throw new Error('Task deadline or abort');
              if (toolCalls >= maxToolCallsPerTask) { termination = 'tool-budget'; break; }
              const response = await boundedRequest(arm, { phase: 'execute', caseId: `${caseId}-turn-${turn}`, tools: world.tools, signal: caseSignal,
                messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify({ goal: world.goal, demonstrations, observations: formatObservedContext(events, arm.state), ...(programResult ? { procedureReturn: { status: programResult.status, error: programResult.error ?? null, variables: programResult.variables } } : {}) }) }] }, () => { modelAttempts++; });
              calls.push(response);
              await onEvent({ type: 'model-response', caseId, turn, response });
              const toolRequests = response.message?.tool_calls;
              if (!toolRequests?.length) { answer = response.message?.content ?? ''; termination = 'model-finished'; break; }
              for (const tool of toolRequests) {
                let args;
                try { args = JSON.parse(tool.function?.arguments ?? ''); }
                catch {
                  // The native sandbox records the proposal and rejects null arguments
                  // before effects. Forbidden proposals still count even when malformed.
                  await invokeTool(tool.function?.name, {});
                  continue;
                }
                await invokeTool(tool.function?.name, args);
              }
            }
          }
        } catch (caught) {
          error = String(caught.message ?? caught);
          termination = caseSignal.aborted ? 'deadline-or-abort' : 'execution-error';
        }
        const verification = world.verify();
        const result = { caseId, fixtureId: world.id, seed: caseSeed, repetition, variant, arm: arm.id, state: arm.state, skill: arm.skill,
          pass: (verification.pass === true || verification.verdict === 'pass') && termination !== 'compilation-failed' && error === null,
          verification, termination, error, modelCalls: modelAttempts, modelResponses: calls.length, toolCalls, wallMilliseconds: Math.round(performance.now() - started), answer, programResult, observationsSha256: hash(events), calls };
        results.push(result);
        await onEvent({ type: 'case-result', ...result });
      }
    }
  }
  const byArm = Object.fromEntries(STATE_SKILL_ARMS.map((arm) => {
    const rows = results.filter((row) => row.arm === arm.id);
    return [arm.id, { passed: rows.filter((row) => row.pass).length, total: rows.length, modelCalls: rows.reduce((sum, row) => sum + row.modelCalls, 0), toolCalls: rows.reduce((sum, row) => sum + row.toolCalls, 0), executionWallMilliseconds: rows.reduce((sum, row) => sum + row.wallMilliseconds, 0), compilationRequests: compilation.filter((row) => row.arm === arm.id && row.dispatched).length, totalModelRequests: armRequests[arm.id], modelRequestBudget: armRequestBudget }];
  }));
  const report = { ...identity, startedAt, completedAt: new Date().toISOString(), scope: 'Exploratory synthetic state/skill ablation; not a model promotion, weight-learning result, neural-recurrence test or sealed qualification', teacher: { kind: 'deterministic sandbox solver', demonstrations: demonstrations.length, sharedAcrossAllArms: true }, compilation, results, byArm, order, weightsChanged: false, neuralRecurrenceTested: false, actualGpuTimeMeasured: false, fullResourceAccounting: 'Report transport attempts and available token usage alongside compilation and execution; wall time is not GPU time.' };
  await onEvent({ type: 'experiment-complete', byArm });
  return report;
}
