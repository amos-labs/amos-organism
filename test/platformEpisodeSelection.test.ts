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
  type OrganismEvent,
} from "../src/index.ts";

// The shared producer/consumer fixture merged with Platform PR #877, copied byte-for-byte from
// coordination/artifacts/platform-terminal-assessment-cases-20260908.json (sha256 9c9bc505...).
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/terminal-assessment-cases-20260908.json", import.meta.url), "utf8")) as {
  consumerRule: string;
  cases: { case: string; expected: { status: string; counts?: { fail?: number } } }[];
};

const SYNTHETIC = "platform-mission:7f80fdb1-a26d-41e8-95ac-451aeaa54e32:a10c9080-71f9-48e3-96b9-f6e2185332a0:completed:v1";

function ev(type: string, episodeId?: string): OrganismEvent {
  return {
    id: `platform-episode:${episodeId ?? "x"}`, type, missionId: "m", occurredAt: "2026-09-07T00:00:00Z",
    authority: "host", hostReceiptId: "r", payload: episodeId ? { episodeId } : {}, digest: "d",
  } as unknown as OrganismEvent;
}

const REAL = "platform-mission:real:t:m:completed:v1";

function evWithAssessment(
  episodeId: string,
  assessment: unknown,
  type = "platform.experience-negative",
): OrganismEvent {
  return {
    id: `platform-episode:${episodeId}`, type, missionId: "m", occurredAt: "2026-09-07T00:00:00Z",
    authority: "host", hostReceiptId: "r",
    payload: { episodeId, source: { verification: assessment === undefined ? {} : { terminalAssessment: assessment } } },
    digest: "d",
  } as unknown as OrganismEvent;
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

// The consumerRule maps a projected status to a credit outcome; derive the expectation from it so
// the test tracks the shared fixture's own stated rule rather than a hand-copied table.
function expectedCredit(status: string): "creditable" | "failed" | "unqualified" {
  if (status === "complete") return "creditable";
  if (status === "failed") return "failed";
  return "unqualified";
}

test("classifyEpisodeCredit replays the shared #877 terminal-assessment fixture", () => {
  assert.match(FIXTURE.consumerRule, /credit only when status == complete/);
  assert.match(FIXTURE.consumerRule, /failed only when status == failed/);
  assert.equal(FIXTURE.cases.length, 9);
  for (const c of FIXTURE.cases) {
    const got = classifyEpisodeCredit(evWithAssessment(REAL, c.expected));
    assert.equal(got, expectedCredit(c.expected.status), `case ${c.case} (status ${c.expected.status})`);
  }
  // Concretely: the completed Northwind mission is the only creditable real episode among the pair;
  // the unknowns-only failed mission is pending -> unqualified, never a model-negative.
  const completed = FIXTURE.cases.find((c) => c.case === "northwind_e152bd9b_completed")!;
  const failedMission = FIXTURE.cases.find((c) => c.case === "northwind_8541ebc6_failed_mission_unknowns_only")!;
  assert.equal(classifyEpisodeCredit(evWithAssessment(REAL, completed.expected)), "creditable");
  assert.equal(classifyEpisodeCredit(evWithAssessment(REAL, failedMission.expected)), "unqualified");
});

test("failed requires a qualifying policy fail; contradictions and missing assessments are unqualified", () => {
  // failed only when status is failed AND counts.fail is a qualifying policy fail.
  assert.equal(classifyEpisodeCredit(evWithAssessment(REAL, { status: "failed", counts: { fail: 1 } })), "failed");
  // Contradictions never become a model-negative: complete-with-fail and failed-without-fail -> unqualified.
  assert.equal(classifyEpisodeCredit(evWithAssessment(REAL, { status: "complete", counts: { fail: 1 } })), "unqualified");
  assert.equal(classifyEpisodeCredit(evWithAssessment(REAL, { status: "failed", counts: { fail: 0 } })), "unqualified");
  // A missing assessment (legacy events, incl. the two delivered episodes) never substitutes completed status.
  assert.equal(classifyEpisodeCredit(evWithAssessment(REAL, undefined, "platform.experience-verified")), "unqualified");
});

test("a wrong-schema or wrong-version assessment is refused", () => {
  assert.equal(classifyEpisodeCredit(evWithAssessment(REAL, { schema: TERMINAL_ASSESSMENT_SCHEMA, version: 1, status: "complete", counts: { fail: 0 } })), "creditable");
  assert.equal(classifyEpisodeCredit(evWithAssessment(REAL, { schema: "something.else", status: "complete", counts: { fail: 0 } })), "unqualified");
  assert.equal(classifyEpisodeCredit(evWithAssessment(REAL, { version: 2, status: "complete", counts: { fail: 0 } })), "unqualified");
});

test("credit classification excludes transport-validation and non-platform events", () => {
  // Even a 'complete' assessment on the transport-validation id is unqualified (never real experience).
  assert.equal(classifyEpisodeCredit(evWithAssessment(SYNTHETIC, { status: "complete", counts: { fail: 0 } })), "unqualified");
  assert.equal(classifyEpisodeCredit(ev("gene.admitted")), "unqualified");
});

test("creditableEpisodes keeps only the complete-assessment real episodes", () => {
  const chain = [
    evWithAssessment(REAL, { status: "complete", counts: { fail: 0 } }),
    evWithAssessment("platform-mission:real2:t:m:failed:v1", { status: "failed", counts: { fail: 2 } }),
    evWithAssessment("platform-mission:real3:t:m:completed:v1", { status: "pending", counts: { fail: 0 } }),
    evWithAssessment(SYNTHETIC, { status: "complete", counts: { fail: 0 } }),
  ];
  const kept = creditableEpisodes(chain);
  assert.equal(kept.length, 1);
  assert.equal((kept[0]!.payload as { episodeId: string }).episodeId, REAL);
});
