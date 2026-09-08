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
import { constrainedPlanningFixture } from "./constrainedPlanning.js";

export const DESKTOP_EVAL_FIXTURES = Object.freeze({
  "numeric-reconciliation": numericReconciliationFixture,
  "recover-without-replaying-completed-actions": recoverWithoutReplayingFixture,
  "reuse-first-tool-selection": reuseFirstToolSelectionFixture,
  "tenant-bound-reporting": tenantBoundReportingFixture,
  "date-time": dateTimeFixture,
  "constrained-planning": constrainedPlanningFixture
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

/**
 * Build a SEMANTICALLY distinct seeded cohort for one family. Seeds are scanned from startSeed;
 * a case whose datasetDigest was already seen (in this cohort or in excludeDigests) is skipped, so
 * two seeds that yield the same task/world are never counted as distinct (Codex 20260908T023953Z).
 */
export function buildFamilyCohort(key, count, { startSeed = 0, excludeDigests = new Set() } = {}) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error(`count must be a positive integer, got ${count}`);
  if (!Number.isSafeInteger(startSeed) || startSeed < 0) throw new Error(`startSeed must be a non-negative integer, got ${startSeed}`);
  const cases = [];
  const seen = new Set();
  const limit = startSeed + count * 100; // bounded search for distinct datasets
  for (let seed = startSeed; seed < limit && cases.length < count; seed += 1) {
    const built = buildFixture(key, { seed });
    const digest = built.fixture.datasetDigest;
    if (!digest) throw new Error(`family ${key} fixture is missing datasetDigest`);
    if (seen.has(digest) || excludeDigests.has(digest)) continue;
    seen.add(digest);
    cases.push(built);
  }
  if (cases.length < count) throw new Error(`family ${key} could not produce ${count} semantically distinct cases`);
  return cases;
}

/**
 * Select a holdout cohort whose datasets are DISJOINT from an inspected development cohort, so the
 * inspected development cases never become the fresh holdout. Returns cases seeded past the dev
 * range and semantically deduplicated against the dev digests.
 */
export function selectHoldoutSeeds(key, count, { devSeeds = [] } = {}) {
  const devDigests = new Set(devSeeds.map((seed) => buildFixture(key, { seed }).fixture.datasetDigest));
  const startSeed = (devSeeds.length ? Math.max(...devSeeds) : -1) + 1;
  const cases = buildFamilyCohort(key, count, { startSeed, excludeDigests: devDigests });
  return { seeds: cases.map((c) => c.fixture.seed), digests: cases.map((c) => c.fixture.datasetDigest), cases };
}
