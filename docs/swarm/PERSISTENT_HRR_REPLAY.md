# Persistent experience and matched HRR replay

This is a CPU preparation path for the next research experiment. It does not modify the running A0 study, call a model, update weights, activate production memory or select a new incumbent.

## Observational learning

An experience can come from AMOS's own execution, a human demonstration, a document, or another model. Store the source, model identity when applicable, exact content, tenant, lineage groups and permitted uses. An independently verified successful demonstration can also contain an existing `amos.system-training-example`.

A book or lecture can be reference memory without a training target. Practice derived from it becomes eligible for successful-demonstration replay only when a checker receipt binds the actual native example. Importers are responsible for validating the upstream receipt; a digest supplied to this module is a binding, not a cryptographic proof that a checker ran. The module never treats confident prose or the teacher's own assertion as a success verdict.

Native examples retain system/user input, visible tool calls and results, and the supervised target. The existing `sftRow` compiler preserves masked context and the final supervised answer or tool call. To teach several decisions in a trajectory, provide separately checked prefix/target examples; a successful final outcome does not establish that every intermediate action was appropriate. Hidden reasoning is not required.

The existing native-example safeguards and content eligibility apply. Source-specific rules are not hard-coded in HRR. No automatic source approval or customer-content ingestion is added here.

## Durable exact memory

`persistentReplayMemory.js` creates immutable generations. Each has exact source records, the previous generation's digest, pinned encoder source hashes/configuration, and digests of the rebuilt semantic and identity indices. It reuses `UnitaryHolographicMemory` and `DualChannelHolographicWorld`.

Save with `saveReplayMemory(directory, snapshot)` and reopen with `loadReplayMemory(path, expectedDigest)`. Publication uses a synced temporary file and atomic create-if-absent hard link. It never overwrites a published generation. Concurrent identical writes converge. Incomplete temporary files are not referenced or read. Reopening reconstructs the indices from exact records and checks both representation digests. No vector estimate replaces source evidence.

There is deliberately no mutable `latest` pointer. The learning controller must pin the exact snapshot digest in a cycle; new input creates a new generation. Repeated identical input returns the same generation. Conflicting IDs, changed encoder configuration, cross-tenant input, altered content and unexpected generations fail. Up to10,000 records/64MiB are supported per snapshot; exceeding capacity fails without silently evicting experience. This is a bounded research snapshot, not yet the scalable company-wide archival service.

`recallReplayMemory` returns related verified records and similarity scores for a specified tenant/family. Similarity is retrieval evidence, never authorization to perform an action. The current encoder uses deterministic token-derived HRR codes; it is not a learned semantic embedding model. The exact dictionary performs semantic cleanup. This work does not establish a compression, language-understanding or neural-retention benefit.

## Equal-exposure replay preparation

`prepareMatchedReplayExperiment` builds two datasets from one pinned memory snapshot and parent:

- Simple replay: deterministic seeded sampling within preselected buckets.
- HRR-guided replay: rank the same bucket using the new task's user input, selecting the closest unused eligible record.

Both arms receive the identical new examples in identical order and the same number of replay slots. Buckets match task family, full sequence token count and supervised token count. The bucket schedule depends on the seed and availability, not the similarity scores. Native counter receipts bind each count to the example's exact rendered messages/tools and tokenizer/counter source identity. They are supplied by the upstream tokenizer process; this module does not claim to have run that counter.

The first experiment supports1–64 unique replay slots. This keeps the existing HRR top100 cleanup bounded and avoids silently repeating examples. The manifests record actual choices, query bindings, family/token budgets, source lineage, parent/recipe identity, row hashes and whether the arms selected different experience. If `comparisonHasDifferentReplay` is false, there is no replay treatment contrast: do not launch it as an HRR efficacy experiment. Narrow exact-token buckets can reduce treatment contrast; disclose this rather than silently relaxing matching after results arrive.

Only verified training-partition examples explicitly eligible for training enter either arm. Development/sealed material cannot become replay via a duplicate under a different ID. Excluded lineage propagates across exact duplicate content. New-example lineage is omitted from the old-experience pool. Exact payload deduplication does not prove semantic independence; the upstream exclusion inventory must group source conversations, templates and derivatives appropriately.

The rows use the existing native trainer format. `writeMatchedReplayExperiment` publishes the two JSONL files and then the completion manifest. A repeated preparation accepts identical bytes; conflicting output fails. No mutable training input is edited on the research host.

## Command

```sh
node swarm/scripts/prepareHrrReplay.js /ABS/request.json RAW_REQUEST_SHA256
```

