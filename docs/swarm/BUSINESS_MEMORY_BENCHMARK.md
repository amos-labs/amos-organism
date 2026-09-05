# Business-memory benchmark

## Purpose

The thesis under test: governed company memory makes any model better at
running a business, and verified procedural memory on top of it helps further.
This benchmark measures that with executable verifiers on a synthetic business,
so the claim can be stated as paired wins and losses rather than an impression.

Four arms matter for the product story:

| Arm | Model | What the model sees |
| --- | --- | --- |
| alone | frontier control | only the asker's own prior sessions |
| memory | frontier control | plus compiled AMOS memory within the asker's scopes |
| procedures | frontier control | plus verified operating procedures |
| procedures | owned Qwen | the same, on the owned substrate |

Memory versus alone is the "we make frontier models better" number. Procedures
versus memory is the value of procedural memory. Qwen versus the control on the
same arm is the margin story: how close the owned cortex gets when it has the
same memory.

## The world

Each world is a small company generated from a seed: four users with role
scopes (owner, finance, marketing, contractor), customers, vendors, invoices,
campaigns, and a policy, each with one to three host-recorded revisions;
operation receipts shaped like the platform's `OperationReceipt` with
`lifecycle_state` and `effect_applied`; company notes; and per-user sessions
containing what people said, including a claim that conflicts with the record
and a preference that was or was not promoted to company memory.

Compiled memory follows the context-compiler invariants: identity and scopes
verbatim, every record with provenance, receipts and pending approvals labeled,
another user's private session never rendered. Section labels describe the
memory class; they do not state rules.

## Families and verifiers

Every family's verifier re-derives the expected answer from the world. None
reads the stored target as truth and none string-matches prose.

| Family | Question shape | Verifier checks |
| --- | --- | --- |
| current-value-after-supersession | current value of a field that changed | latest revision value, record cited |
| executed-versus-proposed | was an operation actually applied | label derived from the receipt, receipt cited |
| scope-boundary | value in a collection outside the asker's scopes | scope_denied, no value or hidden record leaked |
| value-as-of-date | value as of a date between revisions | revision in effect on that date, record cited |
| derived-total-from-records | total unpaid for a customer | sum over current unpaid invoices, pending payment excluded, every invoice cited |
| session-claim-versus-record | the asker's own earlier claim versus the record | recorded value, conflict object with both values, record cited |
| memory-class-recall | a preference stated in a session | answered from a company note, or unknown when only in another user's private session |

Four judgment families were added once recall saturated. Memory alone shows
the facts; the rule that combines them is not stated in the data.

| Family | Question shape | Verifier checks |
| --- | --- | --- |
| approval-required-decision | does a proposed monetary change need owner approval | value against the policy threshold in effect at the receipt's emitted_at, receipt and policy cited |
| invoice-due-date | due date for an invoice | issue date plus the customer's terms in effect on the issue date, invoice and customer cited |
| stale-note-versus-record | a company note records a value a later revision changed | recorded value, conflict carrying the note's value, record and note cited |
| replay-safety | should an attempted operation run again | already_applied, replay_safe, inspect_first, or await_approval derived from the receipt state |

A case is emitted only when its expected answer passes and its distractor fails
its own verifier.

## Answer contract

```json
{"status":"answered|scope_denied|unknown","answer":<string|number|null>,"grounding":["<ids>"],"conflict":null|{"claimed":<value>,"recorded":<value>}}
```

## Harvested procedures

`npm run research:memory-harvest` turns a model's graded failures into
candidate procedures without ever showing it a target. For each failed
memory-arm case the model gets one repair attempt whose feedback is the
verifier's failure list. When the repair passes, the model states the general
rule it should have applied, with no ids, names, dates, or amounts; rules that
name one are rejected before evaluation. Each surviving candidate is then added
alone to the procedures arm and run on its family's development cases. It is
admitted only with at least one paired win and zero paired losses against the
memory-arm baseline, and it carries lineage back to the source case, the
repair, and the evaluation that vested it.

The runner loads a harvested store with `--procedures FILE`. Harvest never runs
on the holdout pool, and a harvested store's value counts only when the
procedures arm is measured there.

## Claim boundary

- Fixture-backed synthetic business. It exercises the memory shapes the platform
  produces; it is not customer data and not a live tenant.
- Authored procedures measure the value of supplying verified procedural memory.
  Harvested procedures measure whether the model can learn it from graded
  failures. Report which store a procedures-arm result used.
- The development pool is research-visible. A result supports a claim only from
  the holdout pool, and the holdout pool must not be used to tune prompts,
  renderers, or procedures.
