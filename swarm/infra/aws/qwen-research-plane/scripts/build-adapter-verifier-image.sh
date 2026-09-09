#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SWARM_DIR="$(cd "$TF_DIR/../../.." && pwd)"
REPO_ROOT="$(cd "$SWARM_DIR/.." && pwd)"
REGION="$(terraform -chdir="$TF_DIR" output -raw aws_region 2>/dev/null || printf 'us-east-1')"
REPOSITORY_URL="$(terraform -chdir="$TF_DIR" output -raw trainer_repository_url)"
REPOSITORY_NAME="${REPOSITORY_URL#*/}"
REGISTRY="${REPOSITORY_URL%%/*}"
SOURCE_REVISION="$(git -C "$REPO_ROOT" rev-parse HEAD)"
SOURCE_DIRTY="$(git -C "$REPO_ROOT" status --porcelain --untracked-files=all)"
if [[ -n "$SOURCE_DIRTY" ]]; then
  SOURCE_STATE="dirty"
else
  SOURCE_STATE="clean"
fi
TAG="adapter-verifier-${SOURCE_REVISION:0:12}-$(date -u +%Y%m%d%H%M%S)"

aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"

# The research runner's default BuildKit cannot emit provenance/SBOM attestations
# ("attestations are not supported by the current buildkitd"). Use a bounded, named
# docker-container builder (capped CPU/memory, max-parallelism 2) — the same setup
# proven for the trainer image — and remove only that builder on exit.
BUILDER="amos-verifier-${SOURCE_REVISION:0:12}"
BUILDKIT_CONFIG="$(mktemp)"
printf '[worker.oci]\n  max-parallelism = 2\n' > "$BUILDKIT_CONFIG"
cleanup_builder() { docker buildx rm "$BUILDER" >/dev/null 2>&1 || true; rm -f "$BUILDKIT_CONFIG"; }
trap cleanup_builder EXIT
docker buildx rm "$BUILDER" >/dev/null 2>&1 || true
docker buildx create --name "$BUILDER" --driver docker-container \
  --driver-opt network=host,memory=4g,cpu-period=100000,cpu-quota=150000 \
  --config "$BUILDKIT_CONFIG"
docker buildx inspect --builder "$BUILDER" --bootstrap

docker buildx build --builder "$BUILDER" \
  --platform linux/amd64 \
  --provenance=true \
  --sbom=true \
  --label "org.opencontainers.image.revision=$SOURCE_REVISION" \
  --label "org.opencontainers.image.source-state=$SOURCE_STATE" \
  --file "$TF_DIR/adapter-verifier/Dockerfile" \
  --tag "$REPOSITORY_URL:$TAG" \
  --push \
  "$REPO_ROOT"

INDEX_DIGEST="$(aws ecr describe-images \
  --region "$REGION" \
  --repository-name "$REPOSITORY_NAME" \
  --image-ids "imageTag=$TAG" \
  --query 'imageDetails[0].imageDigest' \
  --output text)"
MANIFEST="$(aws ecr batch-get-image \
  --region "$REGION" \
  --repository-name "$REPOSITORY_NAME" \
  --image-ids "imageDigest=$INDEX_DIGEST" \
  --accepted-media-types application/vnd.oci.image.index.v1+json \
  --query 'images[0].imageManifest' \
  --output text)"
RUNTIME_DIGEST="$(jq -r '.manifests[] | select(.platform.os == "linux" and .platform.architecture == "amd64") | .digest' <<<"$MANIFEST")"
if [[ ! "$RUNTIME_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  echo "Could not resolve the linux/amd64 runtime manifest from $INDEX_DIGEST" >&2
  exit 1
fi

for _ in $(seq 1 60); do
  STATUS="$(aws ecr describe-image-scan-findings \
    --region "$REGION" \
    --repository-name "$REPOSITORY_NAME" \
    --image-id "imageDigest=$RUNTIME_DIGEST" \
    --query 'imageScanStatus.status' \
    --output text 2>/dev/null || true)"
  if [[ "$STATUS" == "COMPLETE" ]]; then
    break
  fi
  if [[ "$STATUS" == "FAILED" || "$STATUS" == "UNSUPPORTED_IMAGE" ]]; then
    echo "ECR scan failed for $RUNTIME_DIGEST: $STATUS" >&2
    exit 1
  fi
  sleep 10
done
if [[ "${STATUS:-}" != "COMPLETE" ]]; then
  echo "ECR scan did not complete for $RUNTIME_DIGEST" >&2
  exit 1
fi

FINDINGS="$(aws ecr describe-image-scan-findings \
  --region "$REGION" \
  --repository-name "$REPOSITORY_NAME" \
  --image-id "imageDigest=$RUNTIME_DIGEST" \
  --query 'imageScanFindings.findingSeverityCounts' \
  --output json)"
if [[ -z "$FINDINGS" ]]; then
  FINDINGS='{}'
fi
NONZERO="$(jq '[to_entries[] | select(.value != 0)] | length' <<<"$FINDINGS")"
if [[ "$NONZERO" != "0" ]]; then
  echo "ECR scan gate rejected $RUNTIME_DIGEST: $FINDINGS" >&2
  exit 1
fi

printf 'image=%s@%s\n' "$REPOSITORY_URL" "$INDEX_DIGEST"
printf 'runtime_manifest=%s\n' "$RUNTIME_DIGEST"
printf 'scan=%s\n' "$FINDINGS"
