import { digestResearchValue } from "./experimentProtocol.js";
import { PAIRED_COMPLETION_INTERVAL_METHOD } from "./pairedCompletionInterval.js";

export const EMPTY_PROCEDURE_SNAPSHOT_SHA256 = digestResearchValue({ schema: "amos.empty-procedure-snapshot", version: 1 });
export const MISSION_COMPARISON_PRIMARY_METRIC = "verified-first-attempt-completion";
const DIMENSIONS = ["weights", "procedures", "runtime", "promptCompiler", "schedulerPolicy", "inferenceConfig", "encoder"];

/** Producers must attest what actually ran; this only validates its identity. */
export function createMissionTreatment(fields) {
  return validateMissionTreatment(seal({ ...fields, schema: "amos.mission-treatment", version: 1 }));
}

export function validateMissionTreatment(input) {
  const t = structuredClone(input);
  exact(t, ["schema", "version", "model", "procedureSnapshotSha256", "runtimeRevision", "promptCompilerSha256", "schedulerPolicySha256", "inferenceConfigSha256", "encoderSha256", "digest"], "treatment");
  if (t.schema !== "amos.mission-treatment" || t.version !== 1) throw Error("Unsupported Mission treatment version");
  validDigest(t, "treatment");
  exact(t.model, ["modelId", "baseArtifactSha256", "adapter"], "treatment.model");
  text(t.model.modelId, "modelId"); sha(t.model.baseArtifactSha256, "base artifact");
  if (t.model.adapter !== null) {
    const a = t.model.adapter;
    exact(a, ["artifactSha256", "uri", "trainingContractSha256"], "adapter");
    sha(a.artifactSha256, "adapter artifact"); sha(a.trainingContractSha256, "training contract");
    if (!/^s3:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/\S+$/.test(a.uri || "")) throw Error("Adapter URI is required for an adapter treatment");
  }
  for (const field of ["procedureSnapshotSha256", "promptCompilerSha256", "schedulerPolicySha256", "inferenceConfigSha256"]) sha(t[field], field);
  if (t.encoderSha256 !== null) sha(t.encoderSha256, "encoder");
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(t.runtimeRevision || "")) throw Error("Pin the treatment runtime revision");
  return t;
}

export function createMissionComparisonProtocol(fields) {
  const tasks = sortedTasks(fields.tasks);
  return validateMissionComparisonProtocol(seal({
    ...fields, schema: "amos.mission-comparison-protocol", version: 1,
    tasks, taskSetSha256: digestResearchValue(tasks)
  }));
}

/** This manifest must be registered externally before either execution starts.
 * Digest replay cannot establish that registration happened, or seal a dataset.
 */
