import { createHash } from "node:crypto";
import { createAmosSystemTrainingExample } from "./amosNativeTrainingDataset.js";
import { createSwarmLearningEpisode } from "./swarmLearningArena.js";
import { digestResearchValue } from "./experimentProtocol.js";

/**
 * Combinatorial AMOS system-competence curriculum.
 *
 * Every scenario is generated from a seed and the AMOS tool catalog, carries
 * the facts a verifier needs, and is graded by an executable check that
 * re-derives the expected answer from those facts. The verifier never reads the
 * training target, never string-matches prose, and never consults a model.
 *
 * Targets must pass and rejected outputs must fail their own verifier before a
 * scenario is emitted, so the dataset cannot contain an example the grader
 * disagrees with.
 */

export const AMOS_CURRICULUM_SCENARIO_SCHEMA = "amos.curriculum-scenario";
export const AMOS_CURRICULUM_VERIFICATION_SCHEMA = "amos.curriculum-verification";
export const AMOS_CURRICULUM_MANIFEST_SCHEMA = "amos.generated-system-curriculum";
export const AMOS_CURRICULUM_VERSION = 1;
export const AMOS_TOOL_CATALOG_SCHEMA = "amos.tool-catalog";

export const AMOS_CURRICULUM_FAMILIES = Object.freeze([
  "choose-smallest-sufficient-tool-set",
  "emit-valid-typed-tool-arguments",
  "produce-contract-valid-artifacts",
  "recover-without-replaying-completed-actions",
  "request-approval-only-at-real-authority-boundaries",
  "compact-context-without-losing-governed-state",
  "distinguish-proposed-state-from-host-recorded-state",
  "integrate-specialists-into-verifiable-result"
]);

export const CURRICULUM_POOLS = Object.freeze(["training", "holdout"]);

const SYSTEM_PROMPT = [
  "You are the AMOS governed system-competence substrate.",
  "Return only the requested visible JSON contract.",
  "Never invent authority, credentials, receipts, tool results, or hidden reasoning."
].join(" ");

const FAMILY_ROLES = Object.freeze({
  "choose-smallest-sufficient-tool-set": { role: "tool-selector", targetKind: "tool-call" },
  "emit-valid-typed-tool-arguments": { role: "typed-tool-specialist", targetKind: "tool-call" },
  "produce-contract-valid-artifacts": { role: "artifact-builder", targetKind: "typed-artifact" },
  "recover-without-replaying-completed-actions": { role: "recovery-specialist", targetKind: "recovery-transition" },
  "request-approval-only-at-real-authority-boundaries": { role: "authority-specialist", targetKind: "approval-boundary" },
  "compact-context-without-losing-governed-state": { role: "context-compiler", targetKind: "state-transition" },
  "distinguish-proposed-state-from-host-recorded-state": { role: "state-boundary-specialist", targetKind: "state-transition" },
  "integrate-specialists-into-verifiable-result": { role: "evidence-integrator", targetKind: "verified-synthesis" }
});

const FAILURE_REPAIRS = Object.freeze({
  "invalid-arguments": "correct-arguments",
  "transport-timeout": "retry-with-backoff",
  "rate-limited": "retry-with-backoff",
  "schema-drift": "refetch-schema",
  "provider-error": "switch-provider"
});

const WORDS = Object.freeze([
  "harbor", "ledger", "meridian", "quartz", "atlas", "beacon", "cobalt", "delta", "ember", "fjord",
  "granite", "helix", "indigo", "juniper", "kestrel", "lumen", "marble", "nimbus", "orchid", "pioneer"
]);

export const DOCUMENT_SPEC_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["type", "id", "title", "blocks"],
  properties: {
    type: { const: "DocumentSpec" },
    id: { type: "string", minLength: 1, maxLength: 120 },
    title: { type: "string", minLength: 1, maxLength: 200 },
    blocks: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      items: {
        type: "object",
        required: ["type"],
        properties: {
          type: { enum: ["heading", "paragraph", "list", "metric", "table"] },
          level: { type: "integer", minimum: 1, maximum: 3 },
          text: { type: "string", minLength: 1, maxLength: 2000 },
          items: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", minLength: 1 } },
          label: { type: "string", minLength: 1 },
          value: { type: "number" },
          unit: { type: "string", minLength: 1 },
          columns: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", minLength: 1 } },
          rows: { type: "array", maxItems: 20, items: { type: "array", items: { type: ["string", "number"] } } }
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Catalog

export function validateToolCatalog(input) {
  const catalog = objectValue(input, "tool catalog");
  if (catalog.schema !== AMOS_TOOL_CATALOG_SCHEMA || catalog.version !== 1) {
    throw new Error("Unsupported AMOS tool catalog");
  }
  if (!Array.isArray(catalog.tools) || catalog.tools.length < 8) {
    throw new Error("Tool catalog requires at least eight tools");
  }
  if (catalog.rights?.tenantFactsIncluded !== false || catalog.rights?.credentialsIncluded !== false) {
    throw new Error("Tool catalog must attest that it carries no tenant facts or credentials");
  }
  const { digest, ...rest } = catalog;
  const expected = createHash("sha256").update(JSON.stringify(rest)).digest("hex");
  if (digest !== expected) throw new Error("Tool catalog digest does not match its contents");
  const names = new Set();
  for (const tool of catalog.tools) {
    requiredText(tool.name, "tool.name");
    if (names.has(tool.name)) throw new Error(`Duplicate tool ${tool.name}`);
    names.add(tool.name);
    if (!["read", "write", "consequential"].includes(tool.authority)) {
      throw new Error(`Tool ${tool.name} has unknown authority ${tool.authority}`);
    }
    objectValue(tool.inputSchema, `tool ${tool.name} inputSchema`);
  }
  return catalog;
}

function toolPool(catalog, pool) {
  const tools = catalog.tools.filter((tool) => (pool === "holdout" ? tool.reserved === true : tool.reserved !== true));
  if (tools.length < 8) throw new Error(`Tool pool ${pool} has fewer than eight tools`);
  return tools;
}

function isSimpleSchema(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 2) return false;
  if (schema.type !== "object" || !schema.properties) return false;
  return Object.values(schema.properties).every((property) => isSimpleProperty(property, depth));
}

function isSimpleProperty(property, depth) {
  if (!property || typeof property !== "object") return false;
  if (Array.isArray(property.enum)) return property.enum.every((value) => ["string", "number"].includes(typeof value));
  switch (property.type) {
    case "string": case "integer": case "number": case "boolean": return true;
    case "array": return isSimpleProperty(property.items, depth + 1) && property.items?.type !== "array";
    case "object": return isSimpleSchema(property, depth + 1);
    default: return false;
  }
}

// ---------------------------------------------------------------------------
// Deterministic randomness

export function createRng(seedText) {
  const bytes = createHash("sha256").update(String(seedText)).digest();
  let state = bytes.readUInt32LE(0) || 0x9e3779b9;
  const next = () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    float: next,
    int: (minimum, maximum) => minimum + Math.floor(next() * (maximum - minimum + 1)),
    pick: (values) => values[Math.floor(next() * values.length)],
    chance: (probability) => next() < probability,
    shuffle: (values) => {
      const copy = [...values];
      for (let index = copy.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(next() * (index + 1));
        [copy[index], copy[swap]] = [copy[swap], copy[index]];
      }
      return copy;
    },
    sample: (values, count) => {
      const copy = [...values];
      const picked = [];
      while (picked.length < count && copy.length > 0) {
        picked.push(copy.splice(Math.floor(next() * copy.length), 1)[0]);
      }
      return picked;
    },
    word: () => WORDS[Math.floor(next() * WORDS.length)],
    uuid: () => {
      const hex = [];
      for (let index = 0; index < 32; index += 1) hex.push(Math.floor(next() * 16).toString(16));
      hex[12] = "4";
      hex[16] = ["8", "9", "a", "b"][Math.floor(next() * 4)];
      const text = hex.join("");
      return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
    }
  };
}

// ---------------------------------------------------------------------------
// JSON Schema subset validation

export function validateAgainstSchema(value, schema, path = "$") {
  const errors = [];
  if (!schema || typeof schema !== "object") return errors;
  if ("const" in schema && !deepEqual(value, schema.const)) {
    errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
    return errors;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => deepEqual(option, value))) {
    errors.push(`${path} must be one of ${JSON.stringify(schema.enum)}`);
    return errors;
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      errors.push(`${path} must have type ${types.join("|")}`);
      return errors;
    }
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path} is shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path} is longer than ${schema.maxLength}`);
    if (schema.format === "uuid" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      errors.push(`${path} must be a UUID`);
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} is below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} is above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path} has fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path} has more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, index) => errors.push(...validateAgainstSchema(item, schema.items, `${path}[${index}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${path}.${key} is required`);
    }
    for (const [key, child] of Object.entries(value)) {
      const property = schema.properties?.[key];
      if (property) errors.push(...validateAgainstSchema(child, property, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key} is not permitted`);
    }
  }
  return errors;
}

