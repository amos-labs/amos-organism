# Sleep Cycle

The sleep cycle is the organism's idle-time metabolism. A Qwen substrate that
serves missions during the day sits idle most of the night. The sleep cycle
uses that idle GPU time to advance research work that would otherwise wait for
a human to run a script.

## What it does

`npm run research:swarm:sleep` watches vLLM's request gauges
(`vllm:num_requests_running`, `vllm:num_requests_waiting`). When the box has
been quiet for the configured window it drains a queue of sleep work, one item
at a time, re-checking load before every item. The first live request ends the
cycle at the next task boundary; the remaining items stay queued.

Slice 1 runs two kinds of work, both taken from a candidate's `nextGate` in the
organism learning cycle:

| Work kind | Evaluator | Counted as |
|---|---|---|
| `organism-artifact-replay` | `artifact-replay-verifier` (no model calls) | host-contract replays |
| `organism-qwen-phase-probes` | `qwen-execution-verifier` over the candidate-independent AMOS-owned concept verifier | verified evaluations |

Every cycle appends one immutable, digested record to a JSONL ledger and writes
the advanced candidates back as an `amos.swarm-sleep-queue`, which the next
cycle reads in preference to the original promotion queue.

## The one number

`verifiedEvaluationsPerDay` in the ledger summary. It counts only evaluations
graded by a candidate-independent verifier. Invariant replays are reported
separately and never inflate it. The number starts near zero and the point of
slices 2 and 3 (executable verifiers, synthetic curriculum) is to raise it.

## The boundary

Sleep produces candidates, evaluations, and proposals. It never mints fitness,
admits a gene, or promotes an adapter. Cycle records carry
`authority: "research"` and a `vesting` block that is all `false`; the record
validator rejects anything else. Credit still requires host receipts through
the kernel's official-verification path.

This rule exists because the first swarm paid agents energy for being idle and
let them learn skills at random while idle. That system could not learn
anything true.

## Running it

Offline dry run against a promotion queue and a learning store:

```bash
node swarm/scripts/runSleepCycle.js \
  --queue research/sleep/promotion-queue.json \
  --store .amos-agent/research/swarm-learning \
  --assume-idle
```

On the Qwen box, as a daemon with real load detection and phase probes:

```bash
AMOS_QWEN_RESEARCH_URL=http://127.0.0.1:8000/v1 \
AMOS_LOCAL_BENCHMARK_API_KEY=... \
node swarm/scripts/runSleepCycle.js \
  --queue research/sleep/promotion-queue.json \
  --store .amos-agent/research/swarm-learning \
  --metrics-url http://127.0.0.1:8000/metrics \
  --quiet-seconds 300 --poll-seconds 15 --max-cycle-seconds 3600 \
  --enable-phase-probes --daemon
```

Outputs default to `<queue>.sleep.json` and `sleep-ledger.jsonl` beside it.
Set `AMOS_VLLM_METRICS_TOKEN` if the metrics endpoint is behind a bearer token.

## Known gaps

- Preemption is at task boundaries. A phase probe in flight finishes before the
  cycle yields; the result is kept and recorded as `preemptedAfterCompletion`.
- Load detection reads vLLM directly. A gateway in front of vLLM that queues
  requests elsewhere is invisible to it.
- Only two work kinds are sleep-runnable. Full missions, frozen holdouts, and
  canaries are deferred and listed in the sleep queue.
- The phase-probe verifier is concept matching. It is candidate-independent
  but shallow; slice 2 replaces it with executable checks.

## Next slices

1. Executable verifiers and combinatorial scenarios exist in
   [the curriculum generator](CURRICULUM_GENERATOR.md); wire its holdout pool
   in as a sleep work kind so Qwen is graded on it during idle time.
2. Synthetic curriculum as sleep work, with Qwen as the mutation operator.
3. Adapter consolidation: stage-one LoRA jobs, sealed-holdout gate, vLLM hot swap.
