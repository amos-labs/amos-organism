# Compiler output-format comparison

Preregistered 2026-09-13, before live scored dispatch. Prior sequential-skill
acquisition admitted 0/6 skills: 15 JSON parse failures, one invalid instruction
structure and two unbound-variable failures in 18 attempts. This experiment
changes only the compiler response-format setting.

## Fixed comparison

Two arms: free-form (`responseFormat:null`, omitted on the wire) and JSON-object
(`response_format:{type:'json_object'}`). Reuse the existing
`acquireSequentialSkill`, demonstrations, checked interpreter and private native
TRAIN validators unchanged. Both arms receive the same first prompt, tools,
model, sampling settings and limits. The response-format setting changes.

Three fresh model seeds: 20260914, 20261015, 20261116, temperature 1.0.
Families: reserve-order and invoice-order. Per replicate, demonstration seeds
are 80000+r*100 and 90000+r*100. Acquisition seeds are 100000+r*100 and
101000+r*100, hence native validation bases 110000+r*100 and 111000+r*100.
Balanced training-only seed selection still provides applied and unapplied
unknown-outcome demonstrations. Four TRAIN worlds test fresh, partial, applied
ambiguity and unapplied ambiguity. Arm order alternates by replicate/family.

Each of the 12 family/replicate/arm cells starts with an independent empty
library. At most three compiler requests are allowed per cell: 36 scored
logical requests in total. Stop only when all four TRAIN cases pass with an
explicit procedure completion, or the fixed budget expires. Record every
candidate, error and native validation. Do not add previous-candidate text,
change the DSL, trim prompts, increase limits, adjust temperature or change
weights during this comparison. No evaluation feedback or prior experiment
outcomes are supplied to the learner.

Primary outcome: admitted skills within three attempts, out of six cells per
arm. This estimates the whole retry-policy effect. First-attempt paired JSON,
AST and native-validation outcomes are separate secondary evidence about the
mechanism. Retry prompts may diverge because the feedback differs; they are not
identical-input pairs. Early stopping makes pooled per-attempt denominators
outcome-dependent. Do not report those as independent equal-sized trials.

## Serving conformance gate

Before any scored compilation, run two separately recorded prompt pairs, each
free-form and JSON-object. One requests a literal non-JSON answer, the other a
deliberately malformed JSON answer. The content and sampling settings match
within each pair. Each request has 128 output tokens, temperature 1.0 and seed
20260913. Both constrained answers must parse as objects without output
truncation, and at least one free-form answer must fail JSON parsing.

This establishes observed format conformance on two probes, not formal proof of
a decoder's implementation. If the gate fails or is inconclusive, do not run
scored cells or silently fall back. In particular, two naturally valid free-form
answers make the positive-control gate inconclusive; they do not prove the
endpoint lacks support. Probe output never enters the scored curriculum.

## Limits and evidence

Scored output limit 3072 tokens, existing context 8192. Check exact public prompt
tokenization before inference. Existing interpreter limits: 512 AST nodes,
depth 8, 256 executed steps and 64 raw calls per TRAIN validation. Each logical
request permits at most four transport attempts; record every actual attempt.
Whole CLI deadline 30 minutes. Conformance has its own four-logical-request cap.
Account for conformance, compilation, validation, tokenization, retries and
unknown usage separately. Wall time is not GPU occupancy.

Use the retained research instance and unchanged read-only S7 adapter
`amos-a0-epoch-3-step-357`, SHA-256
`fd2224d5e47f5314f6ebacedb5fa7269cd6e7f6dd682aead8013e3ab30f780c5`.
Pin source and manifest bytes, check the previous unit has finished, and export
raw results automatically. This is not a production change or promotion.

Save all resulting immutable libraries. Independently reparse compiler text,
validate instruction structures, rerun native TRAIN programs and audit paired
input/settings, budgets and every HTTP attempt. Successful TRAIN admission
would still require a separately frozen fresh retention/composition evaluation;
this compiler-only experiment establishes neither. JSON validity alone does
not establish useful skill learning, weight learning or neural recurrence.