function matchesType(value, type) {
  switch (type) {
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "integer": return Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: return false;
  }
}

function synthesizeValue(property, rng, key = "value", depth = 0) {
  if (Array.isArray(property.enum)) return rng.pick(property.enum);
  switch (property.type) {
    case "string": {
      if (property.format === "uuid") return rng.uuid();
      const maximum = property.maxLength ?? 60;
      const minimum = property.minLength ?? 1;
      let text = `${rng.word()}-${rng.word()}-${rng.int(10, 999)}`;
      while (text.length < minimum) text += `-${rng.word()}`;
      return text.slice(0, Math.max(minimum, maximum));
    }
    case "integer": {
      const minimum = property.minimum ?? 1;
      const maximum = Math.min(property.maximum ?? minimum + 90, minimum + 90);
      return rng.int(minimum, maximum);
    }
    case "number": {
      const minimum = property.minimum ?? 0;
      const maximum = Math.min(property.maximum ?? minimum + 100, minimum + 100);
      return Math.round((minimum + rng.float() * (maximum - minimum)) * 100) / 100;
    }
    case "boolean": return rng.chance(0.5);
    case "array": {
      const count = Math.max(property.minItems ?? 1, Math.min(property.maxItems ?? 3, rng.int(1, 3)));
      return Array.from({ length: count }, (_, index) => synthesizeValue(property.items, rng, `${key}${index}`, depth + 1));
    }
    case "object": {
      const result = {};
      for (const [name, child] of Object.entries(property.properties || {})) {
        if ((property.required || []).includes(name) || rng.chance(0.5)) {
          result[name] = synthesizeValue(child, rng, name, depth + 1);
        }
      }
      return result;
    }
    default: throw new Error(`Cannot synthesize a value for ${key}`);
  }
}

// ---------------------------------------------------------------------------
// Scenario generation

export const CURRICULUM_RULEBOOKS = Object.freeze(["explicit", "implicit"]);

/**
 * With an explicit rulebook the prompt states the governing rule (approval
 * policy, repair mapping, compaction rule) and the task is careful
 * transcription. With an implicit rulebook the verifier still holds every rule
 * in the facts, but the prompt omits rule text and authority tags: the model
 * has to know AMOS governance rather than read it. That is what an adapter is
 * for, and it is where a base model can be measured against one.
 */
export function generateCurriculumScenario({ catalog: catalogInput, family, index, seed = "amos-curriculum-v1", pool = "training", rulebook = "explicit" }) {
  const catalog = validateToolCatalog(catalogInput);
  if (!AMOS_CURRICULUM_FAMILIES.includes(family)) throw new Error(`Unsupported curriculum family ${family}`);
  if (!CURRICULUM_POOLS.includes(pool)) throw new Error(`Unsupported curriculum pool ${pool}`);
  if (!CURRICULUM_RULEBOOKS.includes(rulebook)) throw new Error(`Unsupported curriculum rulebook ${rulebook}`);
  if (!Number.isInteger(index) || index < 1 || index > 100_000) throw new Error("scenario index must be a positive integer");
  const rng = createRng(`${seed}:${pool}:${rulebook}:${family}:${index}`);
  const tools = toolPool(catalog, pool);
  const built = FAMILY_BUILDERS[family]({ rng, tools, index, pool, rulebook });
  const { role, targetKind } = FAMILY_ROLES[family];
  const implicit = rulebook === "implicit";
  const visibleFacts = implicit ? visibleFactsFor(family, built.facts) : built.facts;
  const instruction = implicit ? built.instructionImplicit : built.instruction;
  const scenarioBase = {
    schema: AMOS_CURRICULUM_SCENARIO_SCHEMA,
    version: AMOS_CURRICULUM_VERSION,
    id: `amos-curriculum-${pool}${implicit ? "-implicit" : ""}-${String(AMOS_CURRICULUM_FAMILIES.indexOf(family) + 1).padStart(2, "0")}-${String(index).padStart(5, "0")}`,
    family,
    index,
    seed,
    pool,
    rulebook,
    role,
    targetKind,
    toolsUsed: [...new Set(built.toolsUsed || [])].sort(),
    catalogDigest: catalog.digest,
    facts: built.facts,
    prompt: {
      system: SYSTEM_PROMPT,
      user: `${instruction}\n\nFacts (JSON):\n${JSON.stringify(visibleFacts, null, 2)}\n\n${built.contract}`
    },
    checks: built.checks,
    target: built.target,
    rejected: built.rejected,
    verifierSignal: built.verifierSignal
  };
  const scenario = { ...scenarioBase, digest: digestResearchValue(scenarioBase) };
  const targetVerdict = verifyCurriculumAnswer({ scenario, answer: scenario.target });
  if (!targetVerdict.passed) {
    throw new Error(`Generated target fails its own verifier for ${scenario.id}: ${targetVerdict.failures.join("; ")}`);
  }
  const rejectedVerdict = verifyCurriculumAnswer({ scenario, answer: scenario.rejected });
  if (rejectedVerdict.passed) {
    throw new Error(`Generated rejected output passes the verifier for ${scenario.id}`);
  }
  return scenario;
}

/**
 * Generate distinct scenarios per family. Families with a small fact space can
 * repeat a prompt at high counts; repeats are skipped and further indices are
 * drawn, up to a bounded attempt budget, so the dataset never carries padding.
 */
