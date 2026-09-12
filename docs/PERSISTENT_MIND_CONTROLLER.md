# Persistent AMOS mind: implementation plan

September 11, 2026. Working implementation plan; the canonical cross-team status remains `coordination/AMOS_SELF_LEARNING_MODEL_PLAN.md`.

## Objective

Build an enduring learning service that observes its work, maintains an evidence-linked model of its capabilities, chooses useful work or practice, learns from outcomes and resumes after interruption. Discrete training runs become activities within this lifecycle. The service must eventually improve its own learning choices, as measured against a fixed curriculum with equal total compute.

Functional self-monitoring is an engineering target. This plan makes no claim of subjective consciousness or a demonstrated improving autonomous mind.

## Existing foundations and the missing connection

The Organism already has an append-only event store, mission energy, verified fitness, procedure lineage, candidate selection and sleep-cycle executors. Keep those responsibilities. The existing energy ledger grants bounded work capacity; it is not a learned drive. The existing fitness ledger records verified contributions; it does not directly update a learning policy.

The new controller owns the lifecycle and its derived capability state. Platform owns authoritative outcomes and permitted content. Organism's established executors own model calls, curriculum construction and training. The independent evaluator owns advancement criteria. Desktop later presents current work, evidence, decisions and resource use.

## Implementation sequence

| Slice | Concrete behavior | Acceptance evidence |
| --- | --- | --- |
| 1. Persistent lifecycle, starting now | Import bounded aggregate observations; derive capability records; select an unprocessed weakness; record a structured reflection; resume without duplicating work | Actual CLI process, durable replay, contradictory-input rejection, single-writer protection, same evidence processed once across restart |
| 2. Existing executor connection | Translate controller work into existing sleep-cycle/standing-order executors; persist dispatch identity and reconcile receipts before retry | One real permitted development task completes through the existing executor and survives interruption without duplicate spend |
| 3. Model-driven reflection | Supply verified capability state and recent outcomes to the hosted model; request a typed hypothesis, predicted benefit and bounded next action | Unsupported reflections remain hypotheses; tool execution and later results determine whether predictions helped |
| 4. Continuous development and consolidation | Generate/check practice material, store eligible trajectories, update procedures and train candidate checkpoints through the existing parent-continuation path | Durable collect → practice → train → validate → retain/reject cycle runs without a human advancing ordinary stages |
| 5. Learned learning policy | Train selection of practice, tools and experiments from delayed verified improvement | Adaptive selector beats a fixed selector on fresh transfer tasks at equal total training and inference cost |
| 6. Population and cooperative specialists | Retain complementary capabilities and a bounded exploration allocation; use pheromones for shared opportunities, not proof | Multiple cycles preserve retention and improve useful task coverage; contributions and costs are attributable |

The S7 regression is the first diagnostic assignment, not a new training corpus. Its aggregate result can inform the weakness map. Its consumed qualification cases and answers remain excluded from practice and fresh qualification.

## First implementation boundary

`PersistentLearningController` uses the existing `EventStore` contract. Its observations are operator-imported aggregate records identifying model, family, cohort, partition, counts and an evidence digest. A digest identifies evidence; it does not authenticate a verdict. This initial import interface is a trusted-operator boundary, not a public ingestion API or a replacement for Platform attestation.

The capability state retains separate cohorts and model identities. A new model version does not inherit an older version's measured score merely because it inherited weights. Missing evidence stays unknown. The first reflection policy is deterministic and explicitly labeled as such: it identifies a recorded weakness and prepares a development investigation. It is not LLM introspection, learned motivation, weight training, a fitness award or a quality improvement.

The CLI rereads its operator input while running, appends new observations and reflections, and waits when no new work exists. Waiting preserves the mind's state. It does not repeatedly manufacture reflections from unchanged evidence. Local process locking protects the single-writer file journal. Service deployment must keep exactly one writer per state directory; multi-host leases require a transactional backend before scale-out.

The authoritative journal and derived snapshots are separate. A restart reconstructs state from the journal. For the initial CPU reflection, stable action identity makes replay idempotent. Future external executors require explicit submitted/running/reconciling/completed states and idempotency keys; a crash after dispatch must reconcile the existing job rather than blindly repeat a model call or training launch.

Automatic lock recovery applies only to a positively dead process on the same host. Remote, unknown, half-written or interrupted-reclamation locks require operator inspection. A truncated authoritative journal also fails closed for inspection; it is not silently repaired. A missing or corrupted derived snapshot can be rebuilt from the valid journal.

### Run the first slice locally

From this repository, run the synthetic example in a new, dedicated state directory:

```sh
npm run organism:mind -- --state-dir "$PWD/.local-mind-example" --observations "$PWD/research/persistent-mind/example-observations.json" --once
```

Repeat the command to verify that the same evidence creates no duplicate work. Omit `--once` to stay running, reread the input every 15 seconds and process one pending reflection per tick. Stop with Ctrl-C. This command runs locally; it does not create an AWS service.

