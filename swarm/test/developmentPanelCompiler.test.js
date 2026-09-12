import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { compileDevelopmentPanel, PANEL_FAMILIES, CASES_PER_FAMILY, PANEL_SIZE, caseIdentity } from "../src/developmentPanelCompiler.js";
import { buildExclusionSet } from "../src/developmentPanelExclusions.js";

const SEED = "20260910";
// Distinct opaque bodies; content-addressed so no two collide.
function panelSpecs() {
  const specs = [];
  for (const family of PANEL_FAMILIES) {
    for (let i = 0; i < CASES_PER_FAMILY; i++) specs.push({ family, body: { family, n: i, prompt: `${family}-case-${i}` } });
  }
  return specs;
}

test("a well-formed panel compiles to 96 cases, 12 per family, with a stable digest", () => {
  const p = compileDevelopmentPanel(panelSpecs(), { seed: SEED });
  assert.equal(p.cases.length, PANEL_SIZE);
  assert.equal(p.panelSize, 96);
  const byFamily = {};
  for (const c of p.cases) byFamily[c.family] = (byFamily[c.family] ?? 0) + 1;
  for (const f of PANEL_FAMILIES) assert.equal(byFamily[f], 12, `family ${f}`);
  assert.match(p.panelSha256, /^[a-f0-9]{64}$/);
  assert.match(p.contractCasesSha256, /^[a-f0-9]{64}$/);
  assert.equal(compileDevelopmentPanel(panelSpecs(), { seed: SEED }).panelSha256, p.panelSha256, "deterministic");
  // canonical order: families in declaration order
  const order = p.cases.map((c) => PANEL_FAMILIES.indexOf(c.family));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test("input order does not change the panel digest (canonicalized)", () => {
  const a = compileDevelopmentPanel(panelSpecs(), { seed: SEED });
  const b = compileDevelopmentPanel([...panelSpecs()].reverse(), { seed: SEED });
  assert.equal(a.panelSha256, b.panelSha256);
});

test("wrong count, wrong per-family distribution and unknown family are rejected", () => {
  assert.throws(() => compileDevelopmentPanel(panelSpecs().slice(0, 95), { seed: SEED }), /exactly 96/);
  // move one case from family[0] to family[1] -> 11 vs 13
  const skew = panelSpecs();
  skew[0] = { family: PANEL_FAMILIES[1], body: { moved: true } };
  assert.throws(() => compileDevelopmentPanel(skew, { seed: SEED }), /expected 12/);
  const foreign = panelSpecs();
  foreign[5] = { family: "not-a-family", body: { x: 1 } };
  assert.throws(() => compileDevelopmentPanel(foreign, { seed: SEED }), /unknown panel family/);
});

test("a duplicate case body within the panel is rejected", () => {
  const dup = panelSpecs();
  dup[1] = { family: dup[0].family, body: { ...dup[0].body } }; // identical body to dup[0]
  assert.throws(() => compileDevelopmentPanel(dup, { seed: SEED }), /duplicate case body/);
});

test("a panel case whose body byte-matches an excluded dataset row is rejected", () => {
  const specs = panelSpecs();
  const clashSha = createHash("sha256").update(JSON.stringify(sortBody(specs[0].body))).digest("hex");
  const excluded = buildExclusionSet([{ namespace: "dataset-row", value: clashSha }]);
  assert.throws(() => compileDevelopmentPanel(specs, { seed: SEED, exclusionSet: excluded }), /overlaps excluded material/);
  // and caseId reuse is rejected
  const caseId = caseIdentity(specs[0].family, clashSha);
  const excluded2 = buildExclusionSet([{ namespace: "panel-case", value: caseId }]);
  assert.throws(() => compileDevelopmentPanel(specs, { seed: SEED, exclusionSet: excluded2 }), /overlaps excluded material/);
});

test("a disjoint exclusion set passes and is reported in the proof", () => {
  const excluded = buildExclusionSet([{ namespace: "dataset-row", value: "f".repeat(64) }, { namespace: "panel-case", value: "date-time#0000000000000000" }]);
  const p = compileDevelopmentPanel(panelSpecs(), { seed: SEED, exclusionSet: excluded });
  assert.equal(p.disjointProof.excludedIdentities, 2);
  assert.ok(p.disjointProof.panelIdentitiesChecked >= PANEL_SIZE);
  assert.match(p.coverage, /Semantic novelty/);
});

test("seed is required and validated", () => {
  assert.throws(() => compileDevelopmentPanel(panelSpecs(), {}), /seed required/);
});

// local canonicalizer mirror for the clash-sha test
function sortBody(v) {
  if (Array.isArray(v)) return v.map(sortBody);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortBody(v[k])]));
  return v;
}