Request shape:

```json
{
  "schema": "amos.prepare-hrr-replay.v1",
  "tenantId": "owned-synthetic",
  "observations": {"path": "/ABS/observations.json", "sha256": "ACTUAL_RAW_SHA256"},
  "previousMemory": {"path": "/ABS/prior-memory.json", "digest": "ACTUAL_GENERATION_DIGEST"},
  "config": {"dimension": 256, "namespace": "amos-replay-v1", "maxEntries": 10000},
  "outputDirectory": "/ABS/new-preparation",
  "experiment": {
    "parentWeightsSha256": "ACTUAL_VERIFIED_PARENT",
    "recipeSha256": "ACTUAL_FIXED_RECIPE",
    "newExperienceIds": ["new-experience-1"],
    "excludedLineages": ["sealed-family-lineage"],
    "tokenCounts": {"path": "/ABS/counts.json", "sha256": "ACTUAL_RAW_SHA256"},
    "replaySlots": 32,
    "seed": 20260913
  }
}
```

Omit `previousMemory` for the first generation. Omit `experiment` for memory-only preparation. Placeholders above are documentation, not runnable values. `observations.json` holds records returned by `createObservedExperience`; native examples are created/validated by the existing dataset module. `counts.json` includes `tokenizerSha256`, `counterSourceSha256`, explicit `synthetic`, and entries `{exampleDigest,contentSha256,tokens,supervisedTokens}`. Test counters are marked synthetic and must not authorize a powered study.

## Next actual experiment

1. Complete A0 and inspect paired old-skill losses/new gains. Retain S6 unless another candidate earns the existing gate. Bind the selected parent and one explicit recipe; do not silently inherit a rejected child.
2. Assemble permitted TRAIN-only new demonstrations and a separate old-skill experience pool. Freeze held-out lineage exclusions before any sampling. Run the native tokenizer on the actual rendered examples and bind its receipts.
3. Prepare both matched datasets. Verify meaningful treatment contrast, identical new-learning exposure, row hashes and independently verified demonstrations. Freeze evaluation/checker/settings and the full run budget.
4. Run both arms on the retained research GPU in sequence. Use identical initialization, optimization and update counts. Inference-time memory stays disabled in both arms so retrieval assistance cannot explain a weight-retention result.
5. Compare against the parent on fresh executable tasks: old-skill retention, new-task learning, paired gains/losses, failures, latency and total compute. Memory recovery, successful training execution and improved performance are three separate claims.
6. Prove the controller can consume a new generation after restart without repeating a completed training dispatch. Integrate the pinned memory/experiment references into that existing journal; do not build another competing scheduler.

A gain over uniform sampling would support this replay strategy on the tested pool. It would not show HRR is uniquely necessary; a stronger lexical/embedding retrieval control should precede that claim. A0 outputs and their descendants remain development material.

## Opus5 comparison and useful differences

Use an external reference model as another measured arm. Compare the same goals, starting state, tools and independent success checks. Record actual provider/model IDs, latency, cost, visible actions and errors. Classify both-pass, reference-only pass, AMOS-only pass and both-fail. Textual disagreement alone is not a model failure, and Opus is not the grading oracle.

Keep two questions distinct: performance under a common product latency/tool budget, and performance with each model's intended reasoning settings. Opus5 thinking is enabled by default and its thinking tokens consume the output allowance. An unchanged256-token cap from a non-thinking run can therefore create an artificial handicap. Freeze the selected configuration and report any budget differences rather than advertising an equal-compute comparison.

Reference-only successes from the development collection can nominate independently checked demonstrations. Import their exact native examples and source/verification metadata through `createObservedExperience`, as for human or self-executed examples. Do not import benchmark answers automatically or train on a still-sealed final test. Once a task or derivative enters training, retire that lineage from future qualification. The actionable learning signal is a verified missing skill or recovery strategy, not stylistic imitation.

Current official model IDs: `claude-opus-5` (Claude API) and `anthropic.claude-opus-5` (Bedrock). [Opus5 behavior and API settings](https://platform.claude.com/docs/en/models/opus-5/whats-new-opus-5), checked September13,2026. This change prepares a provider-neutral observation path; no Opus benchmark or teacher-output training has run.

## Verification

The focused tests cover actual subprocess restart/index reconstruction, immutable generation inheritance and deduplication, content/source tampering, tenant boundaries, reference-only material, matching token exposure, exclusions across duplicate content, native tool trajectories, hash-bound CLI restart and concurrent atomic publication. Their examples and counters are synthetic; they establish implementation behavior, not improved model quality.
