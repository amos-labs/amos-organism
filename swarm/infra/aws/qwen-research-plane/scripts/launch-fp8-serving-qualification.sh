#!/bin/bash
# Dispatch procedure for the isolated FP8 serving qualification.
#   preflight <launch-env.json> [--now EPOCH]   render-only: verifies the pinned controller and stop
#                                               script bytes, the complete launch environment, and
#                                               renders every SSM payload; no AWS call, no compute.
#   dispatch  <launch-env.json>                 preflight, then: upload controller → install and VERIFY
#                                               the runner stop timer (future trigger) → IAM check →
#                                               start trainer → wait for SSM (abort + stop on failure)
#                                               → run the controller from its verified S3 copy.
# Fixed order; nothing interactive. Codex findings 20260906T195329Z folded in.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
CONTROLLER="${SQ_CONTROLLER_PATH:-$HERE/grade-fp8-serving-qualification.sh}"
STOP_SCRIPT="${SQ_STOP_SCRIPT_PATH:-$HERE/sq-runner-stop.sh}"
REGION=us-east-1; RUNNER=i-08ed5227ea48bad2a; TRAINER=i-0d4ab3ea27f5443ad
BUCKET="amos-qwen-research-plane-637423327454-us-east-1"
TRAINER_ROLE="amos-qwen-research-plane-trainer"; TRAINER_POLICY="amos-qwen-research-plane-trainer"
VLLM_REPO_ARN_FRAGMENT="repository/amos-qwen-research/vllm-openai"
REQUIRED_ENV="SRC_URI SRC_SHA_EXPECTED SRC_REVISION ADAPTER_ID ADAPTER_URI ADAPTER_SHA_EXPECTED ADAPTER_CONFIG_SHA_EXPECTED MODEL_MANIFEST_SHA_EXPECTED SERVED_MANIFEST_SHA_EXPECTED EXPECTED_WEIGHT_MANIFEST_SHA PROTOCOL_DIGEST PRIMARY_SET"
RUN_MINUTES=100; STOP_MINUTES=105; MIN_TIMER_LEAD_MINUTES=60
fail() { echo "PREFLIGHT FAIL: $*" >&2; exit 1; }
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -c1-64; else shasum -a 256 "$1" | cut -c1-64; fi; }
iso() { date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }
cal() { date -u -r "$1" "+%Y-%m-%d %H:%M:%S" 2>/dev/null || date -u -d "@$1" "+%Y-%m-%d %H:%M:%S"; }

# A trigger is usable only if it lies far enough in the future for the run itself.
sq_timer_is_future() { local trigger_epoch="$1" now_epoch="$2"; [ $(( trigger_epoch - now_epoch )) -ge $(( MIN_TIMER_LEAD_MINUTES * 60 )) ]; }

preflight() {
  local env_json="$1" now_epoch="$2"
  [ -f "$CONTROLLER" ] || fail "controller not found at $CONTROLLER"
  [ -f "$STOP_SCRIPT" ] || fail "stop script not found at $STOP_SCRIPT"
  [ -n "${SQ_CONTROLLER_SHA_EXPECTED:-}" ] || fail "SQ_CONTROLLER_SHA_EXPECTED must be set (reviewed controller sha256)"
  [ -n "${SQ_STOP_SCRIPT_SHA_EXPECTED:-}" ] || fail "SQ_STOP_SCRIPT_SHA_EXPECTED must be set (reviewed stop script sha256)"
  CONTROLLER_SHA=$(sha "$CONTROLLER"); STOP_SHA=$(sha "$STOP_SCRIPT")
  [ "$CONTROLLER_SHA" = "$SQ_CONTROLLER_SHA_EXPECTED" ] || fail "controller sha $CONTROLLER_SHA != reviewed $SQ_CONTROLLER_SHA_EXPECTED"
  [ "$STOP_SHA" = "$SQ_STOP_SCRIPT_SHA_EXPECTED" ] || fail "stop script sha $STOP_SHA != reviewed $SQ_STOP_SCRIPT_SHA_EXPECTED"
  bash -n "$CONTROLLER" || fail "controller does not parse"
  [ -f "$env_json" ] || fail "launch env $env_json not found"
  for k in $REQUIRED_ENV; do
    v=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],""))' "$env_json" "$k") || fail "launch env unreadable"
    [ -n "$v" ] || fail "launch env lacks $k"
    case "$v" in "<"*) fail "launch env $k is an unfilled placeholder: $v";; esac
  done
  RUN_ID="sq-fp8-s5-$(date -u -r "$now_epoch" +%Y%m%dT%H%MZ 2>/dev/null || date -u -d "@$now_epoch" +%Y%m%dT%H%MZ)"
  DEADLINE_EPOCH=$(( now_epoch + RUN_MINUTES * 60 )); DEADLINE_UTC=$(iso "$DEADLINE_EPOCH")
  STOP_EPOCH=$(( now_epoch + STOP_MINUTES * 60 )); STOP_AT=$(cal "$STOP_EPOCH")
  OUT_DIR="${SQ_RENDER_DIR:-$HERE/../rendered}/$RUN_ID"; mkdir -p "$OUT_DIR"
  CONTROLLER_S3="s3://$BUCKET/build/grade-fp8-serving-qualification-${CONTROLLER_SHA:0:12}.sh"
  UNIT="amos-sq-deadline-$RUN_ID"
  # Runner stop-timer payload: install the script, start a transient timer, print the unit's next trigger as epoch.
  python3 - "$STOP_SCRIPT" "$RUN_ID" "$STOP_AT" "$UNIT" "$STOP_SHA" > "$OUT_DIR/runner-stop-timer.params.json" <<'PY' || fail "could not render the stop-timer payload"
