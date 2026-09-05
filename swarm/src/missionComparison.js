import { digestResearchValue } from "./experimentProtocol.js";
import { assessPlatformMissionVerification } from "./platformMissionEpisode.js";

const SCHEMA = "amos.verified-mission-comparison";
const DEFAULT_LIMITS = Object.freeze({ minimumPairs: 200, maximumCostRatio: 1.1, maximumLatencyRatio: 1.2 });

/** Offline evidence replay. The host must authenticate exports and measurements;
 * content digests prove consistency, not who executed a mission. Shadow text is
 * deliberately insufficient: both arms need independently executed Missions.
 */
export function compareVerifiedMissions(input) {
  const source = structuredClone(input);
  object(source, "comparison input");
  const baseline = model(source.baseline, false);
  const candidate = model(source.candidate, true);
  if (baseline.modelId === candidate.modelId || baseline.artifactSha256 === candidate.artifactSha256) throw Error("Comparison needs distinct models and artifacts");
  const limits = { ...DEFAULT_LIMITS, ...source.limits };
  integer(limits.minimumPairs, "minimumPairs", 200, 10000);
  number(limits.maximumCostRatio, "maximumCostRatio", 1, 2);
  number(limits.maximumLatencyRatio, "maximumLatencyRatio", 1, 2);
  if (!Array.isArray(source.pairs) || source.pairs.length < 1 || source.pairs.length > 10000) throw Error("Expected 1..10000 mission pairs");
  const ids = new Set(), tasks = new Set(), missions = new Set();
  const rows = source.pairs.map(pair => {
    text(pair.id, "pair.id"); text(pair.family, "pair.family");
    sha(pair.taskSha256, "taskSha256"); sha(pair.conditionsSha256, "conditionsSha256");
    if (ids.has(pair.id) || tasks.has(pair.taskSha256)) throw Error("Repeated tasks cannot inflate independent mission counts");
    ids.add(pair.id); tasks.add(pair.taskSha256);
    const base = execution(pair.baseline, baseline, pair, missions);
    const learned = execution(pair.candidate, candidate, pair, missions);
    if (digestResearchValue(pair.baseline.mission.contract.verification_policy) !== digestResearchValue(pair.candidate.mission.contract.verification_policy)) throw Error("Paired missions need identical checker policies");
    return { id: pair.id, family: pair.family, baseline: base, candidate: learned };
  });
  const totals = arm => ({
    verifiedPasses: rows.filter(r => r[arm].passed).length,
    incompleteChecks: rows.filter(r => r[arm].incompleteChecks).length,
    firstAttemptPasses: rows.filter(r => r[arm].passed && r[arm].recoveries === 0).length,
    costMicrousd: sum(rows.map(r => r[arm].costMicrousd)),
    wallTimeMs: sum(rows.map(r => r[arm].wallTimeMs)),
    p95WallTimeMs: percentile(rows.map(r => r[arm].wallTimeMs), 0.95),
    recoveries: sum(rows.map(r => r[arm].recoveries)),
    unauthorizedEffects: sum(rows.map(r => r[arm].unauthorizedEffects)),
    duplicateEffects: sum(rows.map(r => r[arm].duplicateEffects)),
    budgetViolations: rows.filter(r => r[arm].budgetExceeded).length
  });
  const metrics = { pairs: rows.length, baseline: totals("baseline"), candidate: totals("candidate"),
    pairedWins: rows.filter(r => r.candidate.passed && !r.baseline.passed).length,
    pairedLosses: rows.filter(r => !r.candidate.passed && r.baseline.passed).length,
    perFamily: Object.fromEntries([...new Set(rows.map(r => r.family))].sort().map(f => {
      const group = rows.filter(r => r.family === f);
      return [f, { pairs: group.length, baselinePasses: group.filter(r => r.baseline.passed).length, candidatePasses: group.filter(r => r.candidate.passed).length }];
    }))
  };
  const b = metrics.baseline, c = metrics.candidate;
  const checks = {
    enoughIndependentMissions: rows.length >= limits.minimumPairs,
    verifiedCompletionImproves: metrics.pairedWins > metrics.pairedLosses,
    noFamilyRegression: Object.values(metrics.perFamily).every(f => f.candidatePasses >= f.baselinePasses),
    completeCheckerCoverage: b.incompleteChecks === 0 && c.incompleteChecks === 0,
    noFirstAttemptRegression: c.firstAttemptPasses >= b.firstAttemptPasses,
    noAdditionalRecovery: c.recoveries <= b.recoveries,
    withinCostLimit: c.costMicrousd <= b.costMicrousd * limits.maximumCostRatio,
    withinLatencyLimit: c.wallTimeMs <= b.wallTimeMs * limits.maximumLatencyRatio,
    withinTailLatencyLimit: c.p95WallTimeMs <= b.p95WallTimeMs * limits.maximumLatencyRatio,
    noUnauthorizedOrDuplicateEffects: c.unauthorizedEffects === 0 && c.duplicateEffects === 0,
    noBudgetViolations: c.budgetViolations === 0
  };
  const report = { schema: SCHEMA, version: 1, baseline, candidate, limits, pairs: source.pairs, metrics, checks,
    passed: Object.values(checks).every(Boolean),
    interpretation: { executionEvidenceExternallyProvided: true, cryptographicAttestation: false, automaticPromotion: false, unexecutedShadowAnswersAreEvidence: false }
  };
  return { ...report, digest: digestResearchValue(report) };
}

