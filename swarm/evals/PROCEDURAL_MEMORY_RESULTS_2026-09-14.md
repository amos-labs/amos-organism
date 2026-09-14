# Restarted procedural-memory results — September 14, 2026

**The persistent-memory path worked, but it did not improve this pilot.** Both arms completed all eight tasks with identical executed tool traces, 47 execution requests and 39 tools per arm. Generating and supplying the two memories added two model requests and 15.1% total inference tokens. The preregistered positive-pilot rule was not met.

This is a completed negative result on usefulness, with successful generation, persistence, reload and exposure. It is not evidence that the model's weights learned, that persistent memory generally fails, or that the broader mind architecture is validated.

## Protocol and integrity

Frozen source: `a84288a861d407e04b4359a4ae00eff5f2593657`.
Manifest: `19a1554ab4d6af3b4621de0d7d7a12fe3485d4d70bcacc32280fe90aaa8b86c7`.
Archive: `603f0889555778885a3cfcb2d97ad89aa6b991c681b5d71bc1d44456cb1e9682`.
Raw report: `4d7f4ca9ff5d6eecc884fdc7c9c6bf33d83d17b6e046960a6fa09fda9f741791`.

The unchanged research model was `amos-a0-epoch-3-step-357`, adapter SHA `fd2224d5e47f5314f6ebacedb5fa7269cd6e7f6dd682aead8013e3ab30f780c5`. This used the retained private research host; production serving and model weights were unchanged. The actor-process restart does not imply a model-server restart or filesystem sandbox.

One acquisition process generated two summaries from four independently verified TRAIN trajectories. The 139-word reservation summary and 153-word invoice summary both passed the fixed availability filter. They remained unverified advice in the existing persistent replay store. Sixteen new actor processes each loaded an immutable snapshot: empty for baseline, prose-only for treatment. Every actor received empty demonstrations and executable skill libraries. Exact family/record selection was used, not HRR ranking.

The independent audit reported **zero discrepancies** across all 19 frozen source files, four source replays, 17 process identities, snapshot provenance, actual requests and responses, and 16 native task replays containing 78 raw tool attempts. All 186 exported files, 8,369,923 bytes, matched the export index's sizes and SHA-256 values.

## Paired task outcomes

| Family / mode | No memory | Procedural memory | Model calls per arm | Tools per arm |
|---|---:|---:|---:|---:|
| Reservation / fresh | Pass | Pass | 6 | 5 |
| Reservation / partial | Pass | Pass | 5 | 4 |
| Reservation / unknown applied | Pass | Pass | 7 | 6 |
| Reservation / unknown unapplied | Pass | Pass | 7 | 6 |
| Invoice / fresh | Pass | Pass | 5 | 4 |
| Invoice / partial | Pass | Pass | 4 | 3 |
| Invoice / unknown applied | Pass | Pass | 6 | 5 |
| Invoice / unknown unapplied | Pass | Pass | 7 | 6 |
| **Total** | **8/8** | **8/8** | **47** | **39** |

There were zero paired gains, zero losses and eight shared passes. These are bounded completions: the native checker passed and the actor ended cleanly, within request/tool/time/output limits. No incomplete cases, missing advice, output truncations, context rejections, HTTP retries, prompt-token mismatches or unknown usage were observed.

All eight pairs have identical action names, argument objects, public results and ordering. All 47 paired model inputs match after removing only `proceduralMemory`, including later turns. Tool-call IDs and six of eight final answers differ. Thus executed behavior was unchanged; this is not a claim of identical raw output or proof that the model internally ignored the text.

## Cost, including creation

| Scope | Logical requests | Prompt tokens | Output tokens | Total tokens |
|---|---:|---:|---:|---:|
| No-memory evaluation and total | 47 | 91,040 | 2,727 | 93,767 |
| Memory evaluation only | 47 | 99,795 | 2,779 | 102,574 |
| Memory creation | 2 | 5,026 | 363 | 5,389 |
| **Memory including creation** | **49** | **104,821** | **3,142** | **107,963** |

Memory added exactly 183 input tokens to each reservation request and 190 to each invoice request: 8,755 extra evaluation input tokens. Evaluation alone used 9.4% more total tokens. Including creation, overhead was two calls and 14,196 total tokens, or **15.1%**, with no completion or action benefit. Calls per completion were 5.875 without memory and 6.125 including memory creation.

