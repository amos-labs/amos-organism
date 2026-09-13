# Skill repair experiment — September 13, 2026

Freeze before scored dispatch. The prior format comparison admitted 0/6 skills
in each arm. One constrained invoice program reached all four correct TRAIN
states but omitted explicit completion; another passed three cases and failed
after an unapplied invoice-creation timeout. Those candidates are development
evidence only. This experiment uses fresh curriculum and initial generations.

## Hypotheses and treatment

Six source cells combine reserve-order/invoice-order with three model seeds:
20260915, 20261016, 20261117. Generate one shared initial candidate per source,
then replay its exact response into three independent acquisition branches:

| Arm | Repair input |
| --- | --- |
| feedback-only | Existing bounded TRAIN feedback |
| diagnostics | The same feedback plus literal interpreter termination diagnostics |
| candidate-diagnostics | Diagnostics plus the exact immediately preceding candidate |

The primary outcome is admission within three candidates, six sources per arm.
The two paired contrasts are diagnostics minus feedback-only, and
candidate-diagnostics minus diagnostics. The combined contrast is secondary.
This three-arm design does not identify the candidate-only effect or the
interaction between the two changes.

All branches receive the same initial response, including a shared request
failure. A successful initial candidate counts in every arm and needs no repair.
Each branch can make at most two subsequent generations, giving at most
**42 unique scored requests: six shared initial requests plus 36 repairs**.
Shared responses are cloned and replayed, not regenerated. Their inference cost
is counted once; repeated native validation is recorded separately. Branch
execution order rotates across the six source cells. These are six paired
sources, not eighteen independent initial samples.

All prompts use the same compiler guide and general repair instruction. D and
CD receive diagnostics for exactly the first two failed TRAIN cases selected
by the existing feedback, in the same order. Fields include fixture identity,
status, error, terminal type/path, interpreter-authored stop reason, executed
steps and tool calls. A procedure's explicit return reason is model-authored:
omit it from diagnostics and mark that provenance. It remains available only
inside CD's full candidate text. This prevents the diagnostics arm from
accidentally receiving candidate code masquerading as an error explanation.

No host-written remedy or program patch is added. Candidate text is quoted data,
and each generation must return a complete replacement. Diagnostics reset for
every new candidate; syntax failures cannot inherit an older execution trace.
A request failure marks the previous candidate unavailable instead of carrying
stale text. Current-candidate provenance is retained in every branch.

## Fixed learning and admission

Model: the unchanged retained S7 adapter `amos-a0-epoch-3-step-357`, SHA-256
`fd2224d5e47f5314f6ebacedb5fa7269cd6e7f6dd682aead8013e3ab30f780c5`.
Temperature 1, thinking disabled, JSON-object output, 3072 output tokens and the
existing 8192-token context. No weight or serving changes.

Demonstration seeds are 120000+r*100 for reservation and 130000+r*100 for
invoicing. Acquisition seeds are 140000+r*100+familyIndex*1000; native TRAIN
validation uses the existing additional 10000 offset. Freeze actual selected
worlds and demonstration hashes in the dispatch manifest. Both public-tool
demonstrations, covering applied and unapplied ambiguous writes, remain intact.
The existing acquisition engine, tool schemas, fixture and interpreter remain
unchanged.

Each branch starts with an independent empty immutable library. Admission still
requires correct native state and explicit completed termination in all four
TRAIN worlds: fresh, partial and both ambiguous-write outcomes. Limits remain
512 AST/value nodes, depth 8, 256 execution steps and 64 tool calls per case.
Neither completion prose nor partial state success satisfies admission.

## Context and serving qualification

Development qualification constructs all three hypothetical retry inputs from
all 36 candidates returned by the prior format run: 108 tokenizer calls, zero
generations. The first draft inadvertently copied model-written return reasons;
one case exceeded the input allowance and exposed the treatment confound above.
After separating interpreter diagnostics, all 108 probes fit with unchanged
demonstrations: maximum input counts F 3716, D 3894, CD 4660 against a 5120-token
input allowance. Preserve both qualification artifacts and their hashes.

These observations do not guarantee future candidates fit. Keep exact tokenizer
preflight on every actual request. An oversized input consumes its bounded
logical attempt and remains in the denominator, with no silent truncation,
context expansion, resampling or fallback. Count tokenizer work separately.

Repeat four separately accounted response-format conformance requests before
scoring: two matched free-form/JSON-object pairs, seed 20260913 and 128 output
tokens. Both constrained responses must parse as objects without truncation,
and at least one free-form response must fail parsing. An inconclusive gate
prevents scoring. This establishes observed conformance, not decoder internals.

At most four transport attempts per logical request; 30 minutes for the CLI.
Log actual wire seed, temperature, output cap, JSON setting, input digests and
returned token usage. An exclusive output directory prevents accidental replay.
Export all response, failure, validation and eighteen library receipts. Retain
the research host within the approved week; production is outside the run.

## Analysis and fresh-world secondary

Report paired admissions, repair successes among common initial failures,
candidate-by-candidate JSON/AST/native-state/explicit-completion outcomes, and
transitions that fix or introduce defects. Native pass vectors show when repair
loses an already working case. Include request failures, overflows, truncation,
actual tokens, elapsed time and raw validation actions. Equal caps do not mean
equal consumed compute. Six sources provide exploratory evidence, not a broad
quality or population-level superiority claim.

After every compilation branch has finished and the complete report is exported,
run a separately frozen CPU-only probe on each admitted program, with no model
calls, repair, raw-tool fallback or feedback to compilation. Use split
`repair-transfer`, reservation base 210000 and invoice base 220000. For each
family, fresh seeds are base+[0,1,2,3], partial base+[100,101,102,103], ambiguous
base+[200,201,202,203]. Reuse the same twelve worlds for every source and arm.
Do not resample based on hidden outcomes; report their realized fault mix.

Intention-to-learn completion has 72 world slots per arm (six sources times
twelve): absent admitted programs contribute zero. Separately report success
conditional on an admitted program, with identical native/completion limits.
Freeze the probe specification, helper and analysis-plan hashes in the manifest.
It measures limited transfer within this synthetic generator, not A-then-B
retention, broad generalization, weight learning or neural recurrence.
