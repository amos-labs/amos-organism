const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const PUBLIC_FRESHNESS = { historical: "boolean", observedAt: "string", note: "string" };
const TOOLS = {
  inspect_site: { kind: "site", key: "slug", inspect: true },
  inspect_collection: { kind: "collection", key: "name", inspect: true },
  create_site: { kind: "site", key: "slug", inspect: false },
  update_site: { kind: "site", key: "slug", inspect: false },
  create_collection: { kind: "collection", key: "name", inspect: false }
};

/** Project public observations, never intended effects. sourcedAt is a zero-based event index. */
export function projectObservedTaskState(events) {
  return project(publicEvents(events));
}

/** Both arms retain public freshness fields; arbitrary metadata is excluded from both. */
export function formatObservedContext(events, mode = "history") {
  if (!["history", "typed"].includes(mode)) throw new TypeError("unsupported observed context mode");
  const observed = publicEvents(events);
  return mode === "history" ? { mode, events: observed } : { mode, state: project(observed) };
}

function project(events) {
  const state = {
    sitesBySlug: {}, collectionsByName: {}, unresolvedEffects: [], errors: [],
    observationCount: events.length
  };
  for (const [sourcedAt, event] of events.entries()) {
    const { name, args, result } = event;
    const evidence = { ...event, sourcedAt };
    const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name] : null;
    if (!tool) {
      // Preserve unfamiliar public output rather than silently treating it as verified state.
      state.errors.push({ kind: "unprojected-observation", ...evidence });
      continue;
    }
    requireRecord(result, `${name}.result`);
    if (typeof result.ok !== "boolean") throw new TypeError(`${name}.result.ok must be boolean`);
    if (!result.ok) {
      requireRecord(result.error, `${name}.result.error`);
      requireText(result.error.code, "error.code");
      requireText(result.error.message, "error.message");
      state.errors.push({ kind: "tool-error", ...evidence });
      if (!tool.inspect && result.error.code === "outcome_unknown") {
        const affected = mutationTarget(tool, name, args, state);
        state.unresolvedEffects.push({ ...evidence, affected });
        for (const key of affected.keys) invalidate(table(state, tool.kind), key, sourcedAt);
      }
      continue;
    }

    if (!Object.hasOwn(result, tool.kind)) throw new TypeError(`${name} result lacks ${tool.kind}`);
    const value = result[tool.kind];
    let key;
    if (value === null) {
      if (!tool.inspect) throw new TypeError(`${name} success must return an entity`);
      key = requireKey(args[tool.key], `${name}.args.${tool.key}`);
    } else {
      requireRecord(value, `${name}.result.${tool.kind}`);
      requireText(value.id, `${tool.kind}.id`);
      key = requireKey(value[tool.key], `${tool.kind}.${tool.key}`);
      if (tool.inspect && requireKey(args[tool.key], `${name}.args.${tool.key}`) !== key) {
        throw new TypeError(`${name} response does not match its requested lookup`);
      }
    }
    const entities = table(state, tool.kind);
    if (tool.inspect && event.historical !== true) {
      // A read establishes current state, not whether the earlier unknown write ever applied.
      state.unresolvedEffects = state.unresolvedEffects.filter(effect => !matches(effect, tool.kind, key, value));
    }
    const ambiguity = state.unresolvedEffects
      .filter(effect => matches(effect, tool.kind, key, value))
      .map(effect => effect.sourcedAt);
    const observation = { value, sourcedAt };
    for (const field of ["observedAt", "note"]) {
      if (Object.hasOwn(event, field)) observation[field] = event[field];
    }
    if (event.historical === true) {
      entities[key] = { lastObserved: observation, historical: true, ...(ambiguity.length ? { ambiguity } : {}) };
    } else {
      if (Object.hasOwn(event, "historical")) observation.historical = event.historical;
      entities[key] = ambiguity.length ? { lastObserved: observation, ambiguity } : observation;
    }
  }
  return state;
}

function mutationTarget(tool, name, args, state) {
  if (name === "update_site") {
    const id = requireText(args.siteId, "update_site.args.siteId");
    const keys = Object.entries(state.sitesBySlug)
      .filter(([, entry]) => (entry.lastObserved ?? entry).value?.id === id)
      .map(([key]) => key);
    return { kind: "site", id, keys };
  }
  return { kind: tool.kind, id: null, keys: [requireKey(args[tool.key], `${name}.args.${tool.key}`)] };
}

function matches(effect, kind, key, value) {
  return effect.affected.kind === kind && (
    effect.affected.keys.includes(key) || (value !== null && effect.affected.id === value.id)
  );
}

function invalidate(entities, key, sourcedAt) {
  if (!Object.hasOwn(entities, key)) return; // A request cannot manufacture an earlier observation.
  const previous = entities[key];
  entities[key] = {
    lastObserved: previous.lastObserved ?? previous,
    ...(previous.historical === true ? { historical: true } : {}),
    ambiguity: [...(previous.ambiguity ?? []), sourcedAt]
  };
}

function table(state, kind) {
  return kind === "site" ? state.sitesBySlug : state.collectionsByName;
}

function publicEvents(events) {
  if (!Array.isArray(events) || Object.getPrototypeOf(events) !== Array.prototype) {
    throw new TypeError("events must be a plain array");
  }
  if (Reflect.ownKeys(events).length !== events.length + 1) {
    throw new TypeError("events must be a dense JSON array without extra properties");
  }
  return Array.from({ length: events.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(events, index);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
      throw new TypeError("events must contain data entries");
    }
    const event = descriptor.value;
    requireRecord(event, `events[${index}]`);
    const descriptors = safeDescriptors(event, `events[${index}]`);
    for (const field of ["name", "args", "result"]) {
      if (!Object.hasOwn(descriptors, field)) throw new TypeError(`event lacks ${field}`);
    }
    const name = requireText(descriptors.name.value, "event.name");
    const args = copyJson(descriptors.args.value);
    requireRecord(args, "event.args");
    const result = copyJson(descriptors.result.value);
    const observed = { name, args, result };
    for (const [field, type] of Object.entries(PUBLIC_FRESHNESS)) {
      if (!Object.hasOwn(descriptors, field)) continue;
      if (typeof descriptors[field].value !== type) throw new TypeError(`event.${field} must be ${type}`);
      observed[field] = descriptors[field].value;
    }
    return observed;
  });
}

function requireRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a nonempty string`);
  return value;
}

function requireKey(value, label) {
  requireText(value, label);
  if (UNSAFE_KEYS.has(value)) throw new TypeError(`${label} is an unsafe key`);
  return value;
}

function safeDescriptors(value, label) {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== "string" || UNSAFE_KEYS.has(key) ||
        !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
      throw new TypeError(`${label} must contain safe enumerable data properties`);
    }
  }
  return descriptors;
}

function copyJson(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || ancestors.has(value)) throw new TypeError("public evidence must be acyclic JSON data");
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError("public arrays must have a safe prototype");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== value.length + 1) throw new TypeError("public arrays must be dense JSON arrays");
    result = Array.from({ length: value.length }, (_, index) => {
      const descriptor = descriptors[index];
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
        throw new TypeError("public arrays must contain data entries");
      }
      return copyJson(descriptor.value, ancestors);
    });
  } else {
    requireRecord(value, "public evidence");
    result = Object.fromEntries(Object.entries(safeDescriptors(value, "public evidence"))
      .map(([key, descriptor]) => [key, copyJson(descriptor.value, ancestors)]));
  }
  ancestors.delete(value);
  return result;
}