export function validateMissionComparisonProtocol(input) {
  const p = structuredClone(input);
  exact(p, ["schema", "version", "id", "registeredAt", "registrationRef", "tasks", "taskSetSha256", "baselineTreatmentSha256", "candidateTreatmentSha256", "changedDimensions", "primaryMetric", "confidenceMethod", "confidenceLevel", "minimumLift", "limits", "digest"], "comparison protocol");
  if (p.schema !== "amos.mission-comparison-protocol" || p.version !== 1) throw Error("Unsupported comparison protocol version");
  validDigest(p, "comparison protocol");
  text(p.id, "protocol.id"); text(p.registrationRef, "registrationRef");
  if (!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(p.registeredAt || "") || !Number.isFinite(Date.parse(p.registeredAt))) throw Error("Protocol needs a UTC registration timestamp");
  for (const field of ["baselineTreatmentSha256", "candidateTreatmentSha256", "taskSetSha256"]) sha(p[field], field);
  if (p.baselineTreatmentSha256 === p.candidateTreatmentSha256) throw Error("Protocol needs distinct treatments");
  if (!Array.isArray(p.changedDimensions) || p.changedDimensions.length === 0 || new Set(p.changedDimensions).size !== p.changedDimensions.length || p.changedDimensions.some(d => !DIMENSIONS.includes(d))) throw Error("Declare unique supported treatment dimensions");
  if (p.primaryMetric !== MISSION_COMPARISON_PRIMARY_METRIC || p.confidenceMethod !== PAIRED_COMPLETION_INTERVAL_METHOD || p.confidenceLevel !== 0.95) throw Error("Unsupported primary metric or confidence method");
  if (!Number.isFinite(p.minimumLift) || p.minimumLift < 0 || p.minimumLift >= 1) throw Error("Invalid minimum primary lift");
  exact(p.limits, ["minimumPairs", "maximumCostRatio", "maximumLatencyRatio"], "protocol limits");
  integer(p.limits.minimumPairs, "minimumPairs", 200, 10000);
  for (const [field, ceiling] of [["maximumCostRatio", 1.1], ["maximumLatencyRatio", 1.2]]) {
    if (!Number.isFinite(p.limits[field]) || p.limits[field] <= 0 || p.limits[field] > ceiling) throw Error(`Cannot relax ${field} in comparison v2`);
  }
  const tasks = sortedTasks(p.tasks), ids = new Set(), digests = new Set();
  for (const task of tasks) {
    exact(task, ["id", "family", "taskSha256", "conditionsSha256"], "registered task");
    text(task.id, "task.id"); text(task.family, "task.family");
    sha(task.taskSha256, "registered task"); sha(task.conditionsSha256, "registered conditions");
    if (ids.has(task.id) || digests.has(task.taskSha256)) throw Error("Repeated registered tasks cannot inflate independent mission counts");
    ids.add(task.id); digests.add(task.taskSha256);
  }
  if (digestResearchValue(tasks) !== p.taskSetSha256) throw Error("Registered task set digest mismatch");
  return p;
}

export function validateTreatmentContrast(baseline, candidate, protocol) {
  if (protocol.baselineTreatmentSha256 !== baseline.digest || protocol.candidateTreatmentSha256 !== candidate.digest) throw Error("Protocol does not bind the compared treatments");
  const weights = t => ({ base: t.model.baseArtifactSha256, adapter: t.model.adapter?.artifactSha256 ?? null });
  const changes = [];
  if (digestResearchValue(weights(baseline)) !== digestResearchValue(weights(candidate))) changes.push("weights");
  else if (digestResearchValue(baseline.model) !== digestResearchValue(candidate.model)) throw Error("Model aliases or metadata alone are not a weight treatment");
  const fields = { procedures: "procedureSnapshotSha256", runtime: "runtimeRevision", promptCompiler: "promptCompilerSha256", schedulerPolicy: "schedulerPolicySha256", inferenceConfig: "inferenceConfigSha256", encoder: "encoderSha256" };
  for (const [dimension, field] of Object.entries(fields)) if (baseline[field] !== candidate[field]) changes.push(dimension);
  if (digestResearchValue(changes.sort()) !== digestResearchValue([...protocol.changedDimensions].sort())) throw Error("Treatment changes do not match the preregistered contrast");
}

function sortedTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > 10000) throw Error("Expected 1..10000 registered tasks");
  return structuredClone(tasks).sort((a, b) => String(a?.id) < String(b?.id) ? -1 : String(a?.id) > String(b?.id) ? 1 : 0);
}
function seal(input) { const { digest, ...body } = input; return { ...body, digest: digestResearchValue(body) }; }
function validDigest(input, name) { const { digest, ...body } = input; if (digestResearchValue(body) !== digest) throw Error(`${name} digest mismatch`); }
function exact(value, fields, name) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some(k => !Object.hasOwn(value, k))) throw Error(`Invalid ${name} fields`); }
function text(value, name) { if (typeof value !== "string" || !value.trim() || value.length > 500) throw Error(`Invalid ${name}`); }
function sha(value, name) { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw Error(`Invalid ${name} digest`); }
function integer(value, name, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) throw Error(`Invalid ${name}`); }
