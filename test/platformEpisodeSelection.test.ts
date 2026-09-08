import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  TRANSPORT_VALIDATION_EPISODE_IDS,
  isTransportValidationEpisodeId,
  isLearningEligiblePlatformEpisode,
  realPlatformEpisodes,
  classifyEpisodeCredit,
  creditableEpisodes,
  TERMINAL_ASSESSMENT_SCHEMA,
  TERMINAL_ASSESSMENT_VERSION,
  type OrganismEvent,
} from "../src/index.ts";

// Actual serialized terminal_assessment_from producer outputs (independent Rust replay), copied
// byte-for-byte from coordination/artifacts/organism-86-review-20260908/serialized-producer-cases.json.
const PRODUCER = JSON.parse(
  readFileSync(new URL("./fixtures/terminal-assessment-serialized-producer-cases-20260908.json", import.meta.url), "utf8"),
) as { cases: { case: string; assessment: Record<string, unknown> }[] };

// Codex's independent expected consumer credit for each real producer case (organism-86 review proof.json).
const EXPECTED_CREDIT: Record<string, "creditable" | "failed" | "unqualified"> = {
  codex_1_missing_required_b: "unqualified",
  codex_2_extraneous_failure_b: "creditable",
  codex_3_wrong_pin_fail: "unqualified",
  codex_4_partial_coverage_fail: "unqualified",
  northwind_e152bd9b_completed: "creditable",
  northwind_8541ebc6_failed_mission_unknowns_only: "unqualified",
  latest_qualifying_fail: "failed",
  no_policy: "unqualified",
  invalid_policy_self_check: "unqualified",
};

const SYNTHETIC = "platform-mission:7f80fdb1-a26d-41e8-95ac-451aeaa54e32:a10c9080-71f9-48e3-96b9-f6e2185332a0:completed:v1";
const REAL = "platform-mission:real:t:m:completed:v1";
const MISSION = "72154c44-5b9f-443b-8dd4-866543c2d7ca";
const CONTRACT = "c36f3027-d692-4436-9560-2b6db865dd71";

function ev(type: string, episodeId?: string): OrganismEvent {
  return {
    id: `platform-episode:${episodeId ?? "x"}`, type, missionId: "m", occurredAt: "2026-09-07T00:00:00Z",
    authority: "host", hostReceiptId: "r", payload: episodeId ? { episodeId } : {}, digest: "d",
  } as unknown as OrganismEvent;
}

// A real Platform episode whose OUTER identity (event.missionId + source.missionId/contractId) is
// MISSION/CONTRACT, carrying the given nested terminalAssessment (or none).
function episodeFor(
  assessment: unknown,
  { missionId = MISSION, contractId = CONTRACT, episodeId = REAL, type = "platform.experience-negative" as string } = {},
): OrganismEvent {
  return {
    id: `platform-episode:${episodeId}`, type, missionId, occurredAt: "2026-09-07T00:00:00Z", authority: "host", hostReceiptId: "r",
    payload: { episodeId, source: { missionId, contractId, verification: assessment === undefined ? {} : { terminalAssessment: assessment } } },
    digest: "d",
  } as unknown as OrganismEvent;
}

// A valid, creditable assessment (matched ids) used as the base for adversarial mutation.
function creditableAssessment(): Record<string, unknown> {
  return {
    schema: TERMINAL_ASSESSMENT_SCHEMA, version: TERMINAL_ASSESSMENT_VERSION, status: "complete", missionId: MISSION, contractId: CONTRACT,
    counts: { fail: 0, unknown: 0, noEvidence: 0, disqualified: 0, extraneousResults: 0, pass: 1, recordedResults: 1, requirements: 1 },
  };
}

test("the deployed-receiver proof episode id is registered as transport-validation", () => {
  assert.ok(TRANSPORT_VALIDATION_EPISODE_IDS.has(SYNTHETIC));
  assert.equal(isTransportValidationEpisodeId(SYNTHETIC), true);
  assert.equal(isTransportValidationEpisodeId("platform-mission:real:tenant:mission:completed:v1"), false);
});

test("a real platform experience is learning-eligible; the transport-validation id is not", () => {
  const real = ev("platform.experience-verified", "platform-mission:real:t:m:completed:v1");
  const realNeg = ev("platform.experience-negative", "platform-mission:real2:t:m:failed:v1");
  const synthetic = ev("platform.experience-negative", SYNTHETIC);
  assert.equal(isLearningEligiblePlatformEpisode(real), true);
  assert.equal(isLearningEligiblePlatformEpisode(realNeg), true);
  assert.equal(isLearningEligiblePlatformEpisode(synthetic), false);
});

test("non-platform events and payloads without an episode id are not eligible here", () => {
  assert.equal(isLearningEligiblePlatformEpisode(ev("gene.admitted", undefined)), false);
  assert.equal(isLearningEligiblePlatformEpisode(ev("platform.experience-verified", undefined)), false);
});

test("realPlatformEpisodes filters out the transport-validation id, keeps real ones, drops non-platform", () => {
  const chain = [
    ev("gene.admitted"),
    ev("platform.experience-verified", "platform-mission:real:t:m:completed:v1"),
    ev("platform.experience-negative", SYNTHETIC),
    ev("platform.experience-negative", "platform-mission:real2:t:m:failed:v1"),
  ];
  const kept = realPlatformEpisodes(chain);
  assert.equal(kept.length, 2);
  assert.ok(kept.every((e) => (e.payload as { episodeId: string }).episodeId !== SYNTHETIC));
  assert.ok(kept.every((e) => e.type.startsWith("platform.experience-")));
});

