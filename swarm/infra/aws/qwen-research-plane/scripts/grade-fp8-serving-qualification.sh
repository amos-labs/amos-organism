#!/bin/bash
# Isolated FP8 serving qualification: the production FP8 checkpoint served by the
# production vLLM image and effective arguments on the trainer, plus ONE adapter
# as a LoRA module, graded with the balanced arm order and real warm-up of
# swarm/scripts/gradeCurriculum.js. Nothing here touches the live inference cell.
# Every identity is pinned by the environment (no defaults for run, deadline,
# source, adapter or protocol) so the rendered launch file is the complete record.
# Status/upload/timeout handling follows grade-adapters-cloud.sh (#41–#43).
set -u
export HOME=/root
need() { [ -n "${!1:-}" ] || { echo "FAIL: $1 must be set"; exit 2; }; }
for v in RUN_ID DEADLINE_UTC SRC_URI SRC_SHA_EXPECTED SRC_REVISION ADAPTER_ID ADAPTER_URI ADAPTER_SHA_EXPECTED PROTOCOL_DIGEST PRIMARY_SET; do need "$v"; done
DEADLINE_EPOCH=$(date -u -d "$DEADLINE_UTC" +%s)
GRADER_UID="${GRADER_UID:-10002}"
OPTIONAL_SET="${OPTIONAL_SET:-}"                 # "<set-id>=<seed>", runs only if >= OPTIONAL_MIN_SECONDS remain
OPTIONAL_MIN_SECONDS="${OPTIONAL_MIN_SECONDS:-2400}"
BUCKET="amos-qwen-research-plane-637423327454-us-east-1"
PLAN="stage1/stage1-2026-09-060408"
DEST="s3://$BUCKET/$PLAN/serving-qualification/$RUN_ID"
# Production serving stack (coordination/artifacts/gateway-live-configuration-20260905.json, serving.image / effectiveArgs).
VLLM_IMAGE="${VLLM_IMAGE:-637423327454.dkr.ecr.us-east-1.amazonaws.com/amos-qwen-research/vllm-openai@sha256:c2f3b1b964e47809b722b5e75b61b1e7b39a50f70388cf2bf2418f16a9f31da2}"
SLEEP_IMAGE="${SLEEP_IMAGE:-637423327454.dkr.ecr.us-east-1.amazonaws.com/amos-qwen-research-plane/trainer@sha256:ff962a7f5f5679a11e50ee424e5add9477a9fe02b4c11447f2f426bcbacc0432}"
BASE_SERVED_NAME="amos-qwen38-27b-fp8"
HF_REPO="Qwen/Qwen3.8-27B-FP8"
HF_REVISION="017b9c7af6b5689d5dd426a76e0bc077eb5ca20a"
MODEL_MANIFEST_URI="s3://$BUCKET/models/amos-qwen38-27b-fp8/model-manifest.sha256"          # 81 files, from the original download
SERVED_MANIFEST_URI="s3://$BUCKET/models/amos-qwen38-27b-fp8/served-model-manifest-20260905.json"  # 78 files as served on the cell
MODEL_DIR=/opt/amos-fp8/model
ROOT=/opt/amos-serving-qualification/$RUN_ID
OUT=$ROOT/out
mkdir -p "$ROOT/src" "$OUT" /opt/amos-fp8 /opt/amos-adapters-sq
chown "$GRADER_UID:$GRADER_UID" "$OUT" && chmod 0775 "$OUT"
API_KEY=$(python3 -c 'import secrets; print(secrets.token_hex(24))')
STATUS=started
FAIL_REASON=""

