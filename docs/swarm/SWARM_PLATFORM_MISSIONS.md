# Swarm OS as an AMOS Mission worker

Swarm OS can serve as the planning intelligence for checker-native AMOS
Missions without becoming the authority for execution or success. The stable
boundary is deliberately narrow:

```text
AMOS Platform Run Contract
    -> private OpenAI-compatible Swarm gateway
        -> shared Qwen backbone and logical specialists
    <- one canonical MissionPlan JSON object
AMOS Platform validates authority and executes the step
    -> pinned independent checker adapters
    -> immutable verification receipts
    -> explicitly authorized Swarm learning episode
```

This separation is the production harness for the organism. Swarm may propose
`tool`, `checkpoint`, `ask_user`, `verify`, or `fail`; it cannot mint tool
authority, approve its own work, or convert missing verification into success.

## Ownership boundary

The production decomposition is one organism with distinct organs, not two
competing learning systems:

- `amos-managed-platform` owns mission authority, execution, checker truth,
  tenant consent, and terminal outcome receipts.
- Swarm OS owns within-mission cognition: logical specialists, evidence-board
  coordination, mission energy, pheromones, active HRR attention, and prompt
  compilation.
- `amos-organism` owns cross-mission heredity: the canonical genome, gene
  selection rank, expression and outcome history, fitness settlement and
  regression clawback, candidate lineage, promotion, replay, and the durable
  learned HRR world representation.
- AMOS Desktop is a client and optional local Mission worker. It does not mint
  truth, fitness, or learning attestations.
- In Desktop, a hosted Mission is durable background work, not a conversation.
  The Missions control center owns creation, compile progress, Run Contract
  authorization, status, open questions, and controls. Creating a Mission from
  Missions never opens Operator; the compiler run is retained as internal
  evidence hidden from Conversations. A Mission asked for in Operator chat
  leaves exactly one compact receipt (`Mission created: <name> · Waiting for
  approval · View Mission`), and Mission questions surface in a compact
  attention rail beside the composer, never as cards in the transcript.

These components exchange versioned organism contracts. The current Python
Swarm selector is an explicitly provisional research projection of the
organism's lexicographic rank; production expression comes from
`amos-organism`, and Swarm attests only what the host prompt compiler actually
compiled. Transient mission coordination never becomes durable authority.

## Worker protocol

The gateway recognizes only the exact Platform planner envelope
`amos-mission-worker:2026-09-06`. Ordinary chat remains ordinary chat. For a
Mission request it:

1. correlates every private deliberation trace with the mission and immutable
   contract;
2. runs logical specialists over one shared Qwen endpoint;
3. canonicalizes the final response to the Platform's `MissionPlan` schema;
4. performs at most one format-recovery call when the model emits malformed
   JSON, with tools removed so no action can be replayed; and
5. returns only the plan. Platform still validates allowed operations,
   budgets, decisions, checkpoints, and completion.

The `/health` response advertises both the protocol version and the authority
split. Point Platform at the private gateway with:

```text
AMOS__MISSIONS__INTELLIGENCE_BASE_URL=http://<private-swarm-gateway>:18081/v1
AMOS__MISSIONS__INTELLIGENCE_MODEL=amos-qwen38-27b-fp8
```

The gateway must be reachable only from Platform, authenticate every request,
and call the Qwen endpoint over the private VPC path. The no-ingress research
runner remains a queued research and training worker; it is not the production
gateway.

## Checker receipts become organism experience

After a Mission reaches a terminal state, export its `get_mission` result and
the corresponding gateway JSONL traces. A data owner must also provide an
explicit policy; customer data is never silently opted into research or
training.

```json
{
  "sourceClass": "internal-authorized",
  "permittedUses": ["research", "training"],
  "trainingApproved": true,
  "contaminationTags": ["amos-owned-mission"]
}
```

Collect the immutable episode with:

```bash
node swarm/scripts/collectPlatformMissionEpisode.js \
  --mission /secure/get-mission.json \
  --traces /secure/swarm-gateway.jsonl \
  --data-policy /secure/data-policy.json \
  --store /secure/swarm-learning \
  --output /secure/collection-receipt.json
```

Only complete, correctly pinned checker coverage can create a verified pass.
A checker failure creates verified negative experience. Missing, unknown,
under-authority, mismatched, or partial evidence creates an execution-error
episode that is useful for organism policy learning but is ineligible as
positive adapter-training data.

## Harbor's role

Harbor remains an unchanged independent benchmark. It is not the AMOS
production verifier and its missing reward must never be synthesized. A Harbor
run with a qualified candidate-evolution chain but no official reward remains
`official-verifier-coverage-incomplete`. The Platform checker waist lets the
organism learn from real AMOS work while that independent harness problem is
diagnosed separately.

## Rollout gates

1. Merge and deploy the checker-native Platform implementation.
2. Deploy this gateway behind private authenticated networking.
3. Configure Platform's Mission intelligence URL and model.
4. Enable Missions for one AMOS-owned tenant and one bounded, reversible
   pilot Mission.
5. Confirm the gateway emits a contract-correlated trace and Platform accepts
   the canonical plan.
6. Confirm the Platform—not Swarm—executes the action and records pinned
   checker evidence.
7. Collect the terminal Mission into the learning store under an explicit data
   policy and replay it through the organism's normal promotion gates.

Direct Qwen and frontier providers remain valid controls. Swarm becomes a
production intelligence candidate only after it improves verified mission
outcomes without increasing unknown checks, unsafe proposals, cost, or
recovery rate.

### Attributing the served planner input

New gateway traces and shadow records include an `inputEvidence` subrecord
(`schema: "amos.swarm-input-evidence"`, `version: 1`). It contains `stage`,
`compiledInputSha256` and `requestPayloadSha256`. Every stage observation also
contains its own input evidence. The outer trace/shadow schema stays at v1;
older records without this subrecord have unknown input provenance. The existing
`messageDigest` remains the hash of the assistant output, never its input.

`requestPayloadSha256` hashes the parsed JSON actually sent to the backend.
`compiledInputSha256` hashes that same JSON with only `model` removed: messages,
tools, seed, generation settings and all other serialized fields remain bound.
Model identity belongs to the treatment separately. JSON-omitted undefined fields
are omitted here too, and HTTP authorization headers are excluded. No Mission IDs
or prompt content are normalized away to make two inputs compare equal.

The trace's top-level input evidence identifies the request that produced the
served response. Recovery calls and a selected fallback candidate retain their
own identity, including when upstream response IDs repeat or requests interleave.
Shadow mode sends that exact request with the alternate model name; the shadow's
own `inputEvidence` is nested under `shadow`. A failed shadow call records the
attempted request identity. Primary and shadow compiled-input hashes should match;
their full request hashes differ because the model name differs.

These fields are digests, not reconstructible training content or weight-training
permission. Existing tenant-gated answer capture is unchanged. They also do not
attest a model checkpoint, full inference defaults, first-attempt completion or
which proposal Platform accepted. Ingestion still needs the treatment manifest,
host attempt-to-step/receipt binding, complete recovery evidence, and independent
outcomes from each executed arm. Gateway-internal correction stages must be
included when assessing recovery coverage, rather than hidden behind a valid
final response.

The adapter shadow gate now reconstructs its decision from
[paired verified mission comparisons](VERIFIED_MISSION_COMPARISON.md).
Unexecuted alternate answers from the shadow gateway remain diagnostics; they
cannot replace independently executed and checked mission outcomes.
