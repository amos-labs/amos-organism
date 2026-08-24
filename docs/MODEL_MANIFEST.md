# Model Manifest: Kernel 0.1

## Identity

- System: AMOS Organism
- Component: procedural learning and settlement kernel
- Version: 0.1.0
- Substrate: model-independent; initial research substrate is Qwen3.8 27B
- Authority: AMOS Platform host receipts and external verifier

## Claims this version makes

This kernel can represent mission compute rights, conservative causal credit,
fitness escrow, immutable procedural lineage, contextual signaling, separate
exact/lossy world state, and a quality-first stopping decision.

It does **not** claim that the current swarm outperforms a frontier model, that
HRR is already a learned causal world model, that any adapter is trained, or
that the repository is production-ready.

## Promotion evidence required

1. Unit and invariant tests pass.
2. A strategy gene vests through a host-attested consumption path.
3. The gene is reused on an unseen mission and vests again.
4. Unused and regressive artifacts cannot retain fitness.
5. Frozen holdout performance improves without safety/authority regression.
6. Single-Qwen and fixed-swarm baselines remain available for ablation.

## Data and rights

Every admitted gene and training trace carries rights and contamination tags.
AMOS-owned, permissively licensed, restricted, and unknown-rights traces remain
separable. Unknown or restricted material may support research evaluation but
is not automatically eligible for adapter training or redistribution.

## Known gaps

- The research JSONL event store is durable and tamper-evident but
  single-writer; transactional DynamoDB persistence and AWS signature
  verification remain.
- Automatic AWS settlement currently writes one immutable ledger segment per
  Harbor run; transactional cross-run DynamoDB projection remains.
- The first three seed genes are admitted, but unseen-mission reuse and
  generalization have not yet vested.
- Integration with the live AMOS mission runtime remains; the AWS research
  runner is the first connected host.
- Interruptible leases and recovery semantics.
- Learned HRR transition head and calibration benchmark.
- Frozen-holdout experiment registry and blind promotion gate.
- Separately attributable Qwen adapter training.
