#!/bin/bash
# Isolated FP8 serving qualification: the production FP8 checkpoint served by the
# production vLLM image and effective arguments on the trainer, plus ONE adapter
# as a LoRA module, graded with the balanced arm order and real warm-up of
# swarm/scripts/gradeCurriculum.js. Nothing here touches the live inference cell.
#
# Every identity is pinned by the environment (no defaults for run, deadline,
# source, adapter, manifests or protocol) so the rendered launch file is the
# complete record. Review findings from Codex (20260906T191807Z) folded in:
#   - the whole controller is bounded: an absolute watchdog (background killer +
#     scheduled OS shutdown) is installed and verified before any setup, and
#     every blocking operation runs under `timeout -k`;
#   - evidence is fail-closed: manifest generation is validated, every upload's
#     result is recorded, and optional work needs the primary upload to succeed;
#   - treatment binding: both checkpoint manifests are byte-pinned, the weight
#     identity is required, cached checkpoint files are always re-verified, and
#     the adapter's config is hash-pinned beside its weights.
# Set AMOS_SQ_LIBRARY_ONLY=1 to source the functions without running (tests).
set -u
export HOME=/root

sq_need() { [ -n "${!1:-}" ] || { echo "FAIL: $1 must be set"; exit 2; }; }
sq_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
sq_epoch() { date -u +%s; }
sq_remaining() { echo $(( DEADLINE_EPOCH - $(sq_epoch) )); }
sq_die() { STATUS=failed; FAIL_REASON="$1"; echo "FAIL: $1"; exit 1; }
sq_log() { echo "[$(sq_now)] $*"; }

# Run a blocking command under a hard cap: min(<cap seconds>, time left before
# the deadline minus a cleanup reserve). Never lets an operation outlive the run.
sq_bounded() {
  local cap="$1"; shift
  local left=$(( $(sq_remaining) - 60 ))
  [ "$left" -gt 5 ] || { echo "FAIL: no time left for: $1"; return 124; }
  [ "$cap" -lt "$left" ] || cap="$left"
  timeout -k 30 "$cap" "$@"
}

# Absolute stop independent of the controller's own arithmetic: a background
# killer that fires at the deadline + grace and an OS-scheduled shutdown behind it.
sq_install_watchdog() {
  local main_pid="$1" grace="${2:-300}"
  local fire_in=$(( $(sq_remaining) + grace ))
  [ "$fire_in" -gt 0 ] || fire_in=1
  (
    sleep "$fire_in"
    echo "[$(sq_now)] WATCHDOG: deadline passed; stopping run $RUN_ID" >&2
    echo "{\"runId\":\"$RUN_ID\",\"status\":\"watchdog-stopped\",\"at\":\"$(sq_now)\"}" > "$OUT/watchdog.json" 2>/dev/null
    timeout -k 10 60 aws s3 cp "$OUT/watchdog.json" "$DEST/watchdog.json" --only-show-errors >/dev/null 2>&1
    kill -TERM "$main_pid" 2>/dev/null
    sleep 20
    timeout -k 10 60 docker rm -f amos-sq-grader amos-fp8-serving >/dev/null 2>&1
    shutdown -h now "amos serving qualification $RUN_ID watchdog" >/dev/null 2>&1
  ) &
  WATCHDOG_PID=$!
  # OS-level fallback even if the killer itself dies: shutdown at deadline + grace + 2 min.
  # Both the request and the resulting schedule are verified; a refused schedule fails the install.
  local shutdown_in_min=$(( (fire_in + 120 + 59) / 60 ))
  shutdown -h "+$shutdown_in_min" "amos serving qualification $RUN_ID absolute stop" >/dev/null 2>&1 || { echo "FAIL: OS shutdown could not be scheduled"; return 2; }
  kill -0 "$WATCHDOG_PID" 2>/dev/null || return 1
  WATCHDOG_SCHEDULED="$(timeout -k 5 15 shutdown --show 2>&1 | head -1)"
  case "$WATCHDOG_SCHEDULED" in
    ""|*"No scheduled"*|*"not scheduled"*|*"Failed"*) echo "FAIL: scheduled shutdown not verified: '${WATCHDOG_SCHEDULED:-empty}'"; return 3 ;;
  esac
  sq_log "watchdog pid $WATCHDOG_PID fires in ${fire_in}s; scheduled shutdown: $WATCHDOG_SCHEDULED"
  return 0
}

