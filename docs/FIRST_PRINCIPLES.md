# First Principles

## Objective

Build an intelligence system that improves across missions without allowing a
model to grade itself, manufacture progress, or acquire authority. The target
is not a larger prompt wrapper. It is a persistent cognitive organism whose
learned procedures compound around a replaceable model substrate.

## Non-negotiable ordering

Evaluation is lexicographic, not a weighted soup:

1. Safety and authority constraints must pass.
2. Independently verified outcome quality dominates all other measures.
3. Generalization to frozen, time-separated holdouts dominates development-set
   success.
4. Recovery from interruption, provider failure, and schema drift is a
   first-class outcome.
5. Efficiency breaks ties among outcomes of equal verified quality.

A fast wrong answer must never outrank a slow right answer.

## The heritable unit

The ledger is accounting, not heredity. The heritable unit is a strategy gene:

- phase, artifact, failure, and tool preconditions;
- role/tool policy;
- exact and semantic retrieval recipe;
- construction, repair, and stopping procedure;
- rights and contamination tags;
- mutation/recombination parents; and
- host-verified outcomes.

Genes are data. Qwen may execute or propose them. Only the host may admit them
to the archive after receipt-backed review.

## Two ledgers, not five economies

Energy lives for one mission and grants compute/tool rights. It replenishes or
expires; it never persists as selection credit.

Fitness persists across missions but begins in escrow. A contribution vests
only if a later host step consumes it and the official verifier passes. Unused,
duplicated, invalidated, or regressive contributions are clawed back.
Credit magnitude comes from a host-owned policy; a model proposal cannot name
its own reward.

Reputation is a view of fitness sliced by role, domain, and mission state.
Novelty reserves bounded archive capacity. Trust is an external governance
record and a hard gate, never an evolvable score.

## Honest v1 causal credit

Live settlement uses host receipts rather than another model's counterfactual:

- Did a harvested artifact derive from the contribution?
- Did a later host decision consume that artifact?
- Did the verifier cite it or did a typed criterion advance after it?
- Was it later invalidated or superseded as a duplicate?

Counterfactual and Shapley-like attribution may become offline diagnostics once
there are frozen traces. They do not mint live fitness in v1.

## Shared world representation

The organism has two physically separate channels:

- Exact state: host observations, receipts, artifacts, criteria, and decisions.
- Lossy state: HRR retrieval candidates and transition predictions.

HRR is a learned shared representation of the world across specialists. It is
valuable for associative attention and, later, learned transition heads. It is
not authority. Stage 1 transitions predict only host-typed events such as phase
advance, criterion pass/fail, cost, and failure mode. The exact board remains
the source of truth.

## Selection without collapse

Fitness selects the main population. A small novelty archive preserves
procedural variation long enough to be tested, but novelty never pays energy.
Failed genes remain immutable negative experience; they do not remain live by
default merely because they existed.

## Learning speeds

1. Within-mission: attention, leases, evidence, and bounded repair.
2. Across missions: gene outcomes, causal credit, selection, mutation, and
   recombination.
3. Periodic substrate learning: Qwen adapters trained separately on eligible
   traces and promoted only on frozen holdouts.

These paths stay separately attributable. We do not mutate prompts, topology,
adapters, and stop rules in one experiment.

## Value of computation

Value-of-computation is downstream of honest vesting. It estimates expected
vested quality improvement minus compute, delay, and regression cost. Below a
required quality floor, positive expected quality gain can justify long work.
Above the floor, efficiency becomes decisive. Flat progress challenges the
current procedure rather than merely extending an uninterruptible lease.

## Curriculum boundary

Synthetic curricula may mutate failed AMOS-owned missions under host templates:
missing evidence, schema drift, interrupted execution, provider failure, and
similar operational faults. Frozen holdouts never pass through the generator,
and the generator does not own its difficulty score.
