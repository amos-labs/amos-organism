import { digestResearchValue } from "./experimentProtocol.js";
import { assessPlatformMissionVerification } from "./platformMissionEpisode.js";
import { validateMissionTreatment, validateMissionComparisonProtocol, validateTreatmentContrast } from "./missionComparisonProtocol.js";
import { pairedCompletionInterval } from "./pairedCompletionInterval.js";

const SCHEMA = "amos.verified-mission-comparison";
const DEFAULT_LIMITS = Object.freeze({ minimumPairs: 200, maximumCostRatio: 1.1, maximumLatencyRatio: 1.2 });

/** Offline evidence replay. The host must authenticate exports and measurements;
 * content digests prove consistency, not who executed a mission. Shadow text is
 * deliberately insufficient: both arms need independently executed Missions.
 */
export function compareVerifiedMissions(input) {
  if (input?.version === 2) return compareVerifiedMissionsV2(input);
  if (input?.version !== undefined && input.version !== 1) throw Error("Unsupported Mission comparison version");
  return compareVerifiedMissionsV1(input);
}

function compareVerifiedMissionsV1(input) {
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
  if (report?.schema !== SCHEMA || ![1, 2].includes(report?.version)) throw Error("Expected a verified mission comparison");
  const { digest, ...body } = report;
  if (digestResearchValue(body) !== digest) throw Error("Mission comparison digest mismatch");
  const rebuilt = compareVerifiedMissions(report);
  if (rebuilt.digest !== digest) throw Error("Mission comparison does not match its execution evidence");
  return rebuilt;
}

export function missionComparisonBindings(mission, context, version = 1) {
  text(mission.objective, "mission objective", 20000); object(mission.completion_condition, "completion condition");
  object(context, "execution context");
  for (const field of ["toolCatalogSha256", "memorySnapshotSha256", "environmentSha256", "executionPolicySha256"]) sha(context[field], field);
  if (version === 1) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(context.runtimeRevision || "")) throw Error("Pin the mission runtime revision");
  } else if (version === 2) {
    const fields = ["toolCatalogSha256", "memorySnapshotSha256", "environmentSha256", "executionPolicySha256", "runSeed"];
    if (Object.keys(context).length !== fields.length || fields.some(f => !Object.hasOwn(context, f))) throw Error("V2 context binds business memory and run seed; runtime belongs to treatment");
    integer(context.runSeed, "runSeed", 0, 2 ** 32 - 1);
  } else throw Error("Unsupported Mission binding version");
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

function execution(run, expectedModel, pair, missionIds, protocol = null) {
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
  const bindings = missionComparisonBindings(m, evidence.context, protocol ? 2 : 1);
  if (bindings.taskSha256 !== pair.taskSha256 || bindings.conditionsSha256 !== pair.conditionsSha256) throw Error("Exported task or execution conditions changed");
  if (evidence.missionSha256 !== digestResearchValue(m) || evidence.taskSha256 !== pair.taskSha256 || evidence.conditionsSha256 !== pair.conditionsSha256) throw Error("Measurement does not bind the expected mission and conditions");
  if (protocol) {
    if (evidence.treatmentSha256 !== expectedModel.digest || evidence.protocolSha256 !== protocol.digest) throw Error("Measurement does not bind the expected treatment and protocol");
    sha(evidence.compiledInputSha256, "compiledInputSha256");
    if (Object.hasOwn(evidence, "recoveries")) throw Error("V2 requires typed recoveryEvidence, not a legacy recoveries counter");
  } else if (evidence.modelId !== expectedModel.modelId || evidence.artifactSha256 !== expectedModel.artifactSha256) throw Error("Measurement does not bind the expected model");
  for (const field of ["costMicrousd", "unauthorizedEffects", "duplicateEffects", ...(protocol ? [] : ["recoveries"])]) integer(evidence[field], field, 0, Number.MAX_SAFE_INTEGER);
  integer(evidence.wallTimeMs, "wallTimeMs", 1, Number.MAX_SAFE_INTEGER);
  if (typeof evidence.budgetExceeded !== "boolean") throw Error("Budget outcome must be explicit");
  const start = Date.parse(m.started_at), end = Date.parse(m.finished_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || Math.abs(end - start - evidence.wallTimeMs) > 1) throw Error("Wall time must match the exported mission timestamps");
  if (protocol && Date.parse(protocol.registeredAt) >= start) throw Error("Protocol must be registered before either Mission starts");
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
  const result = { passed: m.status === "completed" && assessment.status === "complete", incompleteChecks: assessment.status === "invalid_policy" || assessment.pending.length > 0 || m.status === "cancelled" || (m.status === "failed" && assessment.status === "complete"),
    costMicrousd: evidence.costMicrousd, wallTimeMs: evidence.wallTimeMs, recoveries: evidence.recoveries,
    unauthorizedEffects: evidence.unauthorizedEffects, duplicateEffects: evidence.duplicateEffects, budgetExceeded };
  if (protocol) {
    const recovery = recoveryEvidence(evidence.recoveryEvidence);
    const complete = recovery.coverage === "complete";
    result.recoveries = complete ? sum([recovery.unexpectedCorrections, recovery.requiredRecoveries]) : null;
    result.recoveryCoverage = recovery.coverage;
    result.unexpectedCorrections = complete ? recovery.unexpectedCorrections : null;
    result.requiredRecoveries = complete ? recovery.requiredRecoveries : null;
    result.firstAttemptPass = complete && !result.incompleteChecks ? result.passed && recovery.unexpectedCorrections === 0 : null;
  }
  return result;
}

