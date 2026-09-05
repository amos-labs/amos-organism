# Sleep-cycle daemon and consolidation runner image. Runs on the research
# runner host beside the job runner; reads the shared replay store, talks to the
# private Qwen endpoint, and calls AWS for consolidation.
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}
ENV DEBIAN_FRONTEND=noninteractive NODE_ENV=production
RUN sed -i 's|http://|https://|g' /etc/apt/sources.list /etc/apt/sources.list.d/*.sources 2>/dev/null || true; \
    apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip git python3 \
    && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscli.zip \
    && unzip -q /tmp/awscli.zip -d /tmp && /tmp/aws/install && rm -rf /tmp/aws /tmp/awscli.zip \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/amos-organism
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY contracts ./contracts
COPY swarm/src ./swarm/src
COPY swarm/scripts ./swarm/scripts
COPY swarm/benchmarks/amos-tool-catalog-v1.json swarm/benchmarks/swarm-qwen-adapter-training-v1.json swarm/benchmarks/qwen38-27b-training-checkpoint-v1.json swarm/benchmarks/swarm-organism-owned-missions-v1.json swarm/benchmarks/swarm-organism-owned-verifiers-v1.json ./swarm/benchmarks/
RUN useradd --create-home --uid 10002 organism && chown -R organism:organism /opt/amos-organism
USER organism
ENTRYPOINT ["node"]
CMD ["swarm/scripts/runSleepCycle.js", "--help"]