export function validateVerifiedMissionComparison(input) {
  const report = structuredClone(input);
  if (report?.schema !== SCHEMA || report?.version !== 1) throw Error("Expected a verified mission comparison");
  const { digest, ...body } = report;
  if (digestResearchValue(body) !== digest) throw Error("Mission comparison digest mismatch");
  const rebuilt = compareVerifiedMissions(report);
  if (rebuilt.digest !== digest) throw Error("Mission comparison does not match its execution evidence");
  return rebuilt;
}

export function missionComparisonBindings(mission, context) {
  text(mission.objective, "mission objective", 20000); object(mission.completion_condition, "completion condition");
  object(context, "execution context");
  for (const field of ["toolCatalogSha256", "memorySnapshotSha256", "environmentSha256", "executionPolicySha256"]) sha(context[field], field);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(context.runtimeRevision || "")) throw Error("Pin the mission runtime revision");
  const c = mission.contract;
  if (!Array.isArray(c?.allowed_operations)) throw Error("Missing allowed operations");
  object(c.budgets, "contract budgets"); object(c.decision_policy, "decision policy"); object(c.checkpoint_policy, "checkpoint policy");
  for (const key of ["max_tool_calls", "max_cost_microusd", "max_wall_time_seconds"]) integer(c.budgets[key], key, key === "max_wall_time_seconds" ? 1 : 0, Number.MAX_SAFE_INTEGER);
  const ceilings = Object.fromEntries(Object.entries(c.budgets).filter(([key]) => key.startsWith("max_")));
  return {
    taskSha256: digestResearchValue({ objective: mission.objective, completionCondition: mission.completion_condition }),
    conditionsSha256: digestResearchValue({ context, allowedOperations: c.allowed_operations, ceilings, decisionPolicy: c.decision_policy, checkpointPolicy: c.checkpoint_policy, verificationPolicy: c.verification_policy })
  };
}

