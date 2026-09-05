# Saved autonomous learning-cycle audit — September 5, 2026

The first saved cycle ran from 10:19:56 to 10:35:20 UTC. Its reports and ledger
were downloaded from the existing research bucket's `sleep/state/` prefix.
All report digests were checked, scenarios were regenerated from the recorded
seeds and current catalog, and every saved answer was regraded locally. No new
inference, training, episodes, deployments or uploads were performed by this audit.

| Base-model workload | Tasks | First-attempt passes | Final passes | Verifier attempts replayed |
| --- | ---: | ---: | ---: | ---: |
| Implicit rulebook holdout | 48 | 33 | 47 | 63 |
| Explicit rulebook holdout | 48 | 48 | 48 | 48 |
| Implicit rulebook training pool | 64 | 50 | 59 | 78 |

All **189** verifier results and the reported pass rates reproduced exactly,
including the report format's four-decimal rounding. The model was
`amos-qwen38-27b-fp8` in all three workloads. This establishes that a real
collection/evaluation cycle ran; it is one baseline cycle and cannot establish
an improvement trend or an adapter's advantage.

The existing harvester derived **59** items from the training-pool report:
50 verified first answers and 9 preference pairs whose initial answer failed and
whose repair passed. All 59 expected episode references and objects were read
from the existing `replay/` store. Each episode passed the store validator, matched
its scenario and chosen-verifier digest, and was marked training-eligible. This
checks durable harvesting; it does not prove that a later adapter trained on
these examples improves held-out missions.

## Progress counter correction

The saved ledger reported `candidateGatesAdvanced: 3`, but all three tasks were
standing orders with `candidate: null`. The old counter counted every successful
research task as a candidate advance.

`runSleepCycle` now counts only passed candidate work with a matching candidate
identity, changed candidate digest and changed next gate. `summarizeSleepLedger`
derives the same measure from each record's tasks, including old records. The
observed cycle therefore reports **zero actual candidate advances** while retaining
all 189 verified evaluations. The original immutable ledger is not rewritten.

## Evidence references

Local audit artifacts are under `output/learning-cycle-audit/`:
`download-receipt.json`, `replay.mjs`, `audit.json`, `expected-harvest.json`,
`harvest-download-receipt.json`, and the downloaded reports/episodes.

The ledger file SHA-256 is
`9fafe63b1d9aef5f123d79512dc8bfd3bc1025594da8691af8111cd061a2ea6a`.
The immutable grading report digests are:

- Implicit holdout: `61bd9e7c894e9f8d0742e1adb04c9923a7310f7039ef0f79030cd9253f2d24d2`.
- Explicit holdout: `426c3abbb82cf644ee701a879358902e9c75b03a68254819577ecf8e353966dc`.
- Training harvest: `fde11dbe45d835e959de1bfceabaf8302ab69513529506c14909341602ec505f`.

The next performance claim needs comparisons across candidates and fresh tasks,
followed by [paired verified mission evidence](VERIFIED_MISSION_COMPARISON.md).
