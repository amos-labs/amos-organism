# Sleep-cycle daemon and consolidation runner image. Runs on the research
# runner host beside the job runner; reads the shared replay store, talks to the
# private Qwen endpoint, and calls AWS for consolidation.
#
# The full Node image is used deliberately: research hosts have HTTPS-only
# egress and the slim image has no CA bundle for apt, so nothing here uses apt.
ARG NODE_IMAGE=node:22-bookworm
FROM ${NODE_IMAGE}
ENV NODE_ENV=production AWS_PAGER=""
RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscli.zip \
    && python3 -c "import zipfile; zipfile.ZipFile('/tmp/awscli.zip').extractall('/tmp')" \
    && chmod +x /tmp/aws/install /tmp/aws/dist/aws /tmp/aws/dist/aws_completer \
    && /tmp/aws/install && rm -rf /tmp/aws /tmp/awscli.zip \
    && aws --version
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
