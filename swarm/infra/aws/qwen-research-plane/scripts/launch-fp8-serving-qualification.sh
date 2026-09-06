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
EXPECTED_ACCOUNT=637423327454
TIMEOUT_BIN="${TIMEOUT_BIN:-timeout}"
fail() { echo "PREFLIGHT FAIL: $*" >&2; exit 1; }
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -c1-64; else shasum -a 256 "$1" | cut -c1-64; fi; }
iso() { date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }
cal() { date -u -r "$1" "+%Y-%m-%d %H:%M:%S" 2>/dev/null || date -u -d "@$1" "+%Y-%m-%d %H:%M:%S"; }

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
script=open(sys.argv[1]).read().rstrip("\n"); run_id, stop_at, unit, sha = sys.argv[2:6]
# The heredoc re-adds the final newline, so the installed bytes equal the reviewed file exactly.
# SSM joins the commands into ONE shell script: the first line makes every later failure fatal
# for the parent shell (AWS reports the script's exit status). No `|| (…; exit 1)` subshells.
cmds=[# SSM executes the joined commands with /bin/sh (dash on Ubuntu); re-exec under bash before bash-only options.
      "[ -n \"${BASH_VERSION:-}\" ] || exec /bin/bash \"$0\" \"$@\"",
      "set -euo pipefail",
      # Any stop timer left by an aborted earlier dispatch would fire into this run: stop it first.
      "for u in $(systemctl list-units --all --plain --no-legend 'amos-sq-deadline-*.timer' | awk '{print $1}'); do systemctl stop \"$u\" || true; echo \"STALE_TIMER_STOPPED $u\"; done",
      f"cat > /usr/local/bin/{unit} <<'STOPEOF'\n{script}\nSTOPEOF",
      f"echo '{sha}  /usr/local/bin/{unit}' | sha256sum -c --quiet - || {{ echo 'STOP_SCRIPT_SHA_MISMATCH'; exit 21; }}",
      f"chmod 0755 /usr/local/bin/{unit}",
      f"systemd-run --unit={unit} --on-calendar='{stop_at} UTC' --timer-property=AccuracySec=30s --setenv=RUN_ID={run_id} /usr/local/bin/{unit}",
      f"state=$(systemctl is-active {unit}.timer || true); [ \"$state\" = active ] || {{ echo \"TIMER_NOT_ACTIVE $state\"; exit 22; }}",
      f"next=$(date -u -d \"$(systemctl show {unit}.timer -p NextElapseUSecRealtime --value)\" +%s) || {{ echo TIMER_NO_TRIGGER; exit 23; }}",
      "echo \"TIMER_OK $next\""]
json.dump({"commands": cmds}, sys.stdout)
PY
  # Trainer controller payload: fetch the pinned controller from S3, verify its sha, run it detached with the pinned environment.
  python3 - "$env_json" "$RUN_ID" "$DEADLINE_UTC" "$CONTROLLER_S3" "$CONTROLLER_SHA" > "$OUT_DIR/trainer-controller.params.json" <<'PY' || fail "could not render the controller payload"
import json,sys,shlex
env=json.load(open(sys.argv[1])); run_id, deadline, s3, sha = sys.argv[2:6]
env["RUN_ID"]=run_id; env["DEADLINE_UTC"]=deadline
exports=" ".join(f"{k}={shlex.quote(str(v))}" for k,v in env.items())
cmds=["[ -n \"${BASH_VERSION:-}\" ] || exec /bin/bash \"$0\" \"$@\"",
      "set -euo pipefail",
      f"aws s3 cp {s3} /root/grade-fp8-serving-qualification.sh --only-show-errors",
      f"echo '{sha}  /root/grade-fp8-serving-qualification.sh' | sha256sum -c --quiet - || {{ echo CONTROLLER_SHA_MISMATCH; exit 31; }}",
      "chmod 0755 /root/grade-fp8-serving-qualification.sh",
      f"cd /root && env {exports} setsid nohup /root/grade-fp8-serving-qualification.sh > /root/sq-controller-{run_id}.log 2>&1 & echo $! > /root/sq-controller-{run_id}.pid",
      f"sleep 3; pid=$(cat /root/sq-controller-{run_id}.pid); kill -0 \"$pid\" || {{ echo CONTROLLER_NOT_RUNNING; tail -20 /root/sq-controller-{run_id}.log; exit 32; }}",
      f"echo \"STARTED pid=$pid\""]
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

