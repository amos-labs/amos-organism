import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { desktopTraceExamples, compileDesktopTraceExamples } from "../src/desktopTraceCurriculum.js";
import { sftRow, validateAmosSystemTrainingExample } from "../src/amosNativeTrainingDataset.js";

const NATIVE_TRACE = JSON.parse(
  await readFile(new URL("./fixtures/desktop-training-trace-fixtures-20260908.json", import.meta.url), "utf8"),
);

test("each native trajectory yields the three development examples with the right supervised decision", () => {
  const [corrected, firstCall, finalAnswer] = desktopTraceExamples(NATIVE_TRACE.examples[0], { idPrefix: "usd" });
  // corrected-tool-call: failed call + error masked, corrected call supervised.
  assert.equal(corrected.target.kind, "recovery-transition");
  assert.deepEqual(corrected.input.toolTrace.contextTurns.map((m) => m.role), ["assistant", "tool"]);
  assert.ok(Array.isArray(corrected.target.toolCalls));
  // first-correct-tool-call: no context, corrected call supervised as a clean first action.
  assert.equal(firstCall.target.kind, "tool-call");
  assert.equal(firstCall.input.toolTrace.contextTurns.length, 0);
  assert.ok(Array.isArray(firstCall.target.toolCalls));
  // checked-final-answer: whole exchange masked, final text supervised.
  assert.equal(finalAnswer.target.kind, "verified-synthesis");
  assert.equal(typeof finalAnswer.target.content, "string");
  assert.equal(finalAnswer.target.toolCalls, undefined);
  assert.deepEqual(finalAnswer.input.toolTrace.contextTurns.map((m) => m.role), ["assistant", "tool", "assistant", "tool"]);
});

test("both fixtures compile to six validated examples that render the expected supervised turn", () => {
  const examples = compileDesktopTraceExamples(NATIVE_TRACE.examples);
  assert.equal(examples.length, 6, "3 examples per trajectory x 2 trajectories");
  for (const example of examples) {
    // Round-trips through the immutable digest validator.
    assert.equal(validateAmosSystemTrainingExample(example).digest, example.digest);
    const row = sftRow(example);
    assert.equal(row.messages[0].role, "system");
    assert.equal(row.messages.at(-1).role, "assistant");
    assert.ok(Array.isArray(row.tools) && row.tools.length >= 1);
    // The failed call is only ever masked context, never the supervised final message.
    const final = row.messages.at(-1);
    if (final.tool_calls) {
      // A structured target's arguments are parsed objects, not strings.
      for (const call of final.tool_calls) assert.equal(typeof call.function.arguments, "object");
    }
  }
  // Ids are stable and distinct across the six examples.
  assert.equal(new Set(examples.map((e) => e.id)).size, 6);
});

test("a malformed trajectory is rejected rather than silently mislabeled", () => {
  const bad = { id: "bad", tools: NATIVE_TRACE.examples[0].tools, messages: NATIVE_TRACE.examples[0].messages.slice(0, 5) };
  assert.throws(() => desktopTraceExamples(bad, { idPrefix: "bad" }), /desktop trace must be/);
  const noFinal = structuredClone(NATIVE_TRACE.examples[0]);
  noFinal.messages[6] = { role: "assistant", content: "", tool_calls: [] };
  assert.throws(() => desktopTraceExamples(noFinal, { idPrefix: "x" }), /final message must be an assistant text answer/);
});

test("every example's sourceEpisodeId is a valid swarm store episode id (recordable for the mixed compile)", () => {
  // Mirrors EPISODE_ID_PATTERN in swarmLearningStore.js — must contain no colon so the derivatives
  // can be recorded as episodes and flow through compileAmosNativeTrainingDataset.
  const EPISODE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,499}$/;
  for (const example of compileDesktopTraceExamples(NATIVE_TRACE.examples)) {
    assert.match(example.sourceEpisodeId, EPISODE_ID, `${example.sourceEpisodeId} must be a valid episode id`);
  }
});
