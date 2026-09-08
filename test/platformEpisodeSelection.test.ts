import test from "node:test";
import assert from "node:assert/strict";

import {
  TRANSPORT_VALIDATION_EPISODE_IDS,
  isTransportValidationEpisodeId,
  isLearningEligiblePlatformEpisode,
  realPlatformEpisodes,
  classifyEpisodeCredit,
  creditableEpisodes,
  type OrganismEvent,
} from "../src/index.ts";

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

test("credit binds to terminalAssessment.status, not terminalStatus or event type", () => {
  // A completed terminal assessment with no latest-fail is the only creditable case.
  assert.equal(classifyEpisodeCredit(evWithAssessment(REAL, { status: "complete", counts: { latestFail: 0 } })), "creditable");
  // A genuine latest fail is failed (via status, or defensively via counts even if status is stale).
  assert.equal(classifyEpisodeCredit(evWithAssessment(REAL, { status: "failed", counts: { latestFail: 1 } })), "failed");
  assert.equal(classifyEpisodeCredit(evWithAssessment(REAL, { status: "complete", counts: { latestFail: 1 } })), "failed", "fail closed: a latest fail never reads as creditable");
});

test("pending / invalid_policy / unqualified and a MISSING assessment all stay unqualified", () => {
  assert.equal(classifyEpisodeCredit(evWithAssessment(REAL, { status: "pending", counts: { latestFail: 0 } })), "unqualified");
  assert.equal(classifyEpisodeCredit(evWithAssessment(REAL, { status: "invalid_policy" })), "unqualified");
  assert.equal(classifyEpisodeCredit(evWithAssessment(REAL, { status: "unqualified" })), "unqualified");
  // Legacy event (the two delivered episodes): no terminalAssessment, and a completed terminalStatus never substitutes.
  assert.equal(classifyEpisodeCredit(evWithAssessment(REAL, undefined, "platform.experience-verified")), "unqualified");
});

test("credit classification excludes transport-validation and non-platform events", () => {
  // Even a 'complete' assessment on the transport-validation id is unqualified (never real experience).
  assert.equal(classifyEpisodeCredit(evWithAssessment(SYNTHETIC, { status: "complete", counts: { latestFail: 0 } })), "unqualified");
  assert.equal(classifyEpisodeCredit(ev("gene.admitted")), "unqualified");
});

test("creditableEpisodes keeps only the complete-assessment real episodes", () => {
  const chain = [
    evWithAssessment(REAL, { status: "complete", counts: { latestFail: 0 } }),
    evWithAssessment("platform-mission:real2:t:m:failed:v1", { status: "failed", counts: { latestFail: 2 } }),
    evWithAssessment("platform-mission:real3:t:m:completed:v1", { status: "pending", counts: { latestFail: 0 } }),
    evWithAssessment(SYNTHETIC, { status: "complete", counts: { latestFail: 0 } }),
  ];
  const kept = creditableEpisodes(chain);
  assert.equal(kept.length, 1);
  assert.equal((kept[0]!.payload as { episodeId: string }).episodeId, REAL);
});
