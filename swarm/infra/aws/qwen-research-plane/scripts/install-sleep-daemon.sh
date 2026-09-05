#!/bin/bash
# Install the sleep-cycle daemon and the weekly consolidation timer on the
# research runner host. Runs ON the runner over SSM.
#
#   install-sleep-daemon.sh <sleep-image> <qwen-metrics-url> <standing-orders-s3-uri> <trainer-image> <trainer-instance-id>
#
# The daemon shares /var/lib/amos-research/replay with the job runner (the
# runner syncs it to S3 at job boundaries) and reads the Qwen API key from the
# same secret the runner uses.
set -euo pipefail
IMAGE="${1:?sleep image}"; METRICS_URL="${2:?qwen metrics url}"; ORDERS_URI="${3:?standing orders s3 uri}"
TRAINER_IMAGE="${4:?trainer image}"; TRAINER_ID="${5:?trainer instance id}"
source /etc/amos-research-runner.env
# systemd does not expand shell defaults, so the model list is rendered literally.
GRADING_MODELS="${6:-$AMOS_QWEN_SERVED_MODEL}"
# The host has the AWS CLI but not boto3; the runner container is where boto3 lives.
API_KEY="$(aws secretsmanager get-secret-value --region "$AMOS_AWS_REGION" --secret-id "$AMOS_QWEN_SECRET_ID" --query SecretString --output text | python3 -c 'import json,sys; print(json.load(sys.stdin)["api_key"])')"
install -d -m 0750 /var/lib/amos-research/sleep /var/lib/amos-research/replay
aws s3 cp "$ORDERS_URI" /var/lib/amos-research/sleep/standing-orders.json --only-show-errors
chown -R 10002:10002 /var/lib/amos-research/sleep
chmod -R a+rwX /var/lib/amos-research/replay
umask 077
cat > /etc/amos-sleep.env <<ENV
AMOS_QWEN_RESEARCH_URL=${AMOS_QWEN_API_BASE%/v1}
AMOS_LOCAL_BENCHMARK_API_KEY=$API_KEY
AMOS_QWEN_SERVED_MODEL=$AMOS_QWEN_SERVED_MODEL
AMOS_RESEARCH_ARTIFACT_BUCKET=$AMOS_RESEARCH_ARTIFACT_BUCKET
AMOS_TRAINER_IMAGE_URI=$TRAINER_IMAGE
AMOS_TRAINER_INSTANCE_ID=$TRAINER_ID
AWS_REGION=$AMOS_AWS_REGION
ENV
aws ecr get-login-password --region "$AMOS_AWS_REGION" | docker login --username AWS --password-stdin "${IMAGE%%/*}" >/dev/null 2>&1
docker pull "$IMAGE" >/dev/null
cat > /etc/systemd/system/amos-sleep-cycle.service <<UNIT
[Unit]
Description=AMOS organism sleep cycle (idle-time grading and harvesting)
After=docker.service network-online.target
Requires=docker.service
[Service]
Type=simple
Restart=always
RestartSec=30
ExecStartPre=-/usr/bin/docker rm -f amos-sleep-cycle
ExecStart=/usr/bin/docker run --name amos-sleep-cycle --rm --network=host --env-file /etc/amos-sleep.env \
  -v /var/lib/amos-research/replay:/var/lib/amos-research/replay -v /var/lib/amos-research/sleep:/var/lib/amos-research/sleep \
  $IMAGE swarm/scripts/runSleepCycle.js --standing-orders /var/lib/amos-research/sleep/standing-orders.json \
  --store /var/lib/amos-research/replay --ledger /var/lib/amos-research/sleep/sleep-ledger.jsonl \
  --reports-dir /var/lib/amos-research/sleep/reports --metrics-url $METRICS_URL \
  --quiet-seconds 300 --poll-seconds 30 --max-cycle-seconds 7200 --enable-grading --grading-model-ids $GRADING_MODELS --daemon
ExecStop=/usr/bin/docker stop --time 30 amos-sleep-cycle
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/amos-consolidation.service <<UNIT
[Unit]
Description=AMOS organism weekly adapter consolidation (plan and execute when the data gate is clear)
After=docker.service network-online.target
[Service]
Type=oneshot
ExecStart=/usr/bin/docker run --name amos-consolidation --rm --network=host --env-file /etc/amos-sleep.env \
  -v /var/lib/amos-research/replay:/var/lib/amos-research/replay -v /var/lib/amos-research/sleep:/var/lib/amos-research/sleep \
  $IMAGE swarm/scripts/runAdapterConsolidation.js --store /var/lib/amos-research/replay \
  --output /var/lib/amos-research/sleep/consolidation --ranks 32 --seeds 20260903,20260904,20260905 \
  --exclude-treatments amos-native-stage0-curriculum-v1,amos-native-stage1-curriculum-v1 --execute --start-retry-minutes 240
UNIT
cat > /etc/systemd/system/amos-consolidation.timer <<UNIT
[Unit]
Description=Weekly AMOS adapter consolidation
[Timer]
OnCalendar=Sun *-*-* 03:00:00 UTC
Persistent=true
[Install]
WantedBy=timers.target
UNIT
# The job runner syncs the replay store with S3 only around jobs. The daemon and
# the consolidation run from the same host directory, so keep it converged
# hourly in both directions (objects are immutable and content-addressed, so a
# two-way sync never conflicts).
cat > /usr/local/bin/amos-replay-sync <<'SYNC'
#!/bin/bash
set -euo pipefail
source /etc/amos-research-runner.env
aws s3 sync "s3://$AMOS_RESEARCH_ARTIFACT_BUCKET/replay/" /var/lib/amos-research/replay/ --region "$AMOS_AWS_REGION" --only-show-errors
aws s3 sync /var/lib/amos-research/replay/ "s3://$AMOS_RESEARCH_ARTIFACT_BUCKET/replay/" --region "$AMOS_AWS_REGION" --only-show-errors
aws s3 sync /var/lib/amos-research/sleep/ "s3://$AMOS_RESEARCH_ARTIFACT_BUCKET/sleep/state/" --region "$AMOS_AWS_REGION" --only-show-errors --exclude "consolidation/*/dataset/*"
chmod -R a+rwX /var/lib/amos-research/replay 2>/dev/null || true
SYNC
chmod 0755 /usr/local/bin/amos-replay-sync
cat > /etc/systemd/system/amos-replay-sync.service <<UNIT
[Unit]
Description=Converge the AMOS replay store and sleep state with S3
[Service]
Type=oneshot
ExecStart=/usr/local/bin/amos-replay-sync
UNIT
cat > /etc/systemd/system/amos-replay-sync.timer <<UNIT
[Unit]
Description=Hourly AMOS replay store sync
[Timer]
OnBootSec=5min
OnUnitActiveSec=1h
Persistent=true
[Install]
WantedBy=timers.target
UNIT
sed -i 's#^ExecStart=/usr/bin/docker run --name amos-consolidation#ExecStartPre=/usr/local/bin/amos-replay-sync\nExecStart=/usr/bin/docker run --name amos-consolidation#' /etc/systemd/system/amos-consolidation.service
systemctl daemon-reload
systemctl enable --now amos-sleep-cycle.service
systemctl enable --now amos-consolidation.timer
systemctl enable --now amos-replay-sync.timer
systemctl start amos-replay-sync.service
sleep 5
systemctl is-active amos-sleep-cycle.service
docker logs --tail 5 amos-sleep-cycle 2>&1 | cut -c1-300
