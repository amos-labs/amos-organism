import test from "node:test";
import assert from "node:assert/strict";
import { runRetrospectiveMetadataPilot } from "../src/retrospectiveMetadataPilot.js";

function fixture() {
  return {
    schema: "amos.platform-mission-retrospective-metadata-fixture", version: 1,
    label: "retrospective-metadata-fixture; NOT a signed learning episode",
    mission_id: "m-1", tenant_id: "t-1", status: "completed", planner_attempts: 3,
    extraction: { by: "fable-platform", extracted_at: "2026-09-05T00:00:00Z", source_tool: "growth.get_mission", method: "metadata" },
    instrumentation: { recovery_coverage: "unknown", signed_episode: "none (predates outbox)" },
    allowed_operations: [{ operation: "run_prospecting_batch", consequence: { category: "prospecting" } }],
    completion_condition: { kind: "metric_threshold", operator: ">=", target: 500 },
    usage: { provider_credits: { used: 5, max: 10 }, tool_calls: { used: 2, max: 10 } },
    step_kind_counts: { tool_call: 2, status: 1 },
    // newest-first window, as the Platform exports it
    steps: [
      { position: 13, kind: "status", status: "completed", payload_keys: ["status"] },
      { position: 12, kind: "tool_call", payload_keys: ["operation"] },
      { position: 11, kind: "tool_call", payload_keys: ["operation"] }
    ],
    receipts: { linked_count: 3, items: [
      { id: "r1", operation: "run_prospecting_batch", verified: true },
      { id: "r2", operation: "run_prospecting_batch", verified: true },
      { id: "r3", operation: "mission_completed", verified: true }
    ] },
    verification_policy: { requirements: [{ id: "completion_condition", checker_id: "platform.metric_threshold", definition_sha256: "d".repeat(64) }] },
    verification_results: [
      { requirement_id: "completion_condition", checker_id: "platform.metric_threshold", definition_sha256: "d".repeat(64), verdict: "fail", authority: "deterministic", created_at: "2026-09-03T19:40:00Z" },
      { requirement_id: "completion_condition", checker_id: "platform.metric_threshold", definition_sha256: "d".repeat(64), verdict: "pass", authority: "deterministic", created_at: "2026-09-03T19:56:00Z" }
    ]
  };
}

test("a consistent fixture passes every structural check and yields zero eligible real examples", () => {
  const report = runRetrospectiveMetadataPilot(fixture(), { now: new Date("2026-09-05T22:00:00Z") });
  assert.equal(report.structural.failed, 0, JSON.stringify(report.structural.checks.filter((c) => c.status === "failed")));
  assert.equal(report.eligibility.candidateExamples, 2);
  assert.equal(report.eligibility.accepted, 0);
  assert.equal(report.eligibility.eligibleRealExamples, 0);
  assert.equal(report.eligibility.syntheticSeeds[0].label, "synthetic");
  assert.equal(report.eligibility.syntheticSeeds[0].family, "prospecting");
  assert.equal(report.interpretation.isSignedEpisode, false);
  assert.equal(report.interpretation.stepsWindowed, true);
  assert.match(report.digest, /^[a-f0-9]{64}$/);
});

test("linkage breaks are reported as failed checks, not silently accepted", () => {
  const broken = fixture();
  broken.receipts.items.push({ id: "r4", operation: "send_email", verified: false });
  broken.step_kind_counts.tool_call = 5;
  broken.verification_results[1].verdict = "fail";
  const report = runRetrospectiveMetadataPilot(broken);
  const failed = report.structural.checks.filter((c) => c.status === "failed").map((c) => c.id);
  assert.deepEqual(failed.sort(), ["final-verdict-matches-terminal-status", "receipt-linked-count", "receipt-operations-within-contract", "receipts-verified", "step-kind-counts-match"].sort());
  assert.throws(() => runRetrospectiveMetadataPilot({ schema: "other" }), /retrospective metadata fixture/);
});
