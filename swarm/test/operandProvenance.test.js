import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { desktopTraceExamples, retrievedDataTraceExamples } from "../src/desktopTraceCurriculum.js";

// Codex 134029Z: a supervised desktop_calculate call may not carry a LITERAL operand the evidence
// (prompt / prior reads) never supplied — a verified receipt for 40000-18000 must not teach an
// invented 18000. The compiler fails closed on ungrounded supervised operands.
const load = async (f) => JSON.parse(await readFile(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));

test("the corrected currency example is grounded (every operand is in the prompt) and compiles", async () => {
  const fx = await load("desktop-training-trace-fixtures-recovery-scaled-20260909.json");
  const currency = fx.examples.find((e) => e.id.includes("currency"));
  assert.ok(currency, "a currency recovery example exists");
  // sanity: it must not reintroduce the old ungrounded 18000-without-prompt shape
  assert.doesNotThrow(() => desktopTraceExamples(currency, { idPrefix: "currency" }));
});

test("an INVENTED operand in a supervised corrected call is rejected", async () => {
  const fx = await load("desktop-training-trace-fixtures-recovery-scaled-20260909.json");
  const base = fx.examples.find((e) => e.id.includes("currency"));
  const bad = structuredClone(base);
  // Inject an operand value that appears nowhere in the prompt.
  const args = JSON.parse(bad.messages[4].tool_calls[0].function.arguments);
  args.steps[0].operands[1].value = 99999;
  bad.messages[4].tool_calls[0].function.arguments = JSON.stringify(args);
  assert.throws(() => desktopTraceExamples(bad, { idPrefix: "bad" }), /not grounded in the prompt/);
});

test("a read->calculate call is grounded by the retrieved read results, not the prompt", async () => {
  const fx = await load("desktop-training-trace-fixtures-readcalc-scaled-20260909.json");
  // These operands come from the ledger read receipts (amounts not in the prompt) — must still pass.
  assert.doesNotThrow(() => retrievedDataTraceExamples(fx.examples[0], { idPrefix: "rc" }));
  // Break the grounding: change a read result so the calc operand is no longer present anywhere.
  const bad = structuredClone(fx.examples[0]);
  const rowsMsg = bad.messages.find((m) => m.role === "tool");
  const rows = JSON.parse(rowsMsg.content);
  rows.rows[0].amount = 424242; // calc still references the original amount, now ungrounded
  rowsMsg.content = JSON.stringify(rows);
  assert.throws(() => retrievedDataTraceExamples(bad, { idPrefix: "rcbad" }), /not grounded/);
});
