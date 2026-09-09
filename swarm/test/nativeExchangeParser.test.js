import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { retrievedDataTraceExamples, retrievedAnswerTraceExamples, compileRetrievedDataTraceExamples } from "../src/desktopTraceCurriculum.js";
import { validateAmosSystemTrainingExample, sftRow } from "../src/amosNativeTrainingDataset.js";

// Codex 122641Z / 130503Z: both retrieved-data helpers share one native-exchange parser that
// accepts the real Desktop PARALLEL read representation and rejects orphan/duplicate/missing result
// ids. These are Codex's exact repro fixtures.
const load = async (f) => JSON.parse(await readFile(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));

test("a valid PARALLEL read group (both reads in one assistant turn) is accepted", async () => {
  const trajectory = await load("codex-repro-parallel-read-input.json");
  const examples = retrievedDataTraceExamples(trajectory, { idPrefix: "parallel" });
  assert.equal(examples.length, 2);
  const call = examples.find((e) => e.id.endsWith(":retrieved-tool-call"));
  // The parallel read group is preserved as context: one assistant turn with two calls, then two results.
  const ctx = call.input.toolTrace.contextTurns;
  assert.equal(ctx[0].role, "assistant");
  assert.equal(ctx[0].tool_calls.length, 2, "both parallel reads kept in the one assistant turn");
  assert.equal(ctx.filter((m) => m.role === "tool").length, 2, "both read results kept");
  assert.ok(ctx.at(-1).role === "tool");
  // Compiled forms validate and render.
  const compiled = compileRetrievedDataTraceExamples([trajectory]);
  assert.equal(compiled.length, 2);
  for (const e of compiled) {
    assert.equal(validateAmosSystemTrainingExample(e).digest, e.digest);
    assert.equal(sftRow(e).messages[0].role, "system");
  }
});

test("an ORPHAN read result id (read->calculate) is rejected", async () => {
  const trajectory = await load("codex-repro-orphan-readcalc-input.json");
  assert.throws(() => retrievedDataTraceExamples(trajectory, { idPrefix: "orphan" }), /unmatched tool_call_id/);
});

test("an ORPHAN read result id (retrieval->answer / date) is rejected", async () => {
  const trajectory = await load("codex-repro-orphan-date-input.json");
  assert.throws(() => retrievedAnswerTraceExamples(trajectory, { idPrefix: "orphan-date" }), /unmatched tool_call_id/);
});

test("a duplicate result id and a missing result are both rejected", async () => {
  const base = await load("codex-repro-parallel-read-input.json");
  // duplicate: answer the same call id twice
  const dup = structuredClone(base);
  const firstToolIdx = dup.messages.findIndex((m) => m.role === "tool");
  dup.messages[firstToolIdx + 1].tool_call_id = dup.messages[firstToolIdx].tool_call_id;
  assert.throws(() => retrievedDataTraceExamples(dup, { idPrefix: "dup" }), /unmatched tool_call_id/);
  // missing: drop one of the parallel results
  const miss = structuredClone(base);
  miss.messages.splice(firstToolIdx + 1, 1);
  assert.throws(() => retrievedDataTraceExamples(miss, { idPrefix: "miss" }), /missing tool results/);
});