# ssm_run <instance> <params-file> <comment> <wait-seconds> <out-file>
# Returns 0 only when SSM reports Success; stdout goes to <out-file>, never mixed with status.
ssm_run() {
  local inst="$1" params="$2" comment="$3" wait="$4" out="$5" cid status
  cid=$($TIMEOUT_BIN -k 5 60 aws ssm send-command --region $REGION --instance-ids "$inst" --document-name AWS-RunShellScript --comment "$comment" --parameters "file://$params" --timeout-seconds 600 --query 'Command.CommandId' --output text) || return 1
  [ -n "$cid" ] || return 1
  for _ in $(seq 1 $(( wait / 5 ))); do
    sleep 5
    status=$($TIMEOUT_BIN -k 5 30 aws ssm get-command-invocation --region $REGION --command-id "$cid" --instance-id "$inst" --query 'Status' --output text 2>/dev/null)
    case "$status" in
      Success) $TIMEOUT_BIN -k 5 30 aws ssm get-command-invocation --region $REGION --command-id "$cid" --instance-id "$inst" --query 'StandardOutputContent' --output text > "$out" || return 1; return 0 ;;
      Failed|Cancelled|TimedOut|Cancelling) $TIMEOUT_BIN -k 5 30 aws ssm get-command-invocation --region $REGION --command-id "$cid" --instance-id "$inst" --query '[Status,StandardOutputContent,StandardErrorContent]' --output text > "$out" 2>&1; echo "ssm $comment: $status" >&2; return 1 ;;
    esac
  done
  echo "ssm $comment: still ${status:-unknown} after ${wait}s" >&2
  return 1
}

# Dispatch-host readiness: GNU timeout and a working AWS CLI bound to the research account.
sq_host_ready() {
  TIMEOUT_BIN=$(command -v gtimeout || command -v timeout || true)
  [ -n "$TIMEOUT_BIN" ] && "$TIMEOUT_BIN" --version 2>/dev/null | grep -q "GNU coreutils" || { echo "dispatch host lacks GNU timeout (gtimeout/timeout)" >&2; return 1; }
  aws --version >/dev/null 2>&1 || { echo "aws CLI not working on the dispatch host" >&2; return 1; }
  local acct; acct=$("$TIMEOUT_BIN" -k 5 30 aws sts get-caller-identity --query Account --output text 2>/dev/null) || { echo "aws identity check failed" >&2; return 1; }
  [ "$acct" = "$EXPECTED_ACCOUNT" ] || { echo "aws identity is account $acct, expected $EXPECTED_ACCOUNT" >&2; return 1; }
  return 0
}

# Timer trigger must be a 10-digit epoch inside [now+60 min, now+STOP_MINUTES+10 min]: not stale, not runaway.
sq_timer_trigger_ok() {
  local trigger="$1" now="$2"
  case "$trigger" in ''|*[!0-9]*) return 1;; esac
  [ "${#trigger}" = 10 ] || return 1
  [ $(( trigger - now )) -ge $(( MIN_TIMER_LEAD_MINUTES * 60 )) ] || return 1
  [ $(( trigger - now )) -le $(( (STOP_MINUTES + 10) * 60 )) ] || return 1
  return 0
}