- One repetition per case. Report paired wins and losses per family beside any
  pass rate.

## Running

Dry run, no model, writes the manifest and rendered prompt sizes:

```bash
npm run research:memory-benchmark -- --dry-run --output reports/memory-dry.json
```

Live, against the owned Qwen cell and the Opus control through the Bedrock
benchmark gateway:

```bash
python3 swarm/scripts/bedrockBenchmarkGateway.py --port 8123 &
npm run research:memory-benchmark -- \
  --workers "qwen|amos-qwen38-27b-fp8|$AMOS_QWEN_RESEARCH_URL|qwen,opus|us.anthropic.claude-opus-5|http://127.0.0.1:8123|generic" \
  --control opus --pool development --worlds 4 --cases-per-family 2 \
  --output reports/memory-development.json
```

Repeat with `--pool holdout` only after the development result has stopped
changing. The output records the manifest digest, every run, the paired arm
comparisons per model, and the model comparisons per arm.

## Live arm (real tenant)

The live arm seeds a generated world into a real, non-public AMOS tenant and
reads it back through the production verbs. Nothing about the model's view is
rendered from the synthetic world: records arrive as `record_history` returns
them (Platform UUIDs, host-recorded instants, actors), evidence comes from
`search_company_context` with the case's `as_of`, and the envelope comes from
`whoami` and `get_catalog`. The verifiers are the synthetic ones; the only
bridge is translating cited Platform ids back to world ids before verification
(`translateLiveAnswer`).

- Tenant: the durable `test_fixture` tenant described in the platform repo's
  `docs/TEST-TENANT.md` (`northwind-test`). The owner API key lives in AWS
  Secrets Manager and is read into the environment at run time; it is never
  written to a report.
- Seeding (`seedWorldIntoTenant`) is idempotent: a record whose `world_ref`
  already exists in its live collection is reused. Live collections are named
  `bm_<world>_<collection>` so benchmark data never mixes with the tenant's
  starter data.
- Families: only `current-value-after-supersession`, `value-as-of-date`, and
  `derived-total-from-records` are reproducible with one writing principal.
  Receipt families need proposed/failed/uncertain receipts the governed verbs
  will not fabricate; note and session families need shared notes and prior
  sessions; scope families need a second principal (the member user, once its
  key exists). Those stay synthetic.
- As-of: live revisions are seconds apart, so an as-of *date* becomes an as-of
  *instant* placed between the two live revisions that bracket the world's
  date. The expected value is unchanged; the question text carries the instant.
- Arms: `alone` (no material) and `memory-live` (envelope, records, evidence).
- Workers: the Hosted `/v1/chat/completions` route by default (whatever AMOS
  routes to), plus any `--workers` spec from the synthetic runner. Hosted calls
  also land in `intelligence_grounding_events`, so the run captures the admin
  grounding summary before and after when `AMOS_ADMIN_KEY` is set.

```bash
AMOS_NORTHWIND_OWNER_KEY=... npm run research:memory-live -- --dry-run --output reports/live-dry.json
AMOS_NORTHWIND_OWNER_KEY=... AMOS_ADMIN_KEY=... npm run research:memory-live -- \
  --pool holdout --world-index 0 --cases-per-family 3 \
  --output swarm/benchmarks/results/business-memory-live-hosted-<date>.json
```

## First results (2026-09-04)

Full run records are under `swarm/benchmarks/results/business-memory-*.json`
and the dated entries in `docs/EXPERIMENTS.md`. Holdout pool, 80 cases,
11 families, single repetition, extended thinking off:

| Model | alone | memory | memory vs alone (paired) | own harvested procedures |
| --- | --- | --- | --- | --- |
| Claude Opus 5 | 4/80 | 79/80 | 75 wins, 0 losses | 80/80 |
| Qwen 3.8 27B | 5/80 | 78/80 | 73 wins, 0 losses | 79/80 |

Given the same governed memory, the owned 27B is within one or two cases of
the frontier control on this suite. Rules harvested from a model's own
failures helped that model with no losses; rules authored by hand or harvested
from the other model did not transfer and sometimes cost cases. Everything the
context compiler can state as a fact, such as the collections outside a
principal's scopes, belongs in the compiler; procedural memory has to earn its
place on cases memory alone does not settle, and this suite is now near
ceiling, so the next families must be harder.

## Next slices

1. A live arm that renders memory from a frozen Northwind demo tenant over MCP
   instead of the fixture renderer, to check that the platform's real brief
   carries the same signal.
2. More families from real Platform Mission episodes as they arrive, under the
   data-rights policy.
3. Repetitions and a sealed holdout with a custodian.
