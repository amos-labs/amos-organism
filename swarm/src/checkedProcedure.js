import { isDeepStrictEqual } from "node:util";

const SCHEMA = "amos.checked-procedure.v1";
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PATH_PART = /^(?:[A-Za-z_][A-Za-z0-9_-]*|0|[1-9][0-9]*)$/;

function limit(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function record(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${path} must be a plain JSON object`);
  }
  const entries = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(entries).some(key => typeof key !== "string")) {
    throw new Error(`${path} must not contain symbol keys`);
  }
  for (const [key, descriptor] of Object.entries(entries)) {
    if (UNSAFE_KEYS.has(key)) throw new Error(`${path} contains unsafe key ${key}`);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new Error(`${path}.${key} must be a JSON data property`);
    }
  }
  return Object.fromEntries(Object.entries(entries).map(([key, descriptor]) => [key, descriptor.value]));
}

function fields(value, path, required, optional = []) {
  const result = record(value, path);
  for (const name of required) {
    if (!Object.hasOwn(result, name)) throw new Error(`${path}.${name} is required`);
  }
  for (const name of Object.keys(result)) {
    if (![...required, ...optional].includes(name)) throw new Error(`${path}.${name} is unknown`);
  }
  return result;
}

function array(value, path) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${path} must be a JSON array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) {
    throw new Error(`${path} must be a dense JSON array without extra properties`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new Error(`${path}[${index}] must be a JSON data property`);
    }
  }
  return value;
}

function variable(value, path) {
  if (typeof value !== "string" || !VARIABLE.test(value) || UNSAFE_KEYS.has(value)) {
    throw new Error(`${path} must be a safe variable name`);
  }
  return value;
}

function reference(value, path) {
  if (typeof value !== "string") throw new Error(`${path} must be a reference string`);
  const parts = value.split(".");
  if (!["goal", "vars", "state"].includes(parts[0]) ||
      parts.some(part => !PATH_PART.test(part) || UNSAFE_KEYS.has(part))) {
    throw new Error(`${path} contains an invalid or unsafe reference`);
  }
  return parts;
}

function toolsAllowed(toolNames) {
  if (!Array.isArray(toolNames) && !(toolNames instanceof Set)) {
    throw new Error("toolNames must be an array or Set of tool names");
  }
  const names = [...toolNames];
  if (names.some(name => typeof name !== "string" || !name.trim() || UNSAFE_KEYS.has(name))) {
    throw new Error("toolNames contains an invalid tool name");
  }
  return new Set(names);
}

function jsonCopy(value, { path = "value", maxDepth = 64, visit = () => {}, refs = false } = {}) {
  const ancestors = new Set();
  function copy(item, at, depth) {
    visit();
    if (depth > maxDepth) throw new Error(`${at} exceeds JSON maximum depth`);
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object") throw new Error(`${at} is not a JSON value`);
    if (ancestors.has(item)) throw new Error(`${at} contains a cycle`);
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        return array(item, at).map((child, index) => copy(child, `${at}[${index}]`, depth + 1));
      }
      const object = record(item, at);
      if (refs && Object.hasOwn(object, "$ref")) {
        if (Object.keys(object).length !== 1) throw new Error(`${at} reference must contain only $ref`);
        reference(object.$ref, `${at}.$ref`);
      }
      return Object.fromEntries(Object.entries(object).map(([key, child]) =>
        [key, copy(child, `${at}.${key}`, depth + 1)]));
    } finally {
      ancestors.delete(item);
    }
  }
  return copy(value, path, 0);
}

/** Validate the entire AST, including untaken branches, and return a detached copy.
 * maxNodes counts instructions and JSON value nodes; maxDepth bounds nested control
 * blocks and, independently, each value's JSON nesting. No expressions are evaluated.
 */
export function validateCheckedProcedure(program, { toolNames, maxNodes = 128, maxDepth = 8 } = {}) {
  limit(maxNodes, "maxNodes", 1);
  limit(maxDepth, "maxDepth", 1);
  const allowed = toolsAllowed(toolNames);
  let nodes = 0;
  const visit = () => {
    if (++nodes > maxNodes) throw new Error("Procedure exceeds maxNodes");
  };
  const value = (input, path) => jsonCopy(input, { path, maxDepth, visit, refs: true });
  function steps(input, path, depth) {
    if (depth > maxDepth) throw new Error(`${path} exceeds maxDepth`);
    return array(input, path).map((inputStep, index) => {
      visit();
      const at = `${path}[${index}]`;
      const { type } = record(inputStep, at);
      if (type === "call") {
        const step = fields(inputStep, at, ["type", "tool", "args", "saveAs"]);
        if (typeof step.tool !== "string") throw new Error(`${at}.tool must be a string`);
        if (!allowed.has(step.tool)) throw new Error(`${at} names unknown tool ${step.tool}`);
        return { type, tool: step.tool, args: value(step.args, `${at}.args`), saveAs: variable(step.saveAs, `${at}.saveAs`) };
      }
      if (type === "if") {
        const step = fields(inputStep, at, ["type", "left", "equals", "then"], ["else"]);
        return { type, left: value(step.left, `${at}.left`), equals: value(step.equals, `${at}.equals`),
          then: steps(step.then, `${at}.then`, depth + 1),
          ...(Object.hasOwn(step, "else") ? { else: steps(step.else, `${at}.else`, depth + 1) } : {}) };
      }
      if (type === "for_each") {
        const step = fields(inputStep, at, ["type", "items", "as", "steps"]);
        return { type, items: value(step.items, `${at}.items`), as: variable(step.as, `${at}.as`),
          steps: steps(step.steps, `${at}.steps`, depth + 1) };
      }
      if (type === "return") {
        const step = fields(inputStep, at, ["type", "status"], ["reason"]);
        if (!["completed", "needs_reasoning"].includes(step.status)) throw new Error(`${at}.status is invalid`);
        if (Object.hasOwn(step, "reason") && typeof step.reason !== "string") throw new Error(`${at}.reason must be a string`);
        return { type, status: step.status, ...(Object.hasOwn(step, "reason") ? { reason: step.reason } : {}) };
      }
      throw new Error(`${at}.type is unknown`);
    });
  }
  const source = fields(program, "program", ["schema", "steps"]);
  if (source.schema !== SCHEMA) throw new Error("Invalid checked procedure schema");
  return { schema: SCHEMA, steps: steps(source.steps, "steps", 1) };
}

class Stop extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Run only public injected tools/state. A return is a procedure claim, not a verifier
 * receipt. Falling off the AST never implies success; effects are never rolled back.
 */
export async function executeCheckedProcedure(program, {
  goal = {}, getState, executeTool, toolNames, maxToolCalls = 24, maxSteps = 128,
  maxNodes = 128, maxDepth = 8, signal
} = {}) {
  let toolCalls = 0;
  let stepsExecuted = 0;
  const trace = [];
  const variables = {};
  const result = (status, error) => ({ status, toolCalls, stepsExecuted, trace, variables, ...(error ? { error } : {}) });
  const aborted = () => {
    if (signal?.aborted) throw new Stop("needs_reasoning", "Execution aborted");
  };
  const tick = () => {
    aborted();
    if (stepsExecuted >= maxSteps) throw new Stop("budget_exhausted", "Execution reached maxSteps");
    stepsExecuted += 1;
  };
  function resolver() {
    let state;
    let loadedState = false;
    async function resolve(value) {
      if (value === null || typeof value !== "object") return value;
      if (Array.isArray(value)) {
        const output = [];
        for (const item of value) output.push(await resolve(item));
        return output;
      }
      if (Object.hasOwn(value, "$ref")) {
        const [root, ...parts] = reference(value.$ref, "$ref");
        if (root === "state" && !loadedState) {
          aborted();
          try { state = jsonCopy(await getState(), { path: "state" }); }
          catch (error) { throw new Stop("needs_reasoning", `getState failed: ${errorMessage(error)}`); }
          aborted();
          loadedState = true;
        }
        let current = root === "goal" ? goal : root === "vars" ? variables : state;
        for (const part of parts) {
          if (current === null || typeof current !== "object") throw new Stop("needs_reasoning", `Missing reference ${value.$ref}`);
          const descriptor = Object.getOwnPropertyDescriptor(current, part);
          if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Stop("needs_reasoning", `Missing or non-data reference ${value.$ref}`);
          current = descriptor.value;
        }
        return jsonCopy(current, { path: value.$ref });
      }
      const output = {};
      for (const [key, child] of Object.entries(value)) output[key] = await resolve(child);
      return output;
    }
    return resolve;
  }
  async function run(steps, path) {
    for (let index = 0; index < steps.length; index += 1) {
      tick();
      const step = steps[index];
      const at = `${path}[${index}]`;
      const resolve = resolver();
      if (step.type === "return") {
        trace.push({ ...step, path: at });
        return step.status;
      }
      if (step.type === "call") {
        if (toolCalls >= maxToolCalls) throw new Stop("budget_exhausted", "Execution reached maxToolCalls");
        const args = await resolve(step.args);
        aborted();
        const entry = { type: "call", path: at, tool: step.tool, args: jsonCopy(args), saveAs: step.saveAs };
        trace.push(entry);
        toolCalls += 1;
        try {
          const response = jsonCopy(await executeTool(step.tool, args), { path: `tool.${step.tool}.response` });
          entry.response = jsonCopy(response);
          variables[step.saveAs] = response;
        } catch (error) {
          entry.error = errorMessage(error);
          throw new Stop("needs_reasoning", `Tool ${step.tool} failed: ${entry.error}`);
        }
        aborted();
      } else if (step.type === "if") {
        const left = await resolve(step.left);
        const equals = await resolve(step.equals);
        aborted();
        const matched = isDeepStrictEqual(left, equals);
        trace.push({ type: "if", path: at, left, equals, matched });
        const status = await run(matched ? step.then : step.else ?? [], `${at}.${matched ? "then" : "else"}`);
        if (status) return status;
      } else if (step.type === "for_each") {
        const items = await resolve(step.items);
        if (!Array.isArray(items)) throw new Stop("needs_reasoning", `${at}.items did not resolve to an array`);
        trace.push({ type: "for_each", path: at, as: step.as, count: items.length });
        for (let iteration = 0; iteration < items.length; iteration += 1) {
          tick(); // Empty bodies must still consume a bounded amount of work.
          variables[step.as] = jsonCopy(items[iteration]);
          trace.push({ type: "iteration", path: at, as: step.as, index: iteration });
          const status = await run(step.steps, `${at}.steps`);
          if (status) return status;
        }
      }
    }
    return null;
  }
  try {
    limit(maxToolCalls, "maxToolCalls");
    limit(maxSteps, "maxSteps");
    if (typeof getState !== "function" || typeof executeTool !== "function") {
      throw new Error("getState and executeTool must be functions");
    }
    const checked = validateCheckedProcedure(program, { toolNames, maxNodes, maxDepth });
    aborted();
    const status = await run(checked.steps, "steps");
    aborted();
    if (status) return result(status);
    trace.push({ type: "stop", status: "needs_reasoning", reason: "Procedure ended without an explicit return" });
    return result("needs_reasoning");
  } catch (error) {
    const status = error instanceof Stop ? error.status : "error";
    const message = errorMessage(error);
    trace.push({ type: "stop", status, error: message });
    return result(status, message);
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown execution error";
}
