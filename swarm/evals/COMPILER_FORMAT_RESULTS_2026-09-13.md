# Compiler format comparison — September 13, 2026

JSON-object mode removed the observed serialization failures, but neither arm
admitted a skill within the fixed three-attempt budget. The most useful finding
is more specific: one constrained invoice program produced the correct state
in all four TRAIN worlds, then fell off the end without an explicit completion
return. Its retry feedback omitted both that terminal reason and the candidate
it was supposed to repair.

The original admission score remains **0/6 versus 0/6**. No program was repaired
by hand, rescored or promoted after the run.

## Frozen design and results

The [preregistration](COMPILER_FORMAT_EXPERIMENT.md) compares free-form output
with `response_format: {type: "json_object"}`. Model weights, temperature 1,
output limit 3072, compiler instructions, public demonstrations, interpreter
and native checks were unchanged. Two skill families and three fresh replicates
give six acquisitions per arm. Each starts with an empty library and allows
three compiler attempts. Admission requires correct native state **and an
explicit completed return** in all four TRAIN worlds, including applied and
unapplied ambiguous writes.

| Outcome | Free-form | JSON-object |
| --- | ---: | ---: |
| Primary: admitted within three attempts | **0/6** | **0/6** |
| First attempt: valid JSON | 1/6 | 6/6 |
| First attempt: valid instruction structure | 1/6 | 2/6 |
| First attempt: all four native/completion checks pass | 0/6 | 0/6 |
| Compiler requests consumed | 18 | 18 |

The six first-attempt pairs have identical actual request bodies apart from the
format setting. Later prompts depend on each arm's feedback, so their outputs
are descriptive retry-policy evidence rather than independent matched trials.
Across all attempts, free-form produced 3/18 parseable candidates and
JSON-object produced 18/18. Free-form failures were 15 parse rejections and
three native/completion rejections. Constrained failures were 11 instruction
structure rejections and seven native/completion rejections. All twelve saved
libraries are empty.

Before scoring, four separate conformance requests passed the frozen gate:
both constrained outputs parsed as objects and both free-form outputs did not.
This shows observed format conformance on the probes; it is not a formal proof
of the backend decoder's implementation.

## What the remaining failures teach us

**Correct workflow, incomplete completion contract.** JSON-object replicate 0,
invoice-order attempt 1 passed the native state verifier in all four TRAIN
worlds. Its single top-level loop contained invoice creation, reconciliation
after unknown outcomes, reuse and annotation. The procedure then ended without
an explicit return, so the interpreter correctly returned `needs_reasoning`.
This is a contract failure, rather than evidence that its four workflows were
performed incorrectly. The frozen admission gate still rejects it.

**A concrete recovery defect.** JSON-object replicate 1, invoice-order attempt 1
passed three of four full native/completion checks. When an ambiguous invoice
creation had not applied, reconciliation returned `invoice: null`; the program
then dereferenced its reference field. The next candidate introduced a malformed
reference representation, losing progress instead of repairing that branch.

**Repair currently loses information.** Native retry feedback includes status,
error, verifier output and public tool events, but omits the interpreter's
terminal reason. For the first candidate above, it reports `needs_reasoning`,
`error: null` and a passing verifier without explaining the missing return.
It also omits the previous candidate text. This motivates a separately frozen
repair comparison that distinguishes better execution diagnostics from access
to the candidate. It does not establish that either change will improve results.

Other rejected programs used invalid reference objects, stale revisions or
unsafe retries. One program explicitly returned completed despite missing
invoice references; native verification rejected it. Preserving the completion
and state checks is therefore important even when a particular failure looks
mechanically repairable.

## Execution and independent verification

The scored core ran from 22:08:31 to 22:14:55 UTC on September 13. CLI duration,
including conformance, was 385,968 ms. The runner exited successfully, exported
its receipts and left the research host retained. Production and serving
configuration were unchanged; this experiment performed no weight update.

| Inference scope | Requests | Prompt tokens | Output tokens |
| --- | ---: | ---: | ---: |
| Conformance | 4 | 226 | 38 |
| Scored free-form | 18 | 53,157 | 6,660 |
| Scored JSON-object | 18 | 54,406 | 6,821 |
| Total | **40** | **107,789** | **13,519** |

There were no transport retries, HTTP errors, context rejections or output
truncations. All forty tokenizer preflights matched returned prompt usage.
These are token and elapsed-time measurements, not dollar cost or GPU occupancy.

An independent audit reparsed every compiler response and replayed all forty
TRAIN validations and 106 raw tool calls from the frozen source archive, with
**zero discrepancies**. It also checked input pairing, actual wire settings,
usage, source bindings and all twelve empty library snapshots. Full local
checks passed: 706 tests, one skipped, zero failures; the remote launch's fifty
focused tests also passed.

Evidence bindings:

- Frozen source: `c0ca3b6be3c78a59a8743966b288eb14ee356535`.
- Source archive SHA-256: `90e1afd767a5741b99d094d205c153c280a0dfd8601a554d8e5a6171084953c0`.
- Preregistered manifest SHA-256: `9a8df975f28ac0f458d2dce1327150689463716f983d55b74a85c8f7695ef677`.
- Raw report SHA-256: `30805d3709668854c942c5689d890119369c1e84c2422fc7da1dd12142de4da3`.
- Fixed S7 alias: `amos-a0-epoch-3-step-357`.
- Adapter SHA-256: `fd2224d5e47f5314f6ebacedb5fa7269cd6e7f6dd682aead8013e3ab30f780c5`.
- Shared evidence: `coordination/artifacts/compiler-format-20260913/`, including
  `independent-audit.json`, `independent-audit.md` and `exported/run/`.
- Cloud export: `s3://amos-qwen-research-plane-637423327454-us-east-1/stage1/compiler-format-2026-09-13/run/`.

Serving receipts bind the mounted adapter bytes and alias, not an independent
dump of GPU tensors. The separate results document does not modify frozen
experiment source or raw evidence.

## Decision

Use JSON-object mode in the next compiler experiment, then isolate the repair
feedback changes with the native gate held fixed and fresh TRAIN worlds. Measure
complete retry prompts against the existing context limit before dispatch.
That follow-up is proposed, not run by this result.

This experiment demonstrates a format improvement and identifies repair defects.
It does not yet demonstrate acquired-skill retention, composition, held-out
generalization, improved model weights or neural recurrence. The A-then-B
retention test remains pending successful skill acquisition.
