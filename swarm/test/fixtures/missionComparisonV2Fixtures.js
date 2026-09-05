import { digestResearchValue } from "../../src/experimentProtocol.js";
import { missionComparisonBindings } from "../../src/missionComparison.js";
import { createMissionTreatment, createMissionComparisonProtocol, EMPTY_PROCEDURE_SNAPSHOT_SHA256, MISSION_COMPARISON_PRIMARY_METRIC } from "../../src/missionComparisonProtocol.js";
import { PAIRED_COMPLETION_INTERVAL_METHOD } from "../../src/pairedCompletionInterval.js";
import { missionComparisonInput, resignMeasurement } from "./missionComparisonFixtures.js";

// Synthetic compatibility evidence, never evidence of model quality or deployment.
export function missionComparisonV2Input(count = 200, { dimension = "weights", wins = 40 } = {}) {
  const old = missionComparisonInput(count);
  const common = {
    model: { modelId: "amos-qwen38-27b-fp8", baseArtifactSha256: "a".repeat(64), adapter: null },
    procedureSnapshotSha256: EMPTY_PROCEDURE_SNAPSHOT_SHA256, runtimeRevision: "5".repeat(40),
    promptCompilerSha256: "6".repeat(64), schedulerPolicySha256: "7".repeat(64),
    inferenceConfigSha256: "8".repeat(64), encoderSha256: null
  };
  const baseline = createMissionTreatment(common), candidateFields = structuredClone(common);
  if (dimension === "weights") candidateFields.model.adapter = { artifactSha256: "b".repeat(64), uri: old.candidate.adapterUri, trainingContractSha256: "a".repeat(64) };
  else if (dimension === "procedures") candidateFields.procedureSnapshotSha256 = "9".repeat(64);
  else if (dimension === "runtime") candidateFields.runtimeRevision = "9".repeat(40);
  else throw Error("Unsupported fixture dimension");
  const candidate = createMissionTreatment(candidateFields);
  const pairs = old.pairs.map((pair, index) => {
    setMissionPassed(pair.baseline, index >= wins);
    for (const arm of ["baseline", "candidate"]) {
      const run = pair[arm], m = run.measurement;
      delete m.modelId; delete m.artifactSha256; delete m.recoveries; delete m.context.runtimeRevision;
      m.context.runSeed = 42;
      Object.assign(m, missionComparisonBindings(run.mission, m.context, 2));
      m.treatmentSha256 = (arm === "baseline" ? baseline : candidate).digest;
      m.compiledInputSha256 = digestResearchValue({ task: index, procedures: arm === "candidate" && dimension === "procedures" });
      m.recoveryEvidence = { version: 1, coverage: "complete", unexpectedCorrections: 0, requiredRecoveries: 0, evidenceRefs: [`fixture://${run.mission.mission_id}/complete-host-trace`] };
    }
    Object.assign(pair, missionComparisonBindings(pair.baseline.mission, pair.baseline.measurement.context, 2));
    return pair;
  });
  const input = { version: 2, baseline, candidate, pairs, protocol: {
    id: "fixture-v2", registeredAt: "2026-09-05T09:00:00Z", registrationRef: "fixture://preregistration-before-execution",
    baselineTreatmentSha256: baseline.digest, candidateTreatmentSha256: candidate.digest,
    changedDimensions: [dimension], primaryMetric: MISSION_COMPARISON_PRIMARY_METRIC,
    confidenceMethod: PAIRED_COMPLETION_INTERVAL_METHOD, confidenceLevel: 0.95, minimumLift: 0,
    limits: { minimumPairs: 200, maximumCostRatio: 1.1, maximumLatencyRatio: 1.2 },
    tasks: pairs.map(({ id, family, taskSha256, conditionsSha256 }) => ({ id, family, taskSha256, conditionsSha256 }))
  } };
  refreshProtocol(input);
  return input;
}

export function refreshProtocol(input) {
  input.protocol = createMissionComparisonProtocol(input.protocol);
  for (const pair of input.pairs) for (const arm of ["baseline", "candidate"]) {
    pair[arm].measurement.protocolSha256 = input.protocol.digest;
    resignMeasurement(pair[arm]);
  }
}

export function setMissionPassed(run, passed) {
  run.mission.status = passed ? "completed" : "failed";
  run.mission.verification[0].verdict = passed ? "pass" : "fail";
  run.mission.verification[0].result_sha256 = digestResearchValue({ id: run.mission.mission_id, passed });
  resignMeasurement(run);
}
