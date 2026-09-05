import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { digest, MemoryEventStore } from "../src/index.ts";
import { PlatformEpisodeReceiver, publicKeyFromKmsDer } from "../src/platformEpisodeReceiver.ts";

interface Fixture {
  schema: string;
  version: number;
  keyId: string;
  publicKeyDerBase64: string;
  eventsAfterReplay: number;
  cases: Array<{
    id: string;
    requiresPriorCase: string | null;
    rawBodyBase64: string;
    headers: Record<string, string>;
    expect: { status: number; bodyStatus: string; classification?: string; reasonPattern?: string };
  }>;
}

function fixture(): Fixture {
  return JSON.parse(readFileSync(new URL("./fixtures/platform-episode-delivery.v1.json", import.meta.url), "utf8")) as Fixture;
}

test("the recorded delivery fixture replays against the reference receiver exactly as documented", () => {
  const recorded = fixture();
  assert.equal(recorded.schema, "amos.platform-episode-delivery-fixture");
  assert.equal(recorded.version, 1);
  const store = new MemoryEventStore();
  const receiver = new PlatformEpisodeReceiver(store, {
    publicKey: publicKeyFromKmsDer(recorded.publicKeyDerBase64),
    expectedKeyId: recorded.keyId,
    now: () => new Date("2026-09-05T19:00:00.000Z")
  });
  const seen = new Set<string>();
  for (const item of recorded.cases) {
    if (item.requiresPriorCase) assert.ok(seen.has(item.requiresPriorCase), `${item.id} must follow ${item.requiresPriorCase}`);
    const raw = Buffer.from(item.rawBodyBase64, "base64");
    const response = receiver.receive(raw, { ...item.headers, bearerToken: null } as never);
    assert.equal(response.status, item.expect.status, `${item.id}: status`);
    assert.equal(response.body.status, item.expect.bodyStatus, `${item.id}: body.status`);
    if (item.expect.classification) assert.equal(response.body.classification, item.expect.classification, `${item.id}: classification`);
    if (item.expect.reasonPattern) assert.match(String(response.body.reason), new RegExp(item.expect.reasonPattern, "i"), `${item.id}: reason`);
    if (response.body.status === "accepted") assert.equal(response.body.payloadDigest, digest(JSON.parse(raw.toString("utf8"))), `${item.id}: payload digest`);
    seen.add(item.id);
  }
  assert.equal(store.events().length, recorded.eventsAfterReplay);
  assert.deepEqual(new Set(recorded.cases.map((item) => item.expect.bodyStatus)), new Set(["accepted", "duplicate", "rejected"]));
});
