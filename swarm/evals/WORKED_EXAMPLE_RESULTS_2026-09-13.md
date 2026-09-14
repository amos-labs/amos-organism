# Worked-example comparison — September 13, 2026

The complete worked example improved legal first-attempt procedure structure
from **0/6 to 5/6**, but both arms still admitted **0/6 reusable skills**. Several
example-guided candidates performed part of the workflow correctly; none passed
all four native TRAIN cases. The independent audit reproduced all twelve cells,
72 native validations and 277 raw tool calls with zero discrepancies.

This supports the narrow hypothesis that the representation-teaching package
helps this model express executable programs. It does not establish useful
persistent learning, improved weights or successful skill transfer.

## Fixed comparison

The [preregistration](WORKED_EXAMPLE_EXPERIMENT.md) compared the existing guide
against that same guide plus one complete read-only example: goal, program and
actual public inspection trace. The example teaches looping, safe references,
guards and completion, without supplying either target mutation algorithm.
This tests the whole worked-example package, not syntax instruction alone.

Both arms used the same fixed S7 research adapter, JSON-object mode, temperature
1, 3072 output tokens, 8192 context, paired TRAIN demonstrations and unchanged
feedback/admission rules. There were two families, three fresh replicates and
three attempts per cell. Initial responses were independently generated because
the treatment changes the initial prompt. Later prompts depend on actual feedback.

| Outcome | Guide only | Worked example |
| --- | ---: | ---: |
| Primary: admitted within three attempts | **0/6** | **0/6** |
| First attempt: valid JSON | 6/6 | 6/6 |
| First attempt: legal procedure structure | 0/6 | 5/6 |
| First attempt: all four native/completion checks | 0/6 | 0/6 |
| All attempts with legal structure | 5/18 | 13/18 |
| Native validation exposures | 20 | 52 |
| Successful native/completion exposures | 0 | 12 |

The last three rows are descriptive adaptive-attempt counts. They are not
independent trials or twelve acquired skills. Repeated attempts reuse TRAIN
worlds. In particular, six of the twelve successful exposures are the same
invoice program passing the same two worlds three times.

## What changed, and what still failed

**The model could use the example to produce executable structure.** All 36
scored responses were complete parseable JSON. Structural rejection fell from
13/18 baseline attempts to 5/18 example attempts. This run had no context
rejections, output truncations or transport errors, so those do not explain the
remaining zero admission score. The small sample remains a diagnostic comparison,
not a general claim about program induction or model rankings.

**Partial execution success did not become a reliable skill.** The strongest
reservation candidate passed fresh, partial and applied-timeout worlds: 3/4.
It falsely claimed completion on the unapplied-timeout world. Its next attempt
fell to 0/4, and its final attempt was structurally invalid. An invoice candidate
passed 2/4 and then lost both successes; a different invoice candidate passed
1/4 before two structurally invalid successors. Native behavior of invalid
successors is unassessed, not four measured business-logic failures.

The reservation regression has a concrete cause in the traces: the first
candidate reconciled the unapplied write but did not retry the still-unreserved
line. Its repair saved fresh inspections under a new variable while subsequent
writes still read the old variable's revision. Revision conflicts then broke
every world. All recorded native validations had zero unsafe retries; this
failure was stale state binding after a fresh observation.

**Some repairs repeated without improving.** The first invoice example cell
produced identical candidate text in all three attempts, preserving its two
passing cases while failing both ambiguous cases. Other cells repeated invalid
or unsuccessful candidates. These finite repeats do not establish an infinite
loop, and matching seeds do not guarantee identical outputs generally.

**Independent completion checks remain essential.** Across the 72 native
validation exposures, 33 executions returned completed. Twelve satisfied the
native verifier and 21 did not. The unchanged acceptance gate rejected the false
claims. There was no new all-four-state success held back solely by a missing
terminal return; all twelve verifier passes also met the completion contract.

**The remaining problem includes recovery logic and generalization.** Syntax
teaching makes native failures easier to observe, but does not itself teach
when an uncertain write applied, when to inspect again, which revision to use,
or how to recover without discarding a working branch. Each retry regenerates
from the demonstrations and bounded failure feedback. It does not receive the
previous program or its passing cases. The observed regressions therefore do
not test whether the model can edit a visible prior program successfully; this
retry policy does not preserve the strongest candidate encountered so far.

