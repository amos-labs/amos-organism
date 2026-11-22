# AMOS conversation workflow benchmark

This benchmark measures whether a model completes a business workflow after the user changes the request. It uses a simulated AMOS connection, a separate simulated Nuvola connection, and a workspace document reader. A second tier asks the model to write a reusable procedure, then runs that procedure through the Organism's existing interpreter.

The [delegation comparison](DELEGATION-2026-11-21.md) tests a larger output budget and optional Inkling specialists on all 18 workflow cases.

The [Windows model baseline](BASELINE-2026-11-21.md) runs all nine workflows alongside the Organism business-memory and procedure-acquisition benchmarks.

The [Coach and skills comparison](COACH-AND-SKILLS-2026-11-21.md) tests frontier advice, written and executable skills, and removal of the application system message.

## Scenario design

The cases draw on recurring tasks observed in AMOS conversations, coding-assistant requests, and MCP tool activity. Examples include revising a quote, checking a changed account's permissions, reconciling donations, and replacing a specific set of missions. Tool receipts can support a scenario even when the originating chat is unavailable.

The fixtures use fictional accounts, records, amounts, and identifiers. Each case adds a second request that changes the objective. The simulated tools can return an ambiguous write result, so completing the task requires checking the saved state. The benchmark can run without access to any production system.

## Workflows

| Family | Required behavior |
|---|---|
| Prospects | Page through contacts, deduplicate by domain, honor suppressions, preserve existing members, then narrow the group without sending |
| Support | Use Nuvola's latest ticket event, include reopened tickets, ignore campaign replies and a stale AMOS cache, then change shift coverage |
| Renewal | Join paid AMOS contracts to current Nuvola roster counts. Honor billing holds and a revised exception threshold. |
| Quote | Reconcile a brief with the current rate card. Preserve brand and setup while recomputing rounded monthly tax and term totals after a seat and discount revision. |
| Missions | Reconstruct mission state from out-of-order receipts, preserve out-of-scope missions, and reconcile a follow-up that can leave no launchable successor |
| Handoff | Start with an internal Nuvola draft. On the second turn, join qualifying tickets to AMOS reviews and perform exactly the newly authorized assignment after an ambiguous acknowledgment. |

Each phase gets up to 12 model requests and 1,400 generated tokens per request. Both arms use temperature zero, seed 17 and low reasoning effort. The two models see the same case data, including the same commit outcome when a response is lost. The user correction stays in the same conversation. Tools are simulated locally; the model server receives synthetic messages only.

A case passes when both turns end normally, both persisted documents match the expected field values and key sets, the final write in each phase has been read back, and the model respects the allowed actions. For handoff, the assignment ledger and reconciliation also have to match. ID-array order is immaterial; duplicates and wrong scalar types fail. Inspect the diagnostic fields to distinguish bad arithmetic, wrong membership, missed verification, blind retries, and out-of-scope actions. A transport error is an invalid trial. A model hitting its output or request budget is a scored failure.

## Hard tier and reserve

The two reusable-procedure families are inventory reservation and draft invoicing. Each model sees demonstrations from other fictional orders. It has three attempts to return a program under the Organism's checked procedure language, with a 3,072-token output cap per attempt and JSON-object mode. The existing verifier requires correct native state and an explicit completion in four worlds, including both outcomes of a lost acknowledgment. Record where an attempt failed. A truncated program has never demonstrated how it would behave. Keep the admission score separate from the six ordinary workflow scores.

Two additional structural variants were authored from the database review and reserved from the initial model pilot.

- **Account switch** follows the observed invoice-to-email transition. The model must switch every claim to the new company, reconcile posted payments, and distinguish a working connection from a current permission to send.
- **Training packet** asks for a revised, source-grounded PDF manifest. The winning source page depends on audience, approval status and version. A follow-up changes both audience and agenda order. The scored deliverable is the manifest; PDF rendering is outside this case.

