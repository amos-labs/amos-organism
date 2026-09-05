# Verified mission comparisons for adapter advancement

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