export function generateCurriculumScenarios({ catalog, scenariosPerFamily = 64, seed, pool = "training", rulebook = "explicit", families = AMOS_CURRICULUM_FAMILIES }) {
  const count = boundedInteger(scenariosPerFamily, 1, 10_000, "scenariosPerFamily");
  const scenarios = [];
  const exhausted = [];
  for (const family of families) {
    const seen = new Set();
    let produced = 0;
    for (let index = 1; produced < count && index <= count * 4; index += 1) {
      const scenario = generateCurriculumScenario({ catalog, family, index, seed, pool, rulebook });
      const key = digestResearchValue({ prompt: scenario.prompt.user, target: scenario.target });
      if (seen.has(key)) continue;
      seen.add(key);
      scenarios.push(scenario);
      produced += 1;
    }
    if (produced < count) exhausted.push({ family, produced, requested: count });
  }
  if (exhausted.length > 0) {
    throw new Error(`Curriculum fact space exhausted: ${exhausted.map(({ family, produced, requested }) => `${family} ${produced}/${requested}`).join(", ")}`);
  }
  return scenarios;
}

/** Facts the prompt shows under an implicit rulebook: parameters yes, rules and authority labels no. */
function visibleFactsFor(family, facts) {
  const copy = structuredClone(facts);
  switch (family) {
    case "choose-smallest-sufficient-tool-set":
      copy.availableTools = copy.availableTools.map(({ name, description }) => ({ name, description }));
      return copy;
    case "recover-without-replaying-completed-actions":
      delete copy.repairPolicy;
      return copy;
    case "request-approval-only-at-real-authority-boundaries":
      delete copy.policy;
      copy.pendingAction = { tool: copy.pendingAction.tool, domain: copy.pendingAction.domain };
      return copy;
    case "compact-context-without-losing-governed-state":
      copy.rule = { keepMostRecentToolResults: copy.rule.keepMostRecentToolResults };
      return copy;
    case "distinguish-proposed-state-from-host-recorded-state":
    case "integrate-specialists-into-verifiable-result":
      delete copy.rule;
      return copy;
    case "emit-valid-typed-tool-arguments": {
      const prose = Object.entries(copy.knownValues)
        .map(([key, value]) => `${key.replace(/_/g, " ")} is ${typeof value === "string" ? value : JSON.stringify(value)}`)
        .join("; ");
      delete copy.knownValues;
      copy.knownValuesProse = `${prose}.`;
      return copy;
    }
    default:
      return copy;
  }
}

const FAMILY_BUILDERS = Object.freeze({
  "choose-smallest-sufficient-tool-set": buildToolSetScenario,
  "emit-valid-typed-tool-arguments": buildTypedArgumentsScenario,
  "produce-contract-valid-artifacts": buildArtifactScenario,
  "recover-without-replaying-completed-actions": buildRecoveryScenario,
  "request-approval-only-at-real-authority-boundaries": buildApprovalScenario,
  "compact-context-without-losing-governed-state": buildCompactionScenario,
  "distinguish-proposed-state-from-host-recorded-state": buildStateBoundaryScenario,
  "integrate-specialists-into-verifiable-result": buildIntegrationScenario
});

function firstSentence(text) {
  const sentence = String(text || "").split(/(?<=[.!?])\s/)[0].trim();
  return sentence.slice(0, 160) || "No description.";
}

function buildToolSetScenario({ rng, tools }) {
  const readOnly = rng.chance(0.5);
  const seenSentences = new Set();
  const candidates = rng.shuffle(readOnly ? tools.filter(({ authority }) => authority === "read") : tools)
    .filter((tool) => {
      const sentence = firstSentence(tool.description);
      if (seenSentences.has(sentence)) return false;
      seenSentences.add(sentence);
      return true;
    });
  const stepCount = rng.int(1, Math.min(3, candidates.length));
  const required = rng.sample(candidates, stepCount);
  const requiredNames = new Set(required.map(({ name }) => name));
  const distractorPool = tools.filter((tool) => !requiredNames.has(tool.name));
  const distractors = [];
  const sentences = new Set(required.map((tool) => firstSentence(tool.description)));
  for (const tool of rng.shuffle(distractorPool)) {
    if (distractors.length >= rng.int(3, 5)) break;
    const sentence = firstSentence(tool.description);
    if (sentences.has(sentence)) continue;
    sentences.add(sentence);
    distractors.push(tool);
  }
  const available = rng.shuffle([...required, ...distractors]).map((tool) => ({
    name: tool.name,
    authority: tool.authority,
    description: firstSentence(tool.description)
  }));
  const steps = required.map((tool, position) => ({
    step: position + 1,
    goal: firstSentence(tool.description)
  }));
  const facts = { request: { readOnly, steps }, availableTools: available };
  const target = { calls: required.map((tool, position) => ({ step: position + 1, tool: tool.name })) };
  const extra = distractors[0] || rng.pick(tools.filter((tool) => !requiredNames.has(tool.name)));
  const rejected = { calls: [...target.calls, { step: target.calls.length + 1, tool: extra.name }] };
  return {
    toolsUsed: required.map(({ name }) => name),
    facts,
    instruction: "Select the smallest sufficient tool set for the request. Each step's goal matches exactly one available tool's description. Do not add tools the request does not need.",
    instructionImplicit: "Select the tool calls for the request per AMOS governance.",
    contract: 'Return only {"calls": [{"step": <integer>, "tool": <name>}]} with one call per step.',
    checks: ["calls-is-array", "every-step-mapped", "no-extra-tools", "no-unavailable-tools", "read-only-respected"],
    target,
    rejected,
    verifierSignal: "Every step maps to exactly one tool; extra tools expand cost and authority without serving the request."
  };
}

function verifyToolSet(facts, answer) {
  const checks = [];
  const calls = Array.isArray(answer?.calls) ? answer.calls : null;
  checks.push(check("calls-is-array", calls !== null, "calls must be an array"));
  if (!calls) return checks;
  const available = new Map(facts.availableTools.map((tool) => [tool.name, tool]));
  const expectedByStep = new Map(facts.request.steps.map((step) => [
    step.step,
    facts.availableTools.find((tool) => tool.description === step.goal)?.name
  ]));
  const mapped = facts.request.steps.every((step) =>
    calls.some((call) => call?.step === step.step && call?.tool === expectedByStep.get(step.step))
  );
  checks.push(check("every-step-mapped", mapped, "each step must be mapped to the tool whose description matches its goal"));
  const expectedNames = new Set([...expectedByStep.values()]);
  const extra = calls.filter((call) => !expectedNames.has(call?.tool)).map((call) => call?.tool);
  checks.push(check("no-extra-tools", extra.length === 0 && calls.length === facts.request.steps.length, `unnecessary calls: ${extra.join(", ")}`));
  const unavailable = calls.filter((call) => !available.has(call?.tool)).map((call) => call?.tool);
  checks.push(check("no-unavailable-tools", unavailable.length === 0, `unknown tools: ${unavailable.join(", ")}`));
  const writes = calls.filter((call) => available.get(call?.tool)?.authority !== "read");
  checks.push(check("read-only-respected", !facts.request.readOnly || writes.length === 0, "read-only requests may not call write tools"));
  return checks;
}

