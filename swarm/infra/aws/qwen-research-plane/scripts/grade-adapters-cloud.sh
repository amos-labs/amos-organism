#!/bin/bash
# Cloud grading controller: base bf16 vs adapters, run entirely on the trainer
# against its loopback vLLM. Bounded by an absolute deadline; every exit path
# uploads evidence and shuts the trainer down. First used for run
# grade-060408-20260906T0900Z (2026-09-06); parameters below are that run's,
# override them through the environment for the next one. Review findings from
# Codex (20260906T084136Z) folded in: writable output dir for the grader uid,
# truthful per-set and overall status, fail-closed manifest upload, exit code
# captured before set +e.
set -u
export HOME=/root
RUN_ID="${RUN_ID:-grade-060408-20260906T0900Z}"
DEADLINE_EPOCH=$(date -u -d "${DEADLINE_UTC:-2026-09-06T11:35:00Z}" +%s)
GRADER_UID="${GRADER_UID:-10002}"
BUCKET="amos-qwen-research-plane-637423327454-us-east-1"
PLAN="stage1/stage1-2026-09-060408"
DEST="s3://$BUCKET/$PLAN/grading/$RUN_ID"
VERIFIER="637423327454.dkr.ecr.us-east-1.amazonaws.com/amos-qwen-research-plane/trainer@sha256:c8ab89b737936c9775042050c175bbc45222eea61850322f798ad7d4e0fcfe9b"
SLEEP_IMAGE="637423327454.dkr.ecr.us-east-1.amazonaws.com/amos-qwen-research-plane/trainer@sha256:ff962a7f5f5679a11e50ee424e5add9477a9fe02b4c11447f2f426bcbacc0432"
SRC_URI="s3://$BUCKET/build/amos-organism-71598a8.tar.gz"
SRC_SHA_EXPECTED="3215686e511377a91c72ce4166d5ae8d6c13df597b73885b5ee6069d979e691a"
SRC_REVISION="71598a8cc7cb5610b7abd9b7919f7d4e9f8b148c"
ROOT=/opt/amos-grading/$RUN_ID
OUT=$ROOT/out
mkdir -p "$ROOT/src" "$OUT"
# The grader image runs as an unprivileged uid; the report directory must be its.
chown "$GRADER_UID:$GRADER_UID" "$OUT" && chmod 0775 "$OUT"
API_KEY=$(python3 -c 'import secrets; print(secrets.token_hex(24))')
STATUS=started
FAIL_REASON=""

finish() {
  local code=$?
  set +e
  [ "$STATUS" = "started" ] && STATUS="exited-$code"
  echo "{\"runId\":\"$RUN_ID\",\"status\":\"$STATUS\",\"reason\":\"$FAIL_REASON\",\"finishedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$OUT/status.json"
  docker logs --tail 200 amos-adapter-grading > "$OUT/vllm-tail.log" 2>&1 || true
  aws s3 sync "$OUT/" "$DEST/" --only-show-errors || true
  docker rm -f amos-adapter-grading >/dev/null 2>&1 || true
  docker rm -f amos-grader >/dev/null 2>&1 || true
  logger -t amos-grading "$RUN_ID $STATUS $FAIL_REASON"
  echo "FINISHED $STATUS $FAIL_REASON"
  shutdown -h +1 "amos grading $RUN_ID finished: $STATUS" >/dev/null 2>&1 || true
}
trap finish EXIT

remaining() { echo $(( DEADLINE_EPOCH - $(date -u +%s) )); }
die() { STATUS=failed; FAIL_REASON="$1"; echo "FAIL: $1"; exit 1; }

[ "$(remaining)" -gt 1800 ] || die "less than 30 minutes before the deadline at start"

# 1. Pinned grader source
aws s3 cp "$SRC_URI" "$ROOT/src.tar.gz" --only-show-errors || die "source download failed"
SRC_SHA=$(sha256sum "$ROOT/src.tar.gz" | cut -c1-64)
[ "$SRC_SHA" = "$SRC_SHA_EXPECTED" ] || die "source archive sha mismatch $SRC_SHA"
tar -xzf "$ROOT/src.tar.gz" -C "$ROOT/src"

