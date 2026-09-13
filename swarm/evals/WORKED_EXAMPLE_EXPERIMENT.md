# Complete worked example: bounded skill-acquisition comparison

This follows the completed repair comparison, which admitted no skills. It tests
whether teaching the exact procedure representation improves acquisition from
the same kind of verified tool demonstrations. It changes no model weights.

## Comparison

| Setting | Fixed protocol |
| --- | --- |
| Arms | `guide-only`, `worked-example` |
| Treatment | Add one complete neutral read-only example: goal, executable program and exact public trace |
| Families | `reserve-order`, `invoice-order` |
| Replicates | Three, with model seeds 20260916, 20261017, 20261118 |
| Demonstration seeds | Reservation 160000; invoice 170000; add replicate × 100 |
| Acquisition seeds | 180000 + replicate × 100 + family index × 1000 |
| Admission | Existing four native TRAIN cases all reach verified state and explicitly return completed |
| Generation | JSON-object mode, temperature 1, thinking disabled, 3072 output tokens |
| Context | Existing 8192-token serving window; actual per-request tokenizer preflight |
| Budget | At most three generations per acquisition, six acquisitions per arm; 36 scored logical requests |
| Conformance | Four separate probes using seed 20260913 and 128 output tokens |
| Runtime | Thirty minutes; at most four transport attempts per logical request |

The two arms receive identical raw-tool catalogs, TRAIN demonstrations, compiler
guide and existing retry feedback. The worked example is the only added input
field. Neither arm receives the repair study's extra diagnostics or previous
candidate text. Each starts with an empty independent skill library. Order
alternates by replicate plus family index. The first responses are generated
separately because the treatment applies to the first prompt; responses are not
shared or assumed identical because seeds match. Later prompts depend on each
arm's actual feedback.

The example teaches safe variable names, object-valued references, a loop,
guarded dereferencing, conditional branches and explicit completion. It only
inspects example-specific orders. It supplies no reservation, invoice mutation,
unknown-write reconciliation algorithm or scored-world identifiers. Native CPU
checks must verify its trace, success and failure branches, and unchanged state
before any scored model request. The model still has to infer the target
workflow from its TRAIN demonstrations.

## Measures and decision

Primary: acquisitions admitted within three attempts, denominator six per arm,
with paired gains/losses and the admission difference. This is a small diagnostic
sample, not a broad model benchmark. A zero-versus-zero result does not establish
equivalence. Report first-attempt JSON validity, legal instruction structure and
native/completion success separately. Later attempts are descriptive retry-policy
outcomes, not independent randomized observations.

Record every rejected request, truncated output, structural error, failed native
case, completion claim, full pass vector, raw tool call and saved library. Track
whether repairs preserve previously passing cases. Report actual prompt/output
tokens, inference requests, transport retries and wall time. The example adds
prompt tokens; equal request caps do not imply equal realized compute.

Before scoring, freeze a separate twelve-world-per-family transfer probe with
split `worked-example-transfer`: reservation base 260000 and invoice base
270000; four fresh seeds at base + 0..3, four partial at base + 100..103 and four
ambiguous at base + 200..203. Do not resample after inspecting outcomes. After
all compilation finishes, reload each persisted library and execute admitted
programs on these worlds without model calls, raw fallback or repairs. Retain
all 72 intended slots per arm. With no admitted program, mark no execution;
conditional transfer is undefined. This does not test A-then-B retention.

If the worked-example comparison still admits no skill, prioritize a separate
cold-restart procedural-memory-versus-no-memory comparison before additional
compiler prompt variants. That experiment requires its own frozen design and
native outcomes. If skills are acquired, inspect fresh-world behavior and cost
before claiming a benefit or making any production change. Structural validity
alone is not an improvement in task completion.

## Execution evidence

Freeze the source commit/archive, exact example, demonstration hashes, curriculum,
secondary helper/spec, input-token qualification and manifest before dispatch.
The CLI keeps exclusive output directories, source/import hashes, wire settings,
actual tokenizer counts, returned usage and twelve library identities. An
independent audit replays recorded responses and native validations and checks
that removing the example restores the common first input.

Development tokenizer-only probes are separate from scored generation. Actual
retry prompts still undergo preflight; a development fit does not guarantee
that every future feedback payload will fit. Context rejection consumes an
attempt and remains in the result. No silent context trimming, output-cap
increase, score repair, candidate selection or rescoring is permitted.

Use the retained dedicated research instance and its unchanged S7 research
adapter; verify mounted bytes and serving alias before launch. This is not a
promotion of S7 or a comparison with S6. The existing research allocation and
production boundary remain unchanged. Private run artifacts live under shared
`coordination/artifacts/worked-example-20260913/`; public publication is a
separate pending disclosure approval.