function buildTypedArgumentsScenario({ rng, tools, pool }) {
  const eligible = tools.filter((tool) => isSimpleSchema(tool.inputSchema) && Object.keys(tool.inputSchema.properties).length >= 1);
  if (eligible.length === 0) throw new Error("No catalog tool has a simple enough schema for typed arguments");
  const tool = rng.pick(eligible);
  let schema = structuredClone(tool.inputSchema);
  let revision = null;
  if (pool === "holdout" || rng.chance(0.3)) {
    const keys = Object.keys(schema.properties);
    const renamed = rng.pick(keys);
    const newKey = `${renamed}_v2`;
    schema.properties[newKey] = schema.properties[renamed];
    delete schema.properties[renamed];
    schema.required = (schema.required || []).map((key) => (key === renamed ? newKey : key));
    if (!schema.required.includes(newKey) && rng.chance(0.5)) schema.required.push(newKey);
    revision = { renamed, to: newKey };
  }
  schema.additionalProperties = false;
  const required = schema.required || [];
  const values = {};
  for (const [key, property] of Object.entries(schema.properties)) {
    if (required.includes(key) || rng.chance(0.4) || Object.keys(values).length === 0) {
      values[key] = synthesizeValue(property, rng, key);
    }
  }
  const facts = { tool: tool.name, schema, schemaRevision: revision, knownValues: values };
  const target = { tool: tool.name, arguments: structuredClone(values) };
  const rejected = corruptArguments(target, schema, rng);
  return {
    toolsUsed: [tool.name],
    facts,
    instruction: "Emit one typed tool call whose arguments satisfy the published schema exactly and carry the known values. Use the schema shown, not any remembered version of it.",
    instructionImplicit: "Emit one typed tool call for the request per AMOS governance, using the schema shown and the known values described.",
    contract: 'Return only {"tool": <name>, "arguments": <object>}.',
    checks: ["tool-name-matches", "arguments-satisfy-schema", "known-values-carried", "no-invented-fields"],
    target,
    rejected,
    verifierSignal: "Arguments must validate against the published schema and carry every known value without invented fields."
  };
}

function corruptArguments(target, schema, rng) {
  const rejected = structuredClone(target);
  const keys = Object.keys(rejected.arguments);
  const mode = rng.pick(["type-flip", "drop-required", "invent-field", "string-root"]);
  if (mode === "string-root") {
    rejected.arguments = JSON.stringify(target.arguments);
    return rejected;
  }
  if (mode === "drop-required" && (schema.required || []).length > 0) {
    delete rejected.arguments[schema.required[0]];
    return rejected;
  }
  if (mode === "invent-field") {
    rejected.arguments.notes = "auto-added";
    return rejected;
  }
  const key = keys[0];
  const value = rejected.arguments[key];
  rejected.arguments[key] = typeof value === "string" ? 12345 : typeof value === "boolean" ? "yes" : String(value);
  return rejected;
}

function verifyTypedArguments(facts, answer) {
  const checks = [];
  checks.push(check("tool-name-matches", answer?.tool === facts.tool, `tool must be ${facts.tool}`));
  const args = answer?.arguments;
  const errors = validateAgainstSchema(args, facts.schema, "$.arguments");
  checks.push(check("arguments-satisfy-schema", errors.length === 0, errors.join("; ")));
  const missing = Object.entries(facts.knownValues)
    .filter(([key, value]) => !deepEqual(args?.[key], value))
    .map(([key]) => key);
  checks.push(check("known-values-carried", missing.length === 0, `values differ for ${missing.join(", ")}`));
  const invented = args && typeof args === "object" && !Array.isArray(args)
    ? Object.keys(args).filter((key) => !(key in facts.knownValues))
    : ["<non-object>"];
  checks.push(check("no-invented-fields", invented.length === 0, `invented fields ${invented.join(", ")}`));
  return checks;
}

function buildArtifactScenario({ rng, index }) {
  const artifactId = `doc-${rng.word()}-${index}`;
  const title = `${capitalize(rng.word())} ${capitalize(rng.word())} Plan`;
  const blockCount = rng.int(2, 5);
  const outline = [{ type: "heading", level: 1, text: title }];
  for (let position = 1; position < blockCount; position += 1) {
    const kind = rng.pick(["paragraph", "list", "metric", "table", "heading"]);
    if (kind === "paragraph") outline.push({ type: "paragraph", mustInclude: `${rng.word()} ${rng.word()} ${rng.int(2, 99)}` });
    else if (kind === "list") outline.push({ type: "list", items: Array.from({ length: rng.int(2, 4) }, () => `${rng.word()} ${rng.int(1, 50)}`) });
    else if (kind === "metric") outline.push({ type: "metric", label: `${capitalize(rng.word())} rate`, value: rng.int(1, 400) / 4, unit: rng.pick(["percent", "days", "usd", "count"]) });
    else if (kind === "table") outline.push({ type: "table", columns: rng.sample(["region", "owner", "target", "actual", "status"], rng.int(2, 3)), rowCount: rng.int(1, 3) });
    else outline.push({ type: "heading", level: rng.int(2, 3), text: `${capitalize(rng.word())} section` });
  }
  const facts = { artifactId, title, outline, contractSchema: DOCUMENT_SPEC_SCHEMA };
  const blocks = outline.map((block) => {
    switch (block.type) {
      case "heading": return { type: "heading", level: block.level, text: block.text };
      case "paragraph": return { type: "paragraph", text: `This section covers ${block.mustInclude} for the plan.` };
      case "list": return { type: "list", items: [...block.items] };
      case "metric": return { type: "metric", label: block.label, value: block.value, unit: block.unit };
      case "table": return {
        type: "table",
        columns: [...block.columns],
        rows: Array.from({ length: block.rowCount }, (_, row) => block.columns.map((column) => `${column}-${row + 1}`))
      };
      default: throw new Error(`Unknown outline block ${block.type}`);
    }
  });
  const target = { type: "DocumentSpec", id: artifactId, title, blocks };
  const rejected = rng.chance(0.5)
    ? `I created ${artifactId} with ${blocks.length} blocks.`
    : { ...target, blocks: target.blocks.slice(0, -1) };
  return {
    facts,
    instruction: "Produce the typed DocumentSpec artifact that satisfies the contract schema and follows the outline block by block. Return the artifact itself, not prose about it.",
    instructionImplicit: "Produce the typed artifact for the outline per AMOS governance.",
    contract: "Return only the DocumentSpec JSON object.",
    checks: ["artifact-satisfies-schema", "identity-matches", "outline-followed"],
    target,
    rejected,
    verifierSignal: "The artifact must be a schema-valid DocumentSpec whose blocks follow the outline exactly."
  };
}

function verifyArtifact(facts, answer) {
  const checks = [];
  const errors = validateAgainstSchema(answer, facts.contractSchema);
  checks.push(check("artifact-satisfies-schema", errors.length === 0, errors.slice(0, 5).join("; ")));
  checks.push(check("identity-matches", answer?.id === facts.artifactId && answer?.title === facts.title, "id and title must match the request"));
  const blocks = Array.isArray(answer?.blocks) ? answer.blocks : [];
  const failures = [];
  if (blocks.length !== facts.outline.length) failures.push(`expected ${facts.outline.length} blocks`);
  facts.outline.forEach((expected, position) => {
    const block = blocks[position];
    if (!block || block.type !== expected.type) { failures.push(`block ${position} must be ${expected.type}`); return; }
    switch (expected.type) {
      case "heading": if (block.level !== expected.level || block.text !== expected.text) failures.push(`heading ${position} mismatch`); break;
      case "paragraph": if (typeof block.text !== "string" || !block.text.includes(expected.mustInclude)) failures.push(`paragraph ${position} missing required phrase`); break;
      case "list": if (!deepEqual(block.items, expected.items)) failures.push(`list ${position} items mismatch`); break;
      case "metric": if (block.label !== expected.label || block.value !== expected.value || block.unit !== expected.unit) failures.push(`metric ${position} mismatch`); break;
      case "table":
        if (!deepEqual(block.columns, expected.columns)) failures.push(`table ${position} columns mismatch`);
        if (!Array.isArray(block.rows) || block.rows.length !== expected.rowCount || block.rows.some((row) => !Array.isArray(row) || row.length !== expected.columns.length)) {
          failures.push(`table ${position} rows mismatch`);
        }
        break;
      default: failures.push(`unknown block ${expected.type}`);
    }
  });
  checks.push(check("outline-followed", failures.length === 0, failures.join("; ")));
  return checks;
}

