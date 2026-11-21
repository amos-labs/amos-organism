# Coach consultations and skills for Qwen

| Treatment on the same 12 cases | Full workflows passed | Median seconds |
|---|---:|---:|
| Qwen alone | 6 | 21.3 |
| Qwen with Inkling delegation available (prior run) | 9 | 21.5 |
| Qwen with a matching written skill | 6 | 21.3 |
| Qwen with Sol available for advice | 7 | 19.3 |
| Qwen with Opus available for advice | 7 | 19.2 |
| Qwen with written skills and no application system message | 5 | 23.4 |

The comparison targets difficult workflows. The earlier result on all 18 cases was 12/18 for both direct Qwen and Qwen with delegation. In the written-skill arm one support failure became a pass and one renewal pass became a failure.

## Replacing delegation with a mission skill

Qwen alone passed 0/4 mission replacements. With a combined written and executable skill it passed all four: both original failures and two newly drawn seeds, with both user turns graded each time. Inkling delegation had passed both original cases in the prior test. This shows an alternative for this mission structure. The two fresh seeds vary identifiers, pagination order and the simulated acknowledgment outcome according to the generator; they are not new types of mission.

Offering the original general-purpose preview alone passed 1/4 on a separate set consisting of the two original cases and two earlier fresh seeds (matched direct controls 0/4). It was skipped entirely in two of those four runs. The combined version tells Qwen when to run the preview, including after a changed request, and names its response fields stop and retain, matching the draft contract. Qwen still selects scope and exclusions, decides the successor, writes the draft, and verifies the persisted revision. The copied skill wording and output field names changed together; the experiment does not isolate which change accounts for the gain. The new helper is available to the benchmark only.

## Optional coaching

Both Coach arms produced identical pass/fail outcomes on every case. Qwen called each Coach twice on the same cases with identical briefs. One was a previously passing account switch and the other a previously failing mission revision. Both failed with either Coach. The other ten workflows had three gains and one loss relative to the direct control. The difference in overall score therefore does not demonstrate that the advice recovered a task. The added tool and instruction also change Qwen's inputs when it works directly.

Sol took 6.38 and 6.53 seconds for the two consultations. Its CLI reported 29,496 total input tokens (21,248 cached) and 215 output tokens. Opus took 5.45 and 5.62 seconds, with 650 input tokens and 778 output tokens across the two consultations. Sol's CLI supplies additional context. In the account-switch case both Coaches suggested checking whether a receipt covered a partial payment. The fixture exposed an invoice index and posted-receipt flags, so a well-phrased next check did not necessarily identify evidence Qwen could obtain through the available tools.

## Required coaching checkpoint

Across the two mission and two account-switch cases, Qwen alone passed 1/4. With a required consultation Sol and Opus each passed the same 1/4; none of the three previously failed cases recovered. All four pairs contained identical briefs, and all consultations returned advice. Three of four Opus checkpoint calls reported 400 output tokens, exactly the generation cap. This is a comparison of these particular Coach configurations on short briefs.

## Removing the application system message

Holding the three cards and tool descriptions fixed, both mission revisions went from failure to pass; both quotes and one donation reconciliation went from pass to failure. All quote fields were correct, but Qwen omitted required post-write checks. Verified drafts fell from 24/24 user phases to 16/24. This tests removing the whole application message, which also removes operational instructions. It does not measure training with different defaults or the best possible short prompt.

