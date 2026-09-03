# Curriculum Generator

The curriculum generator produces the training data for stage one of the
adapter ladder and the graded scenarios the sleep cycle will run against Qwen.
It replaces the eight fixed stage-zero fixtures, whose "variants" changed only
an ID string, with combinatorial scenarios drawn from a seed and the AMOS tool
catalog.

## Source of variety

`swarm/benchmarks/amos-tool-catalog-v1.json` is extracted statically from the
platform's MCP tool definitions in Rust (`npm run research:swarm:extract-tool-catalog`).
It carries tool names, domains, JSON input schemas, and a coarse authority tag
(read, write, consequential). Descriptions are product documentation; the
catalog attests that it holds no tenant facts and no credentials, and the
generator refuses a catalog that does not. A hashed fifth of the tools is
`reserved` for the holdout pool and never appears in training scenarios.

## Families and their verifiers

Every family has an executable verifier that re-derives the expected answer
from the scenario's facts. The verifier never reads the training target and
never string-matches prose.

| Family | What varies | Verifier checks |
|---|---|---|
| choose-smallest-sufficient-tool-set | 1 to 3 required tools plus 3 to 5 distractors, read-only or not | exact tool set, step mapping, no unavailable or write tools on read-only requests |
| emit-valid-typed-tool-arguments | real tool schema, synthesized values, optional schema revision | JSON Schema validation, known values carried, no invented fields |
| produce-contract-valid-artifacts | 2 to 5 outline blocks across five block kinds | DocumentSpec schema, identity, outline followed block by block |
| recover-without-replaying-completed-actions | 3 to 6 actions, five failure kinds, host retry bound | retry only the failed action, prescribed repair, receipts preserved, bound respected |
| request-approval-only-at-real-authority-boundaries | tool authority, granted scopes | decision matches policy; over-asking and under-asking both fail |
| compact-context-without-losing-governed-state | 6 to 12 typed items, recency window | governed items and recent results preserved, rest summarized, complete partition |
| distinguish-proposed-state-from-host-recorded-state | host, model, and missing receipts, supersession | per-proposal status, only host receipts cited |
| integrate-specialists-into-verifiable-result | 3 to 7 findings, verified or not | support is verified-only, exclusions carry reasons, status rule |

A scenario is emitted only if its target passes and its rejected output fails
the verifier. Prompts that repeat within a family are skipped and re-drawn, so
the dataset carries no padding. The rejected output and the verifier's failure
list become the preference pair.

## Running it

```bash
# training pool, 64 scenarios per family (clears the stage-one minimums)
npm run research:swarm:generate-stage1-data -- --store .amos-agent/research/swarm-learning --per-family 64

# holdout pool: reserved tools, revised schemas, protected partition
npm run research:swarm:generate-stage1-data -- --store .amos-agent/research/swarm-learning --pool holdout --per-family 8

# stage-one data gate against the real plan
npm run research:swarm:export-adapter-data -- --store .amos-agent/research/swarm-learning --output .amos-agent/research/amos-native-dataset
```

Measured on the committed catalog with the default seed: 512 training scenarios
across 8 families and 40 distinct tools compile to 256 training, 64 validation,
and 192 holdout examples plus 512 preference pairs, with an empty blocker list.

## What this is and is not

It is a legitimate source under the plan's allowed list, deterministically
verified self-play, and it clears the data gate. It is synthetic, so it teaches
contract discipline, not business judgment. Real Platform Mission episodes stay
the highest-value data and should displace synthetic examples as they arrive.
Frozen-holdout and blind frontier comparison remain the promotion gates.

## Next

- Sleep-cycle work kind that runs Qwen on holdout-pool scenarios and grades the
  answers with `gradeCurriculumAnswerText`, so verified evaluations per day
  climbs.
- Preference pairs harvested from phase probes and curriculum runs where a
  first attempt fails and a repair passes.
