import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileEventStore } from "../src/eventStore.ts";

test("file event store persists and verifies an append-only digest chain", () => {
  const directory = mkdtempSync(join(tmpdir(), "amos-organism-events-"));
  const path = join(directory, "events.jsonl");
  try {
    const store = new FileEventStore(path);
    const first = store.append({
      id: "event-1",
      type: "trace.imported",
      missionId: "mission",
      occurredAt: "2026-08-24T00:00:00Z",
      authority: "host",
      hostReceiptId: "receipt-1",
      payload: { value: 1 },
    });
    const second = store.append({
      id: "event-2",
      type: "experience.negative",
      missionId: "mission",
      occurredAt: "2026-08-24T00:01:00Z",
      authority: "host",
      hostReceiptId: "receipt-2",
      payload: { value: 2 },
    });
    assert.equal(second.previousDigest, first.digest);
    assert.deepEqual(new FileEventStore(path).events(), [first, second]);

    const tampered = readFileSync(path, "utf8").replace('"value":1', '"value":9');
    writeFileSync(path, tampered);
    assert.throws(() => new FileEventStore(path), /Invalid organism event digest/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
