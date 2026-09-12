// Assembles the Codex selector contract (amos.development-checkpoint-selection.v1,
// SHA 9c8d6286) from the three upstream A0 artifacts this lane produces: the compiled
// 96-case panel (developmentPanelCompiler v2), the trainer's checkpoint manifest
// (amos.development-checkpoints-manifest.v1, saved at 119/238/357), and the operator's
// grader / inference-settings / recipe / parent-adapter receipt digests. It only
// composes and validates already-produced, hash-verified inputs; it runs no model,
// grades nothing, and selects nothing (the selector does that). Binding the three
// actual checkpoint hashes after training cannot alter the predeclared 119/238/357
// schedule or the fixed panel.

const SHA256 = /^[a-f0-9]{64}$/;
const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/; // the selector's identifier alphabet
const EXPECTED_STEPS = [119, 238, 357];
const EXPECTED_SEED = 20260910;

function requireHash(value, name) {
  if (typeof value !== "string" || !SHA256.test(value)) throw new TypeError(`${name}: expected sha256 hex`);
}

// Verify the trainer's checkpoint manifest is the predeclared three-epoch schedule and
// return its checkpoints keyed by optimizer step, with a selector-safe id per checkpoint.
export function bindCheckpointManifest(manifest) {
  if (manifest?.schema !== "amos.development-checkpoints-manifest.v1") throw new Error("expected development-checkpoints-manifest.v1");
  if (manifest.seed !== EXPECTED_SEED) throw new Error("checkpoint manifest must use original S7 seed 20260910");
  requireHash(manifest.trainingContractSha256, "manifest.trainingContractSha256");
  if (!Array.isArray(manifest.checkpoints) || manifest.checkpoints.length !== 3) throw new Error("manifest must carry exactly three checkpoints");
  const bound = manifest.checkpoints
    .map((c) => ({ ...c }))
    .sort((a, b) => a.optimizerSteps - b.optimizerSteps);
  bound.forEach((c, i) => {
    if (c.epoch !== i + 1) throw new Error(`checkpoint ${i}: expected epoch ${i + 1}`);
    if (c.optimizerSteps !== EXPECTED_STEPS[i]) throw new Error(`checkpoint ${i}: expected ${EXPECTED_STEPS[i]} optimizer updates`);
    requireHash(c.adapterSha256, `checkpoint ${i} adapterSha256`);
    requireHash(c.adapterTensorSha256, `checkpoint ${i} adapterTensorSha256`);
    c.id = `epoch-${c.epoch}-step-${c.optimizerSteps}`;
    if (!CASE_ID.test(c.id) || c.id === "parent") throw new Error(`checkpoint ${i}: invalid id`);
  });
  return bound;
}

// panel: a developmentPanelCompiler v2 output. receipts: the four operator digest fields.
export function buildDevelopmentSelectionContract({ panel, checkpointManifest, graderSha256, inferenceSettingsSha256, recipeSha256, parentAdapterSha256 } = {}) {
  if (panel?.schema !== "amos.development-panel.v2") throw new Error("expected a development-panel.v2 compiler output");
  if (!Array.isArray(panel.cases) || panel.cases.length !== 96) throw new Error("panel must carry exactly 96 cases");
  if (panel.seedNumeric !== EXPECTED_SEED) throw new Error("panel must use original S7 seed 20260910");
  requireHash(panel.panelSha256, "panel.panelSha256");
  requireHash(graderSha256, "graderSha256");
  requireHash(inferenceSettingsSha256, "inferenceSettingsSha256");
  requireHash(recipeSha256, "recipeSha256");
  requireHash(parentAdapterSha256, "parentAdapterSha256");
  for (const c of panel.cases) {
    if (!CASE_ID.test(c.caseId)) throw new Error(`panel caseId '${c.caseId}' outside the selector identifier alphabet`);
  }
  const checkpoints = bindCheckpointManifest(checkpointManifest).map((c) => ({
    id: c.id, epoch: c.epoch, optimizerSteps: c.optimizerSteps, adapterSha256: c.adapterSha256,
  }));
  return Object.freeze({
    schema: "amos.development-checkpoint-selection.v1",
    partition: "development",
    seed: panel.seedNumeric,
    panelSha256: panel.panelSha256,
    graderSha256,
    inferenceSettingsSha256,
    recipeSha256,
    parentAdapterSha256,
    cases: panel.cases,
    checkpoints,
  });
}
