# Training Runs

How a stage-one adapter run happens, end to end, and what counts as a result.

## The loop

```
verified experience ──► learning store ──► dataset compiler (gate)
       ▲                                        │ ready, no blockers
       │                                        ▼
  harvested pairs                    consolidation plan: contracts per (rank, seed)
  graded answers                                │
  Platform episodes                             ▼
       ▲                              disposable trainer per contract (SSM pointer → boot → stop)
       │                                        │ adapter + receipts in S3
       │                                        ▼
  sleep cycle ◄──── load adapter into vLLM ◄── grade base vs adapters on the holdout pool
```

Every arrow is a file with a digest. The trainer never selects a checkpoint,
never sees a holdout scenario, and never claims quality. The executable
verifier decides, with the base model as the control.

## Data sources feeding the store

- **Generated curriculum** (`research:swarm:generate-stage1-data`): training
  pool, verifier-checked, clears the gate on its own.
- **Harvested pairs and answers**: every graded model answer on a training-pool
  scenario that the verifier accepts becomes a verified answer; a rejected first
  attempt followed by an accepted repair becomes a preference pair. Phase probes
  contribute pairs the same way. Harvesting is automatic in the sleep cycle and
  available from the grading CLI with `--harvest-store`.
- **Platform Mission episodes**: through the signed intake in
  [PLATFORM_EPISODE_INTAKE.md](../PLATFORM_EPISODE_INTAKE.md). Highest value,
  lowest volume. These land in the kernel event store today; the bridge into
  the swarm learning store as training examples is the next slice.

Holdout-pool scenarios are never harvested. They are graded, and the grade is
the result.

## One-time infrastructure

Both changes are in this repository and validate with `terraform validate`.
They need an apply.

1. **Research plane**: the trainer now reads its contract URI from an SSM
   parameter at boot. `terraform apply` creates the parameter and grants the
   trainer role `ssm:GetParameter`. The instance is replaced because its user
   data changed. Note the `trainer_contract_parameter` and
   `trainer_instance_id` outputs.
2. **Inference cell**: apply with `enable_lora = true` to serve adapters beside
   the base model and allow runtime loading. This restarts vLLM. Verify that
   speculative decoding and LoRA coexist on the pinned vLLM image before relying
   on it; if they do not, set `mtp_speculative_tokens = 0` for the grading window.

## Running stage one

```bash
export AMOS_RESEARCH_ARTIFACT_BUCKET=amos-qwen-research-plane-637423327454-us-east-1
export AMOS_TRAINER_IMAGE_URI=<trainer image>@sha256:<digest>
export AMOS_TRAINER_INSTANCE_ID=<trainer instance id>

# 1. Plan only: compile the dataset, check the gate, write contracts, print the exact commands.
npm run research:swarm:consolidate-adapter -- --store <store> --ranks 32 --seeds 20260903,20260904,20260905

# 2. Execute: upload dataset and contracts, then run each job on the disposable trainer and wait.
npm run research:swarm:consolidate-adapter -- --store <store> --ranks 32 --seeds 20260903,20260904,20260905 --execute
```

Each job writes `stage0-result.json`, the adapter, and receipts to
`s3://<bucket>/stage1/<run-id>/runs/<contract-id>/`. The consolidation ledger
beside the plan records submitted, completed, and failed jobs; a re-run resumes
at the first unfinished job.

## Grading the result

On the inference box, load each adapter:

```bash
swarm/infra/aws/qwen-inference/scripts/load-adapter.sh stage1-r32-s20260903 s3://<bucket>/stage1/<run-id>/runs/<contract-id>/adapter
```

Then grade base and adapters on the same holdout scenarios:

```bash
npm run research:swarm:grade-curriculum -- \
  --model-ids amos-qwen38-27b-fp8,stage1-r32-s20260903,stage1-r32-s20260904,stage1-r32-s20260905 \
  --pool holdout --per-family 8 --output reports/stage1-holdout.json
```

The comparison reports pass-rate lift, first-attempt lift, and paired wins and
losses per adapter against the base on identical scenarios, plus per-family
lift. Three seeds agreeing is the replication bar in the plan.

Or let the sleep cycle do it nightly with a standing order:

```json
{
  "schema": "amos.swarm-sleep-standing-orders",
  "version": 1,
  "orders": [
    { "id": "nightly-holdout", "kind": "curriculum-grading", "minimumIntervalHours": 24,
      "payload": { "modelIds": ["amos-qwen38-27b-fp8", "stage1-r32-s20260903"], "pool": "holdout", "scenariosPerFamily": 6 } },
    { "id": "nightly-harvest", "kind": "curriculum-grading", "minimumIntervalHours": 24,
      "payload": { "modelIds": ["amos-qwen38-27b-fp8"], "pool": "training", "scenariosPerFamily": 8 } }
  ]
}
```

```bash
npm run research:swarm:sleep -- --queue <promotion-queue> --store <store> \
  --metrics-url http://<qwen>:8000/metrics --standing-orders standing-orders.json \
  --enable-grading --grading-model-ids amos-qwen38-27b-fp8,stage1-r32-s20260903 --daemon
```

## First run log

**2026-09-04, run `stage1-20260904-r2`.** Rank 32, three seeds, 256 training
examples from the explicit-rulebook curriculum. Job one completed in about 40
minutes: training loss fell to zero by epoch three, validation token accuracy
1.0, holdout token accuracy 0.98, adapter reload exact, base bitwise unchanged.

The control arm graded the same day: the production base model passed 48 of 48
explicit-rulebook holdout scenarios on the first attempt. That is the important
result of the run. It says the explicit curriculum has no headroom, not that
the adapter failed. The generator now has an implicit-rulebook mode (see
[CURRICULUM_GENERATOR.md](CURRICULUM_GENERATOR.md)); the next run trains on
implicit scenarios and is graded on the implicit holdout.

Operational lessons folded into the runner: the trainer's boot script runs only
on first boot, so jobs are dispatched over SSM Run Command; SSM's shell on
Ubuntu is dash, so scripts need a bash shebang; the container needs
`TORCH_DISABLE_NATIVE_JIT=1` passed explicitly; EC2 start calls fail in the
post-stop window and during GPU capacity shortages, so the runner waits them
out; adapter weights stay in S3 rather than syncing to the operator's machine;
a finished job is recognized from its S3 result and never retrained.

## What a result means

- **Lift on the holdout pool** means the adapter generalizes to reserved tools
  and revised schemas it never trained on. That is real, and it is still not
  promotion evidence.
- **No lift** is a result too. It says contract discipline from synthetic data
  did not transfer, and the next lever is real episodes, not more epochs.
- Promotion still requires the sealed holdout, the blind frontier comparison,
  and three-seed replication, exactly as the plan states.
