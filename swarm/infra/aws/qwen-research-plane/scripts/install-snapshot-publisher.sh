#!/bin/bash
# Install the hourly learning-selection-snapshot publisher on the research runner.
#
#   install-snapshot-publisher.sh <sleep-image> <runtime-pin> [<runtime-pin> ...]
#
# Each runtime pin is modelId@revision[:adapterSha256] (see
# scripts/publishLearningSelectionSnapshot.ts). The publisher replays the
# organism event chain read-only, writes the snapshot plus a .digest sidecar to
# /var/lib/amos-research/organism/, and copies both to
# s3://$AMOS_RESEARCH_ARTIFACT_BUCKET/sleep/learning-selection-snapshot.json[.digest]
# for the Platform to fetch. Runs hourly; a gene-less chain publishes the empty snapshot.
set -euo pipefail
source /etc/amos-research-runner.env
IMAGE="${1:?sleep image}"; shift
[ "$#" -ge 1 ] || { echo "at least one runtime pin is required" >&2; exit 2; }
PINS=""
for pin in "$@"; do PINS="$PINS --runtime $pin"; done
ORG_DIR=/var/lib/amos-research/organism
install -d -o 10002 -g 10002 -m 0750 "$ORG_DIR"

cat > /usr/local/bin/amos-snapshot-publish <<PUB
#!/bin/bash
set -euo pipefail
source /etc/amos-research-runner.env
/usr/bin/docker run --name amos-snapshot-publish --rm --network=host \\
  -v $ORG_DIR:$ORG_DIR \\
  $IMAGE scripts/publishLearningSelectionSnapshot.ts \\
  --events $ORG_DIR/platform-events.jsonl --out $ORG_DIR/learning-selection-snapshot.json --valid-hours 6 $PINS
aws s3 cp $ORG_DIR/learning-selection-snapshot.json "s3://\$AMOS_RESEARCH_ARTIFACT_BUCKET/sleep/learning-selection-snapshot.json" --region "\$AMOS_AWS_REGION" --only-show-errors
aws s3 cp $ORG_DIR/learning-selection-snapshot.json.digest "s3://\$AMOS_RESEARCH_ARTIFACT_BUCKET/sleep/learning-selection-snapshot.json.digest" --region "\$AMOS_AWS_REGION" --only-show-errors
echo "published \$(cat $ORG_DIR/learning-selection-snapshot.json.digest)"
PUB
chmod 0755 /usr/local/bin/amos-snapshot-publish

cat > /etc/systemd/system/amos-snapshot-publish.service <<UNIT
[Unit]
Description=Publish the AMOS learning selection snapshot from the organism event chain
After=docker.service
Requires=docker.service
[Service]
Type=oneshot
ExecStartPre=-/usr/bin/docker rm -f amos-snapshot-publish
ExecStart=/usr/local/bin/amos-snapshot-publish
UNIT
cat > /etc/systemd/system/amos-snapshot-publish.timer <<UNIT
[Unit]
Description=Hourly AMOS learning selection snapshot publication
[Timer]
OnBootSec=10min
OnUnitActiveSec=1h
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now amos-snapshot-publish.timer
systemctl start amos-snapshot-publish.service
systemctl is-active amos-snapshot-publish.timer
cat "$ORG_DIR/learning-selection-snapshot.json.digest"