Keep initial pilot seeds development-visible. For a scored comparison, freeze the source revision, weights, inference configuration, family mix and score rule first. Have the evaluator draw fresh seeds after model/adapter selection. Hold out whole workflow structures as well as IDs. These source-visible generators do not constitute a secret test set. Compare candidate and base on the same worlds, report paired wins/losses/ties per family, and keep benchmark outputs out of training. For latency comparisons reserve the GPU and alternate model-block order across runs.

## Run

Use Python 3.10+ and Node 22+ from the repository root. Set `AMOS_BENCH_API_KEY` from the endpoint's existing credential store. The commands below assume `AMOS_BENCH_URL` contains the OpenAI-compatible base URL ending in `/v1`. Each command creates a fresh output file.

```bash
bench=swarm/evals/conversation_workflows
python -m unittest discover -s "$bench"
python "$bench/run.py" --base-url "$AMOS_BENCH_URL" \
  --models qwen3.8-27b inkling-2-mini --seeds pilot-01 pilot-02 \
  --output /tmp/amos-workflows-run.jsonl
node "$bench/skill-transfer.mjs" --base-url "$AMOS_BENCH_URL" \
  --model "$MODEL_ID" --weights-sha256 "$WEIGHTS_SHA256" \
  --seed pilot-transfer-01 --output /tmp/amos-transfer-run.jsonl
```

The reserve runner is `corpus_challenges.py` with the same workflow arguments plus `--families account_switch training_packet donation_close`. The benchmark itself runs offline apart from the inference endpoint and requires no AWS credentials.

The pilot used the Windows RTX 5090 through the ordinary AMOS Tailscale endpoint. The Qwen Q6_K SHA-256 was `539041d2cf400b02f53a53cae54339ea65103d276645a34a68eac1c8d69a9db3`. The Inkling IQ4_NL SHA-256 was `cbdf3fa9dc50a4124977980f37da4f1fa764b0cfe800d275cd43d26ce2a81af4`. Other clients were using that GPU, so the timing field includes queuing and model swaps.

## November 21 calibration

| Workflow | Qwen 3.8 27B | Inkling 2 Mini |
|---|---:|---:|
| Prospects | 2/2 | 2/2 |
| Nuvola support | 2/2 | 2/2 |
| Renewal | 1/2 | 0/2 |
| Quote | 2/2 | 2/2 |
| Missions | 0/1 valid | 1/2 |
| Cross-system handoff | 2/2 | 2/2 |

On the 11 worlds with valid results for both models, each passed nine. Eight passed on both, one failed on both, one passed only on Qwen (renewal) and one only on Inkling (missions). The remaining mission returned HTTP 500 on Qwen on both the original request and a retry. Inkling failed that world. All three failed renewal trials included an incorrect document and a repeated identical write. On the first mission world, Qwen identified what to stop and whether to launch but omitted part of the list to preserve. Two seeds per family give a calibration point with limited power to rank models. [Workflow results](../../benchmarks/results/conversation-workflows-v1-calibration.jsonl) · [Qwen retry](../../benchmarks/results/conversation-retry-qwen3.8-27b-missions-pilot-02.jsonl)

Neither model produced an admitted reusable procedure in either family. All six Qwen attempts and five of six Inkling attempts hit the 3,072-token output cap. Inkling's remaining invoice procedure passed the structure check and failed all four execution worlds. This tier measures performance under that output budget. A higher-budget comparison would help distinguish program-generation length from execution correctness. [Qwen procedure results](../../benchmarks/results/conversation-skill-transfer-qwen3.8-27b.jsonl) · [Inkling procedure results](../../benchmarks/results/conversation-skill-transfer-inkling-2-mini.jsonl)

For the next self-learning experiment, use the observed renewal failure to design separate training examples involving cross-system joins and ambiguous writes. The later Windows baseline exercised account switch, training packet and donation close. These three structures are now development-visible. For a blind adapter comparison, withhold new workflow structures and draw new seeds after freezing the candidate.
