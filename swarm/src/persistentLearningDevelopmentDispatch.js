import { digestResearchValue } from "./experimentProtocol.js";
import { createOrganismLearningCandidate, recordOrganismLearningGate } from "./swarmOrganismLearningCycle.js";
import { SleepCandidateRegistry, sleepWorkFromCandidates, createArtifactReplayExecutor } from "./sleepCycleExecutors.js";
import { createCpuDevelopmentDispatch } from "./persistentLearningCpuBridge.js";

// Persistent-mind Slice 2 (increment 2 core): compose the EXISTING artifact-replay
// executor from an explicit operator-bound development input and dispatch it durably
// over the controller's authoritative EventStore via the CPU bridge. The existing
// artifact-replay executor performs local policy-artifact replay with ZERO model
// calls; a controller reflection is not authority — the operator development input is
// the explicit development-work boundary. No model/tool/GPU work, no resource started.

// operatorInput (fully determines the work so restarts dedup rather than re-run):
//   { candidate: { id, policy, optimizedParameters, createdAt(ISO), policySearchDigest?, transitionModelDigest?, rank? },
//     priorGate: { id, status, evaluator, receiptDigest, evaluatedAt(ISO), metrics?, feedbackSignals? },
//     episodes: [ { id, task } ] }
// createdAt + evaluatedAt are required and fixed by the operator: any wall-clock
// default would change the candidate digest each run and defeat restart dedup.
export function buildArtifactReplayDevelopmentDispatch({ store, operatorInput, missionId = "persistent-learning", now = () => new Date() }) {
  validateOperatorInput(operatorInput);
  const spec = operatorInput.candidate;
  const created = createOrganismLearningCandidate({
    id: spec.id,
    policy: spec.policy,
    optimizedParameters: spec.optimizedParameters,
    policySearchDigest: spec.policySearchDigest ?? digestResearchValue(`${spec.id}:policy-search`),
    transitionModelDigest: spec.transitionModelDigest ?? digestResearchValue(`${spec.id}:transition-model`),
    rank: spec.rank ?? 1,
    // A fixed operator-provided createdAt keeps the candidate digest (and thus the
    // work spec + dispatch binding) reproducible across restarts, so the SAME
    // operator input dedups instead of re-running under a new wall-clock digest.
    createdAt: new Date(spec.createdAt),
  });
  const gate = operatorInput.priorGate;
  const candidate = recordOrganismLearningGate(created, {
    id: gate.id, status: gate.status, evaluator: gate.evaluator, receiptDigest: gate.receiptDigest,
    metrics: gate.metrics ?? {}, feedbackSignals: gate.feedbackSignals ?? [],
    // Fixed operator-provided evaluatedAt keeps the gate (and candidate digest)
    // reproducible; without it normalizeGate stamps wall-clock time.
    evaluatedAt: gate.evaluatedAt,
  });
  const episodes = operatorInput.episodes.map((episode) => ({ id: episode.id, digest: digestResearchValue(episode.id), task: episode.task }));
  const registry = new SleepCandidateRegistry([candidate]);
  const executor = createArtifactReplayExecutor({ registry, episodes });
  const work = sleepWorkFromCandidates([candidate]).items[0];
  if (!work) throw new Error("operator candidate produced no artifact-replay work item");
  const { dispatch, journal } = createCpuDevelopmentDispatch({ store, executor, missionId, now });
  return {
    workKind: work.kind,
    journal,
    // The controller supplies the reflection action id + its bound observation; the
    // work item is the operator-approved artifact-replay unit.
    async dispatch(reflectionActionId, observation, options) {
      if (typeof reflectionActionId !== "string" || reflectionActionId.length === 0) throw new Error("reflectionActionId required");
      const action = { actionId: reflectionActionId, workKind: work.kind, observation };
      return dispatch(action, work, options);
    },
  };
}

function validateOperatorInput(input) {
  if (!input || typeof input !== "object") throw new Error("operator development input required");
  const c = input.candidate, g = input.priorGate;
  if (!c || typeof c.id !== "string" || !c.policy || typeof c.policy !== "object" || !Array.isArray(c.optimizedParameters)) {
    throw new Error("operator input.candidate {id, policy, optimizedParameters} required");
  }
  if (typeof c.createdAt !== "string" || Number.isNaN(Date.parse(c.createdAt))) {
    throw new Error("operator input.candidate.createdAt (ISO timestamp) required for reproducible dispatch");
  }
  if (!g || typeof g.id !== "string" || typeof g.status !== "string" || typeof g.evaluator !== "string" || typeof g.receiptDigest !== "string") {
    throw new Error("operator input.priorGate {id, status, evaluator, receiptDigest} required");
  }
  if (typeof g.evaluatedAt !== "string" || Number.isNaN(Date.parse(g.evaluatedAt))) {
    throw new Error("operator input.priorGate.evaluatedAt (ISO timestamp) required for reproducible dispatch");
  }
  if (!Array.isArray(input.episodes) || input.episodes.length === 0
    || !input.episodes.every((e) => e && typeof e.id === "string" && e.task && typeof e.task === "object")) {
    throw new Error("operator input.episodes [{id, task}] required");
  }
}