test("classifyEpisodeCredit replays every real #877 serialized producer output", () => {
  assert.equal(PRODUCER.cases.length, 9);
  for (const c of PRODUCER.cases) {
    // Normalize the fixture's placeholder ids to this episode's outer identity so a valid
    // assessment matches; status and counts are the producer's own.
    const assessment = { ...c.assessment, missionId: MISSION, contractId: CONTRACT };
    const got = classifyEpisodeCredit(episodeFor(assessment));
    assert.equal(got, EXPECTED_CREDIT[c.case], `producer case ${c.case}`);
  }
  // Concretely, among the delivered Northwind pair only the completed mission is creditable.
  const completed = { ...PRODUCER.cases.find((c) => c.case === "northwind_e152bd9b_completed")!.assessment, missionId: MISSION, contractId: CONTRACT };
  const failedMission = { ...PRODUCER.cases.find((c) => c.case === "northwind_8541ebc6_failed_mission_unknowns_only")!.assessment, missionId: MISSION, contractId: CONTRACT };
  assert.equal(classifyEpisodeCredit(episodeFor(completed)), "creditable");
  assert.equal(classifyEpisodeCredit(episodeFor(failedMission)), "unqualified");
});

test("adversarial: schema, version, nested identity, counts are all enforced (never spurious credit)", () => {
  // The unmutated base is creditable.
  assert.equal(classifyEpisodeCredit(episodeFor(creditableAssessment())), "creditable");

  const mutate = (fn: (a: Record<string, unknown>) => void, outer?: { missionId?: string; contractId?: string }): "creditable" | "failed" | "unqualified" => {
    const a = creditableAssessment();
    fn(a);
    return classifyEpisodeCredit(episodeFor(a, outer));
  };

  assert.equal(mutate((a) => delete a.schema), "unqualified", "missing-schema");
  assert.equal(mutate((a) => delete a.version), "unqualified", "missing-version");
  assert.equal(mutate((a) => delete a.missionId), "unqualified", "missing-assessment-mission");
  assert.equal(mutate((a) => delete a.contractId), "unqualified", "missing-assessment-contract");
  // wrong nested mission/contract vs the episode's outer identity.
  assert.equal(mutate((a) => { a.missionId = "different-mission"; }), "unqualified", "wrong-assessment-mission");
  assert.equal(mutate((a) => { a.contractId = "different-contract"; }), "unqualified", "wrong-assessment-contract");
  // malformed fail count on a complete assessment.
  assert.equal(mutate((a) => { (a.counts as Record<string, unknown>).fail = "1"; }), "unqualified", "invalid-fail-count");
  // a complete assessment carrying residual missing evidence is contradictory.
  assert.equal(mutate((a) => { (a.counts as Record<string, unknown>).noEvidence = 1; }), "unqualified", "contradictory-missing-evidence");
  // a completed terminalStatus with no assessment at all never substitutes.
  assert.equal(classifyEpisodeCredit(episodeFor(undefined, { type: "platform.experience-verified" })), "unqualified");
});

test("a failed assessment needs a qualifying policy fail; a wrong schema/version is refused", () => {
  const failed = { ...creditableAssessment(), status: "failed", counts: { fail: 1, unknown: 0, noEvidence: 0, disqualified: 0 } };
  assert.equal(classifyEpisodeCredit(episodeFor(failed)), "failed");
  const failedNoQualifier = { ...creditableAssessment(), status: "failed", counts: { fail: 0, unknown: 0, noEvidence: 0, disqualified: 0 } };
  assert.equal(classifyEpisodeCredit(episodeFor(failedNoQualifier)), "unqualified");
  assert.equal(classifyEpisodeCredit(episodeFor({ ...creditableAssessment(), schema: "other.schema" })), "unqualified");
  assert.equal(classifyEpisodeCredit(episodeFor({ ...creditableAssessment(), version: 2 })), "unqualified");
});

test("credit classification excludes transport-validation and non-platform events", () => {
  // Even a valid complete assessment on the transport-validation id is unqualified (never real experience).
  assert.equal(classifyEpisodeCredit(episodeFor(creditableAssessment(), { episodeId: SYNTHETIC })), "unqualified");
  assert.equal(classifyEpisodeCredit(ev("gene.admitted")), "unqualified");
});

test("creditableEpisodes keeps only the clean-complete, identity-matched real episodes", () => {
  const failed = { ...creditableAssessment(), status: "failed", counts: { fail: 2, unknown: 0, noEvidence: 0, disqualified: 0 } };
  const pending = { ...creditableAssessment(), status: "pending", counts: { fail: 0, unknown: 0, noEvidence: 1, disqualified: 0 } };
  const chain = [
    episodeFor(creditableAssessment(), { episodeId: REAL }),
    episodeFor(failed, { episodeId: "platform-mission:real2:t:m:failed:v1" }),
    episodeFor(pending, { episodeId: "platform-mission:real3:t:m:completed:v1" }),
    episodeFor(creditableAssessment(), { episodeId: SYNTHETIC }),
  ];
  const kept = creditableEpisodes(chain);
  assert.equal(kept.length, 1);
  assert.equal((kept[0]!.payload as { episodeId: string }).episodeId, REAL);
});
