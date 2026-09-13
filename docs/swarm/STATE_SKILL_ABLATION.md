# Persistent state and executable skill diagnostic

This research experiment asks whether a frozen model completes a stateful task
more reliably or cheaply when supplied typed observed state, a compiled reusable
procedure, or both. It is an exploratory synthetic diagnostic, not a production
rollout, qualification panel, weight-learning result or proof of lifelong learning.

| Arm | Public evidence representation | Execution |
| --- | --- | --- |
| A | Complete chronological tool history | Model chooses each step |
| B | Typed observed state, errors and unresolved effects | Model chooses each step |
| C | Same history | Model compiles a reusable procedure, then executes it |
| D | Same typed state | Same compile-and-execute mechanism |

All arms receive the same three independently checked, deterministic development
demonstrations and tool contracts. C/D compile independently before any evaluation
case; one syntax-only correction is allowed. Programs remain frozen throughout the
run. They can return unfamiliar states to the model for bounded repair. Repair
results never change the stored program or enter a later case's context.

The seven sandbox variants exercise new and existing resources, stale observations,
ambiguous writes that applied or did not apply, and a two-page composition. Each
arm receives a freshly constructed private world with the same paired case seed.
No tool can call a customer service. The private verifier checks the actual page
state, resolved effects, no publishing, no unsafe retries and no unrelated changes.
Completion prose and a program's completed return cannot supply verification.

History and typed views use the same public observations, including freshness.
The typed projection does not infer success from requested changes. Unknown effects
invalidate claims about current state until a matching inspection. Historical
observations remain explicitly historical. The diagnostic reports task state
achievement and evidence completeness separately.

The procedure language contains only tool calls, equality branches, bounded loops
and explicit returns. Full validation precedes execution, including unused branches.
There is no JavaScript evaluation, filesystem access or network capability in the
interpreter. The research harness allows 512 AST/value nodes, 128 executed steps
and 32 attempted tools per task. Actual execution and failed proposals count.

## Running

Use the existing research worker against a bare loopback URL; it adds `/v1` paths.
Bind the supplied model alias and weight digest independently to serving evidence.
The probe checks model availability, not tensor identity. The API key is read from
a private file and never written to artifacts.

```sh
node swarm/scripts/runStateSkillAblation.js \
  --base-url http://127.0.0.1:8001 \
  --model VERIFIED_RESEARCH_ALIAS \
  --weights-sha256 VERIFIED_64_CHARACTER_WEIGHT_DIGEST \
  --api-key-file /private/research-api-key \
  --output /research/new-exclusive-run-directory
```

The CLI refuses to reuse an existing output directory. An interruption leaves a
manifest, transport journal and experiment events for reconciliation; it is not
silently resumed or rerun. It is a bounded executor, not a new scheduler. A parent
controller can consume its terminal artifacts. Its default deadline is one hour.

Default primary measurement is 28 case outcomes: seven paired cases across four
arms at temperature zero with thinking disabled. This small panel has no claim to
statistical power or broad generalization. New names alone are not a new domain.
Use fresh held-out workflow structures before claiming learned transfer.

All arms have the same maximum logical request allocation, including compilation:
16 times the number of cases per arm. Each task also has a 16-request and 32-tool
ceiling and a three-minute deadline. Programs can finish using fewer model calls.
The existing worker can make up to four HTTP attempts per logical request. Every
transport attempt is attributed to its case/phase/arm; failed response consumption
leaves compute unknown. The deadline still bounds the whole run.

Report compilation and repair costs, all failed cases, available prompt/output
tokens, transport retries and wall latency. Equal caps are not equal actual GPU
compute; accelerator time is not measured by this runner. More repetitions of
these templates do not substitute for broader tasks or an independent qualification.

## Recurrence remains a separate architecture experiment

The current agent can repeatedly observe, choose, act and reconcile explicit state.
That is recurrence of the execution process. Additional model review passes are
another inference-time intervention. Neither changes the neural architecture.

The earlier recurrent-depth proposal remains active research: a neural block is
trained to iterate internally before decoding, potentially with a learned choice
of iteration count. It requires a compatible trained backbone or an explicit
architecture adaptation; adding a serving flag to the current Qwen checkpoint
does not establish this ability. [Recurrent-depth research](https://arxiv.org/abs/2502.05171)
provides a concrete starting point, not a measured AMOS result.

First isolate state/execution faults with the present diagnostic. Then compare
explicit extra reasoning passes and, in a separate neural prototype, internal
recurrence against competent fixed-compute baselines. Measure actual inference
resources and latency, account for different initial checkpoints and training
budgets, and test any adaptive recurrence policy on unseen tasks. Preserve skill
acquisition, retention and transfer as the shared learning criteria.
