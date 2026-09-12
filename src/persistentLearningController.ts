import { digest, immutable } from "./digest.ts";
import type { EventStore } from "./eventStore.ts";

/** Operator-imported aggregates: a digest identifies evidence; it does not verify a verdict. */
export interface LearningObservation {
  readonly id: string;
  readonly modelId: string;
  readonly family: string;
  readonly passed: number;
  readonly total: number;
  readonly partition: "development" | "qualification";
  readonly cohortId: string;
  readonly evidenceSha256: string;
  readonly observedAt: string;
}

export interface ReflectionAction {
  readonly id: string;
  readonly type: "reflection";
  readonly observationId: string;
  readonly evidenceSha256: string;
}

export interface CapabilitySummary extends LearningObservation {
  readonly observationId: string;
  readonly failed: number;
  readonly passRate: number;
}

export interface CapabilitySelfModel {
  readonly schema: "amos.capability-self-model.v1";
  readonly evidenceBasis: "operator-imported-aggregate";
  readonly capabilities: readonly CapabilitySummary[];
  readonly qualityImprovementEstablished: false;
  readonly limitation: string;
}

export interface GapReflection {
  readonly schema: "amos.gap-reflection.v1";
  readonly id: string;
  readonly actionId: string;
  readonly observation: LearningObservation;
  readonly failed: number;
  readonly method: "deterministic-aggregate-reflection";
  readonly hypotheses: readonly Readonly<{ id: string; status: "unproven"; statement: string }>[];
  readonly nextSteps: readonly string[];
  readonly qualityImprovementEstablished: false;
  readonly incumbentChangeAllowed: false;
  readonly trainingRowsProduced: 0;
  readonly fitnessGranted: 0;
}

const OBSERVATION_TYPE = "learning.observation-imported.v1";
const REFLECTION_TYPE = "learning.gap-reflected.v1";
const MISSION_ID = "persistent-learning";
const OBSERVATION_KEYS = ["id", "modelId", "family", "passed", "total", "partition", "cohortId", "evidenceSha256", "observedAt"];
const ACTION_KEYS = ["id", "type", "observationId", "evidenceSha256"];

/** Single-writer, durable bookkeeping and bounded reflection; no model or tool execution. */
export class PersistentLearningController {
  readonly #store: EventStore;
  readonly #now: () => Date;

  constructor(options: { store: EventStore; now?: () => Date }) {
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date());
    this.#replay();
  }

  ingestObservation(input: unknown): LearningObservation {
    const observation = validateObservation(input);
    const { observations } = this.#replay();
    const existing = observations.get(observation.id);
    if (existing) {
      if (digest(existing) !== digest(observation)) throw new Error("Observation ID has a different payload");
      return existing;
    }
    this.#store.append({
      id: observationEventId(observation), type: OBSERVATION_TYPE, missionId: MISSION_ID,
      occurredAt: this.#timestamp(), authority: "organism", payload: { observation },
    });
    return observation;
  }

  selfModel(): CapabilitySelfModel {
    const { observations } = this.#replay();
    return immutable({
      schema: "amos.capability-self-model.v1" as const,
      evidenceBasis: "operator-imported-aggregate" as const,
      capabilities: sortedObservations(observations).map((observation) => ({
        ...observation, observationId: observation.id,
        failed: observation.total - observation.passed,
        passRate: observation.passed / observation.total,
      })),
      qualityImprovementEstablished: false as const,
      limitation: "Each entry describes one imported observation and cohort, not a pooled capability estimate. Evidence hashes identify artifacts, not verified truth. No subjective self-awareness or model-quality gain is established.",
    });
  }

  planNext(): ReflectionAction | null {
    const { observations, reflections } = this.#replay();
    const observation = sortedObservations(observations).find((item) =>
      item.passed < item.total && !reflections.has(actionFor(item).id));
    return observation ? actionFor(observation) : null;
  }

  reflect(input: unknown): GapReflection {
    const action = validateAction(input);
    const { observations, reflections } = this.#replay();
    const observation = observations.get(action.observationId);
    if (!observation || observation.passed === observation.total || digest(actionFor(observation)) !== digest(action)) {
      throw new Error("Reflection action is not bound to a failed imported observation");
    }
    const existing = reflections.get(action.id);
    if (existing) return existing;
    if (digest(this.planNext()) !== digest(action)) throw new Error("Reflection action is not the next planned action");
    const reflection = reflectionFor(observation);
    this.#store.append({
      id: reflection.id, type: REFLECTION_TYPE, missionId: MISSION_ID,
      occurredAt: this.#timestamp(), authority: "organism", payload: { reflection },
    });
    return reflection;
  }

  #timestamp(): string {
    const timestamp = this.#now().toISOString();
    canonicalTime(timestamp);
    return timestamp;
  }

  #replay(): { observations: Map<string, LearningObservation>; reflections: Map<string, GapReflection> } {
    const observations = new Map<string, LearningObservation>();
    const reflections = new Map<string, GapReflection>();
    for (const event of this.#store.events()) {
      if (event.type !== OBSERVATION_TYPE && event.type !== REFLECTION_TYPE) continue;
      if (event.authority !== "organism" || event.missionId !== MISSION_ID || event.hostReceiptId !== undefined) {
        throw new Error("Invalid learning-event authority or scope");
      }
      canonicalTime(event.occurredAt);
      if (event.type === OBSERVATION_TYPE) {
        const payload = exactObject(event.payload, ["observation"], "observation event");
        const observation = validateObservation(payload.observation);
        if (event.id !== observationEventId(observation) || observations.has(observation.id)) {
          throw new Error("Invalid or duplicate replayed observation");
        }
        observations.set(observation.id, observation);
      } else {
        const payload = exactObject(event.payload, ["reflection"], "reflection event");
        const raw = payload.reflection;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid replayed reflection");
        const claimed = raw as GapReflection;
        const imported = observations.get(validateObservation(claimed.observation).id);
        if (!imported || imported.passed === imported.total) throw new Error("Reflection has no failed source observation");
        const expected = reflectionFor(imported);
        if (event.id !== expected.id || digest(raw) !== digest(expected) || reflections.has(expected.actionId)) {
          throw new Error("Invalid or duplicate replayed reflection");
        }
        reflections.set(expected.actionId, expected);
      }
    }
    return { observations, reflections };
  }
}

