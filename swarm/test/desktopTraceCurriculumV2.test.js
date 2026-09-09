import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compileDesktopTraceExamples } from "../src/desktopTraceCurriculum.js";
import { sftRow, validateAmosSystemTrainingExample } from "../src/amosNativeTrainingDataset.js";

// Curriculum v2: development examples targeting the v3 candidate's concrete failure modes
// (camelCase-not-snake_case calculator keys, missing operand units, currency-mixed reconciliation).
// Tool results are real desktop_calculate executions on holdout-disjoint numbers.
const FIXTURES = JSON.parse(
  await readFile(new URL("./fixtures/desktop-training-trace-fixtures-v2-20260909.json", import.meta.url), "utf8"),
);

test("the three failure-mode trajectories compile to nine validated development examples", () => {
  const examples = compileDesktopTraceExamples(FIXTURES.examples);
  assert.equal(examples.length, 9, "3 trajectories x 3 examples");
  assert.equal(new Set(examples.map((e) => e.id)).size, 9);
  for (const example of examples) {
    assert.equal(validateAmosSystemTrainingExample(example).digest, example.digest);
    const row = sftRow(example);
    assert.equal(row.messages[0].role, "system");
    assert.equal(row.messages.at(-1).role, "assistant");
    assert.ok(Array.isArray(row.tools) && row.tools.length >= 1);
    const final = row.messages.at(-1);
    if (final.tool_calls) {
      for (const call of final.tool_calls) assert.equal(typeof call.function.arguments, "object");
    }
  }
});

test("supervised corrected calls fix the exact failure mode (snake_case keys, explicit operand units)", () => {
  const byId = new Map(compileDesktopTraceExamples(FIXTURES.examples).map((e) => [e.id, e]));
  // snake_case: the supervised corrected call uses only snake_case step keys.
  const snake = byId.get("development-snake-case-key:corrected-tool-call");
  for (const call of snake.target.toolCalls) {
    for (const step of call.function.arguments.steps) {
      assert.match(step.key, /^[a-z][a-z0-9_]*$/, `${step.key} must be snake_case`);
    }
  }
  // operand units: every operand in the supervised corrected call carries an explicit unit or a step reference.
  const unit = byId.get("development-operand-unit:corrected-tool-call");
  for (const call of unit.target.toolCalls) {
    for (const step of call.function.arguments.steps) {
      for (const operand of step.operands) {
        assert.ok(operand.step !== undefined || typeof operand.unit === "string", "operand needs an explicit unit");
      }
    }
  }
  // The rejected (camelCase) call only ever appears as masked context, never as a supervised target.
  assert.equal(snake.target.kind, "recovery-transition");
  assert.deepEqual(snake.input.toolTrace.contextTurns.map((m) => m.role), ["assistant", "tool"]);
});
