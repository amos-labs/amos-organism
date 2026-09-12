import test from "node:test";
import assert from "node:assert/strict";
import { compileDevelopmentPanel, PANEL_FAMILIES, CASES_PER_FAMILY, PANEL_SIZE, caseIdentity, numericSeed } from "../src/developmentPanelCompiler.js";
import { rowContentValue } from "../src/developmentPanelExclusions.js";

const SEED = "20260910";
function panelSpecs() {
  const specs = [];
  for (const family of PANEL_FAMILIES) {
    for (let i = 0; i < CASES_PER_FAMILY; i++) specs.push({ family, body: { family, n: i, prompt: `${family}-case-${i}` } });
  }
  return specs;
}

test("caseIds use ':' (selector-compatible), never '#'", () => {
  const id = caseIdentity("date-time", "a".repeat(64));
  assert.ok(id.startsWith("date-time:"));
  assert.ok(!id.includes("#"));
  assert.match(id, /^[A-Za-z0-9_:.-]+$/, "within the accepted selector identifier alphabet");
});

test("numericSeed maps the all-digit string seed to a safe integer, rejecting non-digits", () => {
  assert.equal(numericSeed("20260910"), 20260910);
  assert.throws(() => numericSeed("2026-09-10"), /all-digit/);
  assert.throws(() => numericSeed("abc"), /all-digit/);
});

test("a well-formed panel compiles to 96 cases, 12 per family, with stable digests and seedNumeric", () => {
  const p = compileDevelopmentPanel(panelSpecs(), { seed: SEED });
  assert.equal(p.cases.length, PANEL_SIZE);
  assert.equal(p.seedNumeric, 20260910);
  const byFamily = {};
  for (const c of p.cases) { byFamily[c.family] = (byFamily[c.family] ?? 0) + 1; assert.ok(c.caseId.includes(":")); }
  for (const f of PANEL_FAMILIES) assert.equal(byFamily[f], 12, `family ${f}`);
  assert.match(p.panelSha256, /^[a-f0-9]{64}$/);
  assert.equal(compileDevelopmentPanel(panelSpecs(), { seed: SEED }).panelSha256, p.panelSha256, "deterministic");
  const order = p.cases.map((c) => PANEL_FAMILIES.indexOf(c.family));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test("input order does not change the panel digest (canonicalized)", () => {
  const a = compileDevelopmentPanel(panelSpecs(), { seed: SEED });
  const b = compileDevelopmentPanel([...panelSpecs()].reverse(), { seed: SEED });
  assert.equal(a.panelSha256, b.panelSha256);
});

test("wrong count, wrong per-family distribution, unknown family and duplicate body are rejected", () => {
  assert.throws(() => compileDevelopmentPanel(panelSpecs().slice(0, 95), { seed: SEED }), /exactly 96/);
  const skew = panelSpecs();
  skew[0] = { family: PANEL_FAMILIES[1], body: { moved: true } };
  assert.throws(() => compileDevelopmentPanel(skew, { seed: SEED }), /expected 12/);
  const foreign = panelSpecs();
  foreign[5] = { family: "not-a-family", body: { x: 1 } };
  assert.throws(() => compileDevelopmentPanel(foreign, { seed: SEED }), /unknown panel family/);
  const dup = panelSpecs();
  dup[1] = { family: dup[0].family, body: { ...dup[0].body } };
  assert.throws(() => compileDevelopmentPanel(dup, { seed: SEED }), /duplicate case body/);
});

test("with an inventory: a disjoint panel proves panel-versus-inventory; reuse (row/case/decision) is caught", () => {
  const specs = panelSpecs();
  const inventory = [
    { type: "row-content", value: "f".repeat(64), partition: "train" },
    { type: "decision-key", value: "deadbeef", partition: "parent-trajectory" },
    { type: "decision-signature", value: "a".repeat(64), partition: "parent-trajectory" },
  ];
  const ok = compileDevelopmentPanel(specs, { seed: SEED, exclusionEntries: inventory });
  assert.equal(ok.panelVersusInventory.disjoint, true);
  assert.ok(ok.panelVersusInventory.inventory.totalUniqueIdentities >= 3);

  // (a) a panel body byte-matching an excluded train row -> caught under row-content
  const rowClash = rowContentValue(specs[0].body);
  assert.throws(() => compileDevelopmentPanel(specs, { seed: SEED, exclusionEntries: [{ type: "row-content", value: rowClash, partition: "train" }] }), /overlaps/);

  // (b) a caseId reused -> caught under case-id
  const caseId = caseIdentity(specs[3].family, rowContentValue(specs[3].body));
  assert.throws(() => compileDevelopmentPanel(specs, { seed: SEED, exclusionEntries: [
    { type: "row-content", value: "e".repeat(64), partition: "train" }, { type: "case-id", value: caseId, partition: "consumed-case" },
  ] }), /overlaps/);

  // (c) a re-rendered sibling sharing a consumed decision key -> caught via decisionProjection
  const project = (body) => (body.n === 0 && body.family === "async-code" ? { decisionKeys: ["cafe1234"] } : {});
  assert.throws(() => compileDevelopmentPanel(specs, { seed: SEED, decisionProjection: project, exclusionEntries: [
    { type: "row-content", value: "e".repeat(64), partition: "train" }, { type: "decision-key", value: "cafe1234", partition: "consumed-selection" },
  ] }), /overlaps/);
});

test("seed is required and validated", () => {
  assert.throws(() => compileDevelopmentPanel(panelSpecs(), {}), /seed required|all-digit/);
});
