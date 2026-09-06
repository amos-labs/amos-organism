import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The cloud controller is bash; its fault-injection harness stubs aws/docker/timeout/shutdown.
const harness = fileURLToPath(new URL("../infra/aws/qwen-research-plane/scripts/test/grade-fp8-serving-qualification.test.sh", import.meta.url));

test("FP8 serving-qualification controller: fault injection (upload, manifest, cached model, adapter config, watchdog)", (t) => {
  const bash = spawnSync("bash", ["--version"], { encoding: "utf8" });
  if (bash.status !== 0) { t.skip("bash not available"); return; }
  const result = spawnSync("bash", [harness], { encoding: "utf8", timeout: 120_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /ALL PASSED/);
});
