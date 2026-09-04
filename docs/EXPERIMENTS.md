# Experiment Log

## 2026-09-04 — business-memory benchmark, first holdout runs

- Holdout pool, manifest `de370e5056ab…`, 80 cases, 11 families, seed
  `amos-business-memory-v1`, never used for tuning. Three runs on the same
  manifest: authored procedures (all arms), Qwen-harvested store (procedures arm),
  Opus-harvested store (procedures arm). Results under
  `swarm/benchmarks/results/business-memory-holdout-2026-09-04-*.json`; stores
  under `swarm/benchmarks/business-memory-procedures-harvested-*.json`.
- Memory versus alone on holdout: Opus 4/80 to 79/80 (75 paired wins, 0
  losses); Qwen 5/80 to 78/80 (73 wins, 0 losses). Qwen versus Opus on the
  memory arm: 1 win, 2 losses.
- Procedures arm, Opus: authored 75/80, Qwen-harvested 75/80, Opus-harvested
  80/80 (1 win, 0 losses against memory). Procedures arm, Qwen: authored
  77/80, Qwen-harvested 79/80 (1 win, 0 losses), Opus-harvested 78/80.
  A model's own harvested rules help it slightly with no losses; rules written
  by or for another model do not transfer and can cost cases. Four of Opus's
  nine procedures-arm failures were two-token empty completions on the longest
  prompts, counted as failures by design.
- Remaining memory-arm misses: Qwen twice compares the change amount rather
  than the resulting value against the approval threshold, which the policy
  text ("sets a monetary value above the threshold") leaves open to that
  reading; Opus missed one due date by using current terms. Tighten the policy
  wording to "the resulting value" before the next holdout.
- Claim boundary: single repetition, synthetic world, thinking off on both
  models. The suite is near ceiling for both models with memory; effect sizes
  for procedures are one or two cases and should not be quoted as a lift
  until harder families exist.

## 2026-09-04 — business-memory benchmark, corrected judgment run (run 4)

- Policy created before any receipt, approval thresholds raised so labels split
  5:3; 79 cases, development pool, manifest `f395bca9db86…`,
  `swarm/benchmarks/results/business-memory-development-2026-09-04-run4.json`.
- Opus 4/79 alone, 76/79 memory, 75/79 procedures. Qwen 5/79, 72/79, 73/79.
- Qwen's remaining misses share one cause: it applies the current value where
  the question asks for the value in effect at an earlier date. All four
  approval misses compare the proposed amount against the current threshold
  rather than the one at proposal time; the two as-of and one due-date misses
  are the same pattern. The authored as-of procedure did not change this.
- Opus: one scope case answered `unknown`, one due-date and one approval miss
  of the same as-of kind, and three empty responses on the procedures arm that
  count as failures.
- These failures feed the first harvest (`research:memory-harvest`) for both
  models; harvested stores are then measured only on the holdout pool.

## 2026-09-04 — business-memory benchmark, judgment families (run 3)

- Added four judgment families (approval-required-decision, invoice-due-date,
  stale-note-versus-record, replay-safety); 80 cases, development pool, manifest
  `8409fa80162e…`, `swarm/benchmarks/results/business-memory-development-2026-09-04-run3-judgment.json`.
  The Qwen cell's vLLM process had restarted between runs 2 and 3; model id unchanged.
- Opus 4/80 alone, 77/80 memory, 77/80 procedures. Qwen 5/80, 73/80, 74/80.
  Recall families stayed saturated. Replay safety and stale notes were solved
  from memory alone by both models. Invoice due dates went 7/8 to 8/8 for both
  with the authored as-of-terms procedure.
- Fixture flaw found through a leaked Opus reasoning trace: the spend policy
  could be recorded after a receipt, and `valueAsOf` returned the first
  revision for instants before it existed, so the verifier demanded approval
  under a policy that did not yet exist. Both models correctly answered
  `no_approval_required`; 4 of Qwen's and 1 of Opus's approval misses were this
  flaw. Fixed by creating the policy before any receipt and skipping cases
  where a receipt predates it. Run 3 approval numbers are therefore invalid;
  the rest of run 3 stands.
- Persistent genuine misses: Qwen chose the current value instead of the as-of
  value on the same two value-as-of-date cases in every run; Opus answered one
  scope case as `unknown` and emitted one empty response.

## 2026-09-04 — business-memory benchmark, first live runs

- Benchmark: `docs/swarm/BUSINESS_MEMORY_BENCHMARK.md`, development pool, 4 worlds,
  52 cases, arms alone / memory / procedures, extended thinking off on both models.
- Models: Qwen 3.8 27B FP8 on the AWS research cell (`amos-qwen38-27b-fp8`) and
  Claude Opus 5 through the Bedrock benchmark gateway as the frontier control.
- Run 1 (manifest `d4434bee0ce4…`, `swarm/benchmarks/results/business-memory-development-2026-09-04-run1.json`):
  Opus 4/52 alone, 42/52 memory, 48/52 procedures; Qwen 5/52, 41/52, 43/52.
  Memory versus alone: 38 and 36 paired wins, zero losses. Two failure clusters
  were contract and renderer artifacts: the two-part session-claim question drew
  prose into the `answer` field, and the envelope did not name collections
  outside scope, so both models returned `unknown` instead of `scope_denied`.
- Changes before run 2: the claim question asks for the recorded value as the
  answer and the mismatch in `conflict`; the envelope lists
  `collectionsOutsideScope` from the catalog, as the platform can.
- Run 2 (manifest `3e9c417472be…`, `…-run2.json`): Opus 4/52 alone, 51/52 memory,
  51/52 procedures; Qwen 5/52, 50/52, 50/52. Memory versus alone: 47 and 45
  paired wins, zero losses. Qwen versus Opus on the memory arm: 1 win, 2 losses.
- Observation: with the deterministic envelope carrying scope facts, the
  authored procedures added nothing on this suite. Rules the compiler can state
  as facts should live in the compiler; procedural memory has to earn its place
  on cases the compiler cannot resolve. The remaining misses are two Qwen as-of
  revision errors (same cases in both runs) and one Opus scope case answered
  `unknown`.
- Claim boundary: development pool, single repetition, synthetic world, authored
  procedures. Not a holdout result.


## 2026-08-24 — active recursive organism run

- Run ID: `recursive-organism-active-hrr-energy-production-planning-20260824-r1`
- Dataset: Terminal-Bench 3.0
- Task: `production-planning`
- Substrate: Qwen3.8 27B FP8 on the AMOS AWS research plane
- Organism policy digest:
  `4c1421c83dfc2562334c4944278f30543f2b38cfc40f0dd1c82f5948c1f24131`
- HRR mode: active
- Last observed state: iteration 1 running; Harbor task and runner containers
  healthy.
- Observation: proactive summarization twice reached the 4096-output-token cap.
  This is retained as evidence about memory pressure, not counted as a benchmark
  result or silently repaired during the run.

Outcome remains unrecorded until the official verifier and result artifacts
complete.
