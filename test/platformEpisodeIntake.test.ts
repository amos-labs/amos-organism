import test from "node:test";
import assert from "node:assert/strict";

import {
  digest,
  MemoryEventStore,
  PlatformEpisodeIntake,
  PLATFORM_MISSION_EPISODE_SCHEMA,
  type PlatformMissionLearningEpisodeContract,
} from "../src/index.ts";
import { AllowListHostGate, receipt } from "./helpers.ts";

function episode(status: "completed" | "failed" = "completed") {
  const source = {
    episodeId: `platform-mission:t:m:${status}:v1`,
    tenantId: "t",
    missionId: "m",
    contractId: "c",
    terminalStatus: status,
    task: {},
    trajectory: {},
    outcome: {},
    verification: status === "completed"
      ? {
          totalCount: 1,
          passedCount: 1,
          failedCount: 0,
          allPassed: true,
          fullTraceDigest: "a".repeat(64),
          first: [{ verdict: "pass" }],
          last: [],
        }
      : {
          totalCount: 1,
          passedCount: 0,
          failedCount: 1,
          allPassed: false,
          fullTraceDigest: "b".repeat(64),
          first: [{ verdict: "fail" }],
          last: [],
        },
  };
  const unsigned = {
    schema: PLATFORM_MISSION_EPISODE_SCHEMA,
    schemaVersion: 1,
    episodeId: source.episodeId,
    tenantId: "t",
    missionId: "m",
    terminalStatus: status,
    sourceEpisodeDigest: digest(source),
    rightsTags: ["amos-owned"],
    consentReceiptId: "consent",
    source,
  } satisfies PlatformMissionLearningEpisodeContract;
  return unsigned;
}

test("an attested successful Platform Mission becomes verified experience idempotently", () => {
  const gate = new AllowListHostGate();
  const store = new MemoryEventStore();
  const intake = new PlatformEpisodeIntake(gate, store);
  const value = episode();
  const attested = gate.allow({
    ...receipt("attested", "m", "platform-episode-attested"),
    payloadDigest: digest(value),
  });
  const first = intake.ingest(value, attested);
  const retried = intake.ingest(value, attested);
  assert.equal(first.classification, "verified");
  assert.equal(first.event.id, retried.event.id);
  assert.equal(store.events().length, 1);
});

test("failure is durable negative experience and cannot admit a gene", () => {
  const gate = new AllowListHostGate();
  const store = new MemoryEventStore();
  const intake = new PlatformEpisodeIntake(gate, store);
  const value = episode("failed");
  const attested = gate.allow({
    ...receipt("attested", "m", "platform-episode-attested"),
    payloadDigest: digest(value),
  });
  const result = intake.ingest(value, attested);
  assert.equal(result.classification, "negative");
  assert.equal(result.event.payload.geneAdmissionAllowed, false);
});

test("tampered source or unbound attestation is refused", () => {
  const gate = new AllowListHostGate();
  const intake = new PlatformEpisodeIntake(gate, new MemoryEventStore());
  const value = episode();
  const attested = gate.allow({
    ...receipt("attested", "m", "platform-episode-attested"),
    payloadDigest: digest(value),
  });
  assert.throws(
    () => intake.ingest({ ...value, sourceEpisodeDigest: "0".repeat(64) }, attested),
    /bytes do not match|source digest mismatch/,
  );
  assert.throws(
    () => intake.ingest(value, { ...attested, id: "different" }),
    /Untrusted host receipt|does not match/,
  );
});