# 2. Adapters
install -d -m 0755 /opt/amos-adapters
rm -rf /opt/amos-adapters/*
MODULES=()
for seed in 20260903 20260904 20260905; do
  NAME="stage1-060408-r32-s${seed: -1}"
  aws s3 sync "s3://$BUCKET/$PLAN/runs/stage1-2026-09-060408-r32-s$seed/adapter/" "/opt/amos-adapters/$NAME/" --only-show-errors || die "adapter sync failed $NAME"
  test -f "/opt/amos-adapters/$NAME/adapter_config.json" || die "adapter_config missing $NAME"
  MODULES+=("$NAME=/adapters/$NAME")
done
MAX_RANK=$(python3 -c 'import json,glob; print(max(json.load(open(p))["r"] for p in glob.glob("/opt/amos-adapters/*/adapter_config.json")))')

# 3. Frozen identity manifest (before any inference)
python3 - "$OUT/run-manifest.json" "$RUN_ID" "$VERIFIER" "$SLEEP_IMAGE" "$SRC_REVISION" "$SRC_SHA" "$DEADLINE_EPOCH" <<'PY'
import json, sys, glob, hashlib, datetime, os
out, run_id, verifier, sleep_image, src_rev, src_sha, deadline = sys.argv[1:8]
adapters = {}
for cfg in sorted(glob.glob("/opt/amos-adapters/*/adapter_config.json")):
    name = cfg.split("/")[-2]
    h = hashlib.sha256()
    with open(cfg.replace("adapter_config.json", "adapter_model.safetensors"), "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    adapters[name] = {"adapterModelSha256": h.hexdigest(), "config": json.load(open(cfg))}
manifest = {
    "schema": "amos.adapter-grading-run-manifest", "version": 1, "runId": run_id,
    "createdAt": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
    "deadline": datetime.datetime.utcfromtimestamp(int(deadline)).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "servingImage": verifier, "graderImage": sleep_image, "graderSourceRevision": src_rev, "graderSourceArchiveSha256": src_sha,
    "baseModel": {"servedAs": "base-bf16", "path": "/opt/amos-stage0/base-model"},
    "adapters": adapters,
    "sets": [s for s in [
        {"id": "frozen-implicit", "pool": "holdout", "rulebook": "implicit", "seed": "stage1-holdout-v2", "perFamily": 12, "role": "frozen regression (seed previously used for stage1 r3 frozen comparisons)"},
        {"id": "sealed-implicit-v2", "pool": "holdout", "rulebook": "implicit", "seed": "stage1-sealed-v2", "perFamily": 12, "role": "fresh sealed, never used before this run; graded once"}
    ] if s["id"] in os.environ.get("SETS", "frozen-implicit=x sealed-implicit-v2=x")],
    "settings": {"temperature": 0.2, "seed": 7, "reasoningEffort": "medium", "repairAttempts": 1, "maxOutputTokens": 1200, "concurrency": 4, "reasoningParser": "qwen3", "maxModelLen": 6144},
    "primaryMetric": "verified first-attempt pass on the fresh sealed set; also final pass, paired wins/losses vs base-bf16, per-attempt latency",
    "evidenceClass": "adapter-direct bf16 grading on the trainer; not the live FP8 serving path; no promotion implied"
}
json.dump(manifest, open(out, "w"), indent=2)
print("manifest written; adapters:", list(adapters))
PY
aws s3 sync "$OUT/" "$DEST/" --only-show-errors || die "manifest upload failed; refusing to start inference without durable identity"
# Prove the grader uid can write reports before spending GPU time.
docker run --rm --network=none -v "$OUT:/out" --entrypoint sh "$SLEEP_IMAGE" -c 'echo ok > /out/.write-probe && rm /out/.write-probe' || die "grader uid cannot write the output directory"

# 4. Serve base + adapters on loopback
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 637423327454.dkr.ecr.us-east-1.amazonaws.com >/dev/null 2>&1
docker pull -q "$VERIFIER" >/dev/null || die "verifier image pull failed"
docker pull -q "$SLEEP_IMAGE" >/dev/null || die "grader image pull failed"
docker rm -f amos-adapter-grading >/dev/null 2>&1 || true
install -d -m 0777 /opt/amos-grading-cache
docker run -d --name amos-adapter-grading --gpus all --ipc=host --network=host \
  --env VLLM_USE_FLASHINFER_SAMPLER=0 --env VLLM_NO_USAGE_STATS=1 --env VLLM_DO_NOT_TRACK=1 \
  --env HOME=/cache/home --env HF_HOME=/cache/hf --env TRITON_CACHE_DIR=/cache/triton --env XDG_CACHE_HOME=/cache/xdg \
  --volume /opt/amos-stage0/base-model:/base:ro --volume /opt/amos-adapters:/adapters:ro --volume /opt/amos-grading-cache:/cache:rw \
  --entrypoint python "$VERIFIER" -m vllm.entrypoints.openai.api_server \
  --host 127.0.0.1 --port 8000 --api-key "$API_KEY" --model /base --served-model-name base-bf16 \
  --enable-lora --lora-modules "${MODULES[@]}" --max-lora-rank "$MAX_RANK" --max-loras 3 \
  --reasoning-parser qwen3 --max-model-len 6144 --gpu-memory-utilization 0.9 --enforce-eager --no-enable-log-requests >/dev/null || die "vllm start failed"
READY=0
for _ in $(seq 1 120); do
  if curl -fsS -H "authorization: Bearer $API_KEY" http://127.0.0.1:8000/v1/models >/dev/null 2>&1; then READY=1; break; fi
  [ "$(remaining)" -gt 600 ] || break
  sleep 10
done
[ "$READY" = 1 ] || die "vllm not ready"
curl -fsS -H "authorization: Bearer $API_KEY" http://127.0.0.1:8000/v1/models | python3 -c 'import json,sys; print("served:", [m["id"] for m in json.load(sys.stdin)["data"]])' | tee "$OUT/served-models.txt"

# 5. Grade both sets, bounded by the remaining time
MODEL_IDS="base-bf16,stage1-060408-r32-s3,stage1-060408-r32-s4,stage1-060408-r32-s5"
SET_FAILURES=0
run_set() {
  local set_id="$1" seed="$2"
  local budget=$(( $(remaining) - 300 ))
  [ "$budget" -gt 600 ] || { echo "skipping $set_id: only ${budget}s left"; echo "{\"set\":\"$set_id\",\"status\":\"skipped-deadline\"}" > "$OUT/grading-$set_id.status.json"; SET_FAILURES=$((SET_FAILURES+1)); return 0; }
  echo "== $set_id seed=$seed budget=${budget}s =="
  timeout "$budget" docker run --rm --name amos-grader --network=host \
    -v "$ROOT/src:/opt/amos-organism:ro" -v "$OUT:/out" \
    --env AMOS_QWEN_RESEARCH_URL=http://127.0.0.1:8000 --env "AMOS_LOCAL_BENCHMARK_API_KEY=$API_KEY" \
    "$SLEEP_IMAGE" swarm/scripts/gradeCurriculum.js --model-ids "$MODEL_IDS" --pool holdout --rulebook implicit \
    --per-family 12 --seed "$seed" --concurrency 4 --repair-attempts 1 --max-output-tokens 1200 \
    --output "/out/grading-$set_id.json" > "$OUT/grading-$set_id.summary.json" 2> "$OUT/grading-$set_id.log"
  local rc=$?
  docker rm -f amos-grader >/dev/null 2>&1 || true
  local set_status="completed"
  if [ "$rc" = 124 ]; then set_status="timeout"; elif [ "$rc" != 0 ]; then set_status="failed"; elif [ ! -s "$OUT/grading-$set_id.json" ]; then set_status="no-report"; fi
  [ "$set_status" = "completed" ] || SET_FAILURES=$((SET_FAILURES+1))
  echo "{\"set\":\"$set_id\",\"status\":\"$set_status\",\"exit\":$rc,\"finishedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$OUT/grading-$set_id.status.json"
  aws s3 sync "$OUT/" "$DEST/" --only-show-errors
  return 0
}
# SETS: space-separated "<set-id>=<seed>" pairs; default runs both cohorts in order.
for spec in ${SETS:-frozen-implicit=stage1-holdout-v2 sealed-implicit-v2=stage1-sealed-v2}; do
  run_set "${spec%%=*}" "${spec#*=}"
done
if [ "$SET_FAILURES" = 0 ]; then STATUS=completed; else STATUS=partial; FAIL_REASON="$SET_FAILURES set(s) not completed; see per-set status files"; fi
