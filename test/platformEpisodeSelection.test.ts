import test from "node:test";
import assert from "node:assert/strict";

import {
  TRANSPORT_VALIDATION_EPISODE_IDS,
  isTransportValidationEpisodeId,
  isLearningEligiblePlatformEpisode,
  realPlatformEpisodes,
  type OrganismEvent,
} from "../src/index.ts";

const SYNTHETIC = "platform-mission:7f80fdb1-a26d-41e8-95ac-451aeaa54e32:a10c9080-71f9-48e3-96b9-f6e2185332a0:completed:v1";

function ev(type: string, episodeId?: string): OrganismEvent {
  return {
    id: `platform-episode:${episodeId ?? "x"}`, type, missionId: "m", occurredAt: "2026-09-07T00:00:00Z",
    authority: "host", hostReceiptId: "r", payload: episodeId ? { episodeId } : {}, digest: "d",
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
