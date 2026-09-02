import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  digest,
  isPlatformMissionLearningEpisodeContract,
  MemoryEventStore,
  PlatformEpisodeIntake,
  type PlatformMissionLearningEpisodeContract,
} from "../src/index.ts";
import { AllowListHostGate, receipt } from "./helpers.ts";

/**
 * The fixture mirrors the JSON emitted by the Platform producer
 * (amos-managed-platform src/services/organism_learning.rs, build_episode_body):
 * no attestationReceiptId in the signed body, bounded-trace objects for
 * trajectory/verification (a summary with passedCount/failedCount/allPassed
 * instead of a bare array), and objective bounding fields on the task.
 */
function producerEpisode(): PlatformMissionLearningEpisodeContract {
  return JSON.parse(readFileSync(
    new URL("./fixtures/platform-mission-episode.producer.json", import.meta.url),
    "utf8",
  )) as PlatformMissionLearningEpisodeContract;
}

test("the producer's actual episode body passes the contract guard without an attestation receipt id", () => {
  const episode = producerEpisode();
  assert.equal("attestationReceiptId" in episode, false);
  assert.equal(isPlatformMissionLearningEpisodeContract(episode), true);
  assert.equal(digest(episode.source), episode.sourceEpisodeDigest);
});

test("a completed producer episode with a passing verification summary becomes verified experience", () => {
  const gate = new AllowListHostGate();
  const store = new MemoryEventStore();
  const intake = new PlatformEpisodeIntake(gate, store);
  const episode = producerEpisode();
  const attested = gate.allow({
    ...receipt("attested-producer", episode.missionId, "platform-episode-attested"),
    payloadDigest: digest(episode),
  });
  const result = intake.ingest(episode, attested);
  assert.equal(result.classification, "verified");
  assert.equal(result.event.type, "platform.experience-verified");
  assert.equal(result.event.payload.geneAdmissionAllowed, false);
  assert.deepEqual(result.event.payload.rightsTags, ["amos-owned", "strategy_learning"]);
});

test("a producer verification summary with any failed check is negative experience", () => {
  const gate = new AllowListHostGate();
  const intake = new PlatformEpisodeIntake(gate, new MemoryEventStore());
  const base = producerEpisode();
  const verification = base.source.verification as Record<string, unknown>;
  const source = {
    ...base.source,
    verification: { ...verification, passedCount: 0, failedCount: 1, allPassed: false },
  };
  const episode = { ...base, sourceEpisodeDigest: digest(source), source };
  const attested = gate.allow({
    ...receipt("attested-producer-failed", episode.missionId, "platform-episode-attested"),
    payloadDigest: digest(episode),
  });
  assert.equal(intake.ingest(episode, attested).classification, "negative");
});
