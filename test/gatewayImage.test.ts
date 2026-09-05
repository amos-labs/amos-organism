import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const enabled = process.env.CI === "true" || process.env.AMOS_TEST_GATEWAY_IMAGE === "1";

// Required CI already runs this suite. Local opt-in: AMOS_TEST_GATEWAY_IMAGE=1
// node --test test/gatewayImage.test.ts. No model calls or credentials are used.
test("the gateway image starts with only its packaged dependencies", { skip: !enabled, timeout: 180_000 }, async () => {
  const image = `amos-mission-gateway:smoke-${process.pid}`;
  const docker = (args: string[], timeout = 15_000) => exec("docker", args, { cwd: root, timeout, maxBuffer: 4 * 1024 * 1024 });
  let containerId: string | null = null;
  try {
    await docker(["build", "--build-arg", `AMOS_SOURCE_REVISION=${process.env.GITHUB_SHA || "local-smoke"}`,
      "-f", "swarm/infra/aws/qwen-inference/gateway/Dockerfile", "-t", image, "."], 120_000);
    containerId = (await docker(["run", "-d", "--network", "none", image,
      "--backend-url", "http://127.0.0.1:9", "--host", "127.0.0.1", "--port", "18081"])).stdout.trim();
    for (let attempt = 0; attempt < 15; attempt++) {
      try {
        await docker(["exec", containerId, "node", "--input-type=module", "-e",
          'const r = await fetch("http://127.0.0.1:18081/health"); const body = await r.json(); if (!r.ok || body.ok !== true || body.service !== "amos-swarm-turn-gateway") process.exit(1);'], 2_000);
        return;
      } catch {
        await delay(500);
      }
    }
    const logs = await docker(["logs", containerId]);
    throw new Error(`Packaged gateway did not become healthy: ${logs.stdout}${logs.stderr}`);
  } finally {
    if (containerId) await docker(["rm", "-f", containerId]);
    await docker(["image", "rm", "-f", image]).catch(() => {});
  }
});