One example-arm reservation cell only inspected orders and stopped. It hardcoded
two identifiers from the target TRAIN demonstrations instead of looping over the
current goal. These were not the teaching example's identifiers. No candidate
was an exact copy of the example program, and neither example order ID appeared
in any candidate text. Read-only behavior here is not proof that the model copied
the teaching goal; the concrete failure is using hardcoded demonstration IDs.

## Transfer and the next decision

All twelve saved libraries are empty. The frozen fresh-world secondary retains
72 intended slots per arm, with zero program executions and zero solved slots.
Conditional execution success is undefined. This is not a measurement of
72 executed programs failing, and supplies no A-then-B retention evidence.

The selector was frozen before inspecting fault outcomes and was not resampled.
Its invoice ambiguous worlds all realize applied writes, so this secondary would
not cover unapplied invoice timeouts even if a program had been admitted. Native
TRAIN admission still includes both outcomes. Future evaluation sets should
declare required fault coverage during design.

The agreed stopping rule now applies: prioritize a direct persisted-procedural-
memory versus no-memory comparison before further compiler prompt variants.
Generate memory from verified TRAIN experience, save it, restart the actor, and
test on fresh workflows through ordinary tools. Neither evaluation arm should
receive the original training traces. Measure verified completion and actual
inference cost, including memory creation, and keep the model fixed.

This asks whether experience can help later work without requiring a compiled
program. The existing narrow raw-tool baseline leaves little observed accuracy
headroom, so fewer calls or lower cost at preserved correctness could be a useful
first result. Memory availability alone would not establish such a benefit.

Keep the compiler findings: a complete example is useful representation guidance
in this sample, and future repair should test preservation of verified progress.
Those findings do not justify admitting a 3/4 program, changing scores or running
another weight update on their own. No subsequent model experiment is dispatched
by this result document.

## Execution and evidence

Scored core: 23:31:28.807–23:38:00.357 UTC, September 13. CLI including conformance:
393,113 ms, approximately six minutes and thirty-three seconds. The wrapper
exited successfully, exported 27 files and retained the research host. Model
weights and production serving were unchanged.

| Actual inference scope | Calls | Prompt tokens | Output tokens |
| --- | ---: | ---: | ---: |
| Guide only | 18 | 54,356 | 6,077 |
| Worked example | 18 | 66,344 | 7,602 |
| Separate conformance | 4 | 226 | 38 |
| Total | **40** | **120,926** | **13,717** |

All forty tokenizer preflights matched returned prompt usage. No requests were
rejected or retried; all usage is known. Another 36 tokenizer-only development
probes preceded scoring and generated no answers. Their maximum prompt sizes
were 3547 baseline and 4041 example tokens. These costs are separate from the
scored run. Wall time and tokens do not measure GPU occupancy or the AWS bill.

Validation: full repository checks passed with 750 tests passing, one skipped,
zero failures. All 55 focused remote launch tests passed. Independent replay binds the
entire import graph, native example trace, exact per-request treatment, persisted
libraries, raw tool responses, tokenizer and inference request hashes, and grades.
The 72 native validation exposures cover 24 distinct TRAIN worlds.

- Frozen source: `ea03be50e5a7d3066f8871da1b394d6bff235d1c`.
- Source archive: `cec1d623bb09ba5df747a0f49a38f1b21b4fb4fc490e291a4b18e9a7555b70f0`.
- Manifest: `63f894f367a977181ea5d39681cabcc062509a066ae6465040d6e7714630f96b`.
- Raw report: `641dae7c69e705f6f3d065ce8fbd605f339f457752eb13bed9c48b23453846b6`.
- Worked example: `b41bcf8e9c7ec14e09b519137790c4fa72dd6db4f11da30ef5f9823bd22f1616`.
- Model alias: `amos-a0-epoch-3-step-357`.
- Adapter bytes: `fd2224d5e47f5314f6ebacedb5fa7269cd6e7f6dd682aead8013e3ab30f780c5`.

Detailed evidence is in shared `coordination/artifacts/worked-example-20260913/`,
including `independent-audit.json`, `independent-findings.md`,
`fresh-world-probe.json`, `context-fit.json`, `source-binding.json` and
`exported/run/`. Cloud exports are under the verified private research prefix
`s3://amos-qwen-research-plane-637423327454-us-east-1/stage1/worked-example-2026-09-13/run/`.
Serving receipts bind mounted adapter bytes and alias; they are not an independent
GPU tensor dump. This readout changes no frozen input, output or score.
