# AMOS Organism: what was done, what was measured, what it means

A self-contained brief for an independent reviewer. It covers the work from
2026-09-02 through 2026-09-05 on the `amos-organism` repository and the AWS
research plane it drives, ending with a trained adapter running in shadow on
the production inference cell. Every number below is reproducible from files
committed under `swarm/benchmarks/results/` and from the runbooks in `docs/`.
The author of this brief is the AI agent that did the work; treat claims here as
the agent's own account and check them against the artifacts.

## 1. Starting point

The organism kernel (TypeScript, ~2.7k lines) is a governed learning ledger:
energy and fitness ledgers, verifier-gated vesting, content-addressed
"strategy genes" with lineage, an append-only hash-chained event store, and a
host-receipt boundary so a model can never mint credit for itself. It was
research-stage: well-tested accounting with no positive learning result. A
separate Qwen swarm experiment (JavaScript, ~13k lines) held the actual
apparatus: a swarm coordinator, a holographic shared-state (HRR) layer,
Terminal-Bench harness, an adapter-training contract, a stage-zero QLoRA
"lineage proof" that had trained a 64-example adapter and loaded it into vLLM,
and an AWS research plane (one g7e.2xlarge inference cell serving Qwen3.8-27B
FP8 via vLLM, one stopped g7e.2xlarge trainer, one t3.large job runner, S3,
SQS, DynamoDB). Stage one of the training ladder was blocked on data: the plan
required 200/50/50 verified examples across 6 families; the only curriculum had
8 unique templates whose "variants" changed an ID string.

Terminal-Bench had been consuming the GPU: of the last 8 training runs, 7
timed out after two hours per trial at zero reward.

Substrate facts used throughout: Qwen3.8-27B (hybrid attention, 64 layers,
262k context), served FP8 in production; trained from the bf16 canonical
checkpoint with QLoRA (nf4 base, bf16 adapter, rank 32, alpha 64, all linear
projections including the linear-attention in/out projections, 233M trainable
parameters, 1.5% of the model).

## 2. What was built (PRs #4 through #10, all merged)

1. **Sleep cycle** (`swarm/src/sleepCycle.js`, executors, daemon). Idle-time
   metabolism: watches vLLM request gauges, sleeps after a quiet window,
   drains research work (artifact replays, verifier-graded phase probes,
   standing orders), stops at the next task boundary on a live request. Every
   cycle is a digested record with `authority: "research"` and a vesting block
   that is all false; the validator rejects anything else. Headline metric:
   verifier-graded evaluations per day.
2. **Tool catalog** (`swarm/benchmarks/amos-tool-catalog-v1.json`): 57 real
   AMOS MCP tool definitions extracted statically from the platform's Rust
   source, with JSON schemas and coarse authority labels; a hashed 20% reserved
   for holdout. Attests no tenant facts or credentials.
3. **Combinatorial curriculum generator** (`swarm/src/amosCurriculumGenerator.js`).
   Eight system-competence families, each with an executable verifier that
   re-derives the expected answer from scenario facts and never reads the
   target: tool selection with distractors, typed arguments against real
   schemas (with schema revisions), DocumentSpec artifacts, recovery without
   replaying completed actions, approval boundaries in both directions,
   context compaction, receipt provenance, specialist integration. Targets
   must pass and rejected outputs must fail before emission; repeated prompts
   are re-drawn. Two **rulebooks**: explicit (the governing rule is printed in
   the prompt) and implicit (verifier keeps the rule; prompt omits rule text
   and authority labels).
4. **Grading** (`swarm/src/curriculumGrading.js`): grade served model IDs on
   identical scenarios with one repair attempt whose feedback is the
   verifier's failure list; pairwise comparison with wins, losses, ties, and
   per-family lift; bounded concurrency.
5. **Preference harvesting**: verifier-accepted answers become training
   examples; a rejected first attempt followed by an accepted repair becomes a
   preference pair. Only from the training pool.
6. **Adapter consolidation**: stage-one QLoRA contract (real plan minimums,
   trainer may not select its own checkpoint), one immutable contract per
   rank×seed, SSM-driven disposable trainer, resume from S3, patient retry for
   EC2 capacity. Trainer accepts stage-one contracts and records validation
   loss per epoch.
