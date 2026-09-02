/**
 * Pinned AMOS Desktop bindings used by the Qwen research environment.
 *
 * The research environment records which production prompt contract and which
 * local Qwen 3.8 catalog entry a baseline was measured against. Those values
 * are owned by AMOS Desktop (amos-agent); the organism must not import Desktop
 * runtime code, so the exact values are snapshotted here as data. Re-pin them
 * when Desktop changes its prompt or catalog and note the source commit.
 *
 * Source: amos-agent origin/main 1b2cf1e3969013ce99c327f9b2081915a3c3b2fa
 *   - digestResearchValue(SYSTEM_PROMPT) from src/prompts.js
 *   - currentProductionToolSchemaVersion() from src/model/toolSurfaceQualification.js
 *   - OFFLINE_MODEL_MANIFEST entry for MTPLX_QWEN38_MODEL_ID from src/desktop/offlineIntelligence.js
 *   - AMOS_LOCAL_HOST from src/desktop/managedOllamaRuntime.js
 *   - AMOS_MTPLX_HOST / AMOS_MTPLX_CONTEXT_LENGTH from src/desktop/managedMtplxRuntime.js
 */

export const DESKTOP_BINDINGS_SOURCE = Object.freeze({
  repository: "amos-labs/amos-agent",
  revision: "1b2cf1e3969013ce99c327f9b2081915a3c3b2fa",
  capturedAt: "2026-09-02"
});

/** sha256 of the Desktop production system prompt (research canonical JSON digest). */
export const PRODUCTION_SYSTEM_PROMPT_DIGEST =
  "b27ee12dd4b7893c095d95df4f8e35f1029269e3d0fa638894e581a123d8ca4c";

/** Desktop production tool-surface contract version (prompt + bootstrap + catalog tools). */
export const PRODUCTION_TOOL_SCHEMA_VERSION =
  "sha256:9ec683f9fd12350733764e938872a4a4feea8fae09f55f121033812745373fb6";

/** Loopback endpoints of the Desktop-managed local runtimes. */
export const AMOS_LOCAL_HOST = "127.0.0.1:11435";
export const AMOS_MTPLX_HOST = "127.0.0.1:18081";
export const AMOS_MTPLX_CONTEXT_LENGTH = 32_768;

/** The pinned Qwen 3.8 27B catalog entry Desktop qualified for local inference. */
export const QWEN38_LOCAL_CATALOG_MODEL = Object.freeze({
  id: "hf.co/ggml-org/Qwen3.8-27B-GGUF:Q4_K_M",
  source: Object.freeze({
    type: "huggingface-ollama",
    repository: "ggml-org/Qwen3.8-27B-GGUF",
    revision: "0669b98607d47046c7c2b3f801011d54a08cfccf",
    tag: "Q4_K_M",
    ollamaManifestDigest: "75312a6ba4358b341346c0291b4f4ee1bf1eb0e3e5b35413f3790d12e67a1b4c",
    artifacts: Object.freeze([
      Object.freeze({
        role: "model",
        file: "Qwen3.8-27B-Q4_K_M.gguf",
        sha256: "31629f53165ab6a7dad8c9847dcfd1fdf55829dac1e6e748f4a68581b0033d34",
        size: 18973870432
      }),
      Object.freeze({
        role: "projector",
        file: "mmproj-Qwen3.8-27B-Q8_0.gguf",
        sha256: "2e968a6af97ce35d8971890b257b9b7edabf20ad91450501fa53162a19ee33eb",
        size: 629247008
      })
    ])
  }),
  capabilityContract: Object.freeze({
    identity: Object.freeze({
      provider: "ollama",
      model: "hf.co/ggml-org/Qwen3.8-27B-GGUF:Q4_K_M",
      protocol: "ollama",
      deployment: "local",
      runtime: "ollama",
      runtimeVersion: "0.32.5",
      quantization: "Q4_K_M",
      promptVersion: "qwen38-production-surface-2026-08-16-v3",
      toolSchemaVersion: "sha256:75f90264b60fe40626caf69c71d4ed3e12f15759406716a1bfa2602905e456b9"
    })
  })
});

export const LOCAL_MODEL_CATALOG = Object.freeze({
  models: Object.freeze([QWEN38_LOCAL_CATALOG_MODEL])
});