import json,sys
script=open(sys.argv[1]).read(); run_id, stop_at, unit, sha = sys.argv[2:6]
cmds=[f"cat > /usr/local/bin/{unit} <<'STOPEOF'\n{script}\nSTOPEOF",
      f"echo '{sha}  /usr/local/bin/{unit}' | sha256sum -c --quiet - || (echo 'stop script sha mismatch' && exit 1)",
      f"chmod 0755 /usr/local/bin/{unit}",
      f"systemd-run --unit={unit} --on-calendar='{stop_at} UTC' --timer-property=AccuracySec=30s --setenv=RUN_ID={run_id} /usr/local/bin/{unit}",
      f"date -u -d \"$(systemctl show {unit}.timer -p NextElapseUSecRealtime --value)\" +%s"]
json.dump({"commands": cmds}, sys.stdout)
PY
  # Trainer controller payload: fetch the pinned controller from S3, verify its sha, run it detached with the pinned environment.
  python3 - "$env_json" "$RUN_ID" "$DEADLINE_UTC" "$CONTROLLER_S3" "$CONTROLLER_SHA" > "$OUT_DIR/trainer-controller.params.json" <<'PY' || fail "could not render the controller payload"
import json,sys,shlex
env=json.load(open(sys.argv[1])); run_id, deadline, s3, sha = sys.argv[2:6]
env["RUN_ID"]=run_id; env["DEADLINE_UTC"]=deadline
exports=" ".join(f"{k}={shlex.quote(str(v))}" for k,v in env.items())
cmds=[f"aws s3 cp {s3} /root/grade-fp8-serving-qualification.sh --only-show-errors",
      f"echo '{sha}  /root/grade-fp8-serving-qualification.sh' | sha256sum -c --quiet - || (echo 'controller sha mismatch' && exit 1)",
      "chmod 0755 /root/grade-fp8-serving-qualification.sh",
      f"cd /root && env {exports} nohup /root/grade-fp8-serving-qualification.sh > /root/sq-controller-{run_id}.log 2>&1 &",
      "sleep 2; pgrep -f grade-fp8-serving-qualification.sh >/dev/null && echo dispatched || (echo 'controller did not start' && exit 1)"]
json.dump({"commands": cmds}, sys.stdout)
PY
  for f in runner-stop-timer.params.json trainer-controller.params.json; do
    python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["commands"]; assert sum(len(c) for c in d["commands"]) < 60000' "$OUT_DIR/$f" || fail "$f invalid or too large for SSM"
  done
  python3 - "$OUT_DIR/preflight.json" "$RUN_ID" "$DEADLINE_UTC" "$STOP_AT" "$CONTROLLER_SHA" "$STOP_SHA" "$CONTROLLER_S3" "$UNIT" "$(iso "$now_epoch")" <<'PY'
import json,sys
out,run_id,deadline,stop_at,csha,ssha,cs3,unit,now=sys.argv[1:10]
json.dump({"schema":"amos.serving-qualification-preflight","version":1,"renderedAt":now,"runId":run_id,"deadlineUtc":deadline,"runnerStopAtUtc":stop_at,"controllerSha256":csha,"controllerS3":cs3,"stopScriptSha256":ssha,"stopTimerUnit":unit,"payloads":["runner-stop-timer.params.json","trainer-controller.params.json"]},open(out,"w"),indent=2)
PY
  echo "PREFLIGHT OK run=$RUN_ID deadline=$DEADLINE_UTC runner-stop=$STOP_AT UTC controller=$CONTROLLER_SHA stop=$STOP_SHA rendered=$OUT_DIR"
}