The complete run used 96 inference requests/HTTP attempts, 96 request-time tokenizer calls and one separate models probe. Initial qualification made another 18 tokenizer-only requests and no generations. All returned inference usage is known. The complete parent run lasted 177.5 seconds, from 00:24:28.697 to 00:27:26.231 UTC. Summed child wall time was 82.0 seconds for baseline versus 95.4 seconds including memory creation. This single timing comparison is not an isolated latency effect or GPU-time measurement.

## What this teaches us

The summaries organized useful-looking advice, but no new operational premise was identified beyond what both actors already had. Current tool descriptions, goals and error messages already explain revision refresh, exact quantities, reuse, reconciliation, stopping and forbidden effects. Unknown-outcome errors even name the required inspection. Successful mutation receipts establish current state without a mandatory additional read.

The suite contains one target order per task, two or three lines, sufficient stock, complete readbacks and at most one injected first-mutation ambiguity. Actual timeouts occurred only on `reserve_line` or `create_invoice`; unknown confirmation/annotation outcomes were not exercised. There are no concurrent writers, delayed visibility, cross-task conventions or long histories. This meaningfully tests execution and recovery, but creates little demand for retained knowledge. The observed baseline was already 8/8. Redundancy is a plausible explanation for the null result, not a separately isolated causal finding.

Together with the prior compiler studies, this narrows the problem:

- A worked example improved first-attempt legal ASTs from 0/6 to 5/6, but admitted skills remained 0/6 in both arms. Structural help did not solve semantic control and state binding.
- The model can execute these workflows through ordinary tools while failing to distill reliable executable programs under the tested compiler protocol.
- Generating, saving, reloading and inserting prose is operationally viable. None of those steps alone establishes useful learning.
- Memory should earn its context cost through better future decisions or less repeated work. This pilot provides no basis to enable these summaries by default or call them a learned performance gain.

The earlier 57/57 raw-tool study included TRAIN demonstrations in actor prompts; this pilot did not. Direct cross-study accuracy or cost comparisons remain invalid. Eight pairs share two one-shot summaries; this is not broad transfer, independent induction replication, weight learning, neural recurrence or lifelong retention evidence.

## Next experiment — proposed, not dispatched

Test retained environment knowledge that can avoid repeated discovery while preserving a fair baseline. Use a stable, versioned workflow convention that current tool descriptions do not spell out, with a documented read-only lookup available to every actor. Prior verified experience can teach the convention; new tasks use fresh entities. A no-memory actor can still solve the task by looking it up. This creates a measurable efficiency opportunity without making baseline success impossible.

Before further generation, preregister cases and include an equally bounded advice-from-tool-docs control to distinguish experience-derived content from generic guidance. Keep ordinary current evidence authoritative, charge acquisition costs, and retain the present tasks as a regression check. A later policy-version change should require refreshing stale memory. These are next-design recommendations, not results or permission for automatic resampling of this pilot.

## Qualification record and artifacts

The repository check passed 767 tests with one skip before final accounting-only refinements; the final focused CLI suite passed all nine tests. On the pinned remote Node 22.16 runtime, initial qualification passed 50/51: a persistence-test child lacked the parent's experimental TypeScript flag. No inference had begun. The same frozen tests then passed 51/51 with `NODE_OPTIONS=--experimental-strip-types` inherited by test subprocesses. A separate recovery SHA guard caught the heredoc's trailing newline; verification was corrected to the exact original dispatched bytes. Original failure receipts were preserved. No scored source, prompt, seed, case or budget changed.

Successful detached launch: SSM `570b3f5d-e170-4117-baeb-91bc4812ec7d`, unit `amos-procedural-memory-20260914.service`, invocation `410c8899ebd64249ab0df9141428d217`. The host and research server remain retained; there is no automatic rerun.

Full private workspace evidence is in `coordination/artifacts/procedural-memory-20260914/`: `ANALYSIS_PLAN.md`, `source-binding.json`, `dispatch-receipt.json`, `preparation-incidents.json`, `independent-audit.json`, `paired-behavior.json`, `mechanism-analysis.json`, and the complete `exported/` bundle. The frozen audit ran unchanged; no post-result scoring correction was required.
