# Skill repair results — September 13, 2026

The three-arm repair comparison completed with **0/6 admitted skills in every
arm**. Adding interpreter diagnostics and the previous candidate did not produce
an admitted skill under the fixed budget. Independent replay reproduced all
18 branches, 56 native TRAIN validations and 122 raw tool calls without a
discrepancy. No weights, production settings or acceptance rules changed.

The strongest diagnosis is a compiler-interface and abstraction bottleneck.
Most candidates failed before native execution, so the trial provided little
exposure to the added execution diagnostics. The limited execution evidence
also shows that repair did not preserve earlier successful behavior.

## Fixed comparison

The [preregistration](SKILL_REPAIR_EXPERIMENT.md) supplied one shared initial
generation to three branches for each of six fresh source cells. Each branch
could generate two repairs. Model, demonstrations, temperature 1, JSON-object
mode, 3072 output tokens, 8192 context and native admission remained fixed.

| Treatment | Skills admitted | Repair generations dispatched | Native validations |
| --- | ---: | ---: | ---: |
| Existing TRAIN feedback | 0/6 | 12 | 28 |
| Feedback + interpreter diagnostics | 0/6 | 12 | 24 |
| Diagnostics + previous candidate | 0/6 | 10 | 4 |

The third arm also consumed two logical attempts rejected by tokenizer preflight.
Six shared initial generations are counted once in actual inference cost, then
replayed into all eighteen branches. Native validation counts include these
replays. All eighteen persisted libraries are empty.

The six actual initial generations included two output truncations, three AST
rejections and one AST-valid candidate that passed only one of four TRAIN
worlds. These initial outcomes are shared across arms, not eighteen independent
samples. Subsequent prompts depend on each branch's feedback.

## What failed

Every scored logical request is retained in the following accounting:

| Failure stage | Unique scored requests |
| --- | ---: |
| Invalid procedure structure | 25 |
| Native execution or completion contract | 12 |
| Output budget exhausted | 3 |
| Input rejected before inference | 2 |
| Total | **42** |

Every untruncated output parsed as JSON here. The preceding format comparison
found higher JSON validity with JSON-object mode; this all-JSON repair run does
not independently estimate that effect. JSON-object mode did not guarantee a
finished valid object within the output allowance or a legal executable AST.

**Structure and reference abstraction dominated.** Examples include a top-level
`return` rather than a return step, invented root `type`/`status` fields,
unsafe variable names, quoted reference objects and literal reference strings.
Some programs copied a demonstration's order ID instead of using the current
goal. Independent inspection confirmed that ID came from the demonstration;
native tools correctly returned `not_found` in the new world. This is more than
a missing terminal return.

The compiler receives raw tool trajectories and separate syntax snippets, but
no complete worked program in this language. It must infer both workflow
control flow and its exact encoding. Its system prompt also contains runtime
operator instructions before the compiler guide. These are source-grounded
hypotheses about the bottleneck, not causal findings from this trial.

**The diagnostics treatment was sparsely exercised.** Nonempty execution
diagnostics reached only 3/12 repair requests in the diagnostics arm and 1/10
dispatched requests in the candidate arm. Most failures were syntax/structure
errors with no execution trace to add. Four branches first reached native
validation on their final candidate, when no repair remained. A zero admission
score does not establish that execution diagnostics are useless.
Raw candidate text reached 8/10 dispatched candidate-arm repairs. The other
two correctly carried unavailable text after the preceding request failed,
rather than silently reusing an older candidate.

**Repair lost working behavior.** The one shared executable invoice candidate
passed the fresh TRAIN world but failed the other three. With ordinary
feedback, its complete pass count went 1/4 to 0/4 to 0/4. The intermediate
candidate reached a correct state in a different partial world but failed to
return completed; the next candidate lost that state too. Diagnostics also
lost the original pass, then produced an invalid AST. Candidate-aware repair
went from that initial pass to an invalid AST and then truncated output.
There is no demonstrated accumulation of a working skill here.

**Completion claims needed independent checking.** Seven native executions
returned completed. Only three passed verification, and those three were the
same initial success replayed across arms. The other four completion claims
were false. The native acceptance gate caught all of them.

