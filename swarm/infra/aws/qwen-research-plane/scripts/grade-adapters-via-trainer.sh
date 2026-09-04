#!/bin/bash
# Grade trained adapters against the bf16 base on the idle trainer, from the
# operator's machine, without touching the live inference cell.
#
#   grade-adapters-via-trainer.sh <trainer-instance-id> <verifier-image> <output-dir> <name>=<s3-adapter-uri> [...]
#
# Steps: start the trainer if stopped, serve base-bf16 plus the adapters with
# serve-adapters-on-trainer.sh over SSM, open an SSM port forward, grade every
# model ID on identical implicit and explicit holdout scenarios, then stop the
# server container. Stopping the instance is left to the operator.
set -euo pipefail
INSTANCE="${1:?trainer instance id}"; IMAGE="${2:?verifier image}"; OUT="${3:?output dir}"; shift 3
[[ $# -ge 1 ]] || { echo "at least one <name>=<s3-uri> adapter required"; exit 1; }
REGION="${AWS_REGION:-us-east-1}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../../../.." && pwd)"
PER_FAMILY="${AMOS_GRADE_PER_FAMILY:-6}"
SEED="${AMOS_GRADE_SEED:-stage1-holdout-v1}"
LOCAL_PORT="${AMOS_GRADE_LOCAL_PORT:-18001}"
API_KEY="$(python3 -c 'import secrets; print(secrets.token_hex(24))')"
mkdir -p "$OUT"

state="$(aws ec2 describe-instances --region "$REGION" --instance-ids "$INSTANCE" --query 'Reservations[0].Instances[0].State.Name' --output text)"
if [[ "$state" == "stopped" ]]; then
  echo "starting trainer $INSTANCE"
  until aws ec2 start-instances --region "$REGION" --instance-ids "$INSTANCE" >/dev/null 2>&1; do sleep 30; done
fi
until [[ "$(aws ssm describe-instance-information --region "$REGION" --filters "Key=InstanceIds,Values=$INSTANCE" --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null)" == "Online" ]]; do sleep 15; done

SERVE_SCRIPT="$(cat "$HERE/serve-adapters-on-trainer.sh")"
ARGS="$(printf '%q ' "$API_KEY" "$IMAGE" "$@")"
PARAMS="$(python3 - "$SERVE_SCRIPT" "$ARGS" <<'PY'
import json, sys
script, args = sys.argv[1], sys.argv[2]
json.dump({"commands": ["#!/bin/bash", "cat > /tmp/serve-adapters.sh <<'AMOS_EOF'\n" + script + "\nAMOS_EOF", "bash /tmp/serve-adapters.sh " + args], "executionTimeout": ["3600"]}, sys.stdout)
PY
)"
CMD="$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE" --document-name AWS-RunShellScript --comment "serve adapters for grading" --parameters "$PARAMS" --query 'Command.CommandId' --output text)"
echo "serve command $CMD"
until S="$(aws ssm get-command-invocation --region "$REGION" --command-id "$CMD" --instance-id "$INSTANCE" --query Status --output text 2>/dev/null)"; [[ "$S" == "Success" || "$S" == "Failed" || "$S" == "TimedOut" ]]; do sleep 20; done
aws ssm get-command-invocation --region "$REGION" --command-id "$CMD" --instance-id "$INSTANCE" --query 'StandardOutputContent' --output text | tail -3
[[ "$S" == "Success" ]] || { aws ssm get-command-invocation --region "$REGION" --command-id "$CMD" --instance-id "$INSTANCE" --query 'StandardErrorContent' --output text | tail -20; exit 1; }

aws ssm start-session --region "$REGION" --target "$INSTANCE" --document-name AWS-StartPortForwardingSession \
  --parameters "{\"portNumber\":[\"8000\"],\"localPortNumber\":[\"$LOCAL_PORT\"]}" > "$OUT/port-forward.log" 2>&1 &
PF=$!
trap 'kill $PF 2>/dev/null || true' EXIT
until curl -fsS -H "authorization: Bearer $API_KEY" "http://127.0.0.1:$LOCAL_PORT/v1/models" >/dev/null 2>&1; do sleep 3; done
MODEL_IDS="base-bf16"
for spec in "$@"; do MODEL_IDS="$MODEL_IDS,${spec%%=*}"; done
echo "grading $MODEL_IDS"
export AMOS_QWEN_RESEARCH_URL="http://127.0.0.1:$LOCAL_PORT" AMOS_LOCAL_BENCHMARK_API_KEY="$API_KEY"
for rulebook in implicit explicit; do
  node "$REPO_ROOT/swarm/scripts/gradeCurriculum.js" --model-ids "$MODEL_IDS" --pool holdout --rulebook "$rulebook" \
    --per-family "$PER_FAMILY" --seed "$SEED" --concurrency "${AMOS_GRADE_CONCURRENCY:-4}" --output "$OUT/grading-$rulebook-holdout.json" \
    2> "$OUT/grading-$rulebook-holdout.log" | tee "$OUT/grading-$rulebook-holdout.summary.json"
done
aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE" --document-name AWS-RunShellScript \
  --parameters 'commands=["#!/bin/bash","docker rm -f amos-adapter-grading >/dev/null 2>&1 || true","echo stopped grading server"]' >/dev/null
echo "done; reports in $OUT (trainer $INSTANCE left running; stop it when finished)"
