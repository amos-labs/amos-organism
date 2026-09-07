// Organism-owned Desktop-eval fixtures (representative families). Each entry is a factory
// returning { fixture, tools, verify } for amos-agent runDesktopFixture. Codex's controller
// supplies modelConfig/fetchImpl/expectedServedModel/limits and binds canonical
// treatment/protocol identity (missionComparisonProtocol) per run. Families are built out
// toward the 8 in coordination/artifacts/next-representative-eval-plan-20260907.md.
import { numericReconciliationFixture } from "./numericReconciliation.js";
import { recoverWithoutReplayingFixture } from "./recoverWithoutReplaying.js";

export const DESKTOP_EVAL_FIXTURES = Object.freeze({
  "numeric-reconciliation": numericReconciliationFixture,
  "recover-without-replaying-completed-actions": recoverWithoutReplayingFixture
});

export const FIXTURE_FAMILIES = Object.freeze([
  "numeric-reconciliation", "constrained-planning", "async-code", "date-time",
  "tenant-bound-reporting", "governed-context-dependent-state",
  "recover-without-replaying-completed-actions", "reuse-first-tool-selection"
]);

export function buildFixture(key) {
  const f = DESKTOP_EVAL_FIXTURES[key];
  if (!f) throw new Error(`unknown desktop-eval fixture: ${key}`);
  return f();
}
