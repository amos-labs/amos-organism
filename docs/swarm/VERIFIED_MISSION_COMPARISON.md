# Verified Mission comparisons

Version 1 is the existing adapter-ledger contract described below. Version 2 adds
explicit experimental treatments, preregistration and typed first-attempt evidence.
The shared comparator and CLI replay both versions. Version 2 reports are available
for integration/evaluation; the ledger explicitly refuses them until its separate
admission change is reviewed. A successful v2 comparison does not advance an adapter.

## Version 2 producer/consumer contract

Set `version: 2` on the comparison input. It contains `baseline` and `candidate`
treatments, a `protocol`, and `pairs` in the existing pair/mission-export shape.
Use `missionComparisonProtocol.js` to construct and validate the treatment and
protocol; use `missionComparisonBindings(mission, context, 2)` for task/condition
digests. The checked-in `swarm/test/fixtures/mission-comparison.v2.json` is a small,
synthetic compatibility fixture. It cannot pass the 200-independent-task gate.
`missionComparisonV2Fixtures.js` generates larger adversarial test cases.

Each treatment has `schema: "amos.mission-treatment"`, `version: 1`, a canonical
`digest`, and these fields:

| Field | Meaning |
| --- | --- |
| `model` | `{modelId, baseArtifactSha256, adapter}`; adapter is explicitly null or `{artifactSha256, uri, trainingContractSha256}` |
| `procedureSnapshotSha256` | Exact frozen learned-procedure snapshot, separate from governed business memory |
| `runtimeRevision` | Pinned 40- or 64-character source revision |
| `promptCompilerSha256` | Compiler/configuration that builds the planner input |
| `schedulerPolicySha256` | Frozen specialist/effort scheduling policy |
| `inferenceConfigSha256` | Tier, reasoning effort, sampling settings and context/output budgets; pair seed is in common conditions |
| `encoderSha256` | Learned encoder artifact, or explicitly null when absent |

Model IDs may stay identical across arms; different weights or procedures have
their own identities. Renaming the same model/weights does not establish a weight
contrast. A base-only treatment does not need an adapter URI. The no-procedures
sentinel is the canonical digest of
`{"schema":"amos.empty-procedure-snapshot","version":1}`:
`3729e785172fb2d92b3a51f2d2f0efc409540291fd0497a569aaa2baefeadde3`.
Only the host compiler can attest that this empty snapshot describes its input;
unknown provenance must not be replaced with the sentinel.

The protocol has `schema: "amos.mission-comparison-protocol"`, `version: 1`, and:

- `id`, `registeredAt` (UTC), `registrationRef`, and canonical `digest`.
- `baselineTreatmentSha256`, `candidateTreatmentSha256`.
- `changedDimensions`: exact nonempty subset of `weights`, `procedures`, `runtime`,
  `promptCompiler`, `schedulerPolicy`, `inferenceConfig`, `encoder`.
- `tasks`: the frozen list of `{id, family, taskSha256, conditionsSha256}`, and
  `taskSetSha256`: its canonical digest sorted lexicographically by task ID.
- `primaryMetric: "verified-first-attempt-completion"`,
  `confidenceMethod: "paired-bonferroni-clopper-pearson"`, `confidenceLevel: 0.95`,
  and `minimumLift` (a nonnegative probability difference).
- `limits: {minimumPairs, maximumCostRatio, maximumLatencyRatio}`. The defaults
  for new manifests are 200, 1.1 and 1.2; producers supply them explicitly. V2 can
  tighten these thresholds but cannot relax them.

Register and seal this protocol before either arm starts. The host must retain
the registration receipt, authenticate it and enforce sealed-once use across
experiments. The module checks chronology, treatment changes, task identity,
family labels, common conditions and complete batch coverage; a timestamp string
and hash alone do not prove preregistration or detect previous holdout access.
Partial batches can be replayed for diagnostics but cannot pass. A distinct task
digest is counted once; repeated seeds or variants of the same task cannot inflate
the independent-task floor. Plan multi-seed/factorial experiments as a registered
batch of contrasts, with the host's multiplicity policy established in advance.

