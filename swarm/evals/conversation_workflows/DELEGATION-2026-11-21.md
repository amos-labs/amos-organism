# Does delegating AMOS workflows to Inkling improve Qwen?

Qwen alone passed 12/18 at a 4,096-token cap. Qwen with optional Inkling delegation also passed 12/18. The routed setup gained three cases and lost three. Both mission replacement cases switched from fail to pass. Two seeds per family support a narrowly scoped trial; they do not establish a general routing advantage.

| Workflow | Qwen at 1,400 | Qwen at 4,096 | Qwen with delegation at 4,096 | Cases with a handoff |
|---|---:|---:|---:|---:|
| Prospect groups | 0/2 | 2/2 | 2/2 | 2 |
| Nuvola support queues | 1/2 | 1/2 | 1/2 | 2 |
| Renewals | 2/2 | 1/2 | 2/2 | 0 |
| Quotes | 2/2 | 2/2 | 2/2 | 0 |
| Mission replacement | 0/2 | 0/2 | 2/2 | 2 |
| Cross-system ticket handoffs | 2/2 | 2/2 | 1/2 | 2 |
| Account switching | 1/2 | 1/2 | 1/2 | 0 |
| Training packets | 2/2 | 2/2 | 0/2 | 0 |
| Donation reconciliation | 0/2 | 1/2 | 1/2 | 0 |
| **Total** | **10/18** | **12/18** | **12/18** | **8** |

## What changed

- Raising the cap recovered three of four originally truncated cases: both prospect lists and one donation close. The support case completed at the larger cap but its first queue was wrong. One previously successful renewal failed in the new run. None of the 18 direct cases hit the larger cap.
- Qwen actually delegated on eight cases. Within that subset the pass count went from 5/8 to 6/8; median end-to-end time for the same eight cases went from 23.9 to 65.9 seconds. Across all 18 cases median time was 22.1 seconds direct and 22.5 seconds with the option to delegate. The other ten cases had a direct score of 7/10 and a routed score of 6/10 even though Qwen handled them itself. These included the new renewal pass and both lost training packets.
- On both mission seeds Qwen delegated the initial plan to AMOS operations and completed the follow-up directly. The resulting stop and retain lists passed both turns. Prospecting scored 2/2 either way at the higher cap.
- The Nuvola role invoked Inkling on both support queues and both cross-system handoffs. In one queue revision and one handoff revision the draft fields matched and the assignment check passed, but the parent ran out of shared requests before its closing response. The handoff cost a previously passing case. Across all families, first-turn passes rose from 12 to 14 while follow-up passes fell from 14 to 13.

## Recommended specialist to trial

**Mission Revision Planner** would be a narrowly scoped AMOS Labs specialist backed by Inkling. Use it when a user asks to revise, pause, or replace a set of existing missions under a project and objective. Its input is the requested scope, proposed change, and any explicit exceptions. It reads the mission inventory and latest status receipts, then produces a draft listing IDs to stop, IDs to retain, the proposed successor, and the conditions for proceeding. It returns the saved revision and evidence to Qwen. Conflicting receipts, unclear scope, or an unverified prior operation are reasons to return the ambiguity to Qwen. Cancellation, launch, and customer communication remain outside its authority. A fresh-seed test of this narrower definition should precede automatic routing.

Keep Qwen on direct prospecting at the larger budget and on cross-system ticket assignments. The Nuvola triage profile remains a candidate for a user-selected support expert. This run did not show a gain from automatically delegating its queue workflows. The research procedure author has a separate native verifier and should remain distinct from production operations.

## Tested role definitions

| Candidate | When Qwen can call it | Tools and authority | What the specialist returns |
|---|---|---|---|
| AMOS operations (`amos_ops`) | Create or revise a prospect group, or draft a replacement plan for missions in a specified project. | Reads AMOS and workspace resources. Can save and verify a shared draft. Customer outreach, launch and cancellation are outside these draft tasks. | A scoped result identifying membership or mission changes, the saved revision or supporting receipt, and any unresolved item. Qwen owns any cross-service join. |
| Nuvola support triage (`nuvola_triage`) | Rebuild the current support queue, change shift coverage, or complete an authorized ticket handoff. | Reads Nuvola and workspace resources. Can save and verify the draft. The assignment and ledger tools appear only in the handoff fixture. User-granted scope determines which assignment can pass. | The qualifying and reopened ticket IDs, latest-event evidence, any verified assignment and any AMOS review still needed. |

