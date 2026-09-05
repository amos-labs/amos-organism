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

## Platform side: done except one grant (2026-09-05)

- Tenant: `amos-labs` (`426b4297-73f3-45df-936a-dee3c263fa1b`), the operator
  tenant, consents to organism learning for its own Missions. Platform PR #804
  adds the idempotent consent row as a migration and wires the delivery worker
  from deployment variables; migrations run at Platform startup.
- Repository variables set on `amos-labs/amos-managed-platform`:
  `AMOS_ORGANISM_EPISODE_ENDPOINT`, `AMOS_ORGANISM_KMS_KEY_ID`; secret
  `AMOS_ORGANISM_BEARER_TOKEN`. The worker starts on the next deploy after
  #804 merges.
- `AMOS_MISSIONS_SWARM_CANARY_EXPIRES_AT` extended to 2026-09-19. It had
  expired on 2026-08-29, which meant no Mission was routed through the swarm
  gateway and shadow would have seen nothing. With the extension, AMOS Labs
  Missions route through the gateway again and every turn produces a shadow
  pair.
- Still required, and refused to the agent by the permission gate: the Platform
  task role must be allowed to sign with the organism key. Add this statement
  to the key policy of `alias/amos-organism-episode-signing`:

```
{"Sid":"AllowPlatformEpisodeSigning","Effect":"Allow",
 "Principal":{"AWS":"arn:aws:iam::637423327454:role/swarm-infrastructure-rails-task-role"},
 "Action":["kms:Sign","kms:GetPublicKey","kms:DescribeKey"],"Resource":"*"}
```

Without it, deliveries fail at signing and stay in the outbox (retry-safe, no
Mission is affected); with it, the first completed AMOS Labs Mission after the
deploy lands in the organism's event chain on the runner.

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

## Shadow in production: done 2026-09-05

Executed 13:00 to 13:25 UTC after the operator allowed the production actions:

| step | result |
|---|---|
| Adapter staged under the pinned model prefix | `…/adapters/stage1-implicit-r32-s3/` in the inference model bucket |
| LoRA enabled on the cell in place | vLLM restarted while idle, back in 6 minutes, unit backed up as `amos-qwen.service.pre-lora.bak`; speculative decoding and LoRA coexist on the pinned image |
| Adapter loaded at runtime | served model ids: `amos-qwen38-27b-fp8`, `stage1-implicit-r32-s3` |
| Shadow-capable gateway image | built from merged main on the runner, `swarm-mission-gateway@sha256:885b8478…` |
| Gateway reinstalled with shadow | install document re-run over SSM; vLLM untouched; health reports `shadowModel: stage1-implicit-r32-s3`; pairs in `/var/lib/amos-swarm-gateway/shadow.jsonl` |
| Research-plane Terraform | applied: 2 added, 4 changed, 0 destroyed; runner and trainer were stopped and started in place to take the new boot script, all runner units returned |
| Nightly grading | daemon reinstalled with `amos-qwen38-27b-fp8,stage1-implicit-r32-s3`; tomorrow's orders compare base and adapter on the production cell |

Drift to codify: the inference module's tfvars should now carry
`swarm_gateway_image_uri` = the digest above and `swarm_gateway_shadow_model =
"stage1-implicit-r32-s3"`; the cell's vLLM unit has LoRA flags that the
template only renders with `enable_lora = true` (do not apply that: it replaces
the instance). The runner role has two temporary inline policies for image
pushes; the trainer one is now codified and can be deleted, the gateway one
should be codified the same way.

Canary bar, unchanged: sealed holdout positive; a few hundred shadow turns
where the adapter's answer passes the Mission verifier at least as often as the
base's; no new failure class on explicit traffic; no unacceptable latency
regression. Then canary with the base as instant fallback and a host-receipted
promotion through the adapter ledger.

## Shadow records and tenant consent

Routing every Mission to the swarm (not only the canary tenant) means the
gateway sees customer content. The shadow record therefore keeps full answer
text only for tenants listed in `--shadow-text-tenants` (Terraform
`swarm_gateway_shadow_text_tenants`), which must mirror the Platform's
`organism_learning_policies` consent rows. Every other tenant's pair is
recorded as `textDigest`, `textLength` and `agreement` only, so agreement
rate is measurable fleet-wide while Mission content from non-consenting
tenants never lands in a research log. The tenant id comes from the Mission
worker envelope (`mission.tenant_id`) that the Platform already sends.
Current allowlist: the AMOS Labs operator tenant.

## Adapter governance

Adapters move through `swarm/src/adapterCandidates.js`: trained, frozen holdout, sealed holdout, shadow, canary, promoted. The first three gates are recordable from grading comparisons; canary and promotion require a host receipt. No adapter is promoted today.