function exactObject(input: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain JSON object`);
  }
  const record = input as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) {
    throw new TypeError(`${label} has missing or unexpected fields`);
  }
  return record;
}

function identifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)) {
    throw new TypeError(`${label} must be a bounded identifier`);
  }
}

function hash(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError("Expected lowercase SHA-256");
}

function canonicalTime(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError("Expected canonical UTC timestamp with milliseconds");
  }
}

function validateObservation(input: unknown): LearningObservation {
  const record = exactObject(input, OBSERVATION_KEYS, "observation");
  for (const field of ["id", "modelId", "family", "cohortId"]) identifier(record[field], field);
  hash(record.evidenceSha256);
  canonicalTime(record.observedAt);
  if (record.partition !== "development" && record.partition !== "qualification") throw new TypeError("Invalid partition");
  if (typeof record.total !== "number" || !Number.isSafeInteger(record.total) || record.total < 1 || record.total > 1_000_000
    || typeof record.passed !== "number" || !Number.isSafeInteger(record.passed) || Object.is(record.passed, -0)
    || record.passed < 0 || record.passed > record.total) throw new RangeError("Invalid bounded passed/total counts");
  return immutable(record) as unknown as LearningObservation;
}

function validateAction(input: unknown): ReflectionAction {
  const record = exactObject(input, ACTION_KEYS, "reflection action");
  identifier(record.id, "action id");
  identifier(record.observationId, "observation id");
  hash(record.evidenceSha256);
  if (record.type !== "reflection") throw new TypeError("Unsupported learning action");
  return immutable(record) as unknown as ReflectionAction;
}

function observationEventId(observation: LearningObservation): string {
  return `learning:observation:${digest(observation.id)}`;
}

function actionFor(observation: LearningObservation): ReflectionAction {
  return immutable({ id: `learning:reflect:${digest(observation)}`, type: "reflection" as const,
    observationId: observation.id, evidenceSha256: observation.evidenceSha256 });
}

function sortedObservations(observations: Map<string, LearningObservation>): LearningObservation[] {
  return [...observations.values()].sort((a, b) => a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function reflectionFor(observation: LearningObservation): GapReflection {
  const action = actionFor(observation);
  return immutable({
    schema: "amos.gap-reflection.v1" as const, id: `learning:reflection:${digest(action)}`,
    actionId: action.id, observation, failed: observation.total - observation.passed,
    method: "deterministic-aggregate-reflection" as const,
    hypotheses: [
      { id: "coverage-gap", status: "unproven" as const, statement: "Development coverage may not represent the failed behavior; aggregate counts cannot establish the cause." },
      { id: "behavior-or-runtime-gap", status: "unproven" as const, statement: "Model behavior, task difficulty, or execution conditions may explain failures; inspect separately permitted development evidence before attributing cause." },
    ],
    nextSteps: [
      "Preserve the incumbent; an imported aggregate and this reflection do not authorize replacement.",
      "Use separately permitted executable development validation to investigate the gap; keep cohort identities separate.",
      "Qualification cases and answers must not become training rows; this controller imports aggregates only.",
      "Predeclare a controlled experiment and its budget before training, inference, or promotion; reflection itself establishes no gain.",
    ],
    qualityImprovementEstablished: false as const, incumbentChangeAllowed: false as const,
    trainingRowsProduced: 0 as const, fitnessGranted: 0 as const,
  });
}
