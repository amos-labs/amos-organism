import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { retrievedDataTraceExamples, compileRetrievedDataTraceExamples } from "../src/desktopTraceCurriculum.js";
import { sftRow, validateAmosSystemTrainingExample } from "../src/amosNativeTrainingDataset.js";

// Retrieved-data curriculum: read the ledgers, THEN choose the calculator on the retrieved operands
// (the v3 candidate's tool-selection-after-retrieval gap). Clean multi-tool trajectory, no error.
const FIXTURES = JSON.parse(
  await readFile(new URL("./fixtures/desktop-training-trace-fixtures-readcalc-20260909.json", import.meta.url), "utf8"),
);

test("a retrieved-data trajectory yields exactly two examples: calc-target (reads kept) and checked-answer", () => {
  const [call, answer] = retrievedDataTraceExamples(FIXTURES.examples[0], { idPrefix: "recon" });
  // calc target: the ledger reads are masked context (never dropped), the calculate call is supervised.
  assert.equal(call.target.kind, "retrieved-tool-call");
  assert.deepEqual(call.input.toolTrace.contextTurns.map((m) => m.role), ["assistant", "tool", "assistant", "tool"]);
  assert.ok(Array.isArray(call.target.toolCalls) && call.target.toolCalls[0].function.name === "desktop_calculate");
  // No context-free arithmetic target is ever minted (operands came from the reads).
  assert.notEqual(call.input.toolTrace.contextTurns.length, 0);
  // checked answer: whole read+calculate exchange is context, the checked answer is supervised.
  assert.equal(answer.target.kind, "verified-synthesis");
  assert.equal(answer.target.toolCalls, undefined);
  assert.deepEqual(answer.input.toolTrace.contextTurns.map((m) => m.role), ["assistant", "tool", "assistant", "tool", "assistant", "tool"]);
});

test("compiles to two validated examples that render context-masked, target-supervised rows", () => {
  const examples = compileRetrievedDataTraceExamples(FIXTURES.examples);
  assert.equal(examples.length, 2);
  assert.equal(new Set(examples.map((e) => e.id)).size, 2);
  for (const example of examples) {
    assert.equal(validateAmosSystemTrainingExample(example).digest, example.digest);
    const row = sftRow(example);
    assert.equal(row.messages[0].role, "system");
    assert.equal(row.messages.at(-1).role, "assistant"); // the supervised target is the last turn
    assert.ok(Array.isArray(row.tools) && row.tools.length >= 1);
    const final = row.messages.at(-1);
    if (final.tool_calls) {
      for (const c of final.tool_calls) assert.equal(typeof c.function.arguments, "object");
    }
  }
});

test("a bare calculate-only trajectory (no retrieval) is rejected, and the final answer must be text", () => {
  const t = FIXTURES.examples[0];
  // system, user, calculate call, calculate result, final — no prior read supplying the operands.
  const noRead = { ...t, messages: [t.messages[0], t.messages[1], t.messages[6], t.messages[7], t.messages[8]] };
  assert.throws(() => retrievedDataTraceExamples(noRead, { idPrefix: "x" }), /retrieved-data trace must be/);
  const noFinal = structuredClone(t);
  noFinal.messages[noFinal.messages.length - 1] = { role: "assistant", content: "", tool_calls: [] };
  assert.throws(() => retrievedDataTraceExamples(noFinal, { idPrefix: "y" }), /final message must be an assistant text answer/);
});
