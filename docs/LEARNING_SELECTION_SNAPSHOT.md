# Learning selection snapshot (contract v1)

The one artifact the Organism publishes describing which learned procedures may
be compiled into planner context, for which runtimes, under which permitted use.
It is the "learning selection snapshot" interface of the shared plan
(`coordination/AMOS_SELF_LEARNING_MODEL_PLAN.md`, section 3). Implementation:
`src/learningSelectionSnapshot.ts`; fixtures
`test/fixtures/learning-selection-snapshot.v1.json` (two procedures, one guide and
one avoid) and `learning-selection-snapshot.empty.v1.json` (the valid
"nothing available" response). Regenerate with
`npm run organism:generate-selection-snapshot-fixture`.

## Shape

| field | meaning |
| --- | --- |
| `schema`, `version` | `amos.learning-selection-snapshot`, `1` |
| `id`, `generatedAt`, `validUntil`, `digest` | identity; `validUntil` bounds the Platform's `(id, digest)` cache and must be after `generatedAt`; `digest` is the canonical digest of everything else and is re-derived on validation |
| `sourceChainDigest` | digest of the organism event chain the snapshot was derived from |
| `procedureSnapshotSha256` | digest of the frozen procedure set as `{id, contentSha256}` sorted by id, where `contentSha256` is each procedure's rendered-content identity (statement, guidance, applicability, contentRef, version, gene digest as lineage; evidence counts excluded). Changing a statement, flipping guide/avoid or narrowing tenant applicability changes it; reordering does not; duplicate ids are refused. With no procedures it is the shared empty-snapshot sentinel `3729e785…`, the same value a comparison-v2 Mission treatment carries in `procedureSnapshotSha256` |
| `compatibleRuntimes[]` | `{modelId, adapterArtifactSha256 or null, runtimeRevision}` the snapshot was evaluated against; a procedure is not assumed to transfer to runtimes not listed |
| `permittedUseScope[]` | permitted uses this snapshot may serve (today `strategy_learning`); the Platform refuses it for tenants without that use |
| `tokenBound` | ceiling on the summed `tokens` of all procedures; the gateway compiler never exceeds it |
| `procedures[]` | sorted by id; see below |

Each procedure: `id`, `version`, `digest` (the kernel gene digest), `guidance`
(`guide` or `avoid`), `applicability` (`phases`, `artifactClasses`,
`failureModes`, `toolFamilies`, `roles`, `tenantScope` any or tenant, and
`tenantIds`, required and non-empty exactly when `tenantScope` is `tenant`, all in
the kernel's precondition vocabulary), `statement` (bounded prose, at most 600
characters, the text the Platform renders synchronously and cites as
`id@version`; `resume_company` never fetches per procedure), `contentRef`
(`gene:<id>@<digest>`, the full content resolved by the Organism when a consumer
needs more than the statement), `tokens` (counts the statement), and `evidence`
(`verifiedPasses`, `verifiedFailures`, `uncreditedAttempts`,
`meanVerifiedQuality` or null, `lastVerifiedAt` or null).

## Rules

- The Platform enforces tenant scope and applicability, caches by `(id, digest)`
  and returns the same procedure ids to the gateway. It never stores a second
  registry; the Organism event chain stays canonical.
- The gateway attests which procedure ids it actually compiled (expression),
  separately from what was offered (selection). Selection is not use.
- An empty or unavailable snapshot is a valid response: `procedures: []`,
  `procedureSnapshotSha256` equal to the sentinel. Unknown provenance is never
  replaced by the sentinel; only the host compiler may claim it compiled no
  procedures.
- `procedureFromStrategyGene` publishes a gene only with at least one verified
  outcome; all-fail outcomes publish it as `avoid`. Uncredited attempts are
  counted but never credited.
- Reordering procedures does not change `digest`; changing any evidence field,
  procedure, runtime or bound does. `procedureSnapshotSha256` is narrower: it
  changes only when what is offered changes (content, guidance, applicability),
  so accruing evidence does not silently re-identify a treatment.
- The offered snapshot (this artifact) is distinct from what the gateway
  actually compiled (expression evidence); the comparator reads the latter.

## Publishing from the live event chain

`npm run organism:publish-selection-snapshot -- --events <organism events jsonl>
--runtime modelId@revision[:adapterSha256] --out <path>` replays the chain
read-only (`src/learningSnapshotPublisher.ts`), offers only genes with at least
one verified outcome, sets `sourceChainDigest` to the chain head, and writes the
snapshot plus a `.digest` sidecar atomically (temp file, then rename). A chain
with no admitted genes publishes the empty snapshot; today's production chain
holds only Platform episodes, so that is what production will see until genes
are admitted. Scheduling it on the runner (hourly, copied to
`s3://amos-qwen-research-plane-…/sleep/learning-selection-snapshot.json`) is
the next infrastructure step; the Platform reads the path it is configured
with.

## Not yet

The Platform-side `resume_company.procedures` consumer is Platform-lane work
(#819). Effectiveness of a procedure on a given runtime is established by
comparison v2, not by appearing in this snapshot.