7. **Adapter candidate ledger** (`swarm/src/adapterCandidates.js`): trained →
   frozen holdout → sealed holdout → shadow → canary → promoted; the last two
   require a host receipt.
8. **Swarm gateway shadow mode**: the final-stage request also goes to a second
   served model; both answers are recorded; the Mission always receives the
   primary.
9. **Signed Platform intake** (`src/platformEpisodeReceiver.ts`): verifies the
   Platform's KMS ECDSA P-256 signature over the raw canonical body, refuses
   non-canonical bytes, mints the host receipt only after verification.
10. Operational fixes recorded in `docs/swarm/TRAINING_RUNS.md`: HTTPS-only
    egress on research hosts, dash vs bash under SSM, `TORCH_DISABLE_NATIVE_JIT`,
    Hub rate limits on lineage checks with cached receipts, Harbor agent timeout
    capped at 0.5× the task budget.

## 3. What was measured

All grading uses the executable verifier. "First-attempt" is the answer the
model gives with no feedback; "pass" allows one repair with the verifier's
failure list. Holdout scenarios draw only from reserved tools and, because the
dataset compiler splits by family, from families the adapters did not train on.

### 3.1 Controls on the production base (FP8, live cell)

| holdout, 48 scenarios | first-attempt | pass |
|---|---|---|
| explicit rulebook | 48/48 | 48/48 |
| implicit rulebook | 33/48 | 45/48 |

Interpretation: with the rule in the prompt the task is transcription and there
is no headroom. Removing the rule exposes what the model does not know about
AMOS governance: repair vocabulary, authority scopes, receipt provenance.

### 3.2 Stage-one training runs

Run `stage1-20260904-r2` (explicit data): one seed completed, training loss to
zero, later shown to regress on implicit prompts. Abandoned.

Run `stage1-20260904-r3-implicit`: 256 training examples from the implicit
curriculum, rank 32, seeds 20260903/04/05, three epochs, lr 1e-4, about 40
minutes per job on one GPU. All three completed: adapter reload exact, base
bitwise unchanged with adapter disabled, holdout token accuracy 0.966 to 0.971.

### 3.3 Adapter grading, and a correction

The first grading server ran vLLM without Qwen's reasoning parser, so thinking
text landed in every model's answer body. That produced a large apparent lift
(base 34/48 pass vs adapters 39–47/48) which was mostly the missing parser
hurting the base more than adapters trained to answer directly. It is reported
in `TRAINING_RUNS.md` with that caveat and should not be quoted.

With the parser on, same 48 scenarios: base 45/48 pass, 38/48 first-attempt;
adapters 46–47/48 pass, 42–44/48 first-attempt; paired W/L 2/1, 3/1, 3/1. Real
but inside the noise of 48.

**Wider holdout, fresh seed, parser on, 96 scenarios** (the number to quote):

| model | pass | first-attempt | paired W / L vs base |
|---|---|---|---|
| base bf16 | 86/96 | 63/96 | – |
| implicit adapter, seed 1 | 90/96 | 84/96 | 7 / 3 |
| implicit adapter, seed 2 | 92/96 | 87/96 | 7 / 1 |
| implicit adapter, seed 3 | 93/96 | 89/96 | 8 / 1 |

First-attempt pass rises 22 to 27 points for every seed. On the explicit
holdout all four models score 47–48/48 with no paired wins or losses: the
adapters cost nothing on rule-in-the-prompt work. Recovery: the contract now
names the allowed repair verbs (the mapping stays in the rulebook), which made
recovery easier for every model than in the earliest runs.

**Sealed holdout (96 implicit scenarios, a seed never used for selection, graded once):**

| model | pass | first-attempt | paired W / L vs base |
|---|---|---|---|
| base bf16 | 81/96 | 61/96 | – |
| implicit adapter, seed 1 | 90/96 | 83/96 | 12 / 3 |
| implicit adapter, seed 2 | 91/96 | 83/96 | 10 / 0 |
| implicit adapter, seed 3 | 93/96 | 84/96 | 12 / 0 |

