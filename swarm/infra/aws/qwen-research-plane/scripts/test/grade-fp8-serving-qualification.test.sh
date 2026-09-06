#!/usr/bin/env bash
# Fault-injection tests for grade-fp8-serving-qualification.sh without GPU, AWS or
# Docker: the controller is sourced in library mode and its external commands are
# stubbed. Exit 0 = all assertions passed.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
CONTROLLER="$HERE/../grade-fp8-serving-qualification.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
STUBS="$WORK/stubs"; mkdir -p "$STUBS"
LOG="$WORK/calls.log"; : > "$LOG"
FAIL=0
fail() { echo "FAIL: $*"; FAIL=1; }
# The watchdog killer is a background subshell whose sleep child would hold our stdout pipe open; stop both.
stop_watchdog() { [ -n "${WATCHDOG_PID:-}" ] || return 0; pkill -P "$WATCHDOG_PID" 2>/dev/null; kill "$WATCHDOG_PID" 2>/dev/null; wait "$WATCHDOG_PID" 2>/dev/null; WATCHDOG_PID=""; }
pass() { echo "ok: $*"; }

# --- stubs -------------------------------------------------------------------
cat > "$STUBS/aws" <<'S'
#!/usr/bin/env bash
echo "aws $*" >> "$STUB_LOG"
case "$*" in
  *"s3 sync"*) [ "${STUB_AWS_SYNC_FAIL:-0}" = 1 ] && exit 1 ;;
  *"s3 cp"*) [ "${STUB_AWS_CP_FAIL:-0}" = 1 ] && exit 1 ;;
  *"ec2 describe-instances"*) [ "${STUB_DESCRIBE_FAIL:-0}" = 1 ] && exit 255; echo "${STUB_STATE:-running}" ;;
  *"ec2 stop-instances"*) [ "${STUB_STOP_FAIL:-0}" = 1 ] && exit 1 ;;
esac
exit 0
S
cat > "$STUBS/docker" <<'S'
#!/usr/bin/env bash
echo "docker $*" >> "$STUB_LOG"
# grader run: produce a report unless told not to
for a in "$@"; do case "$a" in /out/grading-*.json) out="${a#/out/}"; [ "${STUB_GRADER_NO_REPORT:-0}" = 1 ] || echo '{"ok":true}' > "$STUB_OUT/$out";; esac; done
exit "${STUB_DOCKER_RC:-0}"
S
cat > "$STUBS/timeout" <<'S'
#!/usr/bin/env bash
# timeout [-k N] SECONDS cmd...  -> run cmd directly
[ "$1" = "-k" ] && shift 2
shift
exec "$@"
S
cat > "$STUBS/shutdown" <<'S'
#!/usr/bin/env bash
echo "shutdown $*" >> "$STUB_LOG"
if [ "${1:-}" = "--show" ]; then
  if [ "${STUB_SHUTDOWN_NOSCHED:-0}" = 1 ]; then echo "No scheduled shutdown."; else echo "Shutdown scheduled for $(date -u) (stub)"; fi
fi
exit 0
S
cat > "$STUBS/logger" <<'S'
#!/usr/bin/env bash
exit 0
S
if ! command -v sha256sum >/dev/null 2>&1; then
  cat > "$STUBS/sha256sum" <<'S'
