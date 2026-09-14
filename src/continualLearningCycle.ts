import { digest, immutable } from "./digest.ts";
import type { EventStore, OrganismEvent } from "./eventStore.ts";
import type { LearningObservation } from "./persistentLearningController.ts";

export interface LearningCheckpoint {
  readonly modelId: string;
  readonly weightsSha256: string;
  readonly configSha256: string;
}

export interface LearningCycleInput {
  readonly cycleId: string;
  readonly objectiveId: string;
  readonly observationId: string;
  readonly parent: LearningCheckpoint;
  readonly inputSha256: string;
  readonly workKind: string;
  readonly workSpecSha256: string;
}

export interface LearningCycleSelection extends LearningCycleInput {
  readonly schema: "amos.learning-cycle-selection.v1";
  readonly sequence: number;
  readonly previousCycleId: string | null;
  readonly parentCycleId: string | null;
  readonly observation: LearningObservation;
  readonly dispatchActionId: string;
  readonly dispatchKey: string;
}

/** Imported research decisions, never inferred from dispatch completion or applied to serving. */
export interface LearningCycleDecision {
  readonly cycleId: string;
  readonly outcome: "accepted" | "rejected" | "inconclusive";
  readonly parent: LearningCheckpoint;
  readonly candidate: LearningCheckpoint | null;
  readonly receiptDigest: string;
  readonly evidenceSha256: string;
  readonly evidenceKind: "cpu-development" | "exported-training-evaluation";
  readonly externalRunSha256: string | null;
  readonly reason: string;
}

export interface LearningCycleRecord {
  readonly selection: LearningCycleSelection;
  readonly dispatchState: string | null;
  readonly receiptDigest: string | null;
  readonly decision: LearningCycleDecision | null;
}

export interface LearningCycleState {
  readonly schema: "amos.continual-learning-cycles.v1";
  readonly initialParent: LearningCheckpoint | null;
  readonly acceptedParent: LearningCheckpoint | null;
  readonly acceptedParentCycleId: string | null;
  readonly activeCycleId: string | null;
  readonly cycles: readonly LearningCycleRecord[];
  readonly qualityImprovementEstablished: false;
  readonly servingChanged: false;
}

const MISSION = "persistent-learning";
const INITIAL = "learning.cycle-parent-initialized.v1";
const SELECTED = "learning.cycle-selected.v1";
const DECIDED = "learning.cycle-decided.v1";
const DISPATCH = "learning.cpu-dispatch-state.v1";
const INPUT_KEYS = ["cycleId", "objectiveId", "observationId", "parent", "inputSha256", "workKind", "workSpecSha256"];
const DECISION_KEYS = ["cycleId", "outcome", "parent", "candidate", "receiptDigest", "evidenceSha256", "evidenceKind", "externalRunSha256", "reason"];

/** Cycle selection/lineage over the existing single-writer journal, not an executor or scheduler. */
export class ContinualLearningCycles {
  readonly #store: EventStore;
  readonly #now: () => Date;