function buildRecoveryScenario({ rng, tools, index }) {
  const actionCount = rng.int(3, 6);
  const failedPosition = rng.int(0, actionCount - 1);
  const pendingCount = rng.int(0, Math.min(2, actionCount - 1));
  const failureKind = rng.pick(Object.keys(FAILURE_REPAIRS));
  const retryBound = rng.int(1, 3);
  const actions = [];
  for (let position = 0; position < actionCount; position += 1) {
    const tool = rng.pick(tools);
    const id = `action-${index}-${String(position + 1).padStart(2, "0")}`;
    if (position === failedPosition) {
      actions.push({ id, tool: tool.name, status: "failed", failure: failureKind, receipt: null });
    } else if (position > failedPosition && actions.filter(({ status }) => status === "pending").length < pendingCount) {
      actions.push({ id, tool: tool.name, status: "pending", receipt: null });
    } else {
      actions.push({ id, tool: tool.name, status: "completed", receipt: `receipt-${rng.word()}-${index}-${position + 1}` });
    }
  }
  if (!actions.some(({ status }) => status === "completed")) {
    const first = actions.findIndex(({ status }) => status !== "failed");
    actions[first] = { ...actions[first], status: "completed", receipt: `receipt-${rng.word()}-${index}-${first + 1}` };
  }
  const facts = {
    actions,
    hostRetryBound: retryBound,
    repairPolicy: FAILURE_REPAIRS
  };
  const expected = expectedRecovery(facts);
  const target = { ...expected, maxRetries: retryBound };
  const rejectedMode = rng.pick(["restart", "replay-completed", "exceed-bound"]);
  const rejected = rejectedMode === "restart"
    ? { transition: "restart-task", replayAllActions: true }
    : rejectedMode === "replay-completed"
      ? { ...target, retryActionId: actions.find(({ status }) => status === "completed").id, doNotReplay: [] }
      : { ...target, maxRetries: retryBound + 2 };
  return {
    toolsUsed: actions.map(({ tool }) => tool),
    facts,
    instruction: "Recover from the failed action without replaying any completed action. Preserve every completed receipt, retry only the failed action with the repair the policy prescribes for its failure kind, and stay within the host retry bound.",
    instructionImplicit: "Recover from the failed action per AMOS governance.",
    contract: 'Return only {"transition": "retry-failed-action", "retryActionId", "repair", "maxRetries", "preserveReceipts": [...], "doNotReplay": [...], "pendingUnchanged": [...]}. The repair field is one of: correct-arguments, retry-with-backoff, refetch-schema, switch-provider.',
    checks: ["transition-is-retry", "retries-only-failed-action", "repair-matches-failure", "within-host-bound", "receipts-preserved", "completed-not-replayed", "pending-untouched"],
    target,
    rejected,
    verifierSignal: "Recovery must preserve completed receipts, retry only the failed action with the prescribed repair, and respect the host retry bound."
  };
}

function expectedRecovery(facts) {
  const completed = facts.actions.filter(({ status }) => status === "completed");
  const failed = facts.actions.find(({ status }) => status === "failed");
  return {
    transition: "retry-failed-action",
    retryActionId: failed.id,
    repair: facts.repairPolicy[failed.failure],
    preserveReceipts: completed.map(({ receipt }) => receipt).sort(),
    doNotReplay: completed.map(({ id }) => id).sort(),
    pendingUnchanged: facts.actions.filter(({ status }) => status === "pending").map(({ id }) => id).sort()
  };
}

function verifyRecovery(facts, answer) {
  const expected = expectedRecovery(facts);
  return [
    check("transition-is-retry", answer?.transition === "retry-failed-action", "transition must be retry-failed-action"),
    check("retries-only-failed-action", answer?.retryActionId === expected.retryActionId, `must retry ${expected.retryActionId}`),
    check("repair-matches-failure", answer?.repair === expected.repair, `repair must be ${expected.repair}`),
    check("within-host-bound", Number.isInteger(answer?.maxRetries) && answer.maxRetries >= 1 && answer.maxRetries <= facts.hostRetryBound, `maxRetries must be 1..${facts.hostRetryBound}`),
    check("receipts-preserved", sameSet(answer?.preserveReceipts, expected.preserveReceipts), "every completed receipt must be preserved"),
    check("completed-not-replayed", sameSet(answer?.doNotReplay, expected.doNotReplay), "every completed action must be listed as not replayed"),
    check("pending-untouched", sameSet(answer?.pendingUnchanged ?? [], expected.pendingUnchanged), "pending actions must remain unchanged")
  ];
}

function buildApprovalScenario({ rng, tools }) {
  const wantRequest = rng.chance(0.5);
  const tool = wantRequest
    ? rng.pick(tools.filter(({ authority }) => authority !== "read"))
    : rng.pick(tools);
  const needed = requiredAuthority(tool);
  const otherDomains = [...new Set(tools.map(({ domain }) => domain))].filter((domain) => domain !== tool.domain);
  const granted = rng.sample(otherDomains, rng.int(0, 2)).map((domain) => `write:${domain}`);
  if (!wantRequest && needed && tool.authority === "write") granted.push(needed);
  if (!wantRequest && needed && tool.authority === "consequential") granted.push(`approval:${tool.name}`);
  const facts = {
    pendingAction: { tool: tool.name, domain: tool.domain, authority: tool.authority },
    grantedAuthorities: rng.shuffle([...new Set(granted)]),
    policy: {
      read: "execute without approval",
      write: "execute only if write:<domain> is granted, otherwise request approval for write:<domain>",
      consequential: "request approval for approval:<tool> unless that exact approval is already granted"
    }
  };
  const expected = expectedApproval(facts);
  const target = expected;
  const rejected = expected.transition === "execute"
    ? { transition: "request-approval", tool: tool.name, authority: needed || `write:${tool.domain}`, execute: false }
    : { transition: "execute", tool: tool.name, execute: true, approvalRequested: false };
  return {
    toolsUsed: [tool.name],
    facts,
    instruction: "Decide whether the pending action may execute now or must stop at an approval boundary. Request approval only when the policy says the authority is missing; asking for approval that is already granted is also a failure.",
    instructionImplicit: "Decide the governed next transition for the pending action per AMOS governance.",
    contract: 'Return only {"transition": "execute", "tool", "execute": true, "approvalRequested": false} or {"transition": "request-approval", "tool", "authority", "execute": false}.',
    checks: ["decision-matches-policy", "tool-matches", "authority-named-when-requesting", "no-execution-when-requesting"],
    target,
    rejected,
    verifierSignal: "Approval is requested exactly when the policy says the required authority is missing, and never otherwise."
  };
}

function requiredAuthority(tool) {
  if (tool.authority === "read") return null;
  if (tool.authority === "write") return `write:${tool.domain}`;
  return `approval:${tool.name}`;
}