finish() {
  local code=$?
  set +e
  [ "$STATUS" = "started" ] && STATUS="exited-$code"
  echo "{\"runId\":\"$RUN_ID\",\"status\":\"$STATUS\",\"reason\":\"$FAIL_REASON\",\"finishedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$OUT/status.json"
  docker logs --tail 200 amos-fp8-serving > "$OUT/vllm-tail.log" 2>&1 || true
  aws s3 sync "$OUT/" "$DEST/" --only-show-errors || true
  docker rm -f amos-fp8-serving >/dev/null 2>&1 || true
  docker rm -f amos-sq-grader >/dev/null 2>&1 || true
  logger -t amos-serving-qualification "$RUN_ID $STATUS $FAIL_REASON"
  echo "FINISHED $STATUS $FAIL_REASON"
  shutdown -h +1 "amos serving qualification $RUN_ID finished: $STATUS" >/dev/null 2>&1 || true
}
trap finish EXIT
remaining() { echo $(( DEADLINE_EPOCH - $(date -u +%s) )); }
die() { STATUS=failed; FAIL_REASON="$1"; echo "FAIL: $1"; exit 1; }
[ "$(remaining)" -gt 2700 ] || die "less than 45 minutes before the deadline at start"

# 1. Pinned grader source
aws s3 cp "$SRC_URI" "$ROOT/src.tar.gz" --only-show-errors || die "source download failed"
SRC_SHA=$(sha256sum "$ROOT/src.tar.gz" | cut -c1-64)
[ "$SRC_SHA" = "$SRC_SHA_EXPECTED" ] || die "source archive sha mismatch $SRC_SHA"
tar -xzf "$ROOT/src.tar.gz" -C "$ROOT/src"

# 2. Images (ECR)
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 637423327454.dkr.ecr.us-east-1.amazonaws.com >/dev/null 2>&1
docker pull -q "$VLLM_IMAGE" >/dev/null || die "production vllm image pull failed"
docker pull -q "$SLEEP_IMAGE" >/dev/null || die "grader image pull failed"

# 3. Base checkpoint: pinned public revision, verified file by file against BOTH manifests before serving.
aws s3 cp "$MODEL_MANIFEST_URI" "$ROOT/model-manifest.sha256" --only-show-errors || die "model manifest download failed"
aws s3 cp "$SERVED_MANIFEST_URI" "$ROOT/served-model-manifest.json" --only-show-errors || die "served manifest download failed"
if [ ! -f "$MODEL_DIR/.verified-$HF_REVISION" ]; then
  install -d -m 0755 "$MODEL_DIR"
  docker run --rm --network=host -v /opt/amos-fp8:/dl --env HF_HUB_DISABLE_TELEMETRY=1 --entrypoint python "$VLLM_IMAGE" -c \
    "from huggingface_hub import snapshot_download; snapshot_download('$HF_REPO', revision='$HF_REVISION', local_dir='/dl/model', max_workers=8)" \
    || die "checkpoint download failed"
  ( cd "$MODEL_DIR" && sed 's#  \./#  #' "$ROOT/model-manifest.sha256" | sha256sum -c --quiet - ) || die "checkpoint sha256 mismatch against model-manifest.sha256"
  python3 - "$MODEL_DIR" "$ROOT/served-model-manifest.json" <<'PY' || die "checkpoint mismatch against the served-model manifest"
import hashlib, json, sys, os
model_dir, manifest_path = sys.argv[1:3]
served = json.load(open(manifest_path))
expected = {w["file"]: w["sha256"] for w in served["weights"]}
expected.update(served.get("tokenizerAndConfig", {}))
bad = []
for name, digest in sorted(expected.items()):
    path = os.path.join(model_dir, name)
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 22), b""):
            h.update(chunk)
    if h.hexdigest() != digest:
        bad.append(name)
print("served files verified:", len(expected) - len(bad), "mismatch:", bad)
sys.exit(1 if bad else 0)
PY
  touch "$MODEL_DIR/.verified-$HF_REVISION"
fi