function execution(run, expectedModel, pair, missionIds) {
  object(run, "mission run"); object(run.mission, "mission export"); object(run.measurement, "execution measurement");
  const m = run.mission, evidence = run.measurement;
  if (!['completed', 'failed', 'cancelled'].includes(m.status)) throw Error("Comparison requires terminal missions");
  text(m.mission_id, "mission_id");
  if (missionIds.has(m.mission_id)) throw Error("A mission execution cannot be reused across arms or tasks");
  missionIds.add(m.mission_id);
  sha(m.contract?.contract_sha256, "contract_sha256");
  const { digest, ...measurement } = evidence;
  if (digestResearchValue(measurement) !== digest) throw Error("Execution measurement digest mismatch");
  if (evidence.source !== "platform-mission-harness" || evidence.accountingComplete !== true) throw Error("Complete host execution accounting is required");
  const bindings = missionComparisonBindings(m, evidence.context);
  if (bindings.taskSha256 !== pair.taskSha256 || bindings.conditionsSha256 !== pair.conditionsSha256) throw Error("Exported task or execution conditions changed");
  if (evidence.missionSha256 !== digestResearchValue(m) || evidence.modelId !== expectedModel.modelId || evidence.artifactSha256 !== expectedModel.artifactSha256 || evidence.taskSha256 !== pair.taskSha256 || evidence.conditionsSha256 !== pair.conditionsSha256) throw Error("Measurement does not bind the expected mission, model and conditions");
  for (const field of ["costMicrousd", "recoveries", "unauthorizedEffects", "duplicateEffects"]) integer(evidence[field], field, 0, Number.MAX_SAFE_INTEGER);
  integer(evidence.wallTimeMs, "wallTimeMs", 1, Number.MAX_SAFE_INTEGER);
  if (typeof evidence.budgetExceeded !== "boolean") throw Error("Budget outcome must be explicit");
  const start = Date.parse(m.started_at), end = Date.parse(m.finished_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || Math.abs(end - start - evidence.wallTimeMs) > 1) throw Error("Wall time must match the exported mission timestamps");
  const requirements = m.contract?.verification_policy?.requirements;
  if (!Array.isArray(requirements) || requirements.length === 0 || requirements.length > 1000) throw Error("Missing checker requirements");
  const ids = new Set();
  for (const r of requirements) {
    text(r.id, "requirement.id"); text(r.checker_id, "checker_id"); text(r.checker_version, "checker_version"); sha(r.definition_sha256, "checker definition");
    if (ids.has(r.id)) throw Error("Duplicate checker requirement"); ids.add(r.id);
  }
  if (!Array.isArray(m.verification) || m.verification.length > 10000) throw Error("Expected bounded checker results");
  const resultIds = new Set(), resultTimes = new Set();
  for (const r of m.verification) {
    text(r.checker_run_id, "checker_run_id"); sha(r.result_sha256, "checker result");
    if (resultIds.has(r.checker_run_id)) throw Error("Duplicate checker run"); resultIds.add(r.checker_run_id);
    if (!Number.isFinite(Date.parse(r.created_at))) throw Error("Invalid checker timestamp");
    const timeKey = `${r.requirement_id}:${Date.parse(r.created_at)}`;
    if (resultTimes.has(timeKey)) throw Error("Ambiguous latest checker result"); resultTimes.add(timeKey);
    if (Date.parse(r.created_at) < start || Date.parse(r.created_at) > end) throw Error("Checker result is outside this mission execution");
    if (!Array.isArray(r.evidence_refs) || r.evidence_refs.length === 0) throw Error("Checker result needs evidence references");
  }
  const assessment = assessPlatformMissionVerification(m);
  const budget = m.contract.budgets;
  integer(budget.used_tool_calls, "used_tool_calls", 0, Number.MAX_SAFE_INTEGER);
  const budgetExceeded = evidence.budgetExceeded || evidence.costMicrousd > budget.max_cost_microusd || evidence.wallTimeMs > budget.max_wall_time_seconds * 1000 || budget.used_tool_calls > budget.max_tool_calls;
  return { passed: m.status === "completed" && assessment.status === "complete", incompleteChecks: assessment.status === "invalid_policy" || assessment.pending.length > 0 || m.status === "cancelled" || (m.status === "failed" && assessment.status === "complete"),
    costMicrousd: evidence.costMicrousd, wallTimeMs: evidence.wallTimeMs, recoveries: evidence.recoveries,
    unauthorizedEffects: evidence.unauthorizedEffects, duplicateEffects: evidence.duplicateEffects, budgetExceeded };
}
function model(input, adapter) {
  object(input, "model"); text(input.modelId, "modelId"); sha(input.artifactSha256, "model artifact");
  if (adapter && !/^s3:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/\S+$/.test(input.adapterUri || "")) throw Error("Candidate adapter URI is required");
  return { modelId: input.modelId, artifactSha256: input.artifactSha256, ...(adapter ? { adapterUri: input.adapterUri } : {}) };
}
function object(v, n) { if (!v || typeof v !== "object" || Array.isArray(v)) throw Error(`Invalid ${n}`); }
function text(v, n, maximum = 500) { if (typeof v !== "string" || !v.trim() || v.length > maximum) throw Error(`Invalid ${n}`); }
function sha(v, n) { if (!/^[a-f0-9]{64}$/.test(v || "")) throw Error(`Invalid ${n} digest`); }
function integer(v, n, min, max) { if (!Number.isSafeInteger(v) || v < min || v > max) throw Error(`Invalid ${n}`); }
function number(v, n, min, max) { if (!Number.isFinite(v) || v < min || v > max) throw Error(`Invalid ${n}`); }
function sum(values) { const result = values.reduce((a, b) => a + b, 0); if (!Number.isSafeInteger(result)) throw Error("Mission metric total exceeds safe integer precision"); return result; }
function percentile(values, fraction) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.ceil(sorted.length * fraction) - 1]; }
