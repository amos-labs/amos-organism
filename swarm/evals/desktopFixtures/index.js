// Organism-owned Desktop-eval fixtures (representative families). Each entry is a factory
// returning { fixture, tools, verify } for amos-agent runDesktopFixture. Codex's controller
// supplies modelConfig/fetchImpl/expectedServedModel/limits and binds canonical
// treatment/protocol identity (missionComparisonProtocol) per run. Families are built out
// toward the 8 in coordination/artifacts/next-representative-eval-plan-20260907.md.
import { numericReconciliationFixture } from "./numericReconciliation.js";
import { recoverWithoutReplayingFixture } from "./recoverWithoutReplaying.js";
import { reuseFirstToolSelectionFixture } from "./reuseFirstToolSelection.js";
import { tenantBoundReportingFixture } from "./tenantBoundReporting.js";
import { dateTimeFixture } from "./dateTime.js";

export const DESKTOP_EVAL_FIXTURES = Object.freeze({
  "numeric-reconciliation": numericReconciliationFixture,
  "recover-without-replaying-completed-actions": recoverWithoutReplayingFixture,
  "reuse-first-tool-selection": reuseFirstToolSelectionFixture,
  "tenant-bound-reporting": tenantBoundReportingFixture,
  "date-time": dateTimeFixture
});

export const FIXTURE_FAMILIES = Object.freeze([
  "numeric-reconciliation", "constrained-planning", "async-code", "date-time",
  "tenant-bound-reporting", "governed-context-dependent-state",
  "recover-without-replaying-completed-actions", "reuse-first-tool-selection"
]);

export function buildFixture(key, options = {}) {
  const f = DESKTOP_EVAL_FIXTURES[key];
  if (!f) throw new Error(`unknown desktop-eval fixture: ${key}`);
  return f(options);
}

/** True when every planned family has a built factory. */
export function allFamiliesBuilt() {
  return FIXTURE_FAMILIES.every((key) => key in DESKTOP_EVAL_FIXTURES);
}

/** Build a distinct seeded cohort for one family: seeds 0..count-1 must yield unique case ids. */
export function buildFamilyCohort(key, count) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error(`count must be a positive integer, got ${count}`);
  const cases = [];
  const ids = new Set();
  for (let seed = 0; seed < count; seed += 1) {
    const built = buildFixture(key, { seed });
    if (ids.has(built.fixture.id)) throw new Error(`family ${key} produced a duplicate case id at seed ${seed}`);
    ids.add(built.fixture.id);
    cases.push(built);
  }
  return cases;
}