sq_sha256() { sha256sum "$1" | cut -c1-64; }

# Both checkpoint manifests are pinned to reviewed bytes, and the served manifest
# must carry the expected weight identity, before either is trusted.
sq_verify_manifests() {
  [ "$(sq_sha256 "$ROOT/model-manifest.sha256")" = "$MODEL_MANIFEST_SHA_EXPECTED" ] || return 1
  [ "$(sq_sha256 "$ROOT/served-model-manifest.json")" = "$SERVED_MANIFEST_SHA_EXPECTED" ] || return 2
  local weight_id
  weight_id=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["weightManifestSha256"])' "$ROOT/served-model-manifest.json" 2>/dev/null) || return 3
  [ "$weight_id" = "$EXPECTED_WEIGHT_MANIFEST_SHA" ] || return 4
  return 0
}

# Every file of the checkpoint is re-hashed against both manifests on every run;
# a cache marker is never trusted on its own.
sq_verify_model() {
  ( cd "$MODEL_DIR" && sed 's#  \./#  #' "$ROOT/model-manifest.sha256" | sha256sum -c --quiet - ) || return 1
  python3 - "$MODEL_DIR" "$ROOT/served-model-manifest.json" <<'PY' || return 2
import hashlib, json, sys, os
model_dir, manifest_path = sys.argv[1:3]
served = json.load(open(manifest_path))
expected = {w["file"]: w["sha256"] for w in served["weights"]}
expected.update(served.get("tokenizerAndConfig", {}))
bad = []
for name, digest in sorted(expected.items()):
    path = os.path.join(model_dir, name)
    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 22), b""):
                h.update(chunk)
    except OSError:
        bad.append(name); continue
    if h.hexdigest() != digest:
        bad.append(name)
print("served files verified:", len(expected) - len(bad), "mismatch:", bad)
sys.exit(1 if bad else 0)
PY
  return 0
}

# Adapter weights AND config are bound: alpha, target modules and other config
# change behaviour with identical weights.
sq_verify_adapter() {
  local dir="$1"
  [ "$(sq_sha256 "$dir/adapter_model.safetensors")" = "$ADAPTER_SHA_EXPECTED" ] || return 1
  [ "$(sq_sha256 "$dir/adapter_config.json")" = "$ADAPTER_CONFIG_SHA_EXPECTED" ] || return 2
  return 0
}

