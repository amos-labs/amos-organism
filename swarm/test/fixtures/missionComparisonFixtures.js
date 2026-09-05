import { digestResearchValue } from "../../src/experimentProtocol.js";
import { compareVerifiedMissions, missionComparisonBindings } from "../../src/missionComparison.js";

export function missionComparisonInput(count = 200) {
  const baseline = { modelId: "amos-qwen38-27b-fp8", artifactSha256: "a".repeat(64) };
  const candidate = { modelId: "implicit-r32-s3", artifactSha256: "b".repeat(64), adapterUri: "s3://bucket/stage1/run/runs/contract/adapter" };
  const context = { toolCatalogSha256: "1".repeat(64), memorySnapshotSha256: "2".repeat(64), environmentSha256: "3".repeat(64), executionPolicySha256: "4".repeat(64), runtimeRevision: "5".repeat(40) };
  function run(index, model, passed) {
    const id = `fixture-${model.modelId}-${index}`;
    const mission = {
      mission_id: id, objective: `Fixture task ${index}: produce the verified inventory`, completion_condition: { minimumCount: 5 },
      status: passed ? "completed" : "failed", started_at: "2026-09-05T10:00:00Z", finished_at: "2026-09-05T10:01:00Z",
      contract: { contract_sha256: digestResearchValue(id), allowed_operations: ["inventory.read"],
        budgets: { max_tool_calls: 5, max_cost_microusd: 10000, max_wall_time_seconds: 600, used_tool_calls: 1 },
        decision_policy: { authority: "platform" }, checkpoint_policy: { required: true },
        verification_policy: { schema_version: "1", minimum_coverage: 1, requirements: [{ id: "inventory", checker_id: "platform.metric_threshold", checker_version: "1", definition_sha256: "c".repeat(64), minimum_authority: "deterministic", config: { metric: "count", target: 5 } }] }
      },
      verification: [{ checker_run_id: id + "-check", requirement_id: "inventory", checker_id: "platform.metric_threshold", checker_version: "1", definition_sha256: "c".repeat(64), result_sha256: digestResearchValue({ id, passed }), authority: "deterministic", verdict: passed ? "pass" : "fail", coverage: 1, unknown_requirements: [], evidence_refs: ["fixture-inventory-receipt"], created_at: "2026-09-05T10:00:59Z" }]
    };
    const measurement = { source: "platform-mission-harness", accountingComplete: true, missionSha256: digestResearchValue(mission), modelId: model.modelId, artifactSha256: model.artifactSha256, ...missionComparisonBindings(mission, context), context,
      costMicrousd: 100, wallTimeMs: 60000, recoveries: 0, unauthorizedEffects: 0, duplicateEffects: 0, budgetExceeded: false };
    return { mission, measurement: { ...measurement, context: structuredClone(context), digest: digestResearchValue(measurement) } };
  }
  return { baseline, candidate, pairs: Array.from({ length: count }, (_, i) => {
    const base = run(i, baseline, i !== 0), learned = run(i, candidate, true);
    return { id: `case-${i}`, family: i % 2 ? "retrieval" : "execution", ...missionComparisonBindings(base.mission, context), baseline: base, candidate: learned };
  }) };
}
export function resignMeasurement(run) {
  run.measurement.missionSha256 = digestResearchValue(run.mission);
  const { digest, ...body } = run.measurement;
  run.measurement.digest = digestResearchValue(body);
}
export function passingMissionComparison() { return compareVerifiedMissions(missionComparisonInput()); }