dispatch() {
  local env_json="$1"; local now_epoch; now_epoch=$(date -u +%s)
  sq_host_ready || fail "dispatch host not ready; nothing started"
  preflight "$env_json" "$now_epoch"
  local aws="$TIMEOUT_BIN -k 5 60 aws"
  # 1. Controller to S3 by content hash (idempotent), then read back and compare.
  $aws s3 cp "$CONTROLLER" "$CONTROLLER_S3" --only-show-errors || fail "controller upload failed"
  $aws s3 cp "$CONTROLLER_S3" "$OUT_DIR/controller.readback" --only-show-errors || fail "controller readback failed"
  [ "$(sha "$OUT_DIR/controller.readback")" = "$CONTROLLER_SHA" ] || fail "controller in S3 does not match the reviewed sha"
  # 2. Runner stop timer: SSM status first, then the exact TIMER_OK line, then the trigger window.
  ssm_run $RUNNER "$OUT_DIR/runner-stop-timer.params.json" "sq stop timer $RUN_ID" 90 "$OUT_DIR/timer.out" || fail "stop timer install did not succeed on the runner (see $OUT_DIR/timer.out); nothing started"
  local trigger; trigger=$(grep -E '^TIMER_OK [0-9]{10}$' "$OUT_DIR/timer.out" | tail -1 | cut -d' ' -f2)
  [ -n "$trigger" ] || fail "runner did not report TIMER_OK with a trigger epoch; nothing started"
  sq_timer_trigger_ok "$trigger" "$(date -u +%s)" || fail "stop timer trigger $(iso "$trigger") is outside the accepted window; nothing started"
  echo "runner stop timer $UNIT active; fires $(iso "$trigger")"
  # 3. IAM prerequisite, programmatic.
  $aws iam get-role-policy --role-name "$TRAINER_ROLE" --policy-name "$TRAINER_POLICY" --output json > "$OUT_DIR/trainer-policy.json" || fail "could not read the trainer role policy"
  grep -q "$VLLM_REPO_ARN_FRAGMENT" "$OUT_DIR/trainer-policy.json" || fail "trainer role lacks the production vLLM image pull; run the targeted terraform apply first"
  # 4. Trainer start and SSM online; failure aborts and requests a stop.
  $aws ec2 start-instances --region $REGION --instance-ids $TRAINER >/dev/null || fail "trainer start failed"
  local online=0
  for _ in $(seq 1 48); do
    sleep 10
    [ "$($TIMEOUT_BIN -k 5 30 aws ssm describe-instance-information --region $REGION --filters Key=InstanceIds,Values=$TRAINER --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null)" = Online ] && { online=1; break; }
  done
  if [ "$online" != 1 ]; then $aws ec2 stop-instances --region $REGION --instance-ids $TRAINER >/dev/null 2>&1; fail "trainer never came online over SSM; stop requested"; fi
  # 5. Controller from its verified S3 copy; the payload's own STARTED line (recorded PID) is the only accepted proof.
  if ! ssm_run $TRAINER "$OUT_DIR/trainer-controller.params.json" "sq controller $RUN_ID" 120 "$OUT_DIR/controller.out"; then
    $aws ec2 stop-instances --region $REGION --instance-ids $TRAINER >/dev/null 2>&1; fail "controller command failed on the trainer (see $OUT_DIR/controller.out); stop requested"
  fi
  local pid; pid=$(grep -E '^STARTED pid=[0-9]+$' "$OUT_DIR/controller.out" | tail -1 | cut -d= -f2)
  [ -n "$pid" ] || { $aws ec2 stop-instances --region $REGION --instance-ids $TRAINER >/dev/null 2>&1; fail "controller did not report a running PID; stop requested"; }
  echo "{\"runId\":\"$RUN_ID\",\"dispatchedAt\":\"$(iso "$(date -u +%s)")\",\"deadlineUtc\":\"$DEADLINE_UTC\",\"runnerStopTrigger\":\"$(iso "$trigger")\",\"controllerSha256\":\"$CONTROLLER_SHA\",\"controllerS3\":\"$CONTROLLER_S3\",\"controllerPid\":$pid}" | tee "$OUT_DIR/dispatch-receipt.json"
  $aws s3 cp "$OUT_DIR/dispatch-receipt.json" "s3://$BUCKET/stage1/stage1-2026-09-060408/serving-qualification/$RUN_ID/dispatch-receipt.json" --only-show-errors || echo "dispatch receipt upload failed" >&2
  echo "DISPATCHED $RUN_ID pid=$pid"
}

if [ "${AMOS_SQ_LIBRARY_ONLY:-0}" != 1 ]; then
  case "${1:-}" in
    preflight) now_epoch=$(date -u +%s); [ "${3:-}" = "--now" ] && now_epoch="$4"; preflight "${2:?launch env json}" "$now_epoch" ;;
    dispatch) dispatch "${2:?launch env json}" ;;
    *) echo "usage: $0 preflight|dispatch <launch-env.json> [--now EPOCH]"; exit 2 ;;
  esac
fi