**Repeated errors were not all identical loops.** Four adjacent candidate-arm
outputs repeated byte-for-byte under changed inputs. Other retries changed
their text while retaining the same error. No consecutive pair had both the
same input and the same output. Eight diagnostics requests matched actual
feedback-only inputs: four returned matching text and four different text
despite the reused seed. Future comparisons must retain actual responses and
must not assume that a seed guarantees identical serving output.

## Context diagnosis

Both rejected candidate-aware requests followed a 3072-token truncated output.
The failed reservation output repeated structure; the failed invoice output
contained a long whitespace tail. Embedding the entire raw string in JSON
expanded their input lengths to 8080 and 12119 tokens, above the 5120 input
allowance after reserving output space.

A separate **posthoc tokenizer-only diagnostic** measured six hypothetical
payloads. It generated no answers and changed no score:

| Failed source | Original quoted candidate | Verbatim candidate block | Candidate omitted |
| --- | ---: | ---: | ---: |
| Reservation, replicate 0 | 8080 | 6408 | 3288 |
| Invoice, replicate 1 | 12119 | 5753 | 2641 |

Encoding amplified the cost, especially for whitespace and escaped characters.
However, even the verbatim versions exceeded 5120 tokens. The tested
verbatim-block representation would not have rescued either attempt. A future
repair policy needs an explicit way to handle an oversized, incomplete candidate;
silently dropping content or
changing this run's limits would obscure the failure.

## Fresh-world result and limits

The prespecified secondary retained 72 intention-to-learn slots per arm: six
source cells times twelve fresh worlds. Every slot lacks an admitted program,
so each arm records 0/72 solved slots with **zero program executions**. This is
not evidence that 72 executed skills failed. Conditional transfer success is
undefined; A-then-B retention and composition remain untested.

Handwritten positive controls solve both workflow families with the same
interpreter and native limits. Suitable programs exist for these tested tasks.
The experiment measures whether this model/prompt/retry policy induces them;
it does not establish a fundamental expressivity limit, general model inability
or the viability of the wider self-learning architecture. The six shared source
cells and two synthetic families do not support broad superiority claims.

## What the three experiments mean together

The earlier sequential-skill run recorded 57 successful workflow outcomes
through ordinary tools on this same fixed S7 research model, but acquired zero
skills. Those outcomes include repeated measurements and correlated worlds;
they are not a general benchmark. The subsequent format comparison raised
first-attempt JSON validity from 1/6 to 6/6, while admission remained zero.
This repair experiment also admitted zero skills on its fresh source cells.
The runs have different sources and policies; their native scores must not be
plotted as a model learning or regression curve. No weights changed between them.

Together they localize the current failure: successful situated tool use is
not yet becoming a reusable program. This is an additional abstraction and
compilation task imposed by our memory design. A procedure can exist and the
model can execute a workflow without being able to infer that procedure from
two trajectories and a grammar guide. The live tests do not yet distinguish
an unfamiliar interface from a deeper program-induction limitation.

For the persistent-mind design, keep separate evidence for each transition:

| Transition | Evidence from this series |
| --- | --- |
| Solve a workflow with tools | Demonstrated on the narrow synthetic baseline |
| Convert experience into an admitted reusable skill | Not demonstrated |
| Reload and execute an acquired skill on fresh worlds | Live evidence unavailable because libraries stayed empty; integration tests exist |
| Preserve A after learning B, then compose them | Not tested with acquired skills |
| Reduce future model calls, latency or cost without losing correctness | Not demonstrated |
| Improve neural weights, expert selection or neural recurrence | Not manipulated by these experiments |

The exact-program representation is one possible memory mechanism, not the
definition of learning. If explicit instruction in the representation still
leaves induction unreliable, a later comparison
should test retrieval of verified episodes or concise procedures with ordinary
tool execution against compiled skills. Those alternatives require their own
fresh-world and cost measurements; this series does not show they work better.
Avoid making every form of experience retention depend on a compiler that
currently admits no skills.

The original raw-tool baseline leaves no observed accuracy headroom on its
tested worlds. Once acquisition works, fewer model calls or lower latency at
equal native correctness would be a meaningful first benefit. Broader or harder
tasks would need a new frozen test set. Continuing an always-on loop is useful
only if it retains verified progress or produces information that changes the
next intervention; more retries by themselves are not cumulative learning.
These repair calls are recurrence across inference calls. They do not test
recurrence inside the neural network, nor whether learned recurrence depth helps.

