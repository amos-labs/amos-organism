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
| `procedureSnapshotSha256` | digest of the ordered `{id, version, digest}` list; with no procedures it is the shared empty-snapshot sentinel `3729e785…`, the same value a comparison-v2 Mission treatment carries in `procedureSnapshotSha256` |
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
  procedure, runtime or bound does.

## Not yet

Snapshot publication from the live event chain (a standing order in the sleep
cycle) and the Platform-side `resume_company.procedures` consumer are follow-ups
in their respective lanes. Effectiveness of a procedure on a given runtime is
established by comparison v2, not by appearing in this snapshot.
