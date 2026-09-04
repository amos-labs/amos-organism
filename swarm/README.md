# Swarm: the Qwen self-learning experiment

This directory is the running experiment behind the organism: **can a Qwen base
model be made frontier-good at *learning* — not by training a bigger model, but
by wrapping it in a swarm that produces, verifies, and inherits procedures — and
can the results be measured honestly enough to trust them?**

Everything here used to live in `amos-agent` under `src/research`, `scripts`,
`benchmarks`, and `infra/aws`. It now lives next to the organism kernel it
feeds, so one `npm run check` exercises the kernel and the swarm together and
the swarm reads the kernel's contracts instead of carrying copies.

## What the experiment is

Three ideas, tested one at a time and only promoted on verified evidence:

1. **Swarm over single model.** A mission is compiled into bounded specialist
   roles (planner, worker, critic, integrator). Qwen 3.8 27B plays every role.
   The swarm's output is only accepted when an *independent* checker, not the
   model, says the artifact meets the criteria (`src/swarmTaskCoordinator.js`,
   `src/swarmTurnGateway.js`).
2. **Holographic shared state (HRR).** Specialists share attention through a
   holographic reduced representation instead of a chat transcript. HRR is
   attention, never evidence: it can point a worker at something, it cannot
   prove anything (`src/holographicWorldV2.js`, `src/dualChannelHolographicWorld.js`,
   `src/holographicSwarmKernel.js`).
3. **Organism metabolism.** Verified outcomes become *strategy genes*
   (portable procedures with lineage). Genes are selected, mutated, recombined,
   and admitted only through host receipts; failed runs become negative
   experience with zero fitness. Adapter training (LoRA stage 0) is fed only from
   rights-cleared, verified episodes (`src/swarmProcedureExtraction.js`,
   `src/swarmOrganismSimulator.js`, `src/swarmOrganismLearningCycle.js`,
   `src/amosNativeTrainingDataset.js`, `src/qwenAdapterTrainingContract.js`).

Frontier quality is measured against a frozen portfolio with Opus as the
control arm (`benchmarks/frontier-quality-portfolio-v1.json`,
`src/frontierQualityPortfolio.js`, `src/blindComparison.js`). Development
missions are visible fixtures; challenge/holdout missions are sealed.

## The loop

```
   mission fixtures ──► swarm run (Qwen via vLLM, Harbor for Terminal-Bench)
        ▲                          │
        │                          ▼ episodes + checker receipts
   policy select ◄── simulate ◄── swarm-learning store (immutable, digested)
        │                          │
        │                          ▼ exportOrganismTraceBundle
        │                organism kernel: importTraceBundle → gene.admitted
        │                          │
        └────── adapter dataset ◄──┘ (rights-cleared, verified only)
```

Concretely, one recursive cycle (`infra/aws/qwen-inference/scripts/run-recursive-organism-cycle.sh`) is:

1. `benchmarkDualChannelHolographicWorld.js` — check the HRR substrate still
   separates signal from hard negatives on the frozen fixture.
2. `run-terminal-bench-holographic-swarm.sh` — run the holographic swarm agent
   (`benchmarks/harbor_agents/amos_holographic_swarm.py`) on a Terminal-Bench
   task through Harbor against the private Qwen endpoint.
3. `collectHarborSwarmEpisodes.js` — pull the run into the swarm-learning store
   with digests; `exportOrganismTraceBundle.js` — turn verified episodes into an
   organism trace bundle; `scripts/importTraceBundle.ts` (kernel) — settle it
   into the event chain and admit approved genes.
4. `simulateSwarmOrganismTraining.js` — CEM search over the ecological policy
   using the store as calibration; `createSwarmOrganismPromotionQueue.js` and
   `evaluateSwarmOrganismCandidates.js` — real-Qwen promotion gates;
   `replaySwarmOrganismArtifacts.js` — replay artifacts to prove the claim.
5. `selectRecursiveOrganismPolicy.js` — pick the next policy only if verified
   improvement exists; `summarizeRecursiveOrganismCycle.js` — write the cycle
   summary.

## Layout

