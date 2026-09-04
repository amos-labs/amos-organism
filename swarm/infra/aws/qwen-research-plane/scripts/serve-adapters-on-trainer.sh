#!/bin/bash
# Serve the cached bf16 base checkpoint plus one or more trained adapters from
# the idle disposable trainer, for grading only. Runs ON the trainer over SSM.
#
#   serve-adapters-on-trainer.sh <api-key> <verifier-image> <name>=<s3-adapter-uri> [<name>=<s3-uri> ...]
#
# The base model is the canonical Qwen3.8-27B checkpoint already on disk at
# /opt/amos-stage0/base-model, served as "base-bf16". Each adapter is synced
# from S3 to /opt/amos-adapters/<name> and registered as a LoRA module under
# <name>. Nothing here touches the live inference cell.
set -euo pipefail
API_KEY="${1:?api key required}"
IMAGE="${2:?verifier image required}"
shift 2
[[ $# -ge 1 ]] || { echo "at least one <name>=<s3-uri> adapter is required"; exit 1; }
install -d -m 0755 /opt/amos-adapters
MODULES=()
for spec in "$@"; do
  NAME="${spec%%=*}"; URI="${spec#*=}"
  [[ "$NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$ ]] || { echo "invalid adapter name $NAME"; exit 1; }
  [[ "$URI" =~ ^s3://[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]/ ]] || { echo "invalid s3 uri $URI"; exit 1; }
  aws s3 sync "$URI/" "/opt/amos-adapters/$NAME/" --only-show-errors
  test -f "/opt/amos-adapters/$NAME/adapter_config.json" || { echo "adapter_config.json missing for $NAME"; exit 1; }
  MODULES+=("$NAME=/adapters/$NAME")
done
MAX_RANK="$(python3 -c 'import json,sys,glob; print(max(json.load(open(p))["r"] for p in glob.glob("/opt/amos-adapters/*/adapter_config.json")))')"
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin "${IMAGE%%/*}" >/dev/null 2>&1
docker pull "$IMAGE" >/dev/null
docker rm -f amos-adapter-grading >/dev/null 2>&1 || true
install -d -m 0777 /opt/amos-grading-cache
docker run -d --name amos-adapter-grading --gpus all --ipc=host --network=host \
  --env VLLM_USE_FLASHINFER_SAMPLER=0 --env VLLM_NO_USAGE_STATS=1 --env VLLM_DO_NOT_TRACK=1 \
  --env HOME=/cache/home --env HF_HOME=/cache/hf --env TRITON_CACHE_DIR=/cache/triton --env XDG_CACHE_HOME=/cache/xdg \
  --volume /opt/amos-stage0/base-model:/base:ro \
  --volume /opt/amos-adapters:/adapters:ro \
  --volume /opt/amos-grading-cache:/cache:rw \
  --entrypoint python "$IMAGE" -m vllm.entrypoints.openai.api_server \
  --host 127.0.0.1 --port 8000 --api-key "$API_KEY" \
  --model /base --served-model-name base-bf16 \
  --enable-lora --lora-modules "${MODULES[@]}" --max-lora-rank "$MAX_RANK" --max-loras "$#" \
  --max-model-len 6144 --gpu-memory-utilization 0.9 --enforce-eager --no-enable-log-requests
echo "started amos-adapter-grading with modules: ${MODULES[*]}"
for _ in $(seq 1 120); do
  if curl -fsS -H "authorization: Bearer $API_KEY" http://127.0.0.1:8000/v1/models >/dev/null 2>&1; then
    curl -fsS -H "authorization: Bearer $API_KEY" http://127.0.0.1:8000/v1/models | python3 -c 'import json,sys; print("ready:", [m["id"] for m in json.load(sys.stdin)["data"]])'
    exit 0
  fi
  sleep 10
done
echo "vLLM did not become ready; last log lines:"; docker logs --tail 40 amos-adapter-grading; exit 1
