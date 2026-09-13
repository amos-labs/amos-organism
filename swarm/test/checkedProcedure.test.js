import assert from "node:assert/strict";
import test from "node:test";
import { executeCheckedProcedure, validateCheckedProcedure } from "../src/checkedProcedure.js";

const program = steps => ({ schema: "amos.checked-procedure.v1", steps });
const ref = path => ({ $ref: path });
const call = (tool = "write", args = {}, saveAs = "response") => ({ type: "call", tool, args, saveAs });
const done = { type: "return", status: "completed" };
const reasoning = { type: "return", status: "needs_reasoning", reason: "Outcome requires reconciliation" };
const options = overrides => ({ goal: {}, getState: () => ({}), executeTool: async () => ({ ok: true }),
  toolNames: ["write", "read", "reconcile"], ...overrides });

test("validates every nested branch before any write or state access", async () => {
  let effects = 0;
  for (const invalid of [call("unknown"), { ...done, hidden: true }, { type: "eval", code: "write()" },
    { ...call(), args: { x: { $ref: "state.id", fallback: 3 } } }]) {
    const input = program([call(), { type: "if", left: true, equals: true, then: [done], else: [invalid] }]);
    const result = await executeCheckedProcedure(input, options({
      getState: () => { effects += 1; return {}; }, executeTool: () => { effects += 1; return {}; }
    }));
    assert.equal(result.status, "error");
    assert.equal(result.toolCalls, 0);
    assert.equal(result.stepsExecuted, 0);
  }
  assert.equal(effects, 0);
});

test("rejects malicious references, unsafe keys, non-JSON objects and getters without invoking them", () => {
  for (const path of ["goal.__proto__.x", "vars.constructor.name", "state.prototype", "process.env", "goal.sites[0]", "goal..id"]) {
    assert.throws(() => validateCheckedProcedure(program([call("write", ref(path))]), options()), /reference/);
  }
  for (const args of [JSON.parse('{"__proto__":{"polluted":true}}'), { constructor: 1 },
    Object.create({ id: 1 }), { value: undefined }, { value: NaN }, { value: () => 1 }]) {
    assert.throws(() => validateCheckedProcedure(program([call("write", args)]), options()));
  }
  let invoked = false;
  const args = { get id() { invoked = true; return 1; } };
  assert.throws(() => validateCheckedProcedure(program([call("write", args)]), options()), /data property/);
  assert.equal(invoked, false);
  assert.equal({}.polluted, undefined);
});

test("bounds AST nodes, control nesting, value nesting and cycles", () => {
  assert.throws(() => validateCheckedProcedure(program([done, done]), { toolNames: [], maxNodes: 1 }), /maxNodes/);
  const nested = { type: "if", left: 1, equals: 1, then: [done] };
  assert.throws(() => validateCheckedProcedure(program([nested]), { toolNames: [], maxDepth: 1 }), /maxDepth/);
  assert.throws(() => validateCheckedProcedure(program([call("write", { a: { b: { c: 1 } } })]),
    { toolNames: ["write"], maxDepth: 1 }), /depth/);
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => validateCheckedProcedure(program([call("write", cyclic)]), options()), /cycle/);
});

test("execution preserves default validation caps and honors explicit node and depth limits", async () => {
  const wide = program([{ type: "if", left: false, equals: true,
    then: Array.from({ length: 130 }, () => ({ ...done })), else: [done] }]);
  const defaultWidth = await executeCheckedProcedure(wide, options());
  assert.equal(defaultWidth.status, "error");
  assert.match(defaultWidth.error, /maxNodes/);
  assert.equal(defaultWidth.stepsExecuted, 0);
  const expandedWidth = await executeCheckedProcedure(wide, options({ maxNodes: 512 }));
  assert.equal(expandedWidth.status, "completed");
  assert.equal(expandedWidth.stepsExecuted, 2);

  let nested = [done];
  for (let depth = 0; depth < 9; depth += 1) nested = [{ type: "if", left: true, equals: true, then: nested }];
  const defaultDepth = await executeCheckedProcedure(program(nested), options());
  assert.equal(defaultDepth.status, "error");
  assert.match(defaultDepth.error, /maxDepth/);
  assert.equal(defaultDepth.stepsExecuted, 0);
  const expandedDepth = await executeCheckedProcedure(program(nested), options({ maxDepth: 12 }));
  assert.equal(expandedDepth.status, "completed");
  assert.equal(expandedDepth.stepsExecuted, 10);
});