ssm_run() { # ssm_run <instance> <params-file> <comment> <wait-seconds> -> prints stdout, returns 0 only on Success
  local inst="$1" params="$2" comment="$3" wait="$4" cid status
  cid=$(timeout -k 5 60 aws ssm send-command --region $REGION --instance-ids "$inst" --document-name AWS-RunShellScript --comment "$comment" --parameters "file://$params" --timeout-seconds 600 --query 'Command.CommandId' --output text) || return 1
  for _ in $(seq 1 $(( wait / 5 ))); do
    sleep 5
    status=$(timeout -k 5 30 aws ssm get-command-invocation --region $REGION --command-id "$cid" --instance-id "$inst" --query 'Status' --output text 2>/dev/null)
    case "$status" in Success) timeout -k 5 30 aws ssm get-command-invocation --region $REGION --command-id "$cid" --instance-id "$inst" --query 'StandardOutputContent' --output text; return 0;; Failed|Cancelled|TimedOut) timeout -k 5 30 aws ssm get-command-invocation --region $REGION --command-id "$cid" --instance-id "$inst" --query '[StandardOutputContent,StandardErrorContent]' --output text >&2; return 1;; esac
  done
  return 1
}

dispatch() {
  local env_json="$1"; local now_epoch; now_epoch=$(date -u +%s)
  preflight "$env_json" "$now_epoch"
  # 1. Controller to S3 by content hash (idempotent).
  timeout -k 5 120 aws s3 cp "$CONTROLLER" "$CONTROLLER_S3" --only-show-errors || fail "controller upload failed"
  # 2. Runner stop timer: install, then require a future trigger with enough lead; otherwise refuse before any compute.
  local trigger; trigger=$(ssm_run $RUNNER "$OUT_DIR/runner-stop-timer.params.json" "sq stop timer $RUN_ID" 90 | tail -1 | tr -dc '0-9')
  [ -n "$trigger" ] || fail "stop timer not installed/verified on the runner; nothing started"
  sq_timer_is_future "$trigger" "$(date -u +%s)" || fail "stop timer trigger $(iso "$trigger") is not far enough in the future; nothing started"
  echo "runner stop timer $UNIT verified: fires $(iso "$trigger")"
  # 3. IAM prerequisite, programmatic.
  timeout -k 5 60 aws iam get-role-policy --role-name "$TRAINER_ROLE" --policy-name "$TRAINER_POLICY" --output json | grep -q "$VLLM_REPO_ARN_FRAGMENT" || fail "trainer role lacks the production vLLM image pull; run the targeted terraform apply first"
  # 4. Trainer start and SSM online; failure aborts and requests a stop.
  timeout -k 5 60 aws ec2 start-instances --region $REGION --instance-ids $TRAINER >/dev/null || fail "trainer start failed"
  local online=0
  for _ in $(seq 1 48); do
    sleep 10
    timeout -k 5 30 aws ssm describe-instance-information --region $REGION --filters Key=InstanceIds,Values=$TRAINER --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null | grep -q Online && { online=1; break; }
  done
  if [ "$online" != 1 ]; then timeout -k 5 60 aws ec2 stop-instances --region $REGION --instance-ids $TRAINER >/dev/null 2>&1; fail "trainer never came online over SSM; stop requested"; fi
  # 5. Controller from its verified S3 copy.
  ssm_run $TRAINER "$OUT_DIR/trainer-controller.params.json" "sq controller $RUN_ID" 120 | tail -1 | grep -q dispatched || { timeout -k 5 60 aws ec2 stop-instances --region $REGION --instance-ids $TRAINER >/dev/null 2>&1; fail "controller did not start; stop requested"; }
  echo "{\"runId\":\"$RUN_ID\",\"dispatchedAt\":\"$(iso "$(date -u +%s)")\",\"deadlineUtc\":\"$DEADLINE_UTC\",\"runnerStopTrigger\":\"$(iso "$trigger")\",\"controllerSha256\":\"$CONTROLLER_SHA\",\"controllerS3\":\"$CONTROLLER_S3\"}" | tee "$OUT_DIR/dispatch-receipt.json"
  timeout -k 5 60 aws s3 cp "$OUT_DIR/dispatch-receipt.json" "s3://$BUCKET/stage1/stage1-2026-09-060408/serving-qualification/$RUN_ID/dispatch-receipt.json" --only-show-errors || echo "dispatch receipt upload failed" >&2
  echo "DISPATCHED $RUN_ID"
}

if [ "${AMOS_SQ_LIBRARY_ONLY:-0}" != 1 ]; then
  case "${1:-}" in
    preflight) now_epoch=$(date -u +%s); [ "${3:-}" = "--now" ] && now_epoch="$4"; preflight "${2:?launch env json}" "$now_epoch" ;;
    dispatch) dispatch "${2:?launch env json}" ;;
    *) echo "usage: $0 preflight|dispatch <launch-env.json> [--now EPOCH]"; exit 2 ;;
  esac
fi