`events.jsonl` is the authoritative event journal; `snapshot.json` contains its head digest, capability records and completed reflections. `controller.json` marks the directory as dedicated to this controller. Do not point the command at an existing kernel or sleep-cycle state directory. The example observations are synthetic, including their evidence digest. Real inputs require the actual source artifact digest and an explicit development or qualification partition.

## Always-on execution

The target is one service on an AWS CPU runner with durable storage, independent of a laptop session. It observes incoming outcomes and dispatches useful work to an allocated research GPU. It uses quiet periods for development, calibration and consolidation when eligible work and resources exist. Waiting for evidence or a resource does not erase its commitments or history.

Do not install a second daemon beside the existing sleep daemon to compete for the same GPU. Integrate the lifecycle above those executors, with one resource owner, an aggregate budget and completion receipts. Keep production serving separate from research training. The initial CPU-only source is not a claim that an AWS service is installed or a GPU is active.

Rick explicitly chose to review this controller before setting the ongoing research budget. Cloud activation therefore follows a concrete review containing the host, service/image identity, storage, model endpoints, resource cap, shutdown behavior and deployment owner. That is one activation decision; ordinary authorized work inside that envelope must not require repeated human approvals.

## Learning and energy

Each action should eventually predict expected task improvement, uncertainty reduction, cost and retention risk. Compare predictions with later observed outcomes to calibrate the self-model. Pheromones may highlight opportunities and failures, but authoritative task evidence controls rewards. Reward verified useful contribution, including cooperative handoff and useful falsification of a hypothesis.

A learned policy needs training examples of state → chosen action → delayed outcome, not merely a displayed energy balance. Practice success is not enough: measure improved performance on separate development transfer tasks, then qualify final candidates independently. Charge reflection and selection overhead alongside training and inference. Retain quality and retention constraints before optimizing speed.

## Protected exploration time

Rick wants some freedom to choose activity because it may improve ingenuity, problem solving and learning. Useful performance on the assigned job remains the primary objective; personality development is not an optimization target. Reserve a configurable exploration share of the future standing budget; the share and budget are not yet set. During this time the agent may propose questions, pursue small private experiments, compare explanations, create artifacts or follow a promising curiosity without an immediate commercial objective. Pending commitments and service targets take priority; exploration must yield when they need its resources.

Track questions, chosen projects, predictions, findings and unfinished threads across restarts. Exploration can succeed by discovering a useful pattern, disproving a conjecture, building a reusable method or clarifying uncertainty. Do not force it to fabricate a business justification or keep generating text merely to stay busy. Idle waiting remains legitimate when no worthwhile action is available.

Exploration uses its allocated workspace and resources; it does not acquire new access, spend outside the standing envelope, or initiate customer-facing actions by treating curiosity as authorization. Hypotheses and stylistic preferences remain distinct from verified company facts and learned capabilities. Persistent behavioral preferences are observable personality-like traits, not evidence of subjective feelings or consciousness.

Treat the benefit of freedom as a testable hypothesis. Compare an exploration allocation with a job-focused baseline at equal total compute, measuring fresh task completion, retention, cost and useful solution diversity. Individual explorations need not demonstrate immediate payoff; evaluate their delayed contribution across multiple cycles. Reduce or revise the allocation if it consumes resources without improving useful performance. Do not reward self-description, novelty alone or an entertaining persona as a substitute for solving the job.

Rick also suggested earning free time as a reward. One experimental policy is a small baseline exploration allowance plus additional discretionary capacity earned from independently verified contribution. Retain baseline practice so weaker specialists are not starved of opportunities to improve. Additional capacity comes from the existing total resource envelope and cannot displace urgent commitments. Use later verified outcomes, including useful discoveries and cooperative contributions, rather than self-reported success or raw activity counts. Compare this earned allowance against a fixed exploration share before adopting it. Allocating access to exploration is an observable policy; it does not establish that the model intrinsically values free time, and it is not a trained incentive until the action/outcome learning policy is connected.

This first source slice records deterministic reflections only. Self-chosen, model-driven exploration belongs to the executor/policy slices and must be identified honestly when it is actually connected. Its discoveries enter the same evidence and learning path as ordinary work, with unused or unverified artifacts receiving no automatic fitness.

## Next training experiment

Keep the accepted S7 diagnostic design: start from S6, first hold the recipe and curriculum fixed while saving intermediate checkpoints; then vary learning rate separately. Curriculum balance, calendar coverage, independent-task diversity and replay weighting remain distinct treatments. Predeclare executable development metrics and checkpoint selection rules. Development tuning scores do not become independent confirmation.

The controller should progressively own this process, beginning with the evidence and next-action lifecycle. Its first version must not pretend that choosing a deterministic reflection has trained the model to learn autonomously.

## Team handoff

- Codex: lifecycle/controller, capability-state contract, Desktop visibility and independent comparator.
- Organism: existing sleep/execution adapters, curriculum, training and research host operations; retain current producer and checkpoint work.
- Platform: verified outcome feed, tenant/content permissions and later product events.
- Rick: review the first working slice and set the standing resource envelope before cloud activation.

Initial source acceptance requires focused persistence/CLI tests plus the repository checks. No production changes or autonomous promotion are part of this first PR.
