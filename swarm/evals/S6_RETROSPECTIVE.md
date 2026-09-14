# S6 retrospective: a modest signal, recipe reliability still open

An audit of the two retained comparisons reproduced every official outcome and all 297 saved result digests. S6's small lead over base appears in both studies:

| Existing evaluation | S6 | Base | S6 wins / losses / ties | Nominal paired exact p |
| --- | ---: | ---: | --- | ---: |
| September 9 Desktop pilot | 44/48 | 42/48 | 4 / 2 / 42 | 0.6875 |
| September 10 S7 qualification | 46/48 | 44/48 | 2 / 0 / 46 | 0.5 |

Three of the first four wins and one of the second two were strict response-format/completion-wording compliance. The other two were date correctness/execution gains. These are legitimate official wins under explicit requirements, but compliance gains should not be presented as equivalent improvements in business effects. S6's first two relative losses were numerical failures. No alternate score was computed.

Both studies used S6 adapter `36fd8741c18e1a1478629473c7701584e8e9bc92f890eeedf3effff5d3638528`; the second was not an independent retraining of its recipe. The 44-to-46 score change is not learning between runs: the cohort and deployment metadata changed, and base also rose by two. No decision-key overlap was found, but family templates recur, stronger semantic exclusions cover only part of the older cohort, and 24 later initial-input hashes recur with facts supplied through subsequent tool reads.

The retained system prompt/tokenizer identities agree, but desktop revisions, fixture/protocol hashes, serving fingerprints and request ceilings differ. Recorded base-manifest IDs also differ; these records alone do not establish identical base tensor contents across studies. Both wire formats disable thinking but omit explicit temperature/seed, so identical effective decoding defaults are not independently established by this retrospective.

No measurement discrepancy was found. Cohort/runtime variance remains unresolved. A lucky training seed remains untested: repeating evaluation of one artifact does not replicate the training recipe, and S7 used a different continuation dataset and optimization run. These small, template-related comparisons should not be pooled as independent business jobs or described as broad superiority.

Keep S6 as the retained parent and build on the modest positive direction. Testing recipe reliability would require independently trained replicas of the same frozen recipe and matched evaluation on a new sealed cohort. This retrospective performed no model calls, training, official regrading or production change.

Detailed paired receipts and classifications are in the private coordination directory `coordination/artifacts/s6-retrospective-20260914/READOUT.md` and `recount.json`. The separate [workflow-memory result](WORKFLOW_MEMORY_RESULTS.md) evaluates memory under fixed S6 weights and does not provide another S6-versus-base comparison.