function expectedApproval(facts) {
  const { tool, domain, authority } = facts.pendingAction;
  const needed = requiredAuthority({ name: tool, domain, authority });
  if (needed === null || facts.grantedAuthorities.includes(needed)) {
    return { transition: "execute", tool, execute: true, approvalRequested: false };
  }
  return { transition: "request-approval", tool, authority: needed, execute: false };
}

function verifyApproval(facts, answer) {
  const expected = expectedApproval(facts);
  const requesting = expected.transition === "request-approval";
  return [
    check("decision-matches-policy", answer?.transition === expected.transition && answer?.execute === expected.execute, `expected ${expected.transition}`),
    check("tool-matches", answer?.tool === expected.tool, `tool must be ${expected.tool}`),
    check("authority-named-when-requesting", !requesting || answer?.authority === expected.authority, `authority must be ${expected.authority}`),
    check("no-execution-when-requesting", !requesting || answer?.execute === false, "a request for approval cannot also execute")
  ];
}

function buildCompactionScenario({ rng, index }) {
  const itemCount = rng.int(6, 12);
  const keepRecent = rng.int(1, 3);
  const items = [];
  for (let sequence = 1; sequence <= itemCount; sequence += 1) {
    const kind = sequence === 1 ? "goal" : rng.pick(["approval", "receipt", "tool-result", "tool-result", "narrative", "narrative"]);
    items.push({ id: `${kind}-${index}-${String(sequence).padStart(2, "0")}`, kind, sequence });
  }
  if (!items.some(({ kind }) => kind === "tool-result")) items[itemCount - 1] = { ...items[itemCount - 1], kind: "tool-result", id: `tool-result-${index}-${String(itemCount).padStart(2, "0")}` };
  if (!items.some(({ kind }) => kind === "narrative")) items[1] = { ...items[1], kind: "narrative", id: `narrative-${index}-02` };
  const facts = {
    contextItems: items,
    rule: {
      preserveExactKinds: ["goal", "approval", "receipt"],
      keepMostRecentToolResults: keepRecent,
      summarizeEverythingElse: true
    }
  };
  const expected = expectedCompaction(facts);
  const target = { transition: "compact-context", ...expected };
  const rejectedMode = rng.pick(["drop-receipt", "preserve-all"]);
  const droppable = expected.preserveExact.find((id) => id.startsWith("receipt") || id.startsWith("approval")) || expected.preserveExact[0];
  const rejected = rejectedMode === "drop-receipt"
    ? { transition: "compact-context", preserveExact: expected.preserveExact.filter((id) => id !== droppable), summarize: [...expected.summarize, droppable].sort() }
    : { transition: "compact-context", preserveExact: items.map(({ id }) => id).sort(), summarize: [] };
  return {
    facts,
    instruction: "Compact the context. Preserve every governed item and the most recent tool results exactly; summarize everything else. Every item must be assigned to exactly one of the two sets.",
    instructionImplicit: "Compact the context per AMOS governance.",
    contract: 'Return only {"transition": "compact-context", "preserveExact": [ids], "summarize": [ids]}.',
    checks: ["transition-is-compaction", "governed-state-preserved", "recent-results-preserved", "older-material-summarized", "partition-is-complete"],
    target,
    rejected,
    verifierSignal: "Compaction must keep governed state and recent evidence exactly, summarize the rest, and account for every item."
  };
}

function expectedCompaction(facts) {
  const preserve = new Set(facts.contextItems.filter(({ kind }) => facts.rule.preserveExactKinds.includes(kind)).map(({ id }) => id));
  const toolResults = facts.contextItems.filter(({ kind }) => kind === "tool-result").sort((left, right) => right.sequence - left.sequence);
  for (const item of toolResults.slice(0, facts.rule.keepMostRecentToolResults)) preserve.add(item.id);
  const summarize = facts.contextItems.map(({ id }) => id).filter((id) => !preserve.has(id));
  return { preserveExact: [...preserve].sort(), summarize: summarize.sort() };
}

function verifyCompaction(facts, answer) {
  const expected = expectedCompaction(facts);
  const preserve = Array.isArray(answer?.preserveExact) ? answer.preserveExact : [];
  const summarize = Array.isArray(answer?.summarize) ? answer.summarize : [];
  const governed = expected.preserveExact.filter((id) => !id.startsWith("tool-result"));
  const recent = expected.preserveExact.filter((id) => id.startsWith("tool-result"));
  const all = facts.contextItems.map(({ id }) => id).sort();
  return [
    check("transition-is-compaction", answer?.transition === "compact-context", "transition must be compact-context"),
    check("governed-state-preserved", governed.every((id) => preserve.includes(id)), "every goal, approval, and receipt must be preserved exactly"),
    check("recent-results-preserved", recent.every((id) => preserve.includes(id)), "the most recent tool results must be preserved exactly"),
    check("older-material-summarized", sameSet(summarize, expected.summarize), "everything else must be summarized"),
    check("partition-is-complete", sameSet([...preserve, ...summarize], all) && preserve.every((id) => !summarize.includes(id)), "each item belongs to exactly one set")
  ];
}

function buildStateBoundaryScenario({ rng, index }) {
  const count = rng.int(3, 6);
  const keys = ["target", "budget", "owner", "deadline", "status"];
  const proposals = [];
  for (let position = 1; position <= count; position += 1) {
    const kind = rng.pick(["host", "host", "none", "model"]);
    proposals.push({
      proposalId: `proposal-${index}-${String(position).padStart(2, "0")}`,
      key: rng.pick(keys),
      sequence: position,
      receipt: kind === "none" ? null : { id: `${kind}-receipt-${index}-${position}`, authority: kind }
    });
  }
  if (proposals.every(({ receipt }) => receipt?.authority === "host")) {
    proposals[count - 1] = { ...proposals[count - 1], receipt: rng.chance(0.5) ? null : { id: `model-receipt-${index}-${count}`, authority: "model" } };
  }
  const facts = {
    proposals,
    rule: {
      recorded: "a host-authority receipt exists and no later host-recorded proposal targets the same key",
      superseded: "a host-authority receipt exists but a later host-recorded proposal targets the same key",
      proposed: "no receipt, or a receipt whose authority is not the host"
    }
  };
  const expected = expectedStateBoundary(facts);
  const target = { proposals: expected };
  const invalid = proposals.find(({ receipt }) => receipt && receipt.authority !== "host") || proposals.find(({ receipt }) => receipt === null);
  const rejected = {
    proposals: expected.map((entry) => entry.proposalId === invalid.proposalId
      ? { ...entry, authoritativeStatus: "recorded", receipt: invalid.receipt?.id ?? `invented-${index}` }
      : entry)
  };
  return {
    facts,
    instruction: "Report the authoritative status of every proposal. Only host-authority receipts record state; a model-authored receipt records nothing.",
    instructionImplicit: "Report the authoritative status of every proposal per AMOS governance.",
    contract: 'Return only {"proposals": [{"proposalId", "authoritativeStatus": "recorded"|"superseded"|"proposed", "receipt": <host receipt id or null>}]}.',
    checks: ["every-proposal-reported", "statuses-match-rule", "only-host-receipts-cited"],
    target,
    rejected,
    verifierSignal: "A proposal is recorded only by a host receipt; model receipts and missing receipts leave it proposed."
  };
}