test("returns a detached validated program and rejects omitted or unexpected fields", () => {
  const input = program([call("write", { x: 1 }), done]);
  const checked = validateCheckedProcedure(input, options());
  input.steps[0].args.x = 2;
  assert.equal(checked.steps[0].args.x, 1);
  for (const step of [{ type: "call", tool: "write", args: {} }, { ...done, status: "success" },
    { ...done, reason: 1 }, { type: "for_each", items: [], as: "constructor", steps: [] }]) {
    assert.throws(() => validateCheckedProcedure(program([step]), options()));
  }
});

test("loops over public goal data, binds variables and returns an explicit completion", async () => {
  const input = program([{ type: "for_each", items: ref("goal.sites"), as: "site", steps: [
    call("write", { id: ref("vars.site.id"), tags: ["checked", ref("goal.tag")] }, "written")
  ] }, done]);
  const calls = [];
  const result = await executeCheckedProcedure(input, options({ goal: { sites: [{ id: "a" }, { id: "b" }], tag: "ready" },
    executeTool: async (tool, args) => { calls.push({ tool, args }); return { ok: true, id: args.id }; } }));
  assert.equal(result.status, "completed");
  assert.equal(result.toolCalls, 2);
  assert.equal(result.stepsExecuted, 6);
  assert.deepEqual(calls.map(item => item.args), [{ id: "a", tags: ["checked", "ready"] }, { id: "b", tags: ["checked", "ready"] }]);
  assert.deepEqual(result.variables.written, { ok: true, id: "b" });
});

test("empty loop bodies consume steps and cannot exhaustively visit oversized inputs", async () => {
  const input = program([{ type: "for_each", items: ref("goal.items"), as: "item", steps: [] }, done]);
  const result = await executeCheckedProcedure(input, options({ goal: { items: Array.from({ length: 1000 }, (_, i) => i) }, maxSteps: 5 }));
  assert.equal(result.status, "budget_exhausted");
  assert.equal(result.stepsExecuted, 5);
  assert.equal(result.toolCalls, 0);
  assert.equal(result.trace.filter(entry => entry.type === "iteration").length, 4);
});

test("returned tool errors are data and consume the tool budget without blind retries", async () => {
  let calls = 0;
  const input = program([call(), { type: "if", left: ref("vars.response.ok"), equals: false,
    then: [call("reconcile")], else: [done] }, done]);
  const result = await executeCheckedProcedure(input, options({ maxToolCalls: 1,
    executeTool: async () => { calls += 1; return { ok: false, error: "conflict" }; } }));
  assert.equal(result.status, "budget_exhausted");
  assert.equal(calls, 1);
  assert.equal(result.toolCalls, 1);
  assert.deepEqual(result.variables.response, { ok: false, error: "conflict" });
});

test("recognized public failures can follow an explicit reconciliation branch", async () => {
  const input = program([call(), { type: "if", left: ref("vars.response.code"), equals: "conflict", then: [
    call("reconcile", { id: ref("vars.response.id") }, "reconciled"), done
  ], else: [reasoning] }]);
  const result = await executeCheckedProcedure(input, options({ executeTool: async tool =>
    tool === "write" ? { ok: false, code: "conflict", id: "existing-1" } : { ok: true } }));
  assert.equal(result.status, "completed");
  assert.deepEqual(result.trace.filter(entry => entry.type === "call").map(entry => entry.tool), ["write", "reconcile"]);
  assert.deepEqual(result.variables.response, { ok: false, code: "conflict", id: "existing-1" });
});

test("unknown outcomes and AST fallthrough never gain automatic success", async () => {
  const input = program([call(), { type: "if", left: ref("vars.response.code"), equals: "known", then: [done], else: [reasoning] }]);
  const result = await executeCheckedProcedure(input, options({ executeTool: async () => ({ ok: false, code: "new-fault" }) }));
  assert.equal(result.status, "needs_reasoning");
  assert.equal(result.trace.at(-1).reason, reasoning.reason);
  const fallthrough = await executeCheckedProcedure(program([call()]), options());
  assert.equal(fallthrough.status, "needs_reasoning");
  assert.equal(fallthrough.toolCalls, 1);
});