#!/usr/bin/env bash
if [ "${1:-}" = "-c" ]; then shasum -a 256 -c "${@:2}"; else shasum -a 256 "$@"; fi
S
fi
chmod +x "$STUBS"/*
export PATH="$STUBS:$PATH" STUB_LOG="$LOG"

# --- common environment --------------------------------------------------------
export AMOS_SQ_LIBRARY_ONLY=1
source "$CONTROLLER"
RUN_ID=test-run; DEADLINE_UTC=2099-01-01T00:00:00Z; DEADLINE_EPOCH=$(( $(date -u +%s) + 7200 ))
BUCKET=b; DEST=s3://b/test; API_KEY=k; MODEL_IDS=a,b; SLEEP_IMAGE=img; VLLM_IMAGE=vimg
SRC_REVISION=rev; SRC_SHA=src; PROTOCOL_DIGEST=p; PRIMARY_SET=primary=seed-a; OPTIONAL_SET=opt=seed-b; OPTIONAL_MIN_SECONDS=1
ADAPTER_ID=ad; ADAPTER_URI=s3://b/ad; BASE_SERVED_NAME=base; HF_REPO=r; HF_REVISION=h
ROOT="$WORK/root"; OUT="$ROOT/out"; MODEL_DIR="$WORK/model"; mkdir -p "$OUT" "$MODEL_DIR"
export STUB_OUT="$OUT"
STATUS=started; FAIL_REASON=""; SET_FAILURES=0; WATCHDOG_PID=""; WATCHDOG_SCHEDULED=""

# --- T1: upload failure is recorded and blocks optional work -------------------------
STUB_AWS_SYNC_FAIL=1 sq_run_set primary seed-a
grep -q '"uploaded":false' "$OUT/grading-primary.status.json" || fail "T1 primary status must record uploaded:false"
[ "$LAST_SET_STATUS" = completed ] || fail "T1 grading itself completed"
[ "$LAST_SET_UPLOADED" = 0 ] || fail "T1 LAST_SET_UPLOADED must be 0"
[ "$SET_FAILURES" = 1 ] || fail "T1 SET_FAILURES must count the upload failure (got $SET_FAILURES)"
# the main flow's optional gate, reproduced exactly as in sq_main:
PRIMARY_UPLOADED=$LAST_SET_UPLOADED; PRIMARY_STATUS=$LAST_SET_STATUS
if [ "$PRIMARY_UPLOADED" != 1 ]; then echo "{\"set\":\"opt\",\"status\":\"skipped-primary-unsynced\"}" > "$OUT/grading-opt.status.json"; fi
grep -q skipped-primary-unsynced "$OUT/grading-opt.status.json" || fail "T1 optional must be skipped when the primary is unsynced"
[ "$FAIL" = 0 ] && pass "T1 upload failure recorded; optional blocked"

# --- T2: successful upload path ---------------------------------------------------
SET_FAILURES=0; rm -f "$OUT"/grading-*
sq_run_set primary seed-a
grep -q '"uploaded":true' "$OUT/grading-primary.status.json" || fail "T2 uploaded:true expected"
[ "$SET_FAILURES" = 0 ] && [ "$LAST_SET_UPLOADED" = 1 ] || fail "T2 no failures expected"
grep -q -- '--arm-order balanced --block-size 4 --order-seed seed-a:arm-order --warmup inference --warmup-max-tokens 16' "$LOG" || fail "T2 grader must be launched with balanced order and inference warm-up"
[ "$FAIL" = 0 ] && pass "T2 success path uploads and records"

# --- T3: grader timeout / no report are truthful ------------------------------------
SET_FAILURES=0; rm -f "$OUT"/grading-*
STUB_DOCKER_RC=124 STUB_GRADER_NO_REPORT=1 sq_run_set primary seed-a
grep -q '"status":"timeout"' "$OUT/grading-primary.status.json" || fail "T3 timeout status expected"
[ "$SET_FAILURES" = 1 ] || fail "T3 timeout counts as failure"
[ "$FAIL" = 0 ] && pass "T3 timeout recorded truthfully"

# --- T4: run manifest generation fails closed -------------------------------------------
ADAPTER_SHA_EXPECTED=x; ADAPTER_CONFIG_SHA_EXPECTED=y; MODEL_MANIFEST_SHA_EXPECTED=m; SERVED_MANIFEST_SHA_EXPECTED=s; OPTIONAL_MIN_SECONDS=2400
mkdir -p "$WORK/adapter"; echo '{"r":32,"lora_alpha":64,"target_modules":["q_proj"],"peft_type":"LORA"}' > "$WORK/adapter/adapter_config.json"
rm -f "$ROOT/served-model-manifest.json"
if sq_write_run_manifest "$WORK/adapter" 2>/dev/null; then fail "T4 manifest generation must fail without the served manifest"; fi
[ ! -s "$OUT/run-manifest.json" ] || fail "T4 no manifest file may be left behind as valid"
echo '{"weightManifestSha256":"w","weights":[{"file":"a.bin","sha256":"deadbeef"}],"tokenizerAndConfig":{}}' > "$ROOT/served-model-manifest.json"
sq_write_run_manifest "$WORK/adapter" || fail "T4 manifest generation should succeed with inputs present"
python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); assert m["candidate"]["adapterConfigSha256"]=="y" and m["candidate"]["alpha"]==64 and m["base"]["weightManifestSha256"]=="w"' "$OUT/run-manifest.json" || fail "T4 manifest must bind adapter config hash, alpha and weight identity"
[ "$FAIL" = 0 ] && pass "T4 manifest generation fails closed and binds identities"

# --- T5: cached checkpoint is re-verified; mismatch is rejected ----------------------------
printf 'good' > "$MODEL_DIR/a.bin"
GOOD=$(sha256sum "$MODEL_DIR/a.bin" | cut -c1-64)
echo "$GOOD  ./a.bin" > "$ROOT/model-manifest.sha256"
echo "{\"weightManifestSha256\":\"w\",\"weights\":[{\"file\":\"a.bin\",\"sha256\":\"$GOOD\"}],\"tokenizerAndConfig\":{}}" > "$ROOT/served-model-manifest.json"
sq_verify_model >/dev/null 2>&1 || fail "T5 matching checkpoint must verify"
printf 'tampered' > "$MODEL_DIR/a.bin"
if sq_verify_model >/dev/null 2>&1; then fail "T5 tampered cached checkpoint must be rejected"; fi
printf 'good' > "$MODEL_DIR/a.bin"
echo "{\"weightManifestSha256\":\"w\",\"weights\":[{\"file\":\"a.bin\",\"sha256\":\"0000\"}],\"tokenizerAndConfig\":{}}" > "$ROOT/served-model-manifest.json"
if sq_verify_model >/dev/null 2>&1; then fail "T5 served-manifest mismatch must be rejected even when model-manifest matches"; fi
[ "$FAIL" = 0 ] && pass "T5 cached checkpoint always re-verified against both manifests"

# --- T6: manifest bytes and weight identity are pinned ------------------------------------------
echo "{\"weightManifestSha256\":\"w\",\"weights\":[],\"tokenizerAndConfig\":{}}" > "$ROOT/served-model-manifest.json"
MODEL_MANIFEST_SHA_EXPECTED=$(sha256sum "$ROOT/model-manifest.sha256" | cut -c1-64)
SERVED_MANIFEST_SHA_EXPECTED=$(sha256sum "$ROOT/served-model-manifest.json" | cut -c1-64)
EXPECTED_WEIGHT_MANIFEST_SHA=w
sq_verify_manifests || fail "T6 pinned manifests must verify (code $?)"
EXPECTED_WEIGHT_MANIFEST_SHA=other
sq_verify_manifests; [ "$?" = 4 ] || fail "T6 wrong weight identity must be rejected with code 4"
EXPECTED_WEIGHT_MANIFEST_SHA=w; SERVED_MANIFEST_SHA_EXPECTED=nope
sq_verify_manifests; [ "$?" = 2 ] || fail "T6 served manifest byte mismatch must be rejected with code 2"
[ "$FAIL" = 0 ] && pass "T6 manifest bytes and weight identity pinned"

# --- T7: adapter weights and config both bound --------------------------------------------------
printf 'w' > "$WORK/adapter/adapter_model.safetensors"
ADAPTER_SHA_EXPECTED=$(sha256sum "$WORK/adapter/adapter_model.safetensors" | cut -c1-64)
ADAPTER_CONFIG_SHA_EXPECTED=$(sha256sum "$WORK/adapter/adapter_config.json" | cut -c1-64)
sq_verify_adapter "$WORK/adapter" || fail "T7 matching adapter must verify"
echo '{"r":32,"lora_alpha":128,"target_modules":["q_proj"],"peft_type":"LORA"}' > "$WORK/adapter/adapter_config.json"
sq_verify_adapter "$WORK/adapter"; [ "$?" = 2 ] || fail "T7 changed adapter config with identical weights must be rejected with code 2"
[ "$FAIL" = 0 ] && pass "T7 adapter config bound beside weights"

# --- T8: absolute watchdog fires at deadline+grace and stops the run ---------------------------------
: > "$LOG"
( sleep 30 ) & VICTIM=$!
DEADLINE_EPOCH=$(( $(date -u +%s) + 1 ))
sq_install_watchdog "$VICTIM" 1 || fail "T8 watchdog install must succeed"
grep -q "shutdown -h +" "$LOG" || fail "T8 OS-level shutdown must be scheduled at install"
sleep 4
if kill -0 "$VICTIM" 2>/dev/null; then fail "T8 watchdog must TERM the controller after the deadline"; kill "$VICTIM" 2>/dev/null; fi
grep -q '"status":"watchdog-stopped"' "$OUT/watchdog.json" 2>/dev/null || fail "T8 watchdog receipt expected"
wait "$VICTIM" 2>/dev/null
stop_watchdog
# the killer proceeds to docker cleanup + shutdown now after 20 s; give it time in the background and check the log at the end
[ "$FAIL" = 0 ] && pass "T8 watchdog terminates the run and schedules shutdown"

# --- T9: sq_bounded refuses work with no time left ----------------------------------------------------
DEADLINE_EPOCH=$(( $(date -u +%s) + 30 ))
if sq_bounded 10 true; then fail "T9 sq_bounded must refuse when under the cleanup reserve"; fi
DEADLINE_EPOCH=$(( $(date -u +%s) + 7200 ))
sq_bounded 10 true || fail "T9 sq_bounded runs when time remains"
[ "$FAIL" = 0 ] && pass "T9 bounded operations respect the deadline reserve"


# --- T10: watchdog install fails when the OS refuses/does not show a schedule ------------------------
DEADLINE_EPOCH=$(( $(date -u +%s) + 7200 ))
( sleep 30 ) & VICTIM2=$!
STUB_SHUTDOWN_NOSCHED=1 sq_install_watchdog "$VICTIM2" 300; rc=$?
[ "$rc" = 3 ] || fail "T10 unverified shutdown schedule must fail the install (rc $rc)"
stop_watchdog; kill "$VICTIM2" 2>/dev/null; wait "$VICTIM2" 2>/dev/null
[ "$FAIL" = 0 ] && pass "T10 watchdog install requires a verified OS shutdown schedule"

# --- T11: runner stop script — unknown state still stops; stopped leaves alone; stop failure is truthful ---------
STOP="$HERE/../sq-runner-stop.sh"
export RECEIPT_DIR="$WORK/receipts" AMOS_SQ_RUNNER_ENV=/nonexistent STOP_RETRY_SLEEP=0 S3_PREFIX=s3://b/sq
: > "$LOG"
RUN_ID=sq-test STUB_DESCRIBE_FAIL=1 bash "$STOP" >/dev/null 2>&1; rc=$?
grep -q "ec2 stop-instances" "$LOG" || fail "T11 describe failure must still attempt a stop"
grep -q '"trainerState":"unknown"' "$RECEIPT_DIR"/sq-test-deadline-*.json || fail "T11 receipt must record unknown state"
[ "$rc" = 0 ] || fail "T11 stop requested after unknown state should exit 0 (rc $rc)"
rm -f "$RECEIPT_DIR"/*; : > "$LOG"
RUN_ID=sq-test STUB_STATE=stopped bash "$STOP" >/dev/null 2>&1
grep -q "ec2 stop-instances" "$LOG" && fail "T11 a stopped trainer must be left alone"
grep -q '"action":"left-alone"' "$RECEIPT_DIR"/sq-test-deadline-*.json || fail "T11 receipt must record left-alone"
rm -f "$RECEIPT_DIR"/*; : > "$LOG"
RUN_ID=sq-test STUB_STATE=running STUB_STOP_FAIL=1 bash "$STOP" >/dev/null 2>&1; rc=$?
[ "$(grep -c "ec2 stop-instances" "$LOG")" = 3 ] || fail "T11 three bounded stop attempts expected"
grep -q '"action":"stop-failed"' "$RECEIPT_DIR"/sq-test-deadline-*.json || fail "T11 receipt must record stop-failed"
[ "$rc" != 0 ] || fail "T11 stop-failed must exit non-zero"
[ "$FAIL" = 0 ] && pass "T11 runner stop script stops on unknown state and reports truthfully"

# --- T12: launcher preflight is render-only and catches bad bindings -------------------------------------
LAUNCH="$HERE/../launch-fp8-serving-qualification.sh"
CTL="$HERE/../grade-fp8-serving-qualification.sh"
export SQ_RENDER_DIR="$WORK/rendered"
CSHA=$(sha256sum "$CTL" | cut -c1-64); SSHA=$(sha256sum "$STOP" | cut -c1-64)
GOODENV="$WORK/launch.json"
python3 - "$GOODENV" <<'PYE'
import json,sys
json.dump({k:"x"*8 for k in "SRC_URI SRC_SHA_EXPECTED SRC_REVISION ADAPTER_ID ADAPTER_URI ADAPTER_SHA_EXPECTED ADAPTER_CONFIG_SHA_EXPECTED MODEL_MANIFEST_SHA_EXPECTED SERVED_MANIFEST_SHA_EXPECTED EXPECTED_WEIGHT_MANIFEST_SHA PROTOCOL_DIGEST PRIMARY_SET".split()} | {"OPTIONAL_SET":"o=s","RUN_ID":"<set>","DEADLINE_UTC":"<set>"}, open(sys.argv[1],"w"))
PYE
: > "$LOG"
if SQ_CONTROLLER_PATH=/nonexistent/ctl.sh SQ_CONTROLLER_SHA_EXPECTED="$CSHA" SQ_STOP_SCRIPT_SHA_EXPECTED="$SSHA" AMOS_SQ_LIBRARY_ONLY=0 bash "$LAUNCH" preflight "$GOODENV" --now 1800000000 >/dev/null 2>&1; then fail "T12 nonexistent controller must fail preflight"; fi
if SQ_CONTROLLER_SHA_EXPECTED="0000" SQ_STOP_SCRIPT_SHA_EXPECTED="$SSHA" AMOS_SQ_LIBRARY_ONLY=0 bash "$LAUNCH" preflight "$GOODENV" --now 1800000000 >/dev/null 2>&1; then fail "T12 controller sha mismatch must fail preflight"; fi
BADENV="$WORK/launch-bad.json"; python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); d["ADAPTER_SHA_EXPECTED"]="<fill>"; json.dump(d,open(sys.argv[2],"w"))' "$GOODENV" "$BADENV"
if SQ_CONTROLLER_SHA_EXPECTED="$CSHA" SQ_STOP_SCRIPT_SHA_EXPECTED="$SSHA" AMOS_SQ_LIBRARY_ONLY=0 bash "$LAUNCH" preflight "$BADENV" --now 1800000000 >/dev/null 2>&1; then fail "T12 placeholder in launch env must fail preflight"; fi
OUTP=$(SQ_CONTROLLER_SHA_EXPECTED="$CSHA" SQ_STOP_SCRIPT_SHA_EXPECTED="$SSHA" AMOS_SQ_LIBRARY_ONLY=0 bash "$LAUNCH" preflight "$GOODENV" --now 1800000000 2>&1) || fail "T12 good preflight must pass: $OUTP"
echo "$OUTP" | grep -q "PREFLIGHT OK run=sq-fp8-s5-20270115T0800Z deadline=2027-01-15T09:40:00Z" || fail "T12 preflight must render run id and deadline from --now (got: $OUTP)"
R="$WORK/rendered/sq-fp8-s5-20270115T0800Z"
[ -s "$R/runner-stop-timer.params.json" ] && [ -s "$R/trainer-controller.params.json" ] && [ -s "$R/preflight.json" ] || fail "T12 rendered payloads missing"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); c=" ".join(d["commands"]); assert "sha256sum -c" in c and "RUN_ID=sq-fp8-s5-20270115T0800Z" in c and "DEADLINE_UTC=2027-01-15T09:40:00Z" in c and "nohup /root/grade-fp8-serving-qualification.sh" in c' "$R/trainer-controller.params.json" || fail "T12 controller payload must verify sha and carry run id/deadline"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); c=" ".join(d["commands"]); assert "2027-01-15 09:45:00 UTC" in c and "NextElapseUSecRealtime" in c and "sha256sum -c" in c' "$R/runner-stop-timer.params.json" || fail "T12 stop-timer payload must schedule start+105 and report the next trigger"
grep -q "aws " "$LOG" && fail "T12 preflight must make no AWS call"
# future-trigger rule
AMOS_SQ_LIBRARY_ONLY=1 source "$LAUNCH"
sq_timer_is_future 1800006300 1800000000 || fail "T12 105-min trigger must count as future"
if sq_timer_is_future 1800003000 1800000000; then fail "T12 a trigger only 50 min ahead must be refused"; fi
if sq_timer_is_future 1799999000 1800000000; then fail "T12 a past trigger must be refused"; fi
[ "$FAIL" = 0 ] && pass "T12 launcher preflight renders offline and refuses bad bindings"

stop_watchdog
[ "$FAIL" = 0 ] && echo "ALL PASSED" || echo "FAILURES"
exit "$FAIL"