| Path | What is there |
| --- | --- |
| `src/` | The research modules (plain ESM `.js`). `organismContracts.js` and `experimentProtocol.js` import the kernel's `src/contracts.ts` and `src/digest.ts`. |
| `src/runtime/` | Pinned AMOS Desktop bindings (prompt digest, tool-schema version, local Qwen catalog entry, MTPLX/Ollama release manifests). Data only; see the header of `desktopBindings.js` for provenance. |
| `scripts/` | Runnable entry points. Every `research:*` npm script in `package.json` points here. |
| `test/` | `node --test` suites, run by `npm test` together with the kernel tests. |
| `benchmarks/` | Frozen fixtures (missions, verifiers, policy contracts, training plans), `harbor_agents/` (Python agents for Harbor / Terminal-Bench), and `results/` (recorded runs, see below). |
| `infra/aws/qwen-inference/` | Terraform for the private vLLM cell, the Swarm Mission gateway image, and the `run-*.sh` drivers. |
| `infra/aws/qwen-research-plane/` | Terraform for the no-ingress runner (SQS → Harbor → S3), the LoRA stage-0 trainer image, and the adapter verifier. |
| `../docs/swarm/` | Program, protocol, Platform Mission worker contract, slice map, canary runbook. |

## Running things

Local, no cloud needed (Node 24; `npm install` once at the repo root):

```bash
npm run check                          # typecheck kernel, syntax-check swarm, run all tests
npm run test:swarm                     # swarm tests only
npm run research:swarm:hrr-v2 -- --out /tmp/hrr-v2.json
npm run research:swarm:hrr-dual -- --out /tmp/hrr-dual.json
npm run research:validate-quality-portfolio
npm run research:memory-benchmark -- --dry-run --output /tmp/memory-benchmark.json
npm run research:memory-harvest -- --worker "qwen|amos-qwen38-27b-fp8|http://127.0.0.1:18080|qwen" --output /tmp/harvested.json   # needs the served model
npm run research:swarm:simulate -- --store PATH/TO/swarm-learning --output /tmp/sim.json
npm run research:swarm:replay-artifacts -- --help
npm run research:swarm:import-trace-bundle -- research/imports/verified-qwen-swarm-seed-genes-v1.json /tmp/events.jsonl
```

Fixture defaults resolve relative to `swarm/`, so the scripts work from any
working directory; pass explicit paths to override.

Against the private Qwen endpoint (needs the inference cell up, see
`infra/aws/qwen-inference/README.md`):

```bash
npm run research:swarm -- --control qwen-swarm --output /tmp/swarm.json --url http://127.0.0.1:8000 --allow-remote
npm run research:swarm:phase-probes -- --output /tmp/probes.json
npm run research:swarm:blind -- --help
npm run research:swarm:gateway -- --help    # the Swarm Mission gateway (Platform Mission worker)
```

Cloud runs go through `infra/aws/qwen-research-plane/scripts/submit-job.sh`;
the runner image is built from this repository alone
(`scripts/build-runner-image.sh`), the organism kernel is at `/app` inside it.

Python (Harbor agents, trainer, adapter verifier):

```bash
pip install harbor==0.22.0 pytest      # harbor is required by two agent test modules
npm run test:python
```

`runQwenResearchBaseline.js` (Phase-0 baseline) measures Qwen against the AMOS
Desktop production tool surface. That qualification suite stays with Desktop
in `amos-agent` (`scripts/benchmarkLocalModels.js`); pass its location with
`--benchmark-script PATH` or `AMOS_LOCAL_BENCHMARK_SCRIPT`.

## Where results land

- `benchmarks/results/` — committed, digested run reports (Phase-0 AWS baseline,
  blind Qwen-vs-swarm development runs, Opus challenge qualification, HRR v2 and
  dual-channel results).
- `../research/imports/` and `../research/events/` — organism trace bundles
  exported from verified runs and the event chains settled from them; three
  admitted seed genes live there.
- `../docs/EXPERIMENTS.md` — the running experiment log.
- Local stores default to `.amos-agent/research/swarm-learning` (ignored by
  git); the cloud runner uses `AMOS_SWARM_REPLAY_DIR` and S3.

## What was deliberately left in amos-agent

- `scripts/benchmarkLocalModels.js`, `scripts/benchmarkKnowledgeIntegration.js`,
  `src/model/knowledgeIntegration.js` and the `knowledge-integration-*.json`
  fixtures: Desktop local-model qualification. They depend on Desktop's tool
  registry and prompt and have nothing to do with the swarm.
- The Desktop local-runtime process managers (`managedOllamaRuntime.js`,
  `managedMtplxRuntime.js`, `offlineIntelligence.js`). The swarm only needs
  their constants, which are pinned in `src/runtime/desktopBindings.js`.