# Identity record before any inference. Fails closed: the file must be produced,
# non-empty and valid JSON with the run id.
sq_write_run_manifest() {
  local adapter_dir="$1"
  python3 - "$OUT/run-manifest.json" "$adapter_dir" <<PY || return 1
import json, datetime, sys
out, adapter_dir = sys.argv[1:3]
served = json.load(open("$ROOT/served-model-manifest.json"))
adapter_config = json.load(open(adapter_dir + "/adapter_config.json"))
manifest = {
  "schema": "amos.serving-qualification-run-manifest", "version": 1, "runId": "$RUN_ID",
  "createdAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "deadline": "$DEADLINE_UTC",
  "protocolDigest": "$PROTOCOL_DIGEST",
  "watchdog": {"killerPid": int("${WATCHDOG_PID:-0}"), "scheduledShutdown": "${WATCHDOG_SCHEDULED:-}"},
  "servingImage": "$VLLM_IMAGE", "graderImage": "$SLEEP_IMAGE", "graderSourceRevision": "$SRC_REVISION", "graderSourceArchiveSha256": "$SRC_SHA",
  "base": {"servedAs": "$BASE_SERVED_NAME", "hfRepo": "$HF_REPO", "hfRevision": "$HF_REVISION",
           "modelManifestSha256": "$MODEL_MANIFEST_SHA_EXPECTED", "servedManifestSha256": "$SERVED_MANIFEST_SHA_EXPECTED",
           "weightManifestSha256": served["weightManifestSha256"], "filesVerified": len(served["weights"]) + len(served.get("tokenizerAndConfig", {}))},
  "candidate": {"servedAs": "$ADAPTER_ID", "adapterUri": "$ADAPTER_URI", "adapterModelSha256": "$ADAPTER_SHA_EXPECTED", "adapterConfigSha256": "$ADAPTER_CONFIG_SHA_EXPECTED",
                "rank": adapter_config.get("r"), "alpha": adapter_config.get("lora_alpha"), "targetModules": sorted(adapter_config.get("target_modules", [])), "peftType": adapter_config.get("peft_type")},
  "servingArgs": {"maxModelLen": 65536, "maxNumSeqs": 8, "maxNumBatchedTokens": 32768, "gpuMemoryUtilization": 0.85, "toolCallParser": "qwen3_xml", "reasoningParser": "qwen3", "prefixCaching": True, "maxLoraRank": 32, "maxLoras": 4, "speculative": {"method": "mtp", "num_speculative_tokens": 3}, "trustRemoteCode": True,
                  "deviations": ["one LoRA module: $ADAPTER_ID", "loopback host with run-local API key", "trainer GPU/driver, not the cell"]},
  "selfTest": "${SELF_TEST:-0}" == "1", "sets": {"primary": "$PRIMARY_SET", "optional": "$OPTIONAL_SET" or None, "optionalRunsOnlyIf": "primary report uploaded and >= $OPTIONAL_MIN_SECONDS s remaining"},
  "grader": {"armOrder": "balanced", "blockSize": 4, "warmup": "inference", "warmupMaxTokens": 16, "concurrency": 4, "temperature": 0.2, "seed": 7, "reasoningEffort": "medium", "repairAttempts": 1, "maxOutputTokens": 1200},
  "evidenceClass": "FP8 base vs one LoRA under the production vLLM image and effective arguments on an isolated trainer replica; synthetic curriculum; not a real-Mission, tier, router or live-serving claim; no promotion implied"
}
json.dump(manifest, open(out, "w"), indent=2)
PY
  [ -s "$OUT/run-manifest.json" ] || return 2
  python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); assert m["runId"]==sys.argv[2] and m["schema"]=="amos.serving-qualification-run-manifest"' "$OUT/run-manifest.json" "$RUN_ID" || return 3
  return 0
}

# Upload the output directory; the result is returned, never swallowed.
sq_sync_out() { sq_bounded 600 aws s3 sync "$OUT/" "$DEST/" --only-show-errors; }