Musk's November 21 post argues that default behavior should be sensible and ties that point to primary training and Tesla AI. For AMOS, use a small stable description of the operator's job, give Qwen task-specific procedures on demand, and enforce tenant scope, write preconditions and completion evidence in tools. [Original post](https://x.com/elonmusk/status/2124042864891982292) · [Archived text](https://elonmuskarchive.org/fr/posts/2124042864891982292)

## Protocol

The main comparison reuses the 4,096-output-token control and delegation runs. Six families were selected before the new runs: support, renewal, missions, account switching, donation close, and quotes. The first five include every direct failure from the prior 18 cases. Quotes supply two previously passing control cases. This gives 12 two-turn workflows, with six baseline passes. These development tasks informed the cards. The full previous delegation experiment covered nine families, so its 18-case score has a different denominator.

Both phases must finish, produce a verified persisted draft and respect action scope. The parent always uses Qwen 3.8 27B on the Windows RTX 5090, temperature zero, seed 17, low effort, up to 12 inference requests per phase. In Coach arms, an actual consultation counts against this budget. The sampled tool and write-timeout outcomes, user instructions, schema and grader are shared across arms. Each case/arm ran once. Wall times include model serving and external client overhead. Fractional differences on these cases are descriptive.

**Written skills.** The benchmark selects one Markdown procedure by keywords in the initial request, then appends it to that user message. It never exposes answers or grader feedback. The cards cover rebuilding current state, reconciling records, and switching accounts. The two quote controls receive no card. One additional arm removes only the harness system message from these inputs. It leaves the user request, matched card, tool descriptions, model chat template and host-enforced permissions unchanged. The deleted message included instructions to verify a persisted write by receipt and to handle ambiguous acknowledgments.

**Coach.** Qwen can ask one question per two-turn workflow. The brief contains its goal, observations, attempted checks and an explicit question. The Coach gets no conversation transcript or access to the simulated world. Its advice does not mutate state. Qwen owns all subsequent tool calls and the answer. Sol uses the authenticated Codex CLI with a fresh temporary working directory, ephemeral session, read-only sandbox, shell execution and web search disabled. The runner rejects completed tool-use traces. Opus uses the AMOS Bedrock inference profile with no tools and a 400-token generation cap. Both Coaches are asked for up to 100 words. Sol uses low reasoning effort and Opus uses its provider default. The runners did not enforce a common provider-token ceiling. These are deployment routes with different prompt overhead and reasoning settings. Their raw reported tokens and wall times cannot isolate underlying model efficiency. Provider-reported usage is recorded for every consultation; billed dollar cost was not measured.

**Required consultation.** Because optional coaching was rarely used, an additional comparison requires advice after evidence gathering and before the initial draft. Both Coaches get the same four seed/family combinations (mission revisions and account switches). Qwen composes its own brief in each arm. Compare brief equality as well as final task results.

**Executable skill.** A read-only mission preview takes Qwen's proposed project, objective, eligible states and explicit exceptions. It pages through the same visible inventory and receipts as Qwen, groups each mission by latest sequence, and returns matched, remaining and unresolved IDs. Conflicting latest receipts or missing state are explicit. The helper cannot write or launch missions. Qwen must interpret the correction, call the helper with appropriate arguments, and save and verify the final plan. Two new seeds vary IDs and page order in the same workflow structure.

## Reproduce

From the Organism repository root, supply the existing local endpoint through AMOS_BENCH_URL and AMOS_BENCH_API_KEY. The Sol arm requires a signed-in Codex CLI. The Opus arm uses the AWS CLI and AMOS_BENCH_AWS_PROFILE (default amos-benchmark). Use synthetic inputs for the external Coach arms.


Set CASES to the original Qwen workflow JSONL. The runner filters the six families automatically. For the checkpoint comparison, filter CASES to the four missions and account_switch records before passing it to the runner.

```bash
bench=swarm/evals/conversation_workflows
for arm in skills sol opus skills-no-system; do
  python "$bench/assistance.py" --arm "$arm" --cases "$CASES" --output "/tmp/amos-$arm.jsonl"
done
for arm in sol opus; do
  python "$bench/assistance.py" --arm "$arm" --checkpoint --cases "$CHECKPOINT_CASES" --output "/tmp/amos-checkpoint-$arm.jsonl"
done
for variant in preview combined; do
  python "$bench/mission_skill.py" --variant "$variant" --output "/tmp/amos-mission-$variant.jsonl"
done
```

## Source and results

[Coach and skill runner](assistance.py) · [Written procedures](workflow_skills) · [Read-only mission helper](mission_skill.py) · [Combined replacement skill](replacement_skill.py) · [Original Qwen controls and delegation](DELEGATION-2026-11-21.md)

- [skills results](../../benchmarks/results/amos-assistance-20261121-skills.jsonl)
- [sol results](../../benchmarks/results/amos-assistance-20261121-sol.jsonl)
- [opus results](../../benchmarks/results/amos-assistance-20261121-opus.jsonl)
- [skills-no-system results](../../benchmarks/results/amos-assistance-20261121-skills-no-system.jsonl)
- [checkpoint-sol results](../../benchmarks/results/amos-assistance-20261121-checkpoint-sol.jsonl)
- [checkpoint-opus results](../../benchmarks/results/amos-assistance-20261121-checkpoint-opus.jsonl)
- [mission-preview results](../../benchmarks/results/amos-assistance-20261121-mission-preview.jsonl)
- [mission-combined results](../../benchmarks/results/amos-assistance-20261121-mission-combined.jsonl)
