import test from "node:test";
import assert from "node:assert/strict";

import {
  isPlatformMissionLearningEpisodeContract,
  PLATFORM_MISSION_EPISODE_SCHEMA,
} from "../src/contracts.ts";

test("the Platform Mission episode guard requires the canonical attested envelope", () => {
  const episode = {
    schema: PLATFORM_MISSION_EPISODE_SCHEMA,
    schemaVersion: 1,
    episodeId: "platform-mission:tenant:mission:completed:v1",
    tenantId: "tenant",
    missionId: "mission",
    terminalStatus: "completed",
    sourceEpisodeDigest: "a".repeat(64),
    rightsTags: ["amos-owned"],
    consentReceiptId: "consent-receipt",
    attestationReceiptId: "kms-receipt",
    source: { verification: [] },
  };
  assert.equal(isPlatformMissionLearningEpisodeContract(episode), true);
  assert.equal(
    isPlatformMissionLearningEpisodeContract({ ...episode, attestationReceiptId: undefined }),
    false,
  );
  assert.equal(
    isPlatformMissionLearningEpisodeContract({ ...episode, rightsTags: [] }),
    false,
  );
});