# Grade one set. Records the set status AND whether its evidence reached S3;
# sets LAST_SET_STATUS / LAST_SET_UPLOADED for the caller.
sq_run_set() {
  local set_id="$1" seed="$2"
  LAST_SET_STATUS=""; LAST_SET_UPLOADED=0
  local budget=$(( $(sq_remaining) - 300 ))
  if [ "$budget" -le 600 ]; then
    echo "skipping $set_id: only ${budget}s left"
    echo "{\"set\":\"$set_id\",\"status\":\"skipped-deadline\",\"uploaded\":false}" > "$OUT/grading-$set_id.status.json"
    LAST_SET_STATUS="skipped-deadline"; SET_FAILURES=$((SET_FAILURES+1)); return 0
  fi
  sq_log "== $set_id seed=$seed budget=${budget}s =="
  timeout -k 60 "$budget" docker run --rm --name amos-sq-grader --network=host \
    -v "$ROOT/src:/opt/amos-organism:ro" -v "$OUT:/out" \
    --env AMOS_QWEN_RESEARCH_URL=http://127.0.0.1:8000 --env "AMOS_LOCAL_BENCHMARK_API_KEY=$API_KEY" \
    "$SLEEP_IMAGE" swarm/scripts/gradeCurriculum.js --model-ids "$MODEL_IDS" --pool holdout --rulebook implicit \
    --per-family 12 --seed "$seed" --concurrency 4 --repair-attempts 1 --max-output-tokens 1200 \
    --arm-order balanced --block-size 4 --order-seed "$seed:arm-order" --warmup inference --warmup-max-tokens 16 \
    --output "/out/grading-$set_id.json" > "$OUT/grading-$set_id.summary.json" 2> "$OUT/grading-$set_id.log"
  local rc=$?
  timeout -k 10 60 docker rm -f amos-sq-grader >/dev/null 2>&1 || true
  local set_status="completed"
  if [ "$rc" = 124 ] || [ "$rc" = 137 ]; then set_status="timeout"; elif [ "$rc" != 0 ]; then set_status="failed"; elif [ ! -s "$OUT/grading-$set_id.json" ]; then set_status="no-report"; fi
  echo "{\"set\":\"$set_id\",\"status\":\"$set_status\",\"exit\":$rc,\"finishedAt\":\"$(sq_now)\",\"uploaded\":null}" > "$OUT/grading-$set_id.status.json"
  local uploaded=false
  if sq_sync_out; then uploaded=true; LAST_SET_UPLOADED=1; else sq_log "upload of $set_id evidence FAILED"; fi
  echo "{\"set\":\"$set_id\",\"status\":\"$set_status\",\"exit\":$rc,\"finishedAt\":\"$(sq_now)\",\"uploaded\":$uploaded}" > "$OUT/grading-$set_id.status.json"
  [ "$uploaded" = true ] && sq_sync_out >/dev/null 2>&1 || true
  LAST_SET_STATUS="$set_status"
  if [ "$set_status" != "completed" ] || [ "$uploaded" != true ]; then SET_FAILURES=$((SET_FAILURES+1)); fi
  return 0
}

sq_finish() {
  local code=$?
  set +e
  [ "$STATUS" = "started" ] && STATUS="exited-$code"
  echo "{\"runId\":\"$RUN_ID\",\"status\":\"$STATUS\",\"reason\":\"$FAIL_REASON\",\"finishedAt\":\"$(sq_now)\"}" > "$OUT/status.json"
  timeout -k 10 60 docker logs --tail 200 amos-fp8-serving > "$OUT/vllm-tail.log" 2>&1 || true
  timeout -k 30 300 aws s3 sync "$OUT/" "$DEST/" --only-show-errors || echo "final evidence upload failed" >&2
  timeout -k 10 60 docker rm -f amos-fp8-serving amos-sq-grader >/dev/null 2>&1 || true
  [ -n "${WATCHDOG_PID:-}" ] && kill "$WATCHDOG_PID" 2>/dev/null
  logger -t amos-serving-qualification "$RUN_ID $STATUS $FAIL_REASON"
  echo "FINISHED $STATUS $FAIL_REASON"
  # Replaces the absolute-stop schedule with an immediate one; never cancels it.
  shutdown -h +1 "amos serving qualification $RUN_ID finished: $STATUS" >/dev/null 2>&1 || true
}

