# Go-live state

What is running, where, and what still needs a human hand. Updated 2026-09-05.

## Live on the research plane (runner host, private)

| Component | Where | Notes |
|---|---|---|
| Sleep-cycle daemon | `amos-sleep-cycle.service` on the runner | Standing orders from `s3://amos-qwen-research-plane-…/sleep/standing-orders.json`: nightly implicit and explicit holdout grading of the production base, nightly implicit training-pool harvest. Ledger and reports under `/var/lib/amos-research/sleep`. Grades only when vLLM has been idle five minutes. |
| Weekly consolidation | `amos-consolidation.timer`, Sundays 03:00 UTC | Compiles the store, checks the gate, trains rank-32 adapters on the disposable trainer over SSM. Excludes stage-zero and explicit stage-one treatments. |
| Platform episode intake | `amos-platform-intake.service`, `http://10.86.0.104:8787/v1/platform/episodes` | Verifies the Platform's KMS signature, mints the host receipt, appends to the organism event chain at `/var/lib/amos-research/organism/platform-events.jsonl`. Health at `/healthz`. |

Identities created for the intake:

- KMS signing key (ECC P-256, SIGN_VERIFY): `arn:aws:kms:us-east-1:637423327454:key/b02b7322-9b96-4472-8a3e-228383f462a0`, alias `alias/amos-organism-episode-signing`. Public key staged at `s3://amos-qwen-research-plane-…/sleep/organism-kms-public-key.der.b64`.
- Bearer secret: `arn:aws:secretsmanager:us-east-1:637423327454:secret:amos-organism/platform-intake-bearer-Qos4RO` (`{"bearer_token": …}`). Until the runner role may read Secrets Manager, the same JSON is staged at `s3://…/sleep/intake-bearer.json`.

End-to-end proof: a fixture episode signed with the real key through `aws kms sign` was accepted (200, verified), redelivered idempotently (200, duplicate), and refused when the body was tampered (401).

## Platform side, to turn the feed on

Set on the Platform task definition:

```
AMOS__ORGANISM__EPISODE_ENDPOINT=http://10.86.0.104:8787/v1/platform/episodes
AMOS__ORGANISM__KMS_KEY_ID=arn:aws:kms:us-east-1:637423327454:key/b02b7322-9b96-4472-8a3e-228383f462a0
AMOS__ORGANISM__BEARER_TOKEN=<value of bearer_token from the secret>
```

The Platform task role needs `kms:Sign` on that key (grant it in the key policy or the role). Network: the research-plane Terraform now opens port 8787 on the runner to `sg-0967e26d543a5ce47` (the Platform ECS task security group) once applied; both VPCs must route to each other, which the inference module already arranges for the Qwen endpoint. Then insert a consent row in `organism_learning_policies` for the first tenant. Until a consent row exists, no episode leaves the Platform.

## Terraform to apply (research plane)

Plan file and variable file are under the session scratchpad; the variable file reproduces the applied values (AMIs, image URIs, contract URI) plus the two new inputs. Expected changes: SSM contract-pointer parameter, runner role statements (image push, intake secret read), intake ingress rule, trainer instance update in place (boot-template no longer forces replacement). Confirm the plan shows no replacement before applying. After applying, delete the temporary inline policy `amos-stage1-trainer-image-push` from the runner role.

## Production inference cell, deliberately not touched

Enabling adapter serving on the live cell restarts vLLM and writes into the pinned model bucket. Both were refused by the permission gate in this session and are the operator's call:

1. Apply the inference module with `enable_lora = true`, `max_lora_rank = 32`, `max_loras = 4`, or run the equivalent unit edit during a maintenance window.
2. Copy the chosen adapter into a prefix the inference role can read (the role reads only `models/Qwen--Qwen3.8-27B-FP8/<revision>/*`), e.g. `…/<revision>/adapters/stage1-implicit-r32-s3/`, then `load-adapter.sh stage1-implicit-r32-s3 <that s3 uri>` on the cell.
3. Add the adapter model id to the sleep daemon's grading list (installer argument six) so base versus adapter is graded nightly on the production cell.
4. Start the swarm gateway with `--shadow-model stage1-implicit-r32-s3 --shadow-trace <path>` so Mission turns record base and adapter answers side by side; the Mission always receives the base answer.

## Adapter governance

Adapters move through `swarm/src/adapterCandidates.js`: trained, frozen holdout, sealed holdout, shadow, canary, promoted. The first three gates are recordable from grading comparisons; canary and promotion require a host receipt. No adapter is promoted today.
