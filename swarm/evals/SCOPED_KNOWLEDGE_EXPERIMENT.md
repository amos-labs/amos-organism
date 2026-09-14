# Scoped knowledge experiment: CPU implementation

Status: local CPU qualification passed; **no real model run, training, deployment or improvement result**. The evaluation manifest, independent result auditor, actual-request context qualification and AWS wrapper are still to be frozen before dispatch. Fixture constants and case selection below are provisional implementation inputs, not a consumed model holdout.

This follows the completed versioned workflow-memory pilot: all three conditions solved7/8, and one saved lookup did not repay two memory-generation requests. The new comparison asks whether compact knowledge can reduce total work, and whether model generation earns its cost over an exact cache.

## Comparison

Use the same S6 checkpoint in four conditions: no memory, exact receipt-backed policy cache, generated scoped facts, and generated prose. Three independent acquisition profiles supply two verified public trajectories each. Each profile receives one facts and one prose generation, producing six one-shot requests. Each profile then receives two stable worlds and one changed-version world: nine paired worlds,36 actor processes. These are three acquisition units, not36 independent learning replications.

Facts and prose receive the same public evidence, seed and generation budget, but different output instructions. Their semantic content can differ: this measures acquisition and representation strategies rather than formatting identical information. All conditions receive the same actor scope envelope, current goal, tools and instructions. The only different actor field is `memoryKnowledge.knowledge`.

The exact cache copies normalization fields from a successful public source-policy receipt after native replay of every source event. Its document record is verified specifically for that literal observation. Generated records remain unverified. Syntactically valid wrong facts remain available; schema errors, request failures, truncated output and copied training-instance identifiers yield absent memory without deleting an evaluation slot. Escaped JSON identifiers are checked after decoding as well as in raw text. No generation is repaired or replaced.

All conditions receive the same optional `normalize_reference` utility. It computes only from the supplied string and explicit trim/case/prefix/suffix arguments. It cannot discover the current convention, read the private verifier, mutate business records or resolve an uncertain invoice operation. Valid wrong conventions still produce wrong results. The tool's standalone effect is not isolated by this design.

Native completion preserves order/inventory immutability, current revisions, unknown-outcome reconciliation and no-send constraints. Changed-version safety is reported separately: current-policy lookup must precede annotation, and every attempted prior-version reference remains recorded even if later repaired. No host code inserts a missing lookup or repairs an annotation.

## Execution and evidence

New source lives in `scopedKnowledgeFixture.js`, `scopedKnowledgeExperiment.js` and `scopedKnowledgeProcessRunner.js`; the thin entry is `runScopedKnowledgeExperiment.js`. Historical workflow-memory modules and their frozen experiment remain unchanged.

The acquisition process exits before each fresh actor reloads an immutable scoped snapshot. The runner binds source files, plan, runtime configuration, process IDs/nonces, snapshot bytes, actual inputs, tokenizer counts and raw tool receipts. Process separation does not imply an OS filesystem sandbox or an inference-server restart. Source replay by validation is host work; its presence in process code is not actor-visible demonstration retrieval.

Hard caps: six acquisition plus36×12 actor requests =438 logical inferences; at most four transport attempts per logical request,32 raw tools per actor,120 seconds per actor,512 generation output tokens and1,536 actor output tokens. Generation uses temperature1; actors use0. Actual inputs plus full output allowance must fit8,192 tokens. No trimming, fallback model or response-format inference is inserted.

The new runner defaults to100 minutes and rejects values above100. Existing protocols remain capped at60 minutes. The nominal acquisition/actor sum is84 minutes; probe, child-watchdog and forced-termination allowances raise the known serialized envelope to93m34s. The remaining6m26s does not guarantee all local I/O completes. Global deadlines take precedence, and incomplete runs remain incomplete. A105-minute outer wrapper is proposed, not yet implemented or dispatched. The prior90/95-minute design estimate was corrected before source/selection freeze.

Report source construction/replay, cache processing/storage, generation and execution separately. Generation cost is included once in the owning condition. The existing raw child logical journals require task attribution through their bound PID/nonce and process receipt; the parent aggregate supplies task IDs. The independent result auditor must preserve that distinction to avoid the prior pilot's cohort-only accounting bug.

## Interpretation and next gate

CPU tests demonstrate fixture solvability and evidence machinery using deterministic public-tool solvers or mocked transport. Their success is **not** model success. The current implementation does not itself freeze the preregistered primary result or publish any trained model.

Before dispatch: independently bind exact source and selection, implement/review the result auditor and all named contrasts, qualify actual prompts with the retained S6 tokenizer, and test the concrete wrapper/deadline/export path. Keep all slots and unavailable memories. No post-result replacement, semantic filtering or unregistered rerun.

The proposed practical gate is no paired native losses, fewer creation-inclusive calls and no greater total inference-token usage than no memory, with all three changed-version native and version-safety checks passing. Report both generated conditions against the exact cache and against each other even if the practical gate fails. A win would establish retention/application of scoped environment facts; it would not establish learned procedure invention, weight improvement, HRR superiority, broad generalization or a production continuous-learning loop.

## Local validation — September 14

`npm run check` passed: typecheck, syntax checks over232 swarm files, and833 tests (832 passed,1 skipped,0 failed). The36 new tests cover fixture/native solvability, adapter provenance and availability, bounded runner behavior, and actual process integration with mocked transport. Independent adapter/fixture review found no remaining material defect; root separately reviewed the versioned runner diff. These are local results; no remote CI or public source publication is claimed.
