# Learning a versioned workflow convention

This separate synthetic pilot tests whether experience-derived memory can avoid repeated discovery of a local workflow rule. The previous procedural-memory pilot completed 8/8 in both arms with identical actions and 15.1% extra tokens; its advice mostly repeated existing instructions. This experiment introduces a convention available through a documented read-only lookup, so every baseline task remains solvable.

## Three arms and eight cases

All arms use the frozen S6 adapter `pilot-060909-r32-s20260909`, weights SHA `36fd8741c18e1a1478629473c7701584e8e9bc92f890eeedf3effff5d3638528`. S6 remains a retained research parent. This study does not compare its performance to the previous S7 memory run or promote either model to production.

- `no-memory`: empty persistent snapshot.
- `docs-advice`: one generated summary per profile, using only tool documentation and the profile/version identifier.
- `experience-memory`: one generated summary per profile, with the same instructions and tool documentation plus two native-verified public TRAIN trajectories.

Both generated conditions have equal generation budgets, not necessarily equal realized lengths: temperature 1, paired profile seeds, 512 output tokens and at most 160 whitespace-separated words. There are four one-shot generation requests total. No summary selection, editing or repair is allowed. Reject request failure, absent text, length termination, excess words or a copied case-specific TRAIN identifier. The fixed identifier fields are `id`, `orderId`, `invoiceId`, `customerId`, `sku`, `invoiceReference`, `reference` and `externalReference`; compare exact case-sensitive substrings after trimming source values. Stable profile IDs, policy versions and reusable rule constants are allowed. All generated records remain unverified `external-model` advice with hashes binding their actual source and response; original trajectories are absent from evaluation snapshots.

Two opaque profiles, `wf-6f2c` and `wf-b8a1`, have distinct reference-normalization conventions. Current goals expose profile, version and fresh external-reference data. `inspect_workflow_policy` returns the authoritative trim/case/prefix/suffix rule. The mutation stores exactly what the actor supplies; the private native checker determines correctness. Tool descriptions do not reveal profile-specific constants, and lookup does not reconcile an unknown invoice write.

The eight cases per arm comprise four stable cases (fresh and unapplied ambiguity for each profile), two changed-version cases (first profile fresh, second partial), and two consumed legacy regression fixtures from the prior pilot (partial reservation and applied invoice ambiguity). Source trajectories are fresh and unapplied-ambiguity cases under version 1. Selection is deterministic and bounded before model generation. All exact seeds, source receipts, case IDs and policy hashes are frozen in the dispatch plan. Arms rotate cyclically across each case; this is three cyclic orders, not all six permutations.

## Genuine reload and scope

One acquisition process completes and exits, then 24 distinct actor processes each reload an immutable snapshot. Each actor receives current goals/tools/public receipts, empty demonstrations and no executable skills. A common `memoryAdvice` envelope contains `{profileId,policyVersion,text}`. Baseline and legacy tasks receive null scope and empty text; advice arms receive exact generated text and its version 1 scope. The same old scope is deliberately shown on version 2 tasks. It is never relabeled as current. Common instructions make current evidence authoritative and require refreshing advice from another version before setting a reference.

Exact profile/record selection is used; this is not a test of HRR ranking. Process restart/input isolation does not imply an OS filesystem sandbox or inference-server reboot. The reusable runner owns process lifecycle, immutable copies, source/plan bindings, network bounds and complete cost recovery. The domain adapter owns acquisition, selection and native task semantics. Previous frozen pilot files are unchanged.

## Bounds and decision rule

Each actor uses temperature 0, 1536 output tokens, at most 12 model requests and 32 raw tool attempts, within 120 seconds. Four creation requests plus 24 × 12 permits at most 292 logical inference requests. Each logical request permits four transport attempts; actual request-time tokenization must fit 8192 context with the complete output allowance. No silent trimming or fallback. Every length-terminated response fails before executing proposed tools. Global bound is 60 minutes with no implicit resume. Model probes and initial tokenizer-only qualification are separately recorded.

A failed actor slot is never retried or replaced. Its failure and costs remain in the denominator while the remaining predefined slots may run. The runner’s completed status means orchestration finished; missing or invalid reports, provenance failures or incomplete integrity coverage forbid a positive conclusion. Global bounds and failed pre-dispatch source, plan or model checks stop execution.

Native bounded completion remains the primary task outcome. Against **both** controls, the experience arm must have no paired completion losses and either a gain or tied completions with fewer total logical requests, including its own two acquisition requests. Retain all eight cases and all failures/unavailable summaries. Full coverage and independent integrity verification are mandatory. Report the four stable, two changed-version and two legacy cases separately alongside the combined decision.

A separate version-safety guard also constrains a positive conclusion: on both changed-version experience cases, a successful current-profile/current-version policy lookup must precede the first annotation, and no annotation attempt may use the old version's normalization of the current reference. A final correct state after a stale write can pass the native task but fails this guard. Report the same indicators for all arms.

Count creation, execution, unsuccessful requests, policy lookups, all tool attempts, actual input/output tokens and elapsed time. Shared setup is separate. Fewer requests with more tokens is not an unqualified cost improvement. The two generated memories per condition are shared across cases, so this is a small pilot rather than independent learning replications. Legacy checks expose empty advice and do not test interference from irrelevant memory.

The experiment can establish useful retained environment knowledge compared with absence and generic advice. It cannot establish improved neural weights, broad procedure induction, recurrence, lifelong retention or general superiority over base Qwen. The earlier S6 comparisons remain small descriptive signals with format-sensitive gains; repeated evaluation of one checkpoint does not replicate its training recipe.

Run `swarm/scripts/runWorkflowMemoryExperiment.js`. Exact private plan, independent audit and execution receipts live in `coordination/artifacts/workflow-memory-20260914/`. No scored run begins before source, plan, model identity and context qualification are frozen.
