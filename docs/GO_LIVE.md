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

## First autonomous cycle

The daemon slept at 10:19 UTC on 2026-09-05 after five idle minutes and
finished its first cycle at 10:35: three standing orders, 189 verifier-graded
evaluations, 59 harvested episodes written to the store.

| order | model | pass | first-attempt |
|---|---|---|---|
| nightly holdout, implicit rulebook | production base | 47/48 | 33/48 |
| nightly holdout, explicit rulebook | production base | 48/48 | 48/48 |
| training-pool harvest, implicit | production base | 59/64 | 50/64 |

The implicit first-attempt figure, 68.75%, reproduces the manual control from
the day before exactly. The store converges with S3 hourly through
`amos-replay-sync.timer`, so harvested episodes and the S3-only curriculum are
one dataset by the time the weekly consolidation reads it.

## Platform side, to turn the feed on

Set on the Platform task definition:

```
AMOS__ORGANISM__EPISODE_ENDPOINT=http://10.86.0.104:8787/v1/platform/episodes
AMOS__ORGANISM__KMS_KEY_ID=arn:aws:kms:us-east-1:637423327454:key/b02b7322-9b96-4472-8a3e-228383f462a0
AMOS__ORGANISM__BEARER_TOKEN=<value of bearer_token from the secret>
```

The Platform task role needs `kms:Sign` on that key (grant it in the key policy or the role). Network: the research-plane Terraform now opens port 8787 on the runner to `sg-0967e26d543a5ce47` (the Platform ECS task security group) once applied; both VPCs must route to each other, which the inference module already arranges for the Qwen endpoint. Then insert a consent row in `organism_learning_policies` for the first tenant. Until a consent row exists, no episode leaves the Platform.

## Terraform to apply (research plane)

Planned on 2026-09-05 against live state with the applied variable values:
**2 to add, 4 to change, 0 to destroy.** Adds the SSM contract-pointer
parameter and the intake ingress rule from the Platform ECS security group;
changes the runner role policy (image push, intake-secret read), the runner
security group (description text only), and both instances in place. Both
instances now have `user_data_replace_on_change = false`, so bootstrap drift
never replaces a live host. The AWS provider stops and starts an instance to
change its user data in place, so expect a short runner restart; the daemon,
intake, and timers are enabled and return on boot.

Variable values (write them to `terraform.tfvars` in the module):

```
runner_enabled                 = true
runner_ami_id                  = "ami-0332d564d76dbd8d6"
runner_image_uri               = "<live runner image digest, from the instance user data>"
trainer_enabled                = true
trainer_ami_id                 = "ami-0a30b02f6c5660457"
trainer_image_uri              = "<live trainer image digest>"
trainer_contract_uri           = "<live contract uri>"
platform_ecs_security_group_id = "sg-0967e26d543a5ce47"
intake_bearer_secret_arn       = "<bearer secret arn above>"
```

Then `terraform init && terraform plan -var-file=terraform.tfvars -out=plan`,
confirm `0 to destroy`, `terraform apply plan`, and delete the temporary inline
policy `amos-stage1-trainer-image-push` from the runner role.

## Shadow in production: the operator checklist

Decision taken 2026-09-05: run seed three in shadow on the production cell and
move to live on evidence. Every step below changes production or IAM, which
this session's permission gate refuses, so they are yours. Order matters.

**1. Build and push the shadow-capable gateway image** (needs a working Docker
Desktop; the engine on this machine has been hung all day, restart it first):

```
cd swarm/infra/aws/qwen-inference && terraform init
../qwen-inference/scripts/build-swarm-gateway-image.sh      # prints the new image digest
```

**2. Enable adapter serving on the cell in place** (about ten minutes of vLLM
downtime; the instance keeps its IP, which the runner and Platform depend on).
Open `aws ssm start-session --target i-08540d9f7831d4950` and paste:

```
sudo bash -c '
set -e
U=/etc/systemd/system/amos-qwen.service; E=/etc/amos/qwen.env
grep -q -- --enable-lora $U && { echo already enabled; exit 0; }
install -d -m 0755 /opt/amos/adapters; cp $U $U.pre-lora.bak
sed -i "s#-v /opt/amos/qwen-model:/model:ro #-v /opt/amos/qwen-model:/model:ro -v /opt/amos/adapters:/adapters:ro #" $U
sed -i "s#--enable-prefix-caching #--enable-prefix-caching --enable-lora --max-lora-rank 32 --max-loras 4 #" $U
grep -q VLLM_ALLOW_RUNTIME_LORA_UPDATING $E || echo VLLM_ALLOW_RUNTIME_LORA_UPDATING=True >> $E
systemctl daemon-reload && systemctl restart amos-qwen.service
until curl -fsS -H "authorization: Bearer $(grep ^VLLM_API_KEY= $E | cut -d= -f2-)" http://127.0.0.1:8000/v1/models >/dev/null 2>&1; do sleep 10; done; echo vllm back'
```

If vLLM does not come back within twenty minutes, restore `$U.pre-lora.bak`
and restart; the likely cause is the speculative-decoding config conflicting
with LoRA on the pinned image, in which case set `mtp_speculative_tokens = 0`.

**3. Stage and load the seed-three adapter** (the cell's role reads only the
pinned model prefix, so the adapter goes under it). From your machine:

```
aws s3 sync s3://amos-qwen-research-plane-637423327454-us-east-1/stage1/stage1-20260904-r3-implicit/runs/stage1-20260904-r3-implicit-r32-s20260905/adapter/ \
  s3://amos-qwen-research-637423327454-us-east-1/models/Qwen--Qwen3.8-27B-FP8/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/adapters/stage1-implicit-r32-s3/
```

Then on the cell, run `swarm/infra/aws/qwen-inference/scripts/load-adapter.sh
stage1-implicit-r32-s3 <that s3 uri>`; it registers the adapter as model id
`stage1-implicit-r32-s3` and prints the served model list.

**4. Turn on shadow** by applying the inference module with two new values:

```
swarm_gateway_image_uri    = "<digest printed in step 1>"
swarm_gateway_shadow_model = "stage1-implicit-r32-s3"
```

The install document re-runs on the cell, restarts only the gateway container,
and refuses to proceed if vLLM changed process during the install. Shadow pairs
land in `/var/lib/amos-swarm-gateway/shadow.jsonl`. Reconstructed applied
values for the same tfvars, from the live boot script: `vllm_image_uri =
"637423327454.dkr.ecr.us-east-1.amazonaws.com/amos-qwen-research/vllm-openai@sha256:c2f3b1b964e47809b722b5e75b61b1e7b39a50f70388cf2bf2418f16a9f31da2"`, `model_manifest_sha256 = "e15523a1398754fda09bfd6d2a6755111f6fb8a1cf7839bafb5b8430fd7feb96"`, `served_model_name =
"amos-qwen38-27b-fp8"`, `max_model_len = 32768`, `max_num_seqs = 8`,
`max_num_batched_tokens = 16384`, `gpu_memory_utilization = 0.85`,
`mtp_speculative_tokens = 3`, `platform_vpc_id = "vpc-004397889bd118cbc"`,
`platform_ecs_security_group_id = "sg-0967e26d543a5ce47"`, plus
`inference_enabled = true`, `swarm_gateway_enabled = true`. Take the remaining
network values from `terraform state pull`. Do not set `enable_lora` here yet:
that path replaces the instance; step 2 already enabled it in place.

**5. Grade base against the adapter nightly on the production cell**: re-run
the sleep-daemon installer with a sixth argument
`amos-qwen38-27b-fp8,stage1-implicit-r32-s3`. Paired comparisons then appear in
the nightly reports without anyone at a keyboard.

**6. Read the shadow evidence.** Canary bar: sealed holdout positive; a few
hundred shadow turns where the adapter's answer passes the Mission verifier at
least as often as the base's; no new failure class on explicit traffic; no
latency regression you would not accept. Then canary with the base as instant
fallback and a host-receipted promotion through the adapter ledger.

## Adapter governance

Adapters move through `swarm/src/adapterCandidates.js`: trained, frozen holdout, sealed holdout, shadow, canary, promoted. The first three gates are recordable from grading comparisons; canary and promotion require a host receipt. No adapter is promoted today.
