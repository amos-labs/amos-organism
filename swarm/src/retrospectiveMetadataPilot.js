import { digestResearchValue } from "./experimentProtocol.js";

/**
 * Structural and linkage checks over a Platform retrospective metadata fixture
 * (schema amos.platform-mission-retrospective-metadata-fixture). The fixture
 * is metadata only: ids, timestamps, kinds, key names, digests. It is not a
 * signed episode and retains no inputs or outputs, so it can never yield a
 * reconstructible observed training example. What it can do is prove its own
 * internal consistency and seed clearly labeled synthetic task variants.
 */
export const RETROSPECTIVE_PILOT_SCHEMA = "amos.retrospective-metadata-pilot-report";

export function runRetrospectiveMetadataPilot(fixture, { now = new Date(), fixtureDigests = {} } = {}) {
  if (fixture?.schema !== "amos.platform-mission-retrospective-metadata-fixture") throw new Error("expected a retrospective metadata fixture");
  const checks = [];
  const check = (id, passed, detail) => { checks.push({ id, status: passed ? "passed" : "failed", detail }); return passed; };

  // Identity and labeling
  check("label-not-episode", /NOT a signed learning episode/i.test(String(fixture.label ?? "")), "fixture declares itself not a signed episode");
  check("instrumentation-declared", fixture.instrumentation?.recovery_coverage === "unknown" && String(fixture.instrumentation?.signed_episode ?? "").startsWith("none"), "recovery coverage unknown and no signed episode, as declared");
  check("extraction-provenance", !!fixture.extraction?.by && !!fixture.extraction?.extracted_at && !!fixture.extraction?.source_tool, "extraction provenance present");

  // Steps
  // Fixtures may carry a newest-first window of steps; order by position before reasoning about sequence.
  const steps = [...(Array.isArray(fixture.steps) ? fixture.steps : [])].sort((a, b) => a.position - b.position);
  const kindCounts = {};
  for (const step of steps) kindCounts[step.kind] = (kindCounts[step.kind] ?? 0) + 1;
  check("step-kind-counts-match", JSON.stringify(sortObject(kindCounts)) === JSON.stringify(sortObject(fixture.step_kind_counts ?? {})), `observed ${JSON.stringify(sortObject(kindCounts))}`);
  const positions = steps.map((step) => step.position);
  const windowed = positions.length > 0 && positions[0] > 1;
  check("step-positions-unique", new Set(positions).size === positions.length, `${positions.length} positions, ${positions[0]}..${positions.at(-1)}${windowed ? " (window; earlier steps not included in the fixture)" : ""}`);
  const terminal = steps.at(-1);
  check("terminal-step-matches-status", terminal?.kind === "status" && terminal?.status === fixture.status, `highest-position step ${terminal?.kind}/${terminal?.status} vs mission ${fixture.status}`);
  check("no-step-arguments-retained", steps.every((step) => !("payload" in step) && Array.isArray(step.payload_keys)), "steps carry payload key names only");

  // Receipts
  const receipts = fixture.receipts?.items ?? [];
  check("receipt-linked-count", receipts.length === fixture.receipts?.linked_count, `${receipts.length} receipts vs linked_count ${fixture.receipts?.linked_count}`);
  const receiptOps = {};
  for (const receipt of receipts) receiptOps[receipt.operation] = (receiptOps[receipt.operation] ?? 0) + 1;
  const allowed = new Set((fixture.allowed_operations ?? []).map((op) => op.operation));
  const unexpectedOps = Object.keys(receiptOps).filter((op) => !allowed.has(op) && op !== "mission_completed");
  check("receipt-operations-within-contract", unexpectedOps.length === 0, `operations ${JSON.stringify(receiptOps)}; outside allowlist: ${JSON.stringify(unexpectedOps)}`);
  check("receipts-verified", receipts.every((receipt) => receipt.verified === true), "every linked receipt verified by the host");
  const toolCalls = kindCounts.tool_call ?? 0;
  const usedToolCalls = fixture.usage?.tool_calls?.used ?? fixture.budgets?.used_tool_calls;
  check("tool-call-accounting-consistent", usedToolCalls !== undefined && toolCalls <= usedToolCalls && receipts.filter((r) => r.operation !== "mission_completed").length >= toolCalls, `tool_call steps ${toolCalls}, usage.tool_calls.used ${usedToolCalls}, operation receipts ${receipts.length}; a receipts-window of 100 may omit older receipts`);

  // Verification
  const results = Array.isArray(fixture.verification_results) ? fixture.verification_results : [];
  const requirement = fixture.verification_policy?.requirements?.[0];
  check("verification-rows-bound-to-policy", results.length > 0 && results.every((r) => r.requirement_id === requirement?.id && r.checker_id === requirement?.checker_id && r.definition_sha256 === requirement?.definition_sha256), `${results.length} rows against requirement ${requirement?.id}`);
  const last = [...results].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).at(-1);
  check("final-verdict-matches-terminal-status", (fixture.status === "completed") === (last?.verdict === "pass"), `latest verdict ${last?.verdict}, status ${fixture.status}`);
  check("verifier-authority-independent", results.every((r) => ["deterministic", "independent_model", "real_world", "platform"].includes(r.authority) || r.execution_location === "platform"), `authorities ${JSON.stringify([...new Set(results.map((r) => r.authority))])}`);
  check("budgets-respected", (fixture.usage?.provider_credits?.used ?? 0) <= (fixture.usage?.provider_credits?.max ?? Infinity) && (fixture.usage?.tool_calls?.used ?? 0) <= (fixture.usage?.tool_calls?.max ?? Infinity), `credits ${fixture.usage?.provider_credits?.used}/${fixture.usage?.provider_credits?.max}, tool calls ${fixture.usage?.tool_calls?.used}/${fixture.usage?.tool_calls?.max}`);

  // Eligibility: every candidate example is rejected for the same honest reason.
  const candidates = steps.filter((step) => step.kind === "tool_call").map((step) => ({
    sourceKind: "retained-receipt",
    stepPosition: step.position,
    decision: "rejected",
    reason: "no permitted input or output content retained (metadata fixture); not reconstructible"
  }));
  const syntheticSeeds = [{
    kind: "synthetic-task-seed",
    label: "synthetic",
    family: fixture.allowed_operations?.[0]?.consequence?.category ?? "unknown",
    completionKind: fixture.completion_condition?.kind ?? null,
    completionOperator: fixture.completion_condition?.operator ?? null,
    completionTarget: fixture.completion_condition?.target ?? null,
    allowedOperations: [...allowed].sort(),
    plannerAttempts: fixture.planner_attempts ?? null,
    note: "seeds an independently constructed and checked curriculum task; not an observed example"
  }];

  const passed = checks.filter((c) => c.status === "passed").length;
  const body = {
    schema: RETROSPECTIVE_PILOT_SCHEMA,
    version: 1,
    generatedAt: new Date(now).toISOString(),
    fixture: { schema: fixture.schema, missionId: fixture.mission_id, tenantId: fixture.tenant_id, status: fixture.status, digests: fixtureDigests, canonicalDigest: digestResearchValue(fixture) },
    structural: { checks, passed, failed: checks.length - passed },
    eligibility: {
      candidateExamples: candidates.length,
      accepted: 0,
      rejected: candidates.length,
      rejectionReasons: { "no-retained-content": candidates.length },
      eligibleRealExamples: 0,
      syntheticSeeds
    },
    candidates,
    interpretation: {
      stepsWindowed: windowed,
      isSignedEpisode: false,
      observedTrainingExamples: 0,
      recoveryCoverage: fixture.instrumentation?.recovery_coverage ?? "unknown",
      note: "structural consistency of a retrospective metadata fixture; it seeds synthetic tasks and proves linkage, nothing more"
    }
  };
  return { ...body, digest: digestResearchValue(body) };
}

function sortObject(value) { return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))); }
