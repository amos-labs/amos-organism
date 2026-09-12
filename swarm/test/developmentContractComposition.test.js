import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { buildDevelopmentSelectionContract, bindCheckpointManifest } from "../src/developmentContractComposition.js";
import { compileDevelopmentPanel, PANEL_FAMILIES, CASES_PER_FAMILY } from "../src/developmentPanelCompiler.js";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const H = (s) => sha256(String(s));
const SEED = "20260910";

function panelSpecs() {
  const specs = [];
  for (const family of PANEL_FAMILIES) for (let i = 0; i < CASES_PER_FAMILY; i++) specs.push({ family, body: { family, n: i } });
  return specs;
}
function manifest() {
  return {
    schema: "amos.development-checkpoints-manifest.v1", seed: 20260910, trainingContractSha256: H("recipe"),
    checkpoints: [1, 2, 3].map((k) => ({ epoch: k, optimizerSteps: 119 * k, adapterSha256: H(`ckpt-${k}`), adapterTensorSha256: H(`tensor-${k}`), files: [] })),
  };
}
const receipts = { graderSha256: H("grader"), inferenceSettingsSha256: H("inference"), recipeSha256: H("recipe"), parentAdapterSha256: H("parent") };

test("bindCheckpointManifest requires the predeclared 119/238/357 three-epoch schedule", () => {
  const bound = bindCheckpointManifest(manifest());
  assert.deepEqual(bound.map((c) => c.optimizerSteps), [119, 238, 357]);
  assert.deepEqual(bound.map((c) => c.id), ["epoch-1-step-119", "epoch-2-step-238", "epoch-3-step-357"]);
  const bad = manifest(); bad.checkpoints[2].optimizerSteps = 400;
  assert.throws(() => bindCheckpointManifest(bad), /expected 357/);
  const two = manifest(); two.checkpoints.pop();
  assert.throws(() => bindCheckpointManifest(two), /exactly three/);
  assert.throws(() => bindCheckpointManifest({ schema: "wrong" }), /manifest.v1/);
});

test("buildDevelopmentSelectionContract assembles a schema-correct contract from real panel + manifest", () => {
  const panel = compileDevelopmentPanel(panelSpecs(), { seed: SEED });
  const contract = buildDevelopmentSelectionContract({ panel, checkpointManifest: manifest(), ...receipts });
  assert.equal(contract.schema, "amos.development-checkpoint-selection.v1");
  assert.equal(contract.partition, "development");
  assert.equal(contract.seed, 20260910);
  assert.equal(contract.panelSha256, panel.panelSha256);
  assert.equal(contract.cases.length, 96);
  assert.equal(contract.checkpoints.length, 3);
  // digest fields required
  const noGrader = { ...receipts, graderSha256: "nope" };
  assert.throws(() => buildDevelopmentSelectionContract({ panel, checkpointManifest: manifest(), ...noGrader }), /graderSha256/);
  assert.throws(() => buildDevelopmentSelectionContract({ panel: { schema: "x" }, checkpointManifest: manifest(), ...receipts }), /development-panel.v2/);
});

// Compose the ACTUAL selector (SHA-pinned 9c8d6286) with the assembled contract.
const SELECTOR_SHA = "9c8d628684e6a8153b1f2f849446741c1c5183e11af100d80b3a592313a3ab5c";
const selectorPath = [process.env.A0_SELECTOR_PATH, new URL("../../../../coordination/artifacts/successor-experiment-complete-review-20260912/developmentCheckpointSelection.mjs", import.meta.url).pathname].find((p) => { try { return p && fs.existsSync(p); } catch { return false; } });

function report(contract, id, epoch, steps, adapterSha256, passCount) {
  let rem = passCount;
  return {
    id, partition: "development", seed: contract.seed, adapterSha256, epoch, optimizerSteps: steps,
    panelSha256: contract.panelSha256, graderSha256: contract.graderSha256, inferenceSettingsSha256: contract.inferenceSettingsSha256, recipeSha256: contract.recipeSha256,
    results: contract.cases.map((c, i) => ({ caseId: c.caseId, family: c.family, outcome: rem-- > 0 ? "pass" : "fail", evidenceSha256: H(`${id}-${i}`) })),
  };
}

test("the assembled contract is accepted by the actual selector end-to-end", async (t) => {
  if (!selectorPath) { t.skip("selector not resolvable (set A0_SELECTOR_PATH); runs locally"); return; }
  assert.equal(sha256(fs.readFileSync(selectorPath, "utf8")), SELECTOR_SHA, "pinned selector SHA");
  const { selectDevelopmentCheckpoint } = await import(pathToFileURL(selectorPath));
  const panel = compileDevelopmentPanel(panelSpecs(), { seed: SEED });
  const contract = buildDevelopmentSelectionContract({ panel, checkpointManifest: manifest(), ...receipts });
  const reports = [
    report(contract, "parent", 0, 0, contract.parentAdapterSha256, 88),
    ...contract.checkpoints.map((cp) => report(contract, cp.id, cp.epoch, cp.optimizerSteps, cp.adapterSha256, 96)),
  ];
  const result = selectDevelopmentCheckpoint(contract, reports);
  assert.equal(result.status, "development-candidate");
  assert.equal(result.selectedCheckpointId, "epoch-1-step-119");
  assert.equal(result.qualificationPassed, false);
});