V2 common `context` is exactly `{toolCatalogSha256, memorySnapshotSha256,
environmentSha256, executionPolicySha256, runSeed}`. Runtime identity moves to the
treatment. `runSeed` is an explicit unsigned 32-bit integer. Business memory,
authority, task, tools, starting environment, budget ceilings and checker policy
remain paired controls. A procedure experiment cannot change business facts or
permissions under the same comparison.

Each V2 measurement retains `source: "platform-mission-harness"`,
`accountingComplete`, `missionSha256`, `taskSha256`, `conditionsSha256`, `context`,
all cost/time/effect/budget accounting fields and `digest`. Replace legacy
`modelId`/`artifactSha256` with `treatmentSha256`; add `protocolSha256` and
`compiledInputSha256`. The latter identifies the exact compiled planner input
being compared, not an answer or the final checker result. A weights-only
comparison requires the same compiled input in both arms. The host must supply
compatible paired inputs; this module does not strip Mission identifiers or
normalize differing prompts to make their hashes agree. Later interactive inputs
and accepted planner attempts need their own host trace/step bindings at ingestion.

Replace the legacy `recoveries` counter with:

```json
{
  "recoveryEvidence": {
    "version": 1,
    "coverage": "complete",
    "unexpectedCorrections": 0,
    "requiredRecoveries": 0,
    "evidenceRefs": ["host receipt for complete execution trace"]
  }
}
```

Coverage is `complete`, `partial` or `unknown`. Complete coverage requires explicit
integer counts and host evidence references; unknown counts must be null. Partial
counts can be observed lower bounds, but aggregate recovery and primary lift remain
unknown until coverage is complete for every run. Missing evidence is unknown;
old step payloads without recovery annotations do not establish zero corrections.
First-attempt success requires independently verified completion and complete
coverage with zero unexpected corrections. Planned multi-step work and explicitly
required recovery challenges do not count as unexpected correction. Classification
must follow the host's preregistered task/recovery policy, including invalid plans,
checker feedback and tool failures, rather than a model's self-report.