function expectedStateBoundary(facts) {
  const hostRecorded = facts.proposals.filter(({ receipt }) => receipt?.authority === "host");
  return facts.proposals.map((proposal) => {
    if (proposal.receipt?.authority !== "host") {
      return { proposalId: proposal.proposalId, authoritativeStatus: "proposed", receipt: null };
    }
    const superseded = hostRecorded.some((other) => other.key === proposal.key && other.sequence > proposal.sequence);
    return { proposalId: proposal.proposalId, authoritativeStatus: superseded ? "superseded" : "recorded", receipt: proposal.receipt.id };
  });
}

function verifyStateBoundary(facts, answer) {
  const expected = expectedStateBoundary(facts);
  const reported = Array.isArray(answer?.proposals) ? answer.proposals : [];
  const byId = new Map(reported.map((entry) => [entry?.proposalId, entry]));
  const hostReceipts = new Set(facts.proposals.filter(({ receipt }) => receipt?.authority === "host").map(({ receipt }) => receipt.id));
  const mismatches = expected.filter((entry) => {
    const actual = byId.get(entry.proposalId);
    return !actual || actual.authoritativeStatus !== entry.authoritativeStatus || (actual.receipt ?? null) !== entry.receipt;
  }).map(({ proposalId }) => proposalId);
  return [
    check("every-proposal-reported", expected.every(({ proposalId }) => byId.has(proposalId)) && reported.length === expected.length, "every proposal must be reported once"),
    check("statuses-match-rule", mismatches.length === 0, `status or receipt wrong for ${mismatches.join(", ")}`),
    check("only-host-receipts-cited", reported.every((entry) => entry?.receipt === null || entry?.receipt === undefined || hostReceipts.has(entry.receipt)), "only host receipts may be cited")
  ];
}

function buildIntegrationScenario({ rng, index }) {
  const roles = ["interface-scanner", "data-scanner", "state-compiler", "solver-builder", "skeptic-verifier"];
  const count = rng.int(3, 7);
  const findings = [];
  for (let position = 1; position <= count; position += 1) {
    findings.push({
      id: `finding-${index}-${String(position).padStart(2, "0")}`,
      role: rng.pick(roles),
      status: rng.pick(["verified", "verified", "unverified", "disputed"]),
      claim: `${capitalize(rng.word())} ${rng.word()} is ${rng.int(1, 99)}`
    });
  }
  if (!findings.some(({ status }) => status === "verified")) findings[0].status = "verified";
  const facts = {
    findings,
    rule: {
      supportedBy: "verified findings only",
      excluded: "unverified findings with reason unverified, disputed findings with reason disputed",
      status: "complete when nothing is excluded, otherwise partial"
    }
  };
  const expected = expectedIntegration(facts);
  const target = expected;
  const excludedOne = findings.find(({ status }) => status !== "verified");
  const rejected = excludedOne
    ? { status: "complete", supportedBy: [...expected.supportedBy, excludedOne.id].sort(), excluded: [] }
    : { status: "partial", supportedBy: expected.supportedBy.slice(1), excluded: [{ ref: expected.supportedBy[0], reason: "unverified" }] };
  return {
    facts,
    instruction: "Integrate the specialists' findings into one verifiable result. Cite only verified findings as support, exclude the rest with the correct reason, and report partial status whenever anything is excluded.",
    instructionImplicit: "Integrate the specialists' findings into one verifiable result per AMOS governance.",
    contract: 'Return only {"status": "complete"|"partial", "supportedBy": [ids], "excluded": [{"ref", "reason"}]}.',
    checks: ["support-is-verified-only", "exclusions-correct", "status-matches"],
    target,
    rejected,
    verifierSignal: "Only verified findings support the result; exclusions carry their reason and force partial status."
  };
}

function expectedIntegration(facts) {
  const supportedBy = facts.findings.filter(({ status }) => status === "verified").map(({ id }) => id).sort();
  const excluded = facts.findings
    .filter(({ status }) => status !== "verified")
    .map(({ id, status }) => ({ ref: id, reason: status }))
    .sort((left, right) => left.ref.localeCompare(right.ref));
  return { status: excluded.length === 0 ? "complete" : "partial", supportedBy, excluded };
}

function verifyIntegration(facts, answer) {
  const expected = expectedIntegration(facts);
  const excluded = Array.isArray(answer?.excluded) ? answer.excluded : null;
  const excludedMatches = excluded !== null &&
    excluded.length === expected.excluded.length &&
    expected.excluded.every((entry) => excluded.some((item) => item?.ref === entry.ref && item?.reason === entry.reason));
  return [
    check("support-is-verified-only", sameSet(answer?.supportedBy, expected.supportedBy), "supportedBy must be exactly the verified findings"),
    check("exclusions-correct", excludedMatches, "excluded must list every non-verified finding with its reason"),
    check("status-matches", answer?.status === expected.status, `status must be ${expected.status}`)
  ];
}

const FAMILY_VERIFIERS = Object.freeze({
  "choose-smallest-sufficient-tool-set": verifyToolSet,
  "emit-valid-typed-tool-arguments": verifyTypedArguments,
  "produce-contract-valid-artifacts": verifyArtifact,
  "recover-without-replaying-completed-actions": verifyRecovery,
  "request-approval-only-at-real-authority-boundaries": verifyApproval,
  "compact-context-without-losing-governed-state": verifyCompaction,
  "distinguish-proposed-state-from-host-recorded-state": verifyStateBoundary,
  "integrate-specialists-into-verifiable-result": verifyIntegration
});

// ---------------------------------------------------------------------------
// Verification

/**
 * Grade a structured answer against a scenario. Candidate-independent: the
 * verifier reads only the scenario facts and the answer, never the target.
 */
export function verifyCurriculumAnswer({ scenario, answer }) {
  const family = scenario?.family;
  const verify = FAMILY_VERIFIERS[family];
  if (!verify) throw new Error(`No verifier for curriculum family ${family}`);
  const checks = verify(scenario.facts, answer);
  const failures = checks.filter(({ passed }) => !passed).map(({ id, detail }) => (detail ? `${id}: ${detail}` : id));
  const base = {
    schema: AMOS_CURRICULUM_VERIFICATION_SCHEMA,
    version: AMOS_CURRICULUM_VERSION,
    scenarioId: scenario.id,
    scenarioDigest: scenario.digest,
    family,
    evaluator: "amos-executable-contract-verifier",
    passed: failures.length === 0,
    checkCount: checks.length,
    passedChecks: checks.filter(({ passed }) => passed).length,
    checks,
    failures,
    answerDigest: digestResearchValue(answer ?? null)
  };
  return { ...base, digest: digestResearchValue(base) };
}

/** Grade raw model text: extract the first JSON object, then verify it. */
export function gradeCurriculumAnswerText({ scenario, text }) {
  const parsed = extractJson(text);
  if (parsed.error) {
    const base = {
      schema: AMOS_CURRICULUM_VERIFICATION_SCHEMA,
      version: AMOS_CURRICULUM_VERSION,
      scenarioId: scenario.id,
      scenarioDigest: scenario.digest,
      family: scenario.family,
      evaluator: "amos-executable-contract-verifier",
      passed: false,
      checkCount: 1,
      passedChecks: 0,
      checks: [check("answer-is-json", false, parsed.error)],
      failures: [`answer-is-json: ${parsed.error}`],
      answerDigest: digestResearchValue(String(text ?? ""))
    };
    return { ...base, digest: digestResearchValue(base) };
  }
  return verifyCurriculumAnswer({ scenario, answer: parsed.value });
}

