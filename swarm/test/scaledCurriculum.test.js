import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  compileDesktopTraceExamples,
  compileRetrievedDataTraceExamples,
  compileRetrievedAnswerTraceExamples,
} from "../src/desktopTraceCurriculum.js";
import { validateAmosSystemTrainingExample, sftRow } from "../src/amosNativeTrainingDataset.js";

// The scaled targeted curriculum for the approved next candidate: real tool receipts, holdout-disjoint,
// across all three v3-named failure modes. Recovery x8 (24), read->calculate x8 (32: 2 read-prefix +
// calc + answer per trajectory, now that reads are supervised), date x12 (24: read-prefix + answer per trajectory) = 80.
const load = async (f) => JSON.parse(await readFile(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
const recovery = await load("desktop-training-trace-fixtures-recovery-scaled-20260909.json");
const readcalc = await load("desktop-training-trace-fixtures-readcalc-scaled-20260909.json");
const date = await load("desktop-training-trace-fixtures-date-scaled-20260909.json");

test("the scaled curriculum compiles to uniquely-identified, validated examples with supervised reads", () => {
  const a = compileDesktopTraceExamples(recovery.examples);
  const b = compileRetrievedDataTraceExamples(readcalc.examples);
  const c = compileRetrievedAnswerTraceExamples(date.examples);
  assert.equal(a.length, 24, "8 recovery trajectories x 3");
  assert.equal(b.length, 32, "8 read->calculate trajectories x 4 (2 read-prefix + calc + answer)");
  assert.equal(c.length, 24, "8 single + 4 multi-month date trajectories x 2 (read-prefix + answer)");
  const all = [...a, ...b, ...c];
  assert.equal(all.length, 80);
  assert.equal(new Set(all.map((e) => e.id)).size, 80);
  assert.equal(new Set(all.map((e) => e.digest)).size, 80);
  for (const e of all) {
    assert.equal(validateAmosSystemTrainingExample(e).digest, e.digest);
    const row = sftRow(e);
    assert.equal(row.messages[0].role, "system");
    assert.equal(row.messages.at(-1).role, "assistant");
    const final = row.messages.at(-1);
    if (final.tool_calls) for (const call of final.tool_calls) assert.equal(typeof call.function.arguments, "object");
  }
});

test("recovery corrected calls only ever use snake_case keys and explicit operand units", () => {
  for (const ex of compileDesktopTraceExamples(recovery.examples)) {
    if (ex.id.endsWith(":checked-final-answer")) continue;
    for (const call of ex.target.toolCalls ?? []) {
      for (const step of call.function.arguments.steps) {
        assert.match(step.key, /^[a-z][a-z0-9_]*$/, `${ex.id}: ${step.key} must be snake_case`);
        for (const operand of step.operands) {
          assert.ok(operand.step !== undefined || typeof operand.unit === "string", `${ex.id}: operand needs a unit`);
        }
      }
    }
  }
});

test("every scaled example is on a development-only split (never validation/holdout)", () => {
  for (const fx of [recovery, readcalc, date]) {
    for (const ex of fx.examples) {
      assert.match(ex.metadata.split, /^development/);
    }
  }
});
