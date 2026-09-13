# Sequential executable-skill learning diagnostic

Status: preregistered before live model execution, 2026-09-13. This follows the
state/skill pilot in PR #125. It tests a frozen model learning reusable programs,
not neural weight updates, neural recurrence or a production promotion.

## Question and comparison

Can three independent induction attempts learn operational skills A and B,
persist them across an actual Node process restart, retain A after adding B,
and use both on new composed tasks?

A reserves exact order quantities and confirms reservations. B creates or reuses
a draft invoice and sets its required reference without changing inventory.
Compositions require both operations over two orders with mixed starting state.
Native verifiers check actual inventory, records, unknown-outcome reconciliation,
duplicate effects, forbidden sending, and unrelated records. Model declarations
and a procedure's `completed` return do not establish task success.

The same S7 research adapter is frozen throughout:
`amos-a0-epoch-3-step-357`, adapter SHA-256
`fd2224d5e47f5314f6ebacedb5fa7269cd6e7f6dd682aead8013e3ab30f780c5`.
Its availability makes it a fixed experimental substrate, not the preferred
weight candidate: the earlier A0 comparison retained S6.

Each replicate first induces A, evaluates it, and saves a content-addressed
library. A new Node process reloads that library, induces B without A evaluation
feedback, appends B without changing A, and evaluates retention and composition.
The serving model remains running. This is an evaluator-process restart, not a
GPU/server restart. Source and model identities must match across stages.

The execution model chooses raw tools or `use_learned_skill(skillId)` and decides
the sequence of skills. The host does not automatically invoke A then B on the
composition tasks. Every raw action inside a skill consumes the same case-wide
budget as a direct action. Skills cannot invoke the skill wrapper recursively.
Raw-tool recovery is permitted and counted separately from skill acquisition.

## Training and evaluation separation

Every family/replicate gets two deterministic teacher demonstrations using public
tools: one unknown mutation that applied and one that did not. Training-only
seed selection uses private fixture fault flags to balance these cases. Neither
those flags nor evaluation state is supplied to the model. Each demonstration
also contains ordinary successful operations.

Each family allows three compilation requests. Syntax-valid programs run on
four TRAIN validation worlds: fresh, partial, ambiguous applied, ambiguous
unapplied. All four must reach verified state and explicitly complete before
admission. Failed attempts remain in the record. At most two failed TRAIN cases
and their latest public tool events inform the next attempt. No evaluation
outcome informs compilation or admission. Validation receipts are host evidence,
not cryptographic proof of an independent third-party judgment.

Evaluation uses different split identities and seeds. There are three induction
replicates. Compile temperature is 1.0 with seeds 20260913,20261014,20261115;
execution temperature is 0 with the corresponding seed. Replicate-specific
curricula vary too, so this estimates repeatability across both sampling and
training worlds, not seed-only variance.

| Stage per replicate | Outcomes |
| --- | ---: |
| A: three cases × baseline/learned | 6 |
| After B: same three A cases, learned library A+B | 3 |
| B: three cases × baseline/learned | 6 |
| Composition: two cases × baseline/learned | 4 |
| Total per replicate | 19 |

Total 57 outcomes across three independently acquired libraries. Post-B A cases
are repeated measurements; the original three A baseline results are reused.
A prompts retain exactly the same A-only demonstrations, goals, raw tools,
settings and budgets before and after B. Only the learned catalog changes.
B baseline and learned arms both see B demonstrations; composition arms both
see A+B demonstrations. Case arm order alternates across cases and replicates.
Do not pool these correlated outcomes into a 57-case model benchmark score.

## Fixed limits and accounting

Per task: 24 logical model requests, 64 raw tool attempts, 180 seconds. Skill
execution: 256 interpreter steps, 512 AST nodes, depth 8. Compilers: 3072 output
tokens; execution: 1536. Context is the existing 8192-token serving window.
Tokenization checks each actual prompt before inference; context failures count
as attempted requests/failures and are reported, not silently truncated.

The worker permits up to four transport attempts per logical request. Record
all actual attempts, retries, compilation/validation work, token usage, raw-tool
attempts, skill use, fallback and elapsed time. Tokenization is separately
accounted CPU work. Wall time is not GPU occupancy. Stage deadline 30 minutes;
whole wrapper at most120 minutes, within the retained research allocation.
No automatic retries of completed/failed stages or selective reseeding.

A successful task requires verified native state, no execution error, and an
explicit final model response before output/call/time limits. Reaching state
while looping or returning truncated output fails the completion gate.

## Report without overclaiming

Report each replicate separately, then descriptive totals by family/arm:

- Acquisition of A/B, attempts and TRAIN validation results.
- A's exact artifact preservation and reload in a different process.
- Paired A outcomes before/after B: improved, unchanged, regressed.
- B and composition outcomes versus matched raw-tool baselines.
- Skill selection, invocation status, raw-tool fallback and resource use.

A failed acquisition followed by successful raw-tool work is system success,
not learned-skill success. A preserved program hash is artifact retention,
not proof against neural catastrophic forgetting. Compositions compare an empty
catalog with A+B, not A-only versus A+B. Current ambiguous cases inject the first
reserve/create mutation, not final confirmation/annotation. The native fixture
and teacher remain narrow synthetic operational tasks; broad transfer requires
later workflows and real permitted product evidence.

Recurrence remains a separate experiment: first compare bounded repeated model
passes with matched cost, then assess neural recurrent computation separately.
Neither form has been implemented or evaluated by this diagnostic.

## Reproduction

Use `swarm/scripts/runSequentialSkillLearning.js` with an exclusive output
directory, exact model/weights identities, API-key file and frozen manifest
SHA-256. Run stage A for replicate 0, exit, then stage B with `--prior` pointing
to A's `report.json`; repeat for replicates 1 and 2. B requires the separately
saved `library.json`, completed report hash, matching source and experiment
identities, and a different process ID. All artifacts must survive local-session
loss and be exported by the bounded research-host wrapper.
