import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { retrievedAnswerTraceExamples, compileRetrievedAnswerTraceExamples } from "../src/desktopTraceCurriculum.js";
import { sftRow, validateAmosSystemTrainingExample } from "../src/amosNativeTrainingDataset.js";

// Date-overflow coverage: read the month lengths, THEN return the correct month-boundary date.
// A retrieval-then-reasoned-answer trajectory (no compute tool, no fabricated error).
const FIXTURES = JSON.parse(
  await readFile(new URL("./fixtures/desktop-training-trace-fixtures-dateoverflow-20260909.json", import.meta.url), "utf8"),
);

test("a retrieval-then-answer trajectory supervises the read call and the checked answer", () => {
  const examples = retrievedAnswerTraceExamples(FIXTURES.examples[0], { idPrefix: "date" });
  // The single month_lengths read now becomes a supervised read-prefix target, plus the checked answer.
  assert.equal(examples.length, 2);
  const read = examples.find((e) => e.id.endsWith(":read-prefix-0"));
  const answer = examples.find((e) => e.id.endsWith(":checked-final-answer"));
  // read-prefix: the month_lengths read is now SUPERVISED (was masked-only); no prior read context.
  assert.equal(read.target.kind, "retrieved-tool-call");
  assert.equal(read.input.toolTrace.contextTurns.length, 0);
  assert.ok(Array.isArray(read.target.toolCalls) && read.target.toolCalls.length >= 1);
  // checked answer: the read is masked context, never dropped.
  assert.equal(answer.target.kind, "verified-synthesis");
  assert.equal(answer.target.toolCalls, undefined);
  assert.equal(answer.target.content, "2026-02-03");
  assert.deepEqual(answer.input.toolTrace.contextTurns.map((m) => m.role), ["assistant", "tool"]);
});

test("compiles to validated examples (read-prefix + answer) rendering context-masked, target-supervised rows", () => {
  const examples = compileRetrievedAnswerTraceExamples(FIXTURES.examples);
  assert.equal(examples.length, 2);
  for (const example of examples) {
    assert.equal(validateAmosSystemTrainingExample(example).digest, example.digest);
    const row = sftRow(example);
    assert.equal(row.messages[0].role, "system");
    assert.equal(row.messages.at(-1).role, "assistant");
    assert.ok(row.tools.some((t) => t.function.name === "month_lengths"));
  }
  const answer = examples.find((e) => e.id.endsWith(":checked-final-answer"));
  assert.equal(sftRow(answer).messages.at(-1).content, "2026-02-03");
});

test("a trajectory with no prior read, or a nonempty non-text answer, is rejected", () => {
  const t = FIXTURES.examples[0];
  const noRead = { ...t, messages: [t.messages[0], t.messages[1], t.messages[4]] };
  assert.throws(() => retrievedAnswerTraceExamples(noRead, { idPrefix: "x" }), /retrieved-answer trace must be/);
  const noFinal = structuredClone(t);
  noFinal.messages[noFinal.messages.length - 1] = { role: "assistant", content: "", tool_calls: [] };
  assert.throws(() => retrievedAnswerTraceExamples(noFinal, { idPrefix: "y" }), /final message must be an assistant text answer/);
});