  constructor(options: { store: EventStore; now?: () => Date }) {
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date());
    this.state();
  }

  initializeParent(input: unknown): LearningCheckpoint {
    const checkpoint = validateCheckpoint(input);
    const state = this.state();
    if (state.initialParent) {
      if (digest(checkpoint) !== digest(state.initialParent)) throw new Error("Initial learning parent cannot change");
      return state.initialParent;
    }
    this.#append(INITIAL, "learning:cycle-parent", { checkpoint });
    return checkpoint;
  }

  select(input: unknown, observation: LearningObservation): LearningCycleSelection {
    const selectionInput = validateCycleInput(input);
    assertObservationBound(observation, this.#store.events());
    const state = this.state();
    const existing = state.cycles.find(row => row.selection.cycleId === selectionInput.cycleId);
    if (existing) {
      const expected = makeSelection(selectionInput, observation, existing.selection.sequence,
        existing.selection.previousCycleId, existing.selection.parentCycleId);
      if (digest(expected) !== digest(existing.selection)) throw new Error("Cycle ID has different inputs; refusing to rebind");
      return existing.selection;
    }
    assertSelectable(state, selectionInput);
    const selection = makeSelection(selectionInput, observation, state.cycles.length + 1,
      state.cycles.at(-1)?.selection.cycleId ?? null, state.acceptedParentCycleId);
    assertUnusedDispatchKey(selection.dispatchKey, this.#store.events());
    this.#append(SELECTED, `learning:cycle-selected:${digest(selectionInput.cycleId)}`, { selection });
    return selection;
  }

  decide(input: unknown): LearningCycleDecision {
    const decision = validateCycleDecision(input);
    const state = this.state();
    const cycle = state.cycles.find(row => row.selection.cycleId === decision.cycleId);
    if (cycle?.decision) {
      if (digest(cycle.decision) !== digest(decision)) throw new Error("Terminal cycle decision cannot change");
      return cycle.decision;
    }
    assertDecision(state, cycle, decision);
    this.#append(DECIDED, `learning:cycle-decided:${digest(decision.cycleId)}`, { decision });
    return decision;
  }

  state(): LearningCycleState {
    let initialParent: LearningCheckpoint | null = null;
    let acceptedParent: LearningCheckpoint | null = null;
    let acceptedParentCycleId: string | null = null;
    let activeCycleId: string | null = null;
    const cycles: LearningCycleRecord[] = [];
    const snapshot = (): LearningCycleState => ({ schema: "amos.continual-learning-cycles.v1", initialParent,
      acceptedParent, acceptedParentCycleId, activeCycleId, cycles,
      qualityImprovementEstablished: false, servingChanged: false });
    for (const event of this.#store.events()) {
      if (![INITIAL, SELECTED, DECIDED, DISPATCH].includes(event.type)) continue;
      // Pre-existing CPU work belongs to the legacy path, never implicitly to a new cycle.
      const dispatchIndex = event.type === DISPATCH ? cycles.findIndex(row => row.selection.dispatchKey === event.payload.key) : -1;
      if (event.type === DISPATCH && dispatchIndex < 0) continue;
      if (event.missionId !== MISSION || event.authority !== "organism" || event.hostReceiptId !== undefined) {
        throw new Error("Invalid learning-cycle event authority or scope");
      }
      timestamp(event.occurredAt);
      if (event.type === INITIAL) {
        const payload = exact(event.payload, ["checkpoint"]);
        if (initialParent || event.id !== "learning:cycle-parent") throw new Error("Invalid duplicate initial parent");
        initialParent = validateCheckpoint(payload.checkpoint);
        acceptedParent = initialParent;
      } else if (event.type === SELECTED) {
        const raw = exact(event.payload, ["selection"]).selection;
        const row = exact(raw, [...INPUT_KEYS, "schema", "sequence", "previousCycleId", "parentCycleId", "observation", "dispatchActionId", "dispatchKey"]);
        const input = validateCycleInput(Object.fromEntries(INPUT_KEYS.map(key => [key, row[key]])));
        assertObservationBound(row.observation as LearningObservation, this.#store.events().slice(0, event.sequence - 1));
        assertSelectable(snapshot(), input);
        if (cycles.some(cycle => cycle.selection.cycleId === input.cycleId)) throw new Error("Duplicate replayed cycle");
        const selection = makeSelection(input, row.observation as LearningObservation, cycles.length + 1,
          cycles.at(-1)?.selection.cycleId ?? null, acceptedParentCycleId);
        assertUnusedDispatchKey(selection.dispatchKey, this.#store.events().slice(0, event.sequence - 1));
        if (digest(selection) !== digest(raw) || event.id !== `learning:cycle-selected:${digest(input.cycleId)}`) {
          throw new Error("Invalid replayed cycle selection");
        }
        cycles.push({ selection, dispatchState: null, receiptDigest: null, decision: null });
        activeCycleId = input.cycleId;
      } else if (event.type === DISPATCH) {
        const cycle = cycles[dispatchIndex]!;
        const record = event.payload;
        if (cycle.decision || record.actionId !== cycle.selection.dispatchActionId || record.workKind !== cycle.selection.workKind
          || record.workSpecDigest !== cycle.selection.workSpecSha256) throw new Error("Dispatch differs from frozen cycle or follows terminal decision");
        const transitions: Record<string, readonly string[]> = {
          none: ["submitted"], submitted: ["running", "reconciling"], running: ["completed", "reconciling"],
          reconciling: ["completed", "unresolved", "running"], unresolved: ["reconciling"], completed: [],
        };
        if (typeof record.state !== "string" || !transitions[cycle.dispatchState ?? "none"]?.includes(record.state)) {
          throw new Error("Invalid cycle dispatch transition; refusing duplicate dispatch");
        }
        if (record.state === "completed") hash(record.receiptDigest);
        cycles[dispatchIndex] = { ...cycle, dispatchState: record.state,
          receiptDigest: record.state === "completed" ? record.receiptDigest as string : null };
      } else {
        const decision = validateCycleDecision(exact(event.payload, ["decision"]).decision);
        const index = cycles.findIndex(cycle => cycle.selection.cycleId === decision.cycleId);
        const cycle = cycles[index];
        assertDecision(snapshot(), cycle, decision);
        if (event.id !== `learning:cycle-decided:${digest(decision.cycleId)}`) throw new Error("Invalid cycle decision identity");
        cycles[index] = { ...cycle!, decision };
        if (decision.outcome === "accepted") {
          acceptedParent = decision.candidate;
          acceptedParentCycleId = decision.cycleId;
        }
        activeCycleId = null;
      }
    }
    return immutable(snapshot());
  }

  #append(type: string, id: string, payload: Record<string, unknown>): void {
    const occurredAt = this.#now().toISOString();
    timestamp(occurredAt);
    this.#store.append({ id, type, missionId: MISSION, occurredAt, authority: "organism", payload });
  }
}

function assertSelectable(state: LearningCycleState, input: LearningCycleInput): void {
  if (!state.acceptedParent) throw new Error("Initialize the accepted learning parent before selecting a cycle");
  if (state.activeCycleId) throw new Error("An active cycle must reach a terminal decision before selecting fresh work");
  if (state.cycles.some(row => row.selection.objectiveId === input.objectiveId)) throw new Error("Objective already consumed; no same-objective retry");
  if (state.cycles.some(row => row.selection.inputSha256 === input.inputSha256 || row.selection.workSpecSha256 === input.workSpecSha256)) {
    throw new Error("Cycle work already consumed; renaming it cannot authorize another dispatch");
  }
  if (digest(state.acceptedParent) !== digest(input.parent)) throw new Error("Cycle must start from the last accepted parent");
}

function assertUnusedDispatchKey(key: string, events: readonly OrganismEvent[]): void {
  if (events.some(event => event.type === DISPATCH && event.payload.key === key)) throw new Error("Cycle dispatch identity was already used before selection");
}

function assertObservationBound(observation: LearningObservation, events: readonly OrganismEvent[]): void {
  const source = events.find(event => event.type === "learning.observation-imported.v1"
    && event.id === `learning:observation:${digest(observation?.id)}`);
  if (!source || source.authority !== "organism" || source.missionId !== MISSION || source.hostReceiptId !== undefined
    || digest(exact(source.payload, ["observation"]).observation) !== digest(observation)) {
    throw new Error("Cycle observation is not bound to prior imported evidence");
  }
}

function assertDecision(state: LearningCycleState, cycle: LearningCycleRecord | undefined, decision: LearningCycleDecision): void {
  if (!cycle || cycle.decision || state.activeCycleId !== decision.cycleId) throw new Error("Decision requires the active nonterminal cycle");
  if (cycle.dispatchState !== "completed" || cycle.receiptDigest !== decision.receiptDigest) {
    throw new Error("Decision requires the matching completed dispatch receipt; unresolved work cannot advance");
  }
  if (digest(decision.parent) !== digest(cycle.selection.parent)) throw new Error("Decision parent differs from frozen cycle parent");
  if (decision.outcome === "accepted" && (!decision.candidate || decision.candidate.weightsSha256 === decision.parent.weightsSha256)) {
    throw new Error("An accepted child must identify different weight bytes");
  }
  if (decision.outcome === "accepted" && (decision.candidate!.weightsSha256 === state.initialParent?.weightsSha256
    || state.cycles.some(row => row.decision?.candidate?.weightsSha256 === decision.candidate!.weightsSha256))) {
    throw new Error("Accepted child must be fresh, not a previous ancestor or rejected checkpoint");
  }
}

function makeSelection(input: LearningCycleInput, observation: LearningObservation, sequence: number,
  previousCycleId: string | null, parentCycleId: string | null): LearningCycleSelection {
  // The controller supplies the validated imported observation; replay checks its entire shape too.
  const raw = exact(observation, ["id", "modelId", "family", "passed", "total", "partition", "cohortId", "evidenceSha256", "observedAt"]);
  for (const key of ["id", "modelId", "family", "cohortId"]) identifier(raw[key]);
  hash(raw.evidenceSha256); timestamp(raw.observedAt);
  if (raw.id !== input.observationId || !Number.isSafeInteger(raw.total) || (raw.total as number) < 1
    || (raw.total as number) > 1_000_000 || !Number.isSafeInteger(raw.passed) || Object.is(raw.passed, -0)
    || (raw.passed as number) < 0 || (raw.passed as number) > (raw.total as number)
    || !["development", "qualification"].includes(raw.partition as string)) throw new Error("Invalid cycle source observation");
  const dispatchActionId = `learning:cycle-dispatch:${digest(input.cycleId)}`;
  const dispatchKey = digest({ actionId: dispatchActionId, workKind: input.workKind,
    modelId: observation.modelId, family: observation.family, cohortId: observation.cohortId });
  return immutable({ ...input, schema: "amos.learning-cycle-selection.v1", sequence, previousCycleId, parentCycleId,
    observation, dispatchActionId, dispatchKey });
}

export function validateCheckpoint(input: unknown): LearningCheckpoint {
  const row = exact(input, ["modelId", "weightsSha256", "configSha256"]);
  identifier(row.modelId); hash(row.weightsSha256); hash(row.configSha256);
  return immutable(row) as unknown as LearningCheckpoint;
}

export function validateCycleInput(input: unknown): LearningCycleInput {
  const row = exact(input, INPUT_KEYS);
  for (const key of ["cycleId", "objectiveId", "observationId", "workKind"]) identifier(row[key]);
  hash(row.inputSha256); hash(row.workSpecSha256); validateCheckpoint(row.parent);
  return immutable(row) as unknown as LearningCycleInput;
}

export function validateCycleDecision(input: unknown): LearningCycleDecision {
  const row = exact(input, DECISION_KEYS);
  identifier(row.cycleId); validateCheckpoint(row.parent);
  if (row.candidate !== null) validateCheckpoint(row.candidate);
  hash(row.receiptDigest); hash(row.evidenceSha256);
  if (!["accepted", "rejected", "inconclusive"].includes(row.outcome as string)) throw new TypeError("Invalid cycle outcome");
  if (!["cpu-development", "exported-training-evaluation"].includes(row.evidenceKind as string)) throw new TypeError("Invalid decision evidence kind");
  if (row.evidenceKind === "exported-training-evaluation") hash(row.externalRunSha256);
  else if (row.externalRunSha256 !== null) throw new TypeError("CPU development cannot claim an external training run");
  if (typeof row.reason !== "string" || row.reason.trim().length === 0 || row.reason.length > 2048) throw new TypeError("Bounded decision reason required");
  return immutable(row) as unknown as LearningCycleDecision;
}

function exact(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError("Expected plain cycle JSON object");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== keys.length || keys.some(key => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key]!, "value"))) {
    throw new TypeError("Cycle object has missing, unexpected or non-data fields");
  }
  return input as Record<string, unknown>;
}

function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)) throw new TypeError("Expected bounded cycle identifier");
}

function hash(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError("Expected lowercase SHA-256");
}

function timestamp(value: unknown): void {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new TypeError("Expected canonical cycle timestamp");
}