# 4. Candidate adapter, hash-pinned
rm -rf /opt/amos-adapters-sq/*
aws s3 sync "$ADAPTER_URI/" "/opt/amos-adapters-sq/$ADAPTER_ID/" --only-show-errors || die "adapter sync failed"
ADAPTER_SHA=$(sha256sum "/opt/amos-adapters-sq/$ADAPTER_ID/adapter_model.safetensors" | cut -c1-64)
[ "$ADAPTER_SHA" = "$ADAPTER_SHA_EXPECTED" ] || die "adapter sha mismatch $ADAPTER_SHA"
ADAPTER_RANK=$(python3 -c "import json; print(json.load(open('/opt/amos-adapters-sq/$ADAPTER_ID/adapter_config.json'))['r'])")

# 5. Frozen identity manifest before any inference; upload fail-closed
python3 - "$OUT/run-manifest.json" <<PY
import json, datetime, os
manifest = {
  "schema": "amos.serving-qualification-run-manifest", "version": 1, "runId": "$RUN_ID",
  "createdAt": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"), "deadline": "$DEADLINE_UTC",
  "protocolDigest": "$PROTOCOL_DIGEST",
  "servingImage": "$VLLM_IMAGE", "graderImage": "$SLEEP_IMAGE", "graderSourceRevision": "$SRC_REVISION", "graderSourceArchiveSha256": "$SRC_SHA",
  "base": {"servedAs": "$BASE_SERVED_NAME", "hfRepo": "$HF_REPO", "hfRevision": "$HF_REVISION", "servedManifestWeightSha256": json.load(open("$ROOT/served-model-manifest.json"))["weightManifestSha256"]},
  "candidate": {"servedAs": "$ADAPTER_ID", "adapterUri": "$ADAPTER_URI", "adapterModelSha256": "$ADAPTER_SHA", "rank": int("$ADAPTER_RANK")},
  "servingArgs": {"maxModelLen": 65536, "maxNumSeqs": 8, "maxNumBatchedTokens": 32768, "gpuMemoryUtilization": 0.85, "toolCallParser": "qwen3_xml", "reasoningParser": "qwen3", "prefixCaching": True, "maxLoraRank": 32, "maxLoras": 4, "speculative": {"method": "mtp", "num_speculative_tokens": 3}, "trustRemoteCode": True, "deviations": ["one LoRA module: $ADAPTER_ID", "loopback host with run-local API key", "trainer GPU/driver, not the cell"]},
  "sets": {"primary": "$PRIMARY_SET", "optional": "$OPTIONAL_SET" or None, "optionalRunsOnlyIfSecondsRemaining": int("$OPTIONAL_MIN_SECONDS")},
  "grader": {"armOrder": "balanced", "blockSize": 4, "warmup": "inference", "warmupMaxTokens": 16, "concurrency": 4, "temperature": 0.2, "seed": 7, "reasoningEffort": "medium", "repairAttempts": 1, "maxOutputTokens": 1200},
  "evidenceClass": "FP8 base vs one LoRA under the production vLLM image and effective arguments on an isolated trainer replica; synthetic curriculum; not a real-Mission, tier, router or live-serving claim; no promotion implied"
}
json.dump(manifest, open("$OUT/run-manifest.json", "w"), indent=2)
print("manifest written")
PY
aws s3 sync "$OUT/" "$DEST/" --only-show-errors || die "manifest upload failed; refusing to start inference without durable identity"
docker run --rm --network=none -v "$OUT:/out" --entrypoint sh "$SLEEP_IMAGE" -c 'echo ok > /out/.write-probe && rm /out/.write-probe' || die "grader uid cannot write the output directory"

# 6. Serve FP8 base + the one adapter with the production arguments
docker rm -f amos-fp8-serving >/dev/null 2>&1 || true
install -d -m 0777 /opt/amos-sq-cache
docker run -d --name amos-fp8-serving --gpus all --ipc=host --network=host \
  --env VLLM_NO_USAGE_STATS=1 --env VLLM_DO_NOT_TRACK=1 \
  --env HOME=/cache/home --env HF_HOME=/cache/hf --env TRITON_CACHE_DIR=/cache/triton --env XDG_CACHE_HOME=/cache/xdg \
  --volume "$MODEL_DIR:/model:ro" --volume /opt/amos-adapters-sq:/adapters:ro --volume /opt/amos-sq-cache:/cache:rw \
  --entrypoint python "$VLLM_IMAGE" -m vllm.entrypoints.openai.api_server \
  --host 127.0.0.1 --port 8000 --api-key "$API_KEY" --model /model --served-model-name "$BASE_SERVED_NAME" \
  --max-model-len 65536 --max-num-seqs 8 --max-num-batched-tokens 32768 --gpu-memory-utilization 0.85 \
  --enable-auto-tool-choice --tool-call-parser qwen3_xml --reasoning-parser qwen3 --enable-prefix-caching \
  --enable-lora --max-lora-rank 32 --max-loras 4 --lora-modules "$ADAPTER_ID=/adapters/$ADAPTER_ID" \
  --speculative-config '{"method":"mtp","num_speculative_tokens":3}' --trust-remote-code >/dev/null || die "vllm start failed"
READY=0
for _ in $(seq 1 120); do
  if curl -fsS -H "authorization: Bearer $API_KEY" http://127.0.0.1:8000/v1/models >/dev/null 2>&1; then READY=1; break; fi
  [ "$(remaining)" -gt 900 ] || break
  sleep 10
done
[ "$READY" = 1 ] || die "vllm not ready"
curl -fsS -H "authorization: Bearer $API_KEY" http://127.0.0.1:8000/v1/models | python3 -c 'import json,sys; print("served:", [m["id"] for m in json.load(sys.stdin)["data"]])' | tee "$OUT/served-models.txt"

# 7. Grade: primary set always; optional set only with enough time left
MODEL_IDS="$BASE_SERVED_NAME,$ADAPTER_ID"
SET_FAILURES=0
run_set() {
  local set_id="$1" seed="$2"
  local budget=$(( $(remaining) - 300 ))
  [ "$budget" -gt 600 ] || { echo "skipping $set_id: only ${budget}s left"; echo "{\"set\":\"$set_id\",\"status\":\"skipped-deadline\"}" > "$OUT/grading-$set_id.status.json"; SET_FAILURES=$((SET_FAILURES+1)); return 0; }
  echo "== $set_id seed=$seed budget=${budget}s =="
  timeout "$budget" docker run --rm --name amos-sq-grader --network=host \
    -v "$ROOT/src:/opt/amos-organism:ro" -v "$OUT:/out" \
    --env AMOS_QWEN_RESEARCH_URL=http://127.0.0.1:8000 --env "AMOS_LOCAL_BENCHMARK_API_KEY=$API_KEY" \
    "$SLEEP_IMAGE" swarm/scripts/gradeCurriculum.js --model-ids "$MODEL_IDS" --pool holdout --rulebook implicit \
    --per-family 12 --seed "$seed" --concurrency 4 --repair-attempts 1 --max-output-tokens 1200 \
    --arm-order balanced --block-size 4 --order-seed "$seed:arm-order" --warmup inference --warmup-max-tokens 16 \
    --output "/out/grading-$set_id.json" > "$OUT/grading-$set_id.summary.json" 2> "$OUT/grading-$set_id.log"
  local rc=$?
  docker rm -f amos-sq-grader >/dev/null 2>&1 || true
  local set_status="completed"
  if [ "$rc" = 124 ]; then set_status="timeout"; elif [ "$rc" != 0 ]; then set_status="failed"; elif [ ! -s "$OUT/grading-$set_id.json" ]; then set_status="no-report"; fi
  [ "$set_status" = "completed" ] || SET_FAILURES=$((SET_FAILURES+1))
  echo "{\"set\":\"$set_id\",\"status\":\"$set_status\",\"exit\":$rc,\"finishedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$OUT/grading-$set_id.status.json"
  aws s3 sync "$OUT/" "$DEST/" --only-show-errors
  return 0
}
run_set "${PRIMARY_SET%%=*}" "${PRIMARY_SET#*=}"
if [ -n "$OPTIONAL_SET" ]; then
  if [ "$(remaining)" -ge "$OPTIONAL_MIN_SECONDS" ]; then run_set "${OPTIONAL_SET%%=*}" "${OPTIONAL_SET#*=}";
  else echo "{\"set\":\"${OPTIONAL_SET%%=*}\",\"status\":\"skipped-optional\",\"secondsRemaining\":$(remaining)}" > "$OUT/grading-${OPTIONAL_SET%%=*}.status.json"; fi
fi
if [ "$SET_FAILURES" = 0 ]; then STATUS=completed; else STATUS=partial; FAIL_REASON="$SET_FAILURES set(s) not completed; see per-set status files"; fi
