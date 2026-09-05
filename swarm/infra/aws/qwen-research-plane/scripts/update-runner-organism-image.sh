#!/bin/bash
# Swap the sleep/intake image digest in the runner's organism units and restart
# the long-running services (intake, sleep daemon). The consolidation and
# snapshot-publisher units pick the new image up on their next timer run.
#
#   update-runner-organism-image.sh <new-sleep-image-uri-with-digest>
#
# Refuses to restart the intake if the new image cannot import the intake
# entrypoint (preflight in an isolated container), and fails closed if the
# intake does not answer /healthz afterwards.
set -euo pipefail
source /etc/amos-research-runner.env
NEW="${1:?new sleep image uri@sha256:...}"
[[ "$NEW" =~ @sha256:[a-f0-9]{64}$ ]] || { echo "image must be pinned by digest" >&2; exit 2; }
aws ecr get-login-password --region "$AMOS_AWS_REGION" | docker login --username AWS --password-stdin "${NEW%%/*}" >/dev/null 2>&1
docker pull -q "$NEW" >/dev/null
docker run --rm --network=none --entrypoint node "$NEW" -e "import('/opt/amos-organism/src/platformEpisodeReceiver.ts').then(()=>console.log('intake import ok'),(e)=>{console.error(e.message);process.exit(1)})"
docker run --rm --network=none --entrypoint node "$NEW" -e "import('/opt/amos-organism/swarm/scripts/runSleepCycle.js').catch((e)=>{console.error(e.message);process.exit(1)})" --help >/dev/null 2>&1 || true
OLD_LINE=$(grep -o 'amos-qwen-research-plane/trainer@sha256:[a-f0-9]*' /etc/systemd/system/amos-platform-intake.service | head -1)
echo "current: $OLD_LINE"
for unit in amos-platform-intake amos-sleep-cycle amos-consolidation; do
  f=/etc/systemd/system/$unit.service
  [ -f "$f" ] || continue
  cp "$f" "$f.bak-$(date -u +%Y%m%dT%H%M%SZ)"
  sed -i -E "s#[0-9]+\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/amos-qwen-research-plane/trainer@sha256:[a-f0-9]{64}#${NEW}#g" "$f"
done
[ -f /usr/local/bin/amos-snapshot-publish ] && sed -i -E "s#[0-9]+\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/amos-qwen-research-plane/trainer@sha256:[a-f0-9]{64}#${NEW}#g" /usr/local/bin/amos-snapshot-publish
systemctl daemon-reload
systemctl restart amos-platform-intake.service
for attempt in $(seq 1 20); do
  if curl -s -f -m 3 http://127.0.0.1:8787/healthz >/dev/null; then echo "intake healthy on $NEW"; break; fi
  sleep 3
  [ "$attempt" = 20 ] && { echo "intake did not become healthy; rolling back"; for f in /etc/systemd/system/amos-platform-intake.service; do cp "$(ls -t $f.bak-* | head -1)" "$f"; done; systemctl daemon-reload; systemctl restart amos-platform-intake.service; exit 1; }
done
systemctl restart amos-sleep-cycle.service
sleep 3
systemctl is-active amos-platform-intake.service amos-sleep-cycle.service