function compareVerifiedMissionsV2(input) {
  const source = structuredClone(input);
  if (source.schema !== undefined && source.schema !== SCHEMA) throw Error("Expected a verified mission comparison");
  const baseline = validateMissionTreatment(source.baseline), candidate = validateMissionTreatment(source.candidate);
  const protocol = validateMissionComparisonProtocol(source.protocol), limits = protocol.limits;
  validateTreatmentContrast(baseline, candidate, protocol);
  if (source.limits !== undefined && digestResearchValue(source.limits) !== digestResearchValue(limits)) throw Error("Limits must match the preregistered protocol");
  if (!Array.isArray(source.pairs) || source.pairs.length < 1 || source.pairs.length > 10000) throw Error("Expected 1..10000 mission pairs");
  const registered = new Map(protocol.tasks.map(t => [t.id, t]));
  const ids = new Set(), tasks = new Set(), missions = new Set();
  const rows = source.pairs.map(pair => {
    object(pair, "mission pair");
    const { id, family, taskSha256, conditionsSha256 } = pair;
    const task = registered.get(id);
    if (!task || digestResearchValue(task) !== digestResearchValue({ id, family, taskSha256, conditionsSha256 })) throw Error("Mission pair does not match a preregistered task and conditions");
    if (ids.has(id) || tasks.has(taskSha256)) throw Error("Repeated tasks cannot inflate independent mission counts");
    ids.add(id); tasks.add(taskSha256);
    const base = execution(pair.baseline, baseline, pair, missions, protocol);
    const learned = execution(pair.candidate, candidate, pair, missions, protocol);
    if (digestResearchValue(pair.baseline.mission.contract.verification_policy) !== digestResearchValue(pair.candidate.mission.contract.verification_policy)) throw Error("Paired missions need identical checker policies");
    if (protocol.changedDimensions.length === 1 && protocol.changedDimensions[0] === "weights" && pair.baseline.measurement.compiledInputSha256 !== pair.candidate.measurement.compiledInputSha256) throw Error("Weights-only comparisons require identical compiled inputs");
    return { id, family, baseline: base, candidate: learned };
  });
  const totals = arm => ({
    verifiedPasses: rows.filter(r => r[arm].passed).length,
    incompleteChecks: rows.filter(r => r[arm].incompleteChecks).length,
    firstAttemptPasses: rows.filter(r => r[arm].firstAttemptPass === true).length,
    firstAttemptUnknown: rows.filter(r => r[arm].firstAttemptPass === null).length,
    costMicrousd: sum(rows.map(r => r[arm].costMicrousd)),
    wallTimeMs: sum(rows.map(r => r[arm].wallTimeMs)),
    p95WallTimeMs: percentile(rows.map(r => r[arm].wallTimeMs), 0.95),
    recoveries: knownSum(rows.map(r => r[arm].recoveries)),
    unexpectedCorrections: knownSum(rows.map(r => r[arm].unexpectedCorrections)),
    requiredRecoveries: knownSum(rows.map(r => r[arm].requiredRecoveries)),
    unauthorizedEffects: sum(rows.map(r => r[arm].unauthorizedEffects)),
    duplicateEffects: sum(rows.map(r => r[arm].duplicateEffects)),
    budgetViolations: rows.filter(r => r[arm].budgetExceeded).length
  });
  const observed = rows.filter(r => r.baseline.firstAttemptPass !== null && r.candidate.firstAttemptPass !== null);
  const wins = observed.filter(r => r.candidate.firstAttemptPass && !r.baseline.firstAttemptPass).length;
  const losses = observed.filter(r => !r.candidate.firstAttemptPass && r.baseline.firstAttemptPass).length;
  const fullPrimaryCoverage = observed.length === rows.length;
  const primary = {
    metric: protocol.primaryMetric, pairs: rows.length, observedPairs: observed.length, unknownPairs: rows.length - observed.length,
    pairedWins: wins, pairedLosses: losses, ties: observed.length - wins - losses,
    lift: fullPrimaryCoverage ? (wins - losses) / rows.length : null,
    confidenceInterval: fullPrimaryCoverage ? pairedCompletionInterval(wins, losses, rows.length) : null
  };
  const metrics = {
    pairs: rows.length, registeredPairs: protocol.tasks.length, baseline: totals("baseline"), candidate: totals("candidate"), primary,
    pairedWins: rows.filter(r => r.candidate.passed && !r.baseline.passed).length,
    pairedLosses: rows.filter(r => !r.candidate.passed && r.baseline.passed).length,
    perFamily: Object.fromEntries([...new Set(protocol.tasks.map(t => t.family))].sort().map(family => {
      const group = rows.filter(r => r.family === family);
      return [family, { pairs: group.length, baselinePasses: group.filter(r => r.baseline.passed).length, candidatePasses: group.filter(r => r.candidate.passed).length,
        baselineFirstAttemptPasses: group.filter(r => r.baseline.firstAttemptPass === true).length,
        candidateFirstAttemptPasses: group.filter(r => r.candidate.firstAttemptPass === true).length }];
    }))
  };
  const b = metrics.baseline, c = metrics.candidate;
  const completeRecovery = rows.every(r => r.baseline.recoveryCoverage === "complete" && r.candidate.recoveryCoverage === "complete");
  const checks = {
    enoughIndependentMissions: rows.length >= limits.minimumPairs,
    completePreregisteredBatch: rows.length === protocol.tasks.length,
    verifiedCompletionImproves: metrics.pairedWins > metrics.pairedLosses,
    noFamilyRegression: Object.values(metrics.perFamily).every(f => f.candidatePasses >= f.baselinePasses),
    completeCheckerCoverage: b.incompleteChecks === 0 && c.incompleteChecks === 0,
    completeRecoveryCoverage: completeRecovery,
    primaryImprovesWithConfidence: primary.confidenceInterval !== null && primary.confidenceInterval.lower > protocol.minimumLift,
    noFirstAttemptRegression: fullPrimaryCoverage && c.firstAttemptPasses >= b.firstAttemptPasses,
    noFamilyFirstAttemptRegression: fullPrimaryCoverage && Object.values(metrics.perFamily).every(f => f.candidateFirstAttemptPasses >= f.baselineFirstAttemptPasses),
    noAdditionalRecovery: completeRecovery && c.recoveries <= b.recoveries,
    noAdditionalUnexpectedCorrection: completeRecovery && c.unexpectedCorrections <= b.unexpectedCorrections,
    withinCostLimit: c.costMicrousd <= b.costMicrousd * limits.maximumCostRatio,
    withinLatencyLimit: c.wallTimeMs <= b.wallTimeMs * limits.maximumLatencyRatio,
    withinTailLatencyLimit: c.p95WallTimeMs <= b.p95WallTimeMs * limits.maximumLatencyRatio,
    noUnauthorizedOrDuplicateEffects: c.unauthorizedEffects === 0 && c.duplicateEffects === 0,
    noBudgetViolations: c.budgetViolations === 0
  };
  const report = { schema: SCHEMA, version: 2, baseline, candidate, protocol, limits, pairs: source.pairs, metrics, checks,
    passed: Object.values(checks).every(Boolean),
    interpretation: { executionEvidenceExternallyProvided: true, cryptographicAttestation: false, automaticPromotion: false,
      unexecutedShadowAnswersAreEvidence: false, registrationAndSealHistoryRequireHostVerification: true,
      unknownRecoveryIsZero: false, ledgerAdmission: "requires-reviewed-v2-integration" }
  };
  return { ...report, digest: digestResearchValue(report) };
}

function recoveryEvidence(input) {
  if (input === undefined || input === null) return { version: 1, coverage: "unknown", unexpectedCorrections: null, requiredRecoveries: null, evidenceRefs: [] };
  object(input, "recoveryEvidence");
  const fields = ["version", "coverage", "unexpectedCorrections", "requiredRecoveries", "evidenceRefs"];
  if (Object.keys(input).length !== fields.length || fields.some(f => !Object.hasOwn(input, f)) || input.version !== 1 || !["complete", "partial", "unknown"].includes(input.coverage)) throw Error("Invalid recovery evidence schema or coverage");
  for (const field of ["unexpectedCorrections", "requiredRecoveries"]) {
    if (input.coverage === "unknown" && input[field] !== null) throw Error("Unknown recovery counts must be null");
    if (input.coverage === "complete" || input[field] !== null) integer(input[field], field, 0, Number.MAX_SAFE_INTEGER);
  }
  if (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.length > 10000 || (input.coverage === "complete" && input.evidenceRefs.length === 0)) throw Error("Complete recovery coverage requires host evidence references");
  for (const ref of input.evidenceRefs) text(ref, "recovery evidence reference", 2000);
  return input;
}

function knownSum(values) { return values.some(v => v === null) ? null : sum(values); }
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