The primary statistic counts paired candidate-only first-attempt wins and
baseline-only losses, with all independent pairs in the denominator. Its interval
subtracts conservative 97.5% exact binomial bounds on these two discordant cell
probabilities. Their joint coverage is at least 95% by Bonferroni. This construction
uses [Clopper–Pearson binomial intervals](https://www.stat.math.ethz.ch/R-manual/R-devel/library/stats/html/binom.test.html)
and the [Bonferroni inequality](https://www.itl.nist.gov/div898/handbook/prc/section4/prc473.htm);
the paired-difference construction is implemented here. It is conservative and
assumes independent task pairs sampled from the registered target population.
It is not a guarantee across arbitrary datasets, dependent task variants or
multiple adaptively selected contrasts. The primary lower bound must exceed the
registered `minimumLift`; one win out of 200 pairs is insufficient.

All previous final-completion, family, checker, recovery, cost, latency and effect
guards remain. V2 additionally checks complete recovery evidence and no first-attempt
regression within any family. A primary gain with equal eventual completion still
fails the retained final-completion-improvement guard. Unknown primary evidence
produces null lift/interval; it is never silently assigned a zero or dropped from
the eligible batch. Report validation recomputes every metric and check, including
the confidence bounds. These fixtures prove evaluator behavior; real quality
claims still require authenticated, separately executed Missions.

## Version 1 adapter-ledger contract

An adapter's shadow gate now requires a replayable paired mission comparison.
A count of turns, matching text, or valid planner JSON cannot advance it.
`recordAdapterGate` reconstructs the gate from the comparison, checks that it
names the candidate's adapter URI and base model, and rejects invented metrics.
Canary and production decisions still require their existing host receipts.

## What is measured

`compareVerifiedMissions` reads two terminal Platform `get_mission` exports for
each independent task, plus host execution measurements. It reuses
`assessPlatformMissionVerification` to assess the pinned independent checker
results. Completion without full checker coverage does not count as success.
Missing coverage blocks advancement rather than disappearing from the denominator.
Insufficient sample size or checker coverage leaves the gate pending: the gate
builder refuses to record a pass or rejection until the evidence is ready.

The default gate requires:

- At least 200 distinct tasks, with a separate execution for each arm.
- More verified paired wins than losses and no task-family regression.
- Complete checker coverage for both arms.
- No decline in completions without recovery and no increase in recovery count.
- Total cost no more than 1.10 times the control and total and p95 wall time no
  more than 1.20 times the control; these are explicit experimental limits, not measured gains.
- No candidate budget violations, unauthorized effects, or duplicate effects.

The host must freeze the task set, models, execution conditions and limits before
running either arm. A comparison is evidence for the host to assess; its aggregate
thresholds are not a statistical guarantee of general capability or a substitute
for the preceding holdout gates. Repeated variants of one task are not additional
independent samples. The checker policy must be identical within each pair;
mission-scoped checker configurations that differ need a separately reviewed
benchmark design and are currently rejected.

## Input and execution

The module exports `missionComparisonBindings(mission, context)` to derive the
expected task and condition digests from actual mission fields. Conditions include
allowed operations, budget ceilings, decision and checkpoint policies, checker
policy, and the pinned tool catalog, memory, environment, execution policy and
mission runtime. Used budget counters are not compared as conditions.

A comparison input contains:

- `baseline: {modelId, artifactSha256}`.
- `candidate: {modelId, artifactSha256, adapterUri}`.
- Optional `limits: {minimumPairs, maximumCostRatio, maximumLatencyRatio}`.
- `pairs: [{id, family, taskSha256, conditionsSha256, baseline, candidate}]`.

Each arm contains `{mission, measurement}`. `mission` is the terminal Platform
export. `measurement` contains:

- `source: "platform-mission-harness"`, `accountingComplete: true`.
- `missionSha256`, `modelId`, `artifactSha256`, `taskSha256`, `conditionsSha256`.
- `context: {toolCatalogSha256, memorySnapshotSha256, environmentSha256,
  executionPolicySha256, runtimeRevision}`.
- `costMicrousd`, `wallTimeMs`, `recoveries`, `unauthorizedEffects`,
  `duplicateEffects`, `budgetExceeded`.
- `digest`: `digestResearchValue` of all measurement fields except `digest`.

`missionSha256` is the research canonical digest of the entire exported mission.
Wall time must match its start/end timestamps. Cost must include all backend and
specialist calls, recovery and tools; Platform budget counters or the last gateway
response alone are insufficient for complete accounting. The host must obtain
recovery and effect counts from complete execution traces, not the truncated
`get_mission.steps` window.

```sh
node swarm/scripts/compareVerifiedMissions.js executions.json comparison.json
```

The CLI writes an immutable comparison. Identical retries are safe; changed
results cannot overwrite it. To advance the existing candidate ledger:

```js
const gate = shadowGateFromMissionComparison(comparison);
const nextCandidate = recordAdapterGate(candidate, gate);
```

The output includes raw supplied evidence so validation can reconstruct metrics.
Store it under the same access rules as the source mission data. This path does
not create training episodes, issue inference calls, or deploy an adapter.

## What is still required from the host

Digests establish content consistency, not execution authenticity. The host must
authenticate exports and measurement receipts, resolve model artifact identities,
enforce consent, and retain the frozen experiment manifest. The `source` field
alone does not authenticate a receipt. The comparison cannot independently prove
that supplied context snapshots or accounting counters describe the actual runtime.

The current gateway's unexecuted alternate answer is insufficient input. To test
mission-agent performance, the host needs paired isolated mission executions with
independent checker results. No second live customer action should be executed
merely to obtain a shadow score; use AMOS-owned fixtures or an explicitly authorized
isolated evaluation environment. Production intake and KMS permissions remain
separate deployment work.

Validation here uses synthetic fixture exports and adversarial evidence mutations.
It demonstrates the gate's behavior, not an observed Swarm quality improvement.