test("missing references stop before the dependent call and cannot traverse inherited properties", async () => {
  let calls = 0;
  const result = await executeCheckedProcedure(program([call("write", { id: ref("goal.missing.id") }), done]), options({
    executeTool: async () => { calls += 1; return {}; }
  }));
  assert.equal(result.status, "needs_reasoning");
  assert.match(result.error, /Missing/);
  assert.equal(calls, 0);
  const inherited = await executeCheckedProcedure(program([call("write", ref("goal.hidden"))]),
    options({ goal: Object.create({ hidden: 1 }) }));
  assert.equal(inherited.status, "needs_reasoning");
});

test("state references read the latest injected state after calls and once within a step", async () => {
  let state = { count: 0 };
  let reads = 0;
  const input = program([call("write", { count: ref("state.count"), again: ref("state.count") }),
    { type: "if", left: ref("state.count"), equals: 1, then: [done], else: [reasoning] }]);
  const result = await executeCheckedProcedure(input, options({
    getState: async () => { reads += 1; return state; },
    executeTool: async (_tool, args) => { assert.deepEqual(args, { count: 0, again: 0 }); state = { count: 1 }; return { ok: true }; }
  }));
  assert.equal(result.status, "completed");
  assert.equal(reads, 2);
});

test("a thrown tool fault preserves its attempted call, earlier writes and public trace", async () => {
  const writes = [];
  const result = await executeCheckedProcedure(program([call("write", { id: 1 }, "first"),
    call("write", { id: 2 }, "second"), call("write", { id: 3 }), done]), options({
    executeTool: async (_tool, args) => { writes.push(args.id); if (args.id === 2) throw new Error("acknowledgment lost"); return { ok: true }; }
  }));
  assert.equal(result.status, "needs_reasoning");
  assert.equal(result.toolCalls, 2);
  assert.deepEqual(writes, [1, 2]);
  assert.deepEqual(result.variables.first, { ok: true });
  assert.equal(Object.hasOwn(result.variables, "second"), false);
  assert.match(result.trace.filter(entry => entry.type === "call")[1].error, /acknowledgment lost/);
});

test("abort before execution or after a tool stops subsequent effects and retains returned data", async () => {
  const already = new AbortController(); already.abort();
  const first = await executeCheckedProcedure(program([call(), done]), options({ signal: already.signal }));
  assert.equal(first.status, "needs_reasoning");
  assert.equal(first.toolCalls, 0);
  const controller = new AbortController();
  const result = await executeCheckedProcedure(program([call(), call(), done]), options({ signal: controller.signal,
    executeTool: async () => { controller.abort(); return { ok: true }; }
  }));
  assert.equal(result.status, "needs_reasoning");
  assert.equal(result.toolCalls, 1);
  assert.deepEqual(result.variables.response, { ok: true });
});

test("state faults and invalid public tool results stop without subsequent calls", async () => {
  let calls = 0;
  const stateFailure = await executeCheckedProcedure(program([call("write", ref("state.id")), done]), options({
    getState: async () => { throw new Error("state unavailable"); },
    executeTool: async () => { calls += 1; return {}; }
  }));
  assert.equal(stateFailure.status, "needs_reasoning");
  assert.match(stateFailure.error, /state unavailable/);
  assert.equal(calls, 0);
  const invalidResult = await executeCheckedProcedure(program([call(), call(), done]), options({
    executeTool: async () => { calls += 1; return undefined; }
  }));
  assert.equal(invalidResult.status, "needs_reasoning");
  assert.equal(invalidResult.toolCalls, 1);
  assert.equal(calls, 1);
  assert.match(invalidResult.trace[0].error, /JSON/);
});

test("zero budgets prevent effects and tool mutation cannot change validated instructions or the trace", async () => {
  for (const budget of [{ maxSteps: 0 }, { maxToolCalls: 0 }]) {
    const result = await executeCheckedProcedure(program([call(), done]), options(budget));
    assert.equal(result.status, "budget_exhausted");
    assert.equal(result.toolCalls, 0);
  }
  const input = program([call("write", { id: "original" }), done]);
  const result = await executeCheckedProcedure(input, options({ executeTool: async (_tool, args) => {
    args.id = "mutated"; input.steps[1].status = "needs_reasoning"; return { ok: true };
  } }));
  assert.equal(result.status, "completed");
  assert.equal(result.trace[0].args.id, "original");
});