The specialist sees the user requests up to that point and Qwen's scoped assignment. It receives a fresh message history for each handoff, can inspect the shared workspace, and returns a report. Qwen receives the report and owns the final response. Both models work on the same simulated draft and action ledger. The grader checks final state and both conversational phases, so a handoff report claiming success does not earn credit by itself. As in the direct baseline, the grader checks the persisted document and authorized effects; it does not independently grade the wording of the parent’s final message.

## Protocol and interpretation

Both treatments used the same two baseline seeds across nine families and the same simulated timeout outcomes. Qwen alone uses the ordinary workflow runner. In the routed treatment, Qwen can do all work directly or call either specialist on Inkling. It chooses freely on each user turn. Qwen sees a short orchestration instruction and one additional tool. Those changes are part of the treatment, including on cases where no handoff occurs. The test exercises the inline handoff pattern on the real model endpoint in a synthetic workspace. It does not run a live desktop session or contact tenant tools.

A phase allows 12 inference requests shared between models, including the parent's routing and integration turns. A running specialist leaves one turn for the parent. Both models have a 4,096-token completion limit per request, temperature zero, sampling seed 17 and low reasoning effort. The model IDs are checked on every response. Durations include tool calls, queuing and any model loading on the shared endpoint. The direct and routed measurements were taken in separate blocks. They measure experienced latency in this run without isolating swap time.

The role descriptions were informed by the preceding baseline on these families. This is a paired development comparison. The experiment measures giving Qwen a delegation option and does not independently identify the effects of the role prompt, extra tool, model choice, or delegation itself.

## How this maps to the existing agents

The coding harness defines eight built-in roles. Its default profile on this machine resolves to Qwen 3.8 27B. The four saved session configurations inspected had no custom agent definitions or per-agent model overrides.

| Existing role | Boundary relevant to this experiment |
|---|---|
| Orchestrator | Own the user request and correction, select a specialist when appropriate, integrate cross-system evidence, and return the final result. |
| AMOS Labs | Handles a wide range of AMOS operations. The `amos_ops` profile evaluates a narrower prospect-group and mission-planning assignment. Billing, quotes and broad AMOS administration were outside its description. |
| Nuvola | Handles multiple Nuvola domains. The `nuvola_triage` profile evaluates only support queues, shift changes and authorized ticket handoffs. Contract-to-roster renewal stays with the orchestrator or a finance-capable role. |
| Planner | Plans scoped project work. These cases provide no model comparison for code planning. |
| Coding | Implements scoped repository changes. No coding tasks were graded here. |
| Reviewer | Checks patches and evidence. The workflow grader did not evaluate code-review ability. |
| Omarchy | Desktop inspection and user-authorized desktop operations. No desktop-action comparison was run. |
| Mail | Mailbox operations with local authorization. None of these workflows tested either model against the Mail role. |

The previously tested procedure author is a separate research role in the Organism. Its output is a candidate procedure plus verifier results. Scope it to synthetic demonstrations and require all native checks to pass before admitting a candidate. Its reservation result does not qualify it to execute production finance, mail or support actions.

## Reproduction and evidence

[Earlier baseline](BASELINE-2026-11-21.md) · [Four original truncations rerun at 4,096](../../benchmarks/results/amos-budget-4096-20261121-qwen3.8-27b.jsonl) · [Remaining 14 direct controls](../../benchmarks/results/amos-delegation-4096-solo-remaining-20261121.jsonl) · [All 18 routed cases, tool calls and specialist reports](../../benchmarks/results/amos-delegation-4096-routed-20261121.jsonl) · [Runner and role definitions](delegation.py)

From the Organism root, with the local endpoint and its credential supplied in the environment:

```bash
bench=swarm/evals/conversation_workflows
cases=swarm/benchmarks/results/amos-baseline-20261121-workflows-qwen3.8-27b.jsonl
for arm in solo routed; do
  python "$bench/delegation.py" --base-url "$AMOS_BENCH_URL" --cases "$cases" --arm "$arm" --output "/tmp/delegation-$arm.jsonl"
done
```
