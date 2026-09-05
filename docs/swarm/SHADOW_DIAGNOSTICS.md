# Shadow diagnostics (Organism ingestion step for comparison v2)

`swarm/src/shadowDiagnostics.js` joins the gateway's shadow log
(`amos.swarm-turn-shadow` records, one per final-stage Mission turn) to the
Platform's terminal-Mission episodes ingested by the intake
(`platform.experience-verified` / `platform.experience-negative` events) and
names the base and adapter treatments in the comparison-v2 vocabulary
(`docs/swarm/VERIFIED_MISSION_COMPARISON.md`).

Run it against the live files:

```
node swarm/scripts/reportShadowDiagnostics.js \
  --shadow /var/lib/amos-swarm-gateway/shadow.jsonl \
  --events /var/lib/amos-research/organism/platform-events.jsonl \
  --candidate swarm/benchmarks/results/adapter-candidate-stage1-implicit-r32-s3.json \
  --base-model-id amos-qwen38-27b-fp8 --base-artifact <sha> --adapter-artifact <sha> \
  --runtime-revision <git sha> --prompt-compiler <sha> --scheduler-policy <sha> --inference-config <sha> \
  --out shadow-diagnostics.json
```

## What it says, and what it refuses to say

- Per Mission turn: agreement between the served base answer and the adapter's
  shadow answer on the same compiled input, compiled-input parity across arms
  (from `inputEvidence`), whether text was captured (consenting tenant only),
  and the Mission's independently checked terminal outcome when its episode
  has arrived. Rows without a Mission or without an episode stay in the report
  as unattributable.
- Aggregates: agreement rate over attributed turns, agreement split by terminal
  status, parity rate, shadow errors, and the distinct task identities
  observed.
- `comparatorEligiblePairs` is always 0. A shadow answer was never executed and
  has no verdict; comparison v2 needs two independently executed arms with host
  receipts. This report is the input to planning such a run (which tasks, which
  treatments), not a substitute for it.
- `treatmentPairFromCandidate` builds the baseline and adapter treatments from
  an adapter-ledger record; the only changed dimension is `weights`. The
  caller supplies the artifact, runtime and configuration digests it can
  attest; the module does not invent them.
