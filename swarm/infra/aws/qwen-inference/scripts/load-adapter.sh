#!/usr/bin/env bash
# Load a trained adapter into the live vLLM cell at runtime.
#
#   load-adapter.sh <adapter-name> <s3://.../runs/<contract-id>/adapter>
#
# Requires the cell to have been applied with enable_lora = true. Syncs the
# adapter directory to /opt/amos/adapters/<name> (mounted read-only into the
# container at /adapters) and registers it under <adapter-name>, which then
# appears as a model ID beside the base model for grading.
set -euo pipefail
NAME="${1:?adapter name required}"
SOURCE="${2:?s3 adapter URI required}"
[[ "$NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$ ]] || { echo "invalid adapter name"; exit 1; }
[[ "$SOURCE" =~ ^s3://[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]/ ]] || { echo "invalid s3 uri"; exit 1; }
DEST="/opt/amos/adapters/$NAME"
install -d -m 0755 "$DEST"
aws s3 sync "$SOURCE/" "$DEST/" --only-show-errors
test -f "$DEST/adapter_config.json" || { echo "adapter_config.json missing after sync"; exit 1; }
API_KEY="$(grep '^VLLM_API_KEY=' /etc/amos/qwen.env | cut -d= -f2-)"
curl -fsS -X POST http://127.0.0.1:8000/v1/load_lora_adapter \
  -H "content-type: application/json" \
  -H "authorization: Bearer $API_KEY" \
  -d "{\"lora_name\":\"$NAME\",\"lora_path\":\"/adapters/$NAME\"}"
echo
curl -fsS http://127.0.0.1:8000/v1/models -H "authorization: Bearer $API_KEY" | python3 -c 'import json,sys; print([m["id"] for m in json.load(sys.stdin)["data"]])'
