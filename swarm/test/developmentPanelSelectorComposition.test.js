import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { compileDevelopmentPanel, PANEL_FAMILIES, CASES_PER_FAMILY } from "../src/developmentPanelCompiler.js";

// Composes the ACTUAL Codex selector (amos.development-checkpoint-selection.v1,
// SHA 9c8d6286...) with this compiler's real output, proving the emitted caseIds and
// numeric seed are accepted end-to-end. The selector is Codex-owned and lives outside
// this repo; the test resolves it by env override or known coordination paths and
// SKIPS with a clear message when absent (e.g. CI checks out only amos-organism). Run
// locally against the pinned selector; evidence is reported in the mailbox/PR.
const SELECTOR_SHA = "9c8d628684e6a8153b1f2f849446741c1c5183e11af100d80b3a592313a3ab5c";
const CANDIDATES = [
  process.env.A0_SELECTOR_PATH,
  new URL("../../../../coordination/artifacts/successor-experiment-complete-review-20260912/developmentCheckpointSelection.mjs", import.meta.url).pathname,
].filter(Boolean);
const selectorPath = CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const H = (seed) => sha256(String(seed)); // deterministic synthetic 64-hex digest
const SEED = "20260910";

function panelSpecs() {
  const specs = [];
  for (const family of PANEL_FAMILIES) {
    for (let i = 0; i < CASES_PER_FAMILY; i++) specs.push({ family, body: { family, n: i, prompt: `${family}-case-${i}` } });
  }
  return specs;
}

function buildContract(panel) {
  return {
    schema: "amos.development-checkpoint-selection.v1",
    partition: "development",
    seed: panel.seedNumeric,
    panelSha256: panel.panelSha256.length === 64 ? panel.panelSha256 : H("panel"),
    graderSha256: H("grader"),
    inferenceSettingsSha256: H("inference"),
    recipeSha256: H("recipe"),
    parentAdapterSha256: H("parent-adapter"),
    cases: panel.cases,
    checkpoints: [1, 2, 3].map((k) => ({ id: `ckpt-${k}`, epoch: k, optimizerSteps: 119 * k, adapterSha256: H(`ckpt-${k}`) })),
  };
}

// Build a report giving `passCount` passes across the 96 cases (fills families evenly).
function buildReport(contract, id, epoch, optimizerSteps, adapterSha256, passCount) {
  let remaining = passCount;
  const results = contract.cases.map((c, idx) => ({
    caseId: c.caseId,
    family: c.family,
    outcome: remaining-- > 0 ? "pass" : "fail",
    evidenceSha256: H(`${id}-${idx}`),
  }));
  return {
    id, partition: "development", seed: contract.seed, adapterSha256, epoch, optimizerSteps,
    panelSha256: contract.panelSha256, graderSha256: contract.graderSha256,
    inferenceSettingsSha256: contract.inferenceSettingsSha256, recipeSha256: contract.recipeSha256,
    results,
  };
}

test("compiler output is accepted by the actual selector; strict gain selects earliest tie, no gain retains parent", async (t) => {
  if (!selectorPath) { t.skip("Codex selector not resolvable (set A0_SELECTOR_PATH); run locally"); return; }
  const selectorSource = fs.readFileSync(selectorPath, "utf8");
  assert.equal(sha256(selectorSource), SELECTOR_SHA, "pinned selector SHA 9c8d6286 must match");
  const { selectDevelopmentCheckpoint } = await import(pathToFileURL(selectorPath));

  const panel = compileDevelopmentPanel(panelSpecs(), { seed: SEED });
  const contract = buildContract(panel);

  // strict gain: parent 88/96, all three checkpoints 96/96 -> select earliest (epoch 1)
  const gainReports = [
    buildReport(contract, "parent", 0, 0, contract.parentAdapterSha256, 88),
    ...contract.checkpoints.map((cp) => buildReport(contract, cp.id, cp.epoch, cp.optimizerSteps, cp.adapterSha256, 96)),
  ];
  const gain = selectDevelopmentCheckpoint(contract, gainReports);
  assert.equal(gain.status, "development-candidate");
  assert.equal(gain.selectedCheckpointId, "ckpt-1", "earliest optimizer update wins the tie");
  assert.equal(gain.qualificationPassed, false);
  assert.equal(gain.promotionAllowed, false);
  assert.equal(gain.learningGainEstablished, false);

  // no gain: parent 96/96, children 96/96 -> retain parent
  const flatReports = [
    buildReport(contract, "parent", 0, 0, contract.parentAdapterSha256, 96),
    ...contract.checkpoints.map((cp) => buildReport(contract, cp.id, cp.epoch, cp.optimizerSteps, cp.adapterSha256, 96)),
  ];
  const flat = selectDevelopmentCheckpoint(contract, flatReports);
  assert.equal(flat.status, "retain-parent");
  assert.equal(flat.selectedCheckpointId, null);
});