sq_main() {
  for v in RUN_ID DEADLINE_UTC SRC_URI SRC_SHA_EXPECTED SRC_REVISION ADAPTER_ID ADAPTER_URI ADAPTER_SHA_EXPECTED ADAPTER_CONFIG_SHA_EXPECTED \
           MODEL_MANIFEST_SHA_EXPECTED SERVED_MANIFEST_SHA_EXPECTED EXPECTED_WEIGHT_MANIFEST_SHA PROTOCOL_DIGEST PRIMARY_SET; do sq_need "$v"; done
  DEADLINE_EPOCH="${DEADLINE_EPOCH:-$(date -u -d "$DEADLINE_UTC" +%s)}"
  GRADER_UID="${GRADER_UID:-10002}"
  OPTIONAL_SET="${OPTIONAL_SET:-}"
  OPTIONAL_MIN_SECONDS="${OPTIONAL_MIN_SECONDS:-2400}"
  SELF_TEST="${SQ_SELF_TEST:-0}"   # 1 = prove startup and stop before any scenario is generated; consumes no seed
  BUCKET="amos-qwen-research-plane-637423327454-us-east-1"
  PLAN="stage1/stage1-2026-09-060408"
  DEST="s3://$BUCKET/$PLAN/serving-qualification/$RUN_ID"
  VLLM_IMAGE="${VLLM_IMAGE:-637423327454.dkr.ecr.us-east-1.amazonaws.com/amos-qwen-research/vllm-openai@sha256:c2f3b1b964e47809b722b5e75b61b1e7b39a50f70388cf2bf2418f16a9f31da2}"
  SLEEP_IMAGE="${SLEEP_IMAGE:-637423327454.dkr.ecr.us-east-1.amazonaws.com/amos-qwen-research-plane/trainer@sha256:ff962a7f5f5679a11e50ee424e5add9477a9fe02b4c11447f2f426bcbacc0432}"
  BASE_SERVED_NAME="amos-qwen38-27b-fp8"
  HF_REPO="Qwen/Qwen3.8-27B-FP8"
  HF_REVISION="017b9c7af6b5689d5dd426a76e0bc077eb5ca20a"
  MODEL_MANIFEST_URI="s3://$BUCKET/models/amos-qwen38-27b-fp8/model-manifest.sha256"
  SERVED_MANIFEST_URI="s3://$BUCKET/models/amos-qwen38-27b-fp8/served-model-manifest-20260905.json"
  MODEL_DIR=/opt/amos-fp8/model
  ROOT=/opt/amos-serving-qualification/$RUN_ID
  OUT=$ROOT/out
  mkdir -p "$ROOT/src" "$OUT" /opt/amos-fp8 /opt/amos-adapters-sq
  chown "$GRADER_UID:$GRADER_UID" "$OUT" && chmod 0775 "$OUT"
  API_KEY=$(python3 -c 'import secrets; print(secrets.token_hex(24))')
  STATUS=started; FAIL_REASON=""; SET_FAILURES=0; WATCHDOG_PID=""; WATCHDOG_SCHEDULED=""
  trap sq_finish EXIT
  [ "$(sq_remaining)" -gt 2700 ] || sq_die "less than 45 minutes before the deadline at start"

  # 0. Absolute stop first: nothing else starts until the watchdog is verified active.
  sq_install_watchdog "$$" 300 || sq_die "watchdog could not be installed"

  # 1. Pinned grader source, fail closed.
  sq_bounded 300 aws s3 cp "$SRC_URI" "$ROOT/src.tar.gz" --only-show-errors || sq_die "source download failed"
  SRC_SHA=$(sq_sha256 "$ROOT/src.tar.gz")
  [ "$SRC_SHA" = "$SRC_SHA_EXPECTED" ] || sq_die "source archive sha mismatch $SRC_SHA"
  sq_bounded 120 tar -xzf "$ROOT/src.tar.gz" -C "$ROOT/src" || sq_die "source archive extraction failed"
  [ -f "$ROOT/src/swarm/scripts/gradeCurriculum.js" ] || sq_die "extracted source lacks the grader"

  # 2. Images.
  sq_bounded 120 bash -c 'aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 637423327454.dkr.ecr.us-east-1.amazonaws.com >/dev/null 2>&1' || sq_die "ecr login failed"
  sq_bounded 900 docker pull -q "$VLLM_IMAGE" >/dev/null || sq_die "production vllm image pull failed"
  sq_bounded 600 docker pull -q "$SLEEP_IMAGE" >/dev/null || sq_die "grader image pull failed"

  # 3. Checkpoint manifests (byte-pinned) and the checkpoint itself (always re-verified).
  sq_bounded 120 aws s3 cp "$MODEL_MANIFEST_URI" "$ROOT/model-manifest.sha256" --only-show-errors || sq_die "model manifest download failed"
  sq_bounded 120 aws s3 cp "$SERVED_MANIFEST_URI" "$ROOT/served-model-manifest.json" --only-show-errors || sq_die "served manifest download failed"
  sq_verify_manifests || sq_die "checkpoint manifests are not the reviewed bytes / weight identity (code $?)"
  install -d -m 0755 "$MODEL_DIR"
  if ! sq_bounded 900 bash -c "$(declare -f sq_verify_model); MODEL_DIR='$MODEL_DIR' ROOT='$ROOT' sq_verify_model" >/dev/null 2>&1; then
    sq_log "checkpoint absent or not matching; downloading pinned revision $HF_REVISION"
    sq_bounded 2400 docker run --rm --network=host -v /opt/amos-fp8:/dl --env HF_HUB_DISABLE_TELEMETRY=1 --entrypoint python "$VLLM_IMAGE" -c \
      "from huggingface_hub import snapshot_download; snapshot_download('$HF_REPO', revision='$HF_REVISION', local_dir='/dl/model', max_workers=8)" \
      || sq_die "checkpoint download failed"
    sq_bounded 900 bash -c "$(declare -f sq_verify_model); MODEL_DIR='$MODEL_DIR' ROOT='$ROOT' sq_verify_model" || sq_die "downloaded checkpoint does not match the pinned manifests"
  fi

  # 4. Candidate adapter, weights and config pinned.
  rm -rf /opt/amos-adapters-sq/*
  sq_bounded 300 aws s3 sync "$ADAPTER_URI/" "/opt/amos-adapters-sq/$ADAPTER_ID/" --only-show-errors || sq_die "adapter sync failed"
  sq_verify_adapter "/opt/amos-adapters-sq/$ADAPTER_ID" || sq_die "adapter weights/config do not match the pinned hashes (code $?)"

  # 5. Identity record before inference; upload fail-closed; grader write probe.
  sq_write_run_manifest "/opt/amos-adapters-sq/$ADAPTER_ID" || sq_die "run manifest could not be generated/validated (code $?)"
  sq_sync_out || sq_die "manifest upload failed; refusing to start inference without durable identity"
  sq_bounded 60 docker run --rm --network=none -v "$OUT:/out" --entrypoint sh "$SLEEP_IMAGE" -c 'echo ok > /out/.write-probe && rm /out/.write-probe' || sq_die "grader uid cannot write the output directory"

  # 6. Serve the FP8 base + the one adapter with the production arguments.
  sq_bounded 60 docker rm -f amos-fp8-serving >/dev/null 2>&1 || true
  install -d -m 0777 /opt/amos-sq-cache
  sq_bounded 120 docker run -d --name amos-fp8-serving --gpus all --ipc=host --network=host \
    --env VLLM_NO_USAGE_STATS=1 --env VLLM_DO_NOT_TRACK=1 \
    --env HOME=/cache/home --env HF_HOME=/cache/hf --env TRITON_CACHE_DIR=/cache/triton --env XDG_CACHE_HOME=/cache/xdg \
    --volume "$MODEL_DIR:/model:ro" --volume /opt/amos-adapters-sq:/adapters:ro --volume /opt/amos-sq-cache:/cache:rw \
    --entrypoint python "$VLLM_IMAGE" -m vllm.entrypoints.openai.api_server \
    --host 127.0.0.1 --port 8000 --api-key "$API_KEY" --model /model --served-model-name "$BASE_SERVED_NAME" \
    --max-model-len 65536 --max-num-seqs 8 --max-num-batched-tokens 32768 --gpu-memory-utilization 0.85 \
    --enable-auto-tool-choice --tool-call-parser qwen3_xml --reasoning-parser qwen3 --enable-prefix-caching \
    --enable-lora --max-lora-rank 32 --max-loras 4 --lora-modules "$ADAPTER_ID=/adapters/$ADAPTER_ID" \
    --speculative-config '{"method":"mtp","num_speculative_tokens":3}' --trust-remote-code >/dev/null || sq_die "vllm start failed"
  READY=0
  for _ in $(seq 1 120); do
    if timeout -k 5 15 curl -fsS -H "authorization: Bearer $API_KEY" http://127.0.0.1:8000/v1/models >/dev/null 2>&1; then READY=1; break; fi
    [ "$(sq_remaining)" -gt 900 ] || break
    sleep 10
  done
  [ "$READY" = 1 ] || sq_die "vllm not ready"
  timeout -k 5 15 curl -fsS -H "authorization: Bearer $API_KEY" http://127.0.0.1:8000/v1/models | python3 -c 'import json,sys; print("served:", [m["id"] for m in json.load(sys.stdin)["data"]])' | tee "$OUT/served-models.txt"

  # 7. Primary set always; optional set only if the primary's evidence is in S3 and time remains.
  MODEL_IDS="$BASE_SERVED_NAME,$ADAPTER_ID"
  if [ "$SELF_TEST" = 1 ]; then
    # Startup proof only: one bounded warm-up request per arm through the served endpoint, no gradeCurriculum, no seed.
    for m in "$BASE_SERVED_NAME" "$ADAPTER_ID"; do
      code=$(timeout -k 5 60 curl -s -o "$OUT/selftest-$m.json" -w '%{http_code}' -H "authorization: Bearer $API_KEY" -H 'content-type: application/json' \
        http://127.0.0.1:8000/v1/chat/completions \
        -d "{\"model\":\"$m\",\"max_tokens\":16,\"temperature\":0,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with the single word ready.\"}]}") || code=000
      echo "{\"arm\":\"$m\",\"httpCode\":\"$code\"}" >> "$OUT/selftest.jsonl"
      [ "$code" = 200 ] || { STATUS=failed; FAIL_REASON="self-test arm $m returned $code"; sq_sync_out; return 1; }
    done
    STATUS=self-test-passed
    echo "{\"runId\":\"$RUN_ID\",\"selfTest\":true,\"arms\":[\"$BASE_SERVED_NAME\",\"$ADAPTER_ID\"],\"result\":\"served and answered a bounded warm-up on both arms; no scenario generated; no seed consumed\"}" > "$OUT/self-test-result.json"
    sq_sync_out
    return 0
  fi
  sq_run_set "${PRIMARY_SET%%=*}" "${PRIMARY_SET#*=}"
  PRIMARY_STATUS="$LAST_SET_STATUS"; PRIMARY_UPLOADED="$LAST_SET_UPLOADED"
  if [ -n "$OPTIONAL_SET" ]; then
    local opt_id="${OPTIONAL_SET%%=*}"
    if [ "$PRIMARY_UPLOADED" != 1 ]; then
      echo "{\"set\":\"$opt_id\",\"status\":\"skipped-primary-unsynced\",\"primaryStatus\":\"$PRIMARY_STATUS\"}" > "$OUT/grading-$opt_id.status.json"
    elif [ "$(sq_remaining)" -lt "$OPTIONAL_MIN_SECONDS" ]; then
      echo "{\"set\":\"$opt_id\",\"status\":\"skipped-optional\",\"secondsRemaining\":$(sq_remaining)}" > "$OUT/grading-$opt_id.status.json"
    else
      sq_run_set "$opt_id" "${OPTIONAL_SET#*=}"
    fi
  fi
  if [ "$SET_FAILURES" = 0 ]; then STATUS=completed; else STATUS=partial; FAIL_REASON="$SET_FAILURES set(s) not completed or not uploaded; see per-set status files"; fi
}

if [ "${AMOS_SQ_LIBRARY_ONLY:-0}" != 1 ]; then sq_main "$@"; fi
