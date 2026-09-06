#!/bin/bash
# Independent stop for a serving-qualification run. Installed on the runner as a
# transient systemd timer BEFORE the trainer is started; fires at the deadline +
# 5 min regardless of the controller, mailbox or any session. Every AWS call is
# bounded; a failed or unknown instance-state read still leads to a bounded stop
# attempt on this exact dedicated trainer, and the receipt records what was known.
# Env: RUN_ID (required), TRAINER (default the research-plane trainer), S3_PREFIX
# (receipt destination), AWS_REGION_OVERRIDE (tests), AMOS_SQ_RUNNER_ENV (tests).
set -u
[ -n "${RUN_ID:-}" ] || { echo "RUN_ID must be set"; exit 2; }
ENV_FILE="${AMOS_SQ_RUNNER_ENV:-/etc/amos-research-runner.env}"
[ -f "$ENV_FILE" ] && source "$ENV_FILE"
REGION="${AWS_REGION_OVERRIDE:-${AMOS_AWS_REGION:-us-east-1}}"
TRAINER="${TRAINER:-i-0d4ab3ea27f5443ad}"
BUCKET="${AMOS_RESEARCH_ARTIFACT_BUCKET:-amos-qwen-research-plane-637423327454-us-east-1}"
S3_PREFIX="${S3_PREFIX:-s3://$BUCKET/stage1/stage1-2026-09-060408/serving-qualification/$RUN_ID}"
RECEIPT_DIR="${RECEIPT_DIR:-/var/lib/amos-research/sleep/serving-qualification}"
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

STATE=$(timeout -k 5 45 aws ec2 describe-instances --region "$REGION" --instance-ids "$TRAINER" --query 'Reservations[0].Instances[0].State.Name' --output text 2>/dev/null)
STATE_RC=$?
case "$STATE" in running|pending|stopping|stopped|shutting-down|terminated) ;; *) STATE="unknown" ;; esac
[ "$STATE_RC" = 0 ] || STATE="unknown"

ACTION=left-alone
if [ "$STATE" != stopped ] && [ "$STATE" != stopping ] && [ "$STATE" != shutting-down ] && [ "$STATE" != terminated ]; then
  # running, pending or unknown: attempt a bounded stop, three tries.
  ACTION=stop-failed
  for attempt in 1 2 3; do
    if timeout -k 5 45 aws ec2 stop-instances --region "$REGION" --instance-ids "$TRAINER" >/dev/null 2>&1; then ACTION=stop-requested; break; fi
    sleep "${STOP_RETRY_SLEEP:-20}"
  done
fi
mkdir -p "$RECEIPT_DIR"
RECEIPT="$RECEIPT_DIR/$RUN_ID-deadline-$(date -u +%Y%m%dT%H%M%SZ).json"
echo "{\"schema\":\"amos.serving-qualification-deadline-receipt\",\"version\":2,\"runId\":\"$RUN_ID\",\"at\":\"$(now)\",\"trainer\":\"$TRAINER\",\"trainerState\":\"$STATE\",\"stateReadExit\":$STATE_RC,\"action\":\"$ACTION\"}" > "$RECEIPT"
timeout -k 5 60 aws s3 cp "$RECEIPT" "$S3_PREFIX/$(basename "$RECEIPT")" --region "$REGION" --only-show-errors || echo "receipt upload failed: $RECEIPT" >&2
logger -t amos-sq-deadline "$RUN_ID trainer=$STATE/$ACTION receipt=$RECEIPT" 2>/dev/null || true
echo "sq-runner-stop: run=$RUN_ID state=$STATE action=$ACTION receipt=$RECEIPT"
[ "$ACTION" != stop-failed ]