The sealed result reproduces the wider holdout within two points on every
row. Explicit wide holdout (96): all four models 95–96/96, no paired wins or
losses. Report files: `curriculum-grading-stage1-adapters-implicit-SEALED-96-2026-09-05.json`,
`curriculum-grading-stage1-adapters-explicit-holdout-v2-96-2026-09-05.json`.

### 3.4 First autonomous cycle

The sleep daemon on the runner slept at 10:19 UTC on 2026-09-05 and finished at
10:35: three standing orders, 189 verifier-graded evaluations, 59 harvested
episodes. The base's implicit first-attempt figure (33/48) reproduced the manual
control exactly. From 2026-09-06 the nightly orders grade base and adapter on
the production cell.

## 4. What is live (2026-09-05, 13:25 UTC)

- Production cell: LoRA serving enabled in place; adapter `stage1-implicit-r32-s3`
  loaded beside the base; swarm gateway running the shadow-capable image with
  `--shadow-model stage1-implicit-r32-s3`, pairs to `shadow.jsonl`. The Mission
  path is unchanged: it always receives the base answer.
- Research plane: sleep daemon, hourly replay-store sync, weekly consolidation
  timer, signed Platform intake at a private address; Terraform applied (2 add,
  4 change, 0 destroy).
- Not yet live: the Platform-side feed (three env vars, `kms:Sign` for the
  Platform task role, a tenant consent row). Until then no real Mission
  episode reaches the organism.

## 5. Claims the author makes, and their limits

1. Adapters trained on generated, verifier-checked data generalized to reserved
   tools and unseen families, measured by the same verifier with the base as a
   paired control, consistently across three seeds. Limit: the distribution is
   the generator's eight families; real Missions differ in prose, context
   length, and tool surface.
2. The lift is on first-attempt behaviour (knowing AMOS conventions without
   being told); with one verifier-feedback repair the base nearly catches up.
   Limit: the repair loop presupposes an executable verifier that real Missions
   may not have per turn.
3. No regression on explicit prompts. Limit: 48 scenarios.
4. The pipeline is autonomous end to end and every step is a digested,
   replayable artifact. Limit: two of the weekly consolidation's inputs (real
   episodes, harvested pairs) have not yet been through a full cycle.

## 6. Questions a reviewer should press on

- Is the implicit-rulebook holdout genuinely out of distribution, given the
  same generator produced training and holdout? Reserved tools and unseen
  families argue yes; shared templates argue partly no. The shadow log on real
  Missions is the decisive test.
- Are 96 scenarios enough? Paired sign tests on 7/1 and 8/1 are significant at
  conventional levels; 7/3 is marginal. A 200-scenario sealed set would settle
  it.
- Training loss reached ~0.001 on 256 examples: memorization risk. Holdout
  token accuracy 0.97 and the paired results argue it generalized; a reviewer
  could check per-family variance across seeds (seed 2 regressed on explicit
  in the first, parser-off grading).
- The base model in grading is bf16 on the trainer; production is FP8. The
  adapter was trained against nf4-quantized weights and is served on FP8. The
  stage-zero proof showed the load works; the shadow log shows whether the
  behaviour holds.
- Governance: the adapter reached production shadow through hand-run steps
  (recorded in `docs/GO_LIVE.md`) rather than through the adapter ledger's
  gates. The ledger exists; the shadow and canary receipts should be recorded
  in it before any promotion.

## 7. Files to inspect

- `docs/GO_LIVE.md`, `docs/swarm/TRAINING_RUNS.md`, `docs/swarm/CURRICULUM_GENERATOR.md`,
  `docs/swarm/SLEEP_CYCLE.md`, `docs/PLATFORM_EPISODE_INTAKE.md`
- `swarm/benchmarks/results/curriculum-grading-*.json` (controls, adapter
  gradings, parser-on regrades, wider holdout), `stage1-20260904-r3-implicit*.json`
- `swarm/src/amosCurriculumGenerator.js`, `curriculumGrading.js`,
  `preferencePairHarvest.js`, `adapterConsolidation.js`, `adapterCandidates.js`,
  `sleepCycle.js`, `swarmTurnGateway.js`; `src/platformEpisodeReceiver.ts`
- Tests: `npm run check` (245 tests) and `python3 -m pytest swarm/infra/aws/qwen-research-plane`