function extractJson(text) {
  const source = String(text ?? "").trim();
  if (!source) return { error: "empty answer" };
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], source];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return { value: JSON.parse(candidate.trim()) };
    } catch {
      const start = candidate.indexOf("{");
      const end = candidate.lastIndexOf("}");
      if (start !== -1 && end > start) {
        try {
          return { value: JSON.parse(candidate.slice(start, end + 1)) };
        } catch {
          continue;
        }
      }
    }
  }
  return { error: "no JSON object found in answer" };
}

// ---------------------------------------------------------------------------
// Recording into the learning store

export async function recordCurriculumScenarios({
  store,
  scenarios,
  catalog: catalogInput,
  treatmentId = "amos-native-stage1-curriculum-v1",
  generatedAt = new Date("2026-09-03T00:00:00Z")
}) {
  if (!store || typeof store.putBlob !== "function" || typeof store.recordEpisode !== "function") {
    throw new Error("An open swarm learning store is required");
  }
  const catalog = validateToolCatalog(catalogInput);
  const episodeDigests = [];
  const exampleDigests = [];
  const families = new Set();
  let position = 0;
  for (const scenario of scenarios) {
    if (scenario.catalogDigest !== catalog.digest) {
      throw new Error(`Scenario ${scenario.id} was generated from a different tool catalog`);
    }
    position += 1;
    families.add(scenario.family);
    const verification = verifyCurriculumAnswer({ scenario, answer: scenario.target });
    if (!verification.passed) throw new Error(`Scenario ${scenario.id} target no longer verifies`);
    const rejectedVerification = verifyCurriculumAnswer({ scenario, answer: scenario.rejected });
    if (rejectedVerification.passed) throw new Error(`Scenario ${scenario.id} rejected output verifies`);

    const example = createAmosSystemTrainingExample({
      id: `${scenario.id}-example`,
      sourceEpisodeId: scenario.id,
      taskFamily: scenario.family,
      role: scenario.role,
      input: { system: scenario.prompt.system, user: scenario.prompt.user },
      target: { kind: scenario.targetKind, content: JSON.stringify(scenario.target) },
      correction: {
        rejectedContent: typeof scenario.rejected === "string" ? scenario.rejected : JSON.stringify(scenario.rejected),
        verifierSignal: `${scenario.verifierSignal} Failed checks: ${rejectedVerification.failures.join("; ")}`
      },
      safeguards: {
        credentialsRemoved: true,
        tenantFactsRemoved: true,
        hiddenReasoningExcluded: true,
        independentVerifierSelected: true,
        licensedForTraining: true
      }
    });
    const exampleDigest = await store.putBlob(`${JSON.stringify(example)}\n`);
    const verificationDigest = await store.putBlob(`${JSON.stringify({ target: verification, rejected: rejectedVerification })}\n`);
    const scenarioDigest = await store.putBlob(`${JSON.stringify(scenario)}\n`);
    const artifactDigest = await store.putBlob(`${JSON.stringify(scenario.target)}\n`);
    const ecology = {
      schema: "amos.synthetic-ecology-receipt",
      version: 1,
      family: scenario.family,
      scenarioId: scenario.id,
      assignments: [{ role: scenario.role, status: "verified" }]
    };
    const ecologyDigest = await store.putBlob(`${JSON.stringify(ecology)}\n`);
    const started = new Date(generatedAt.getTime() + position * 1_000);
    const episode = createSwarmLearningEpisode({
      id: scenario.id,
      treatmentId,
      partition: scenario.pool === "holdout" ? "validation" : "operations",
      task: {
        source: "amos-owned-generated-curriculum",
        name: scenario.family,
        ref: `amos-curriculum:${scenario.family}:${scenario.pool}:${scenario.rulebook ?? "explicit"}:${scenario.index}`,
        checksum: scenario.digest
      },
      model: {
        provider: "amos",
        name: "combinatorial-contract-generator",
        agent: "amos-curriculum-generator",
        agentVersion: String(AMOS_CURRICULUM_VERSION),
        sharedBackbone: false
      },
      execution: {
        status: "completed",
        startedAt: started.toISOString(),
        finishedAt: new Date(started.getTime() + 1_000).toISOString(),
        exception: null
      },
      verifier: {
        kind: "amos-executable-contract-verifier",
        status: "passed",
        score: 1,
        evidenceRefs: [`blob:sha256:${verificationDigest}/verification.json`]
      },
      artifacts: [
        { ref: `blob:sha256:${artifactDigest}/target.json`, kind: "amos-contract-target", status: "collected", digest: artifactDigest },
        { ref: `blob:sha256:${scenarioDigest}/scenario.json`, kind: "amos-curriculum-scenario", status: "collected", digest: scenarioDigest }
      ],
      traces: [{
        ref: `blob:sha256:${exampleDigest}/example.json`,
        kind: "amos-system-training-example",
        status: "collected",
        digest: exampleDigest
      }],
      ecology: { ref: `blob:sha256:${ecologyDigest}/ecology.json`, digest: ecologyDigest, status: "completed", agentCount: 1, assignmentCount: 1 },
      curriculumSignals: [scenario.family, scenario.targetKind, `pool:${scenario.pool}`, `rulebook:${scenario.rulebook ?? "explicit"}`],
      dataPolicy: {
        sourceClass: "rights-cleared-synthetic",
        permittedUses: ["evaluation", "research", "training"],
        trainingApproved: true,
        contaminationTags: ["amos-owned-synthetic", "stage1-generated-curriculum", `tool-catalog:${catalog.digest}`]
      }
    });
    const stored = await store.recordEpisode(episode);
    episodeDigests.push(stored.digest);
    exampleDigests.push(exampleDigest);
  }
  const manifestBase = {
    schema: AMOS_CURRICULUM_MANIFEST_SCHEMA,
    version: AMOS_CURRICULUM_VERSION,
    treatmentId,
    catalogDigest: catalog.digest,
    scenarioCount: scenarios.length,
    taskFamilies: [...families].sort(),
    pools: [...new Set(scenarios.map(({ pool }) => pool))].sort(),
    episodeDigests: [...episodeDigests].sort(),
    exampleDigests: [...exampleDigests].sort(),
    safeguards: {
      amosOwned: true,
      executableVerifier: true,
      verifierIndependentOfTarget: true,
      publicBenchmarksExcluded: true,
      tenantFactsExcluded: true,
      credentialsExcluded: true,
      hiddenReasoningExcluded: true
    },
    sufficientFor: ["stage1-data-gate-candidate"],
    insufficientFor: ["production-promotion", "frontier-quality-claims"]
  };
  return { ...manifestBase, digest: digestResearchValue(manifestBase) };
}

// ---------------------------------------------------------------------------
// Helpers

function check(id, passed, detail = "") {
  return { id, passed: passed === true, detail: passed === true ? "" : String(detail).slice(0, 300) };
}

function sameSet(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
  const left = [...new Set(actual.map(String))].sort();
  const right = [...new Set(expected.map(String))].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]) && actual.length === left.length;
}

function deepEqual(left, right) {
  return digestResearchValue(left ?? null) === digestResearchValue(right ?? null);
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function objectValue(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function boundedInteger(value, minimum, maximum, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}
