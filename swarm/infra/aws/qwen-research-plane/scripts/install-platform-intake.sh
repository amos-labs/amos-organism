#!/bin/bash
# Install the signed Platform-episode intake on the research runner host. Runs
# ON the runner over SSM.
#
#   install-platform-intake.sh <sleep-image> <kms-key-arn> <public-key-s3-uri> <bearer-secret-id> [port]
#
# The intake listens on the host's private address; Platform ECS tasks reach it
# through the intake_from_platform security-group rule. Events land in the
# durable JSONL hash chain under /var/lib/amos-research/organism, which the job
# runner does not touch.
set -euo pipefail
IMAGE="${1:?sleep image}"; KEY_ARN="${2:?kms key arn}"; PUBKEY_URI="${3:?public key s3 uri}"; SECRET_ID="${4:?bearer secret id}"; PORT="${5:-8787}"
source /etc/amos-research-runner.env
install -d -m 0750 /var/lib/amos-research/organism
aws s3 cp "$PUBKEY_URI" /var/lib/amos-research/organism/platform-kms-public-key.der.b64 --only-show-errors
TOKEN="$(aws secretsmanager get-secret-value --region "$AMOS_AWS_REGION" --secret-id "$SECRET_ID" --query SecretString --output text | python3 -c 'import json,sys; print(json.load(sys.stdin)["bearer_token"])')"
chown -R 10002:10002 /var/lib/amos-research/organism
umask 077
printf 'AMOS_ORGANISM_INTAKE_BEARER_TOKEN=%s\n' "$TOKEN" > /etc/amos-intake.env
aws ecr get-login-password --region "$AMOS_AWS_REGION" | docker login --username AWS --password-stdin "${IMAGE%%/*}" >/dev/null 2>&1
docker pull "$IMAGE" >/dev/null
cat > /etc/systemd/system/amos-platform-intake.service <<UNIT
[Unit]
Description=AMOS organism intake for signed Platform Mission learning episodes
After=docker.service network-online.target
Requires=docker.service
[Service]
Type=simple
Restart=always
RestartSec=10
ExecStartPre=-/usr/bin/docker rm -f amos-platform-intake
ExecStart=/usr/bin/docker run --name amos-platform-intake --rm --network=host --env-file /etc/amos-intake.env \
  -v /var/lib/amos-research/organism:/var/lib/amos-research/organism \
  $IMAGE scripts/servePlatformEpisodeIntake.ts --events /var/lib/amos-research/organism/platform-events.jsonl \
  --kms-key-id $KEY_ARN --public-key /var/lib/amos-research/organism/platform-kms-public-key.der.b64 --host 0.0.0.0 --port $PORT
ExecStop=/usr/bin/docker stop --time 15 amos-platform-intake
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now amos-platform-intake.service
sleep 8
systemctl is-active amos-platform-intake.service
curl -fsS "http://127.0.0.1:$PORT/healthz" && echo
echo "intake endpoint: http://$(hostname -I | awk '{print $1}'):$PORT/v1/platform/episodes"