## What to test next

1. **Teach the target representation explicitly.** Compare the current guide
   against one complete, short, neutral worked AST showing references, branches,
   a loop and completion. Do not supply the reservation/invoice solution. Keep
   native checks and repair policy fixed to isolate this curriculum change.
2. **Then test preservation of verified progress.** Compare repairing the best
   prior candidate with repairing only the latest one, retaining per-world pass
   vectors and new-world checks. This applies the accepted-parent principle to
   learned programs as well as model weights. It is proposed, not implemented.
3. **Keep role wording and schema decoding separate.** A compiler-specific
   system prompt and exact AST-schema decoding are plausible independent tests;
   changing them together with examples would confound attribution. Structural
   validity still cannot certify reference correctness or task completion.

Set a stopping rule for compiler work: if the bounded worked-example comparison
still admits no skill, prioritize the direct memory ablation before more prompt
variants. Generate a procedural memory from verified TRAIN experience, persist
it, restart the actor, and compare memory versus no memory on frozen fresh
workflow variants. Neither evaluation arm receives the original TRAIN traces;
tools, actor and budgets stay fixed. Report memory-creation cost separately and
measure verified completion and inference cost over repeated tasks. This asks
whether persistent learning can help without compilation, while the worked
example asks why this particular compiler fails. Both are proposed experiments,
not results or background jobs.

Prioritize one bounded interface/curriculum comparison rather than simply
adding retries or treating this result as grounds for another weight update.
The current repair mechanism is not reliable enough to support a claim that
the system accumulates executable skills automatically.

## Execution and evidence

Scored core: 22:52:47–23:04:41 UTC, September 13. CLI elapsed time including
conformance: 715,688 ms. Research host retained; production instance launch time
and state were unchanged at closeout.

| Actual inference component | Requests | Prompt tokens | Output tokens |
| --- | ---: | ---: | ---: |
| Shared initial generations | 6 | 17,869 | 8,178 |
| Existing-feedback repairs | 12 | 37,219 | 4,351 |
| Diagnostic repairs | 12 | 37,737 | 5,105 |
| Candidate-aware repairs | 10 | 35,805 | 7,518 |
| Conformance | 4 | 226 | 38 |
| Total | **44** | **128,856** | **25,190** |

All usage was returned; there were no HTTP retries, HTTP errors or prompt-token
count differences. The 46 logical requests include two pre-inference rejections.
Report tokenizer calls separately: 46 within the CLI, 216 development calls
across the two qualification versions, and six posthoc encoding probes.
Elapsed time and tokens are not measured GPU occupancy or an AWS bill.

Required local checks: 728 passed, one skipped, zero failures. Remote launch
checks: 55 passed. Independent audit matched 56 native validation exposures
over twenty distinct TRAIN worlds and all 122 raw calls. Frozen source is
`a6c3422dbfc75b0f7d66c4b4923ef3e85aebc993`; its sole change from `e172eff` is a
test-parent timeout for full-suite contention. Runtime limits were unchanged.

Manifest SHA-256: `2f798afa6d939c25e02faabc6b52405caf654848ac36c1dffc5a43c2b3705ec7`.
Source archive SHA-256: `8de01370469e3cff4c96ad8b24f9591b2c684e0098debc8ee474c1cd7cff11a2`.
Model: `amos-a0-epoch-3-step-357`; adapter SHA-256
`fd2224d5e47f5314f6ebacedb5fa7269cd6e7f6dd682aead8013e3ab30f780c5`.

Detailed evidence is in shared `coordination/artifacts/skill-repair-20260913/`:
`independent-findings.md`, `independent-audit.json`, `fresh-world-probe.json`,
`encoding-result.json`, `source-binding.json` and `exported/run/`. Raw
exports are under
`s3://amos-qwen-research-plane-637423327454-us-east-1/stage1/skill-repair-2026-09-13/run/`.
Serving receipts bind mounted adapter bytes and alias rather than independently
dumping GPU tensors. The readout does not alter frozen source, candidates or
scores.
