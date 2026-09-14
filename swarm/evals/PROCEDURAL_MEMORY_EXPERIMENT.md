# Restarted procedural-memory pilot

This bounded synthetic experiment asks whether advice distilled from successful prior experience helps the same frozen model execute later tasks after its actor process restarts. It follows the worked-example compiler experiment's zero admitted skills. It does not change production, weights, the existing raw-tool actor, or its native task checker.

## Fixed comparison

One acquisition process generates exactly one prose summary for each of `reserve-order` and `invoice-order`. Each input includes the existing teacher's two verified TRAIN trajectories, public goals, and tool schemas. Reuse `buildSequentialDemonstrations` with seeds 240000 and 250000: its existing split is `training`, with a bounded 1000-offset selection. The selected applied/unapplied TRAIN seeds are 240000/240001 and 250005/250000.

Summary generation uses temperature 1, seeds 20260917 and 20261018, and 512 output tokens. At most 160 whitespace-separated words are allowed. Request failure, missing text, output truncation, excess words, or an exact copied TRAIN entity identifier makes the advice unavailable. There is no regeneration, manual edit, semantic admission, or evaluation-feedback loop. Preserve rejected responses and their costs.

Available summaries enter the existing persistent replay store as **unverified advice**, with model/source/response hashes and no original TRAIN example. Verified source trajectories do not verify generated advice. Selection is exact family/record ID, not HRR ranking.

The acquisition process exits before 16 independent actor processes run eight paired worlds. Each baseline actor reloads an empty snapshot; each treatment actor reloads the frozen advice snapshot. Both receive empty demonstrations and executable skill libraries, their current goal, tools and public observations. Only treatment adds `proceduralMemory` text (empty if unavailable). No prior task conversation or source trajectories enter actor inputs. This proves actor-process restart and input isolation; it does not claim an OS sandbox or model-server restart.

| Case | Family | Mode | Fixture seed | Model seed |
|---|---|---|---:|---:|
| 0 | reserve-order | fresh | 260000 | 20260917 |
| 1 | reserve-order | partial | 260100 | 20261018 |
| 2 | reserve-order | ambiguous, applied | 260200 | 20261119 |
| 3 | reserve-order | ambiguous, unapplied | 260202 | 20261220 |
| 4 | invoice-order | fresh | 270000 | 20261321 |
| 5 | invoice-order | partial | 270100 | 20261422 |
| 6 | invoice-order | ambiguous, applied | 270200 | 20261523 |
| 7 | invoice-order | ambiguous, unapplied | 270201 | 20261624 |

Evaluation split is `procedural-memory-evaluation`. Ambiguous seeds are the first matching outcome within 100 offsets from each family's ambiguity base, selected before generation. Even cases run baseline first; odd cases run treatment first. Each actor uses temperature 0, 1536 output tokens, at most 12 model calls, 32 raw tool attempts, and 120 seconds. All length-terminated responses fail before executing their proposed tools.

## Bounds and evidence

The entire run permits at most 194 logical inference requests (2 + 16 × 12), four HTTP attempts per request, and 40 minutes. A separate models probe is not an inference. There is no automatic resume. Every inference input is checked by the serving tokenizer against an 8192-token context while reserving its complete output allowance. Oversized inputs fail visibly without trimming or fallback. Record logical calls, transport attempts, tokenization, returned usage, missing usage, tools and wall time, including failed processes. Wall time is not measured GPU time.

Freeze source, archive, analysis plan, source receipts, case selection, model identity, weight digest and initial-context qualification before either generation. Record actual child PID/nonce/start/exit receipts, immutable snapshot bytes before and after evaluation, exact model messages and responses, public tool receipts and private native verdicts. Independently replay all source and evaluation actions and compare every result. Removing only treatment's memory field must make each initial paired input identical.

## Decision rule and limits

Primary outcome is native-verified completion within all bounds with clean `model-finished` termination. State correctness alone is insufficient. Retain all eight cases per arm, including unavailable memory and failures. A numerical positive requires no paired completion losses and either a completion gain, or equal completion with fewer total logical requests **including both summary-generation requests**. Full coverage and independent integrity checks are required. Report token, transport, tool and time costs alongside any call reduction.

Two generated summaries shared across eight task pairs are a small pilot, not independent learning replicates. Gains where advice is unavailable cannot be attributed to saved memory. The prior 57/57 raw-tool study included TRAIN trajectories in actor context; this baseline does not, so its ceiling is unknown and cross-study accuracy or cost comparisons are invalid. The experiment tests experience-derived guidance against its absence, not against equally sized generic advice. It does not establish weight learning, neural recurrence, HRR efficacy, lifelong retention, broad transfer or production readiness.

Run with `swarm/scripts/runProceduralMemoryExperiment.js`. The private dispatch manifest and `coordination/artifacts/procedural-memory-20260914/ANALYSIS_PLAN.md` bind this one run; they do not authorize adaptive reruns.
