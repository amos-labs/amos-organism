# Sequential skill learning: completed diagnostic, 2026-09-13

The frozen model completed the workflows through raw tools, but acquired **0/6
skills** across three independent learning replicates. This run shows no benefit
from skill learning and cannot establish retention of an acquired skill.

## Results

| Workflow | Raw-tool baseline | Learning-attempt arm | After learning B |
| --- | ---: | ---: | ---: |
| Reserve orders (A) | 9/9 | 9/9 | 9/9 |
| Prepare draft invoices (B) | 9/9 | 9/9 | — |
| Compose reservation + invoicing | 6/6 | 6/6 | — |

These are 57 recorded outcomes, including nine repeated A measurements and
reused A baselines. All six libraries stayed empty; the learning-attempt arm
therefore also used raw tools. No learned skill was invoked. The three
replicates each completed their 19 outcomes, but these correlated cases are not
a 57-case general model benchmark or evidence of improvement.

## Acquisition failure

All 18 allowed compiler requests were attempted:

- 15 returned malformed JSON, independently confirmed by parsing the original
  model text.
- One returned JSON with an invalid instruction shape (`steps[1].return`).
- Two produced valid instruction structures but failed immediately on unbound
  variables (`vars.order.orderId` and `vars.item.orderId`). Each failed all four
  native TRAIN validations before executing a tool.

No candidate reached admission. The grader did not treat successful raw-tool
fallback as successful learning. Actual separate A/B processes reloaded the
persisted snapshots, but those snapshots were empty. Acquired-skill persistence
is covered by integration tests; this live run supplies no such evidence.

## Evidence and limits

The run used frozen source `9a1b7d9b8cee954b1b40793b228beea7da021f13`, from
21:16:53.720 to 21:32:59.366 UTC (16 minutes, 6 seconds). The model and research
serving container stayed unchanged. Adapter identity:
`fd2224d5e47f5314f6ebacedb5fa7269cd6e7f6dd682aead8013e3ab30f780c5`
(`amos-a0-epoch-3-step-357`). This remains the fixed S7 research substrate;
this diagnostic does not supersede the earlier A0 comparison that retained S6.

Independent replay matched all 348 evaluation tool responses and all 57 complete
native verifier records, with zero integrity discrepancies. It also reproduced
the two programs' eight TRAIN validation failures, checked source/model hashes,
all process-reload receipts, paired inputs, empty libraries and compiler errors.

Cost: 18 compilation requests + 405 execution requests; 1,797,011 prompt tokens
and 32,366 output tokens. Every request has observed usage. There were no
inference retries, HTTP errors, tokenizer rejections or prompt-token count
mismatches. Peak prompt size was 6,456 tokens, within the existing 8,192-token
window with its reserved output allowance. Elapsed time is not GPU occupancy or
a cloud bill. The research GPU remains retained under its existing week budget.

Validation before dispatch: full repository checks passed (681 passed, one
skipped, no failures), and all 59 focused tests passed on the actual research
Node runtime. Eight additional durable CLI tests were added after source freeze;
they do not change the frozen executable, curriculum or scoring. All endpoints
in those CLI tests are mocked.

## Decision

Keep this as a negative acquisition result. Do not infer that program memory,
retention, neural recurrence or the broader architecture cannot work: the
experiment stopped being informative about those downstream claims when no
skill was acquired. The successful raw-tool baseline also leaves no measured
accuracy headroom on these particular tasks.

The next isolated compiler comparison should change only output serialization:
JSON-constrained versus free-form generation, with the same model, TRAIN data,
validation and budgets. A passing JSON object would still have to pass
instruction and native-effect checks. If admission remains poor, separately test
repair with the previous candidate and TRAIN feedback. Do not bundle new
weights, a different language, larger budgets and different prompts into one
uninterpretable change.

Repeated candidate correction would be recurrence across inference calls.
Neural recurrence remains a separate architecture experiment. No neural weights,
production serving, customer records or live product configuration changed here.
