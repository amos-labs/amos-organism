import { createHash } from "node:crypto";
import { rowContentValue, identityKey, assertPanelDisjoint, panelVersusInventoryReceipt } from "./developmentPanelExclusions.js";

// Deterministic compiler for the persistent-mind A0 development panel: exactly eight
// named families, twelve cases each, ninety-six total. It does NOT invent task content
// (the source does not build datasets); it consumes operator-supplied case bodies,
// binds each to a content-addressed caseId, projects each into the SAME unified identity
// model the excluded inventory uses (developmentPanelExclusions), proves disjointness,
// and emits the canonical panelSha256 the Codex selector contract
// (amos.development-checkpoint-selection.v1, SHA 9c8d6286) consumes. caseIds use ':'
// (the accepted selector's identifier alphabet is [A-Za-z0-9_:.-] and rejects '#').
// Identity disjointness proves no EXACT reuse, not semantic novelty (a disclosed
// judgement that stays with the fixture author).

export const PANEL_FAMILIES = Object.freeze([
  "numeric-reconciliation",
  "constrained-planning",
  "async-code",
  "date-time",
  "tenant-bound-reporting",
  "governed-context-dependent-state",
  "recover-without-replaying-completed-actions",
  "reuse-first-tool-selection",
]);
export const CASES_PER_FAMILY = 12;
export const PANEL_SIZE = PANEL_FAMILIES.length * CASES_PER_FAMILY; // 96

const FAMILY_INDEX = new Map(PANEL_FAMILIES.map((f, i) => [f, i]));
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const canonical = (v) => JSON.stringify(sortKeys(v));
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

// The selector consumes a numeric seed; the panel/policy carries the seed as an
// all-digit string. Map explicitly (no silent coercion) so both envelopes agree.
export function numericSeed(seed) {
  if (typeof seed !== "string" || !/^\d+$/.test(seed)) throw new TypeError("panel seed must be an all-digit string");
  const n = Number(seed);
  if (!Number.isSafeInteger(n)) throw new RangeError("panel seed is not a safe integer");
  return n;
}

// A caseId is content-addressed so identical bodies cannot appear twice and the id is
// reproducible from the body alone: family + ':' + a 16-hex prefix of the body digest.
export function caseIdentity(family, contentSha256) {
  if (!FAMILY_INDEX.has(family)) throw new RangeError(`unknown panel family '${family}'`);
  if (typeof contentSha256 !== "string" || !/^[a-f0-9]{64}$/.test(contentSha256)) throw new TypeError("content sha256 required");
  return `${family}:${contentSha256.slice(0, 16)}`;
}

// specs: [{ family, body }]. body is the operator-authored task object (opaque here).
// options.decisionProjection(body) -> { decisionKeys?: string[], decisionSignatures?: string[] }
//   optional hook that surfaces any decision identity a body carries, so a re-rendered
//   or sibling of a consumed/parent task is caught (not only a byte-identical body).
// options.exclusionEntries: the unified excluded inventory [{type,value,partition?}].
//   When present, the panel is proved disjoint and a panel-versus-inventory receipt is
//   emitted; when absent, only structural compilation + intra-panel identities are done.
export function compileDevelopmentPanel(specs, { exclusionEntries = null, seed, decisionProjection = null } = {}) {
  if (!Array.isArray(specs)) throw new TypeError("panel specs array required");
  if (specs.length !== PANEL_SIZE) throw new RangeError(`panel must have exactly ${PANEL_SIZE} cases, got ${specs.length}`);
  if (typeof seed !== "string" || seed.length === 0) throw new TypeError("panel seed required");
  const seedNumeric = numericSeed(seed);

  const perFamily = new Map(PANEL_FAMILIES.map((f) => [f, 0]));
  const seenCaseId = new Set();
  const seenBody = new Set();
  const compiled = [];
  const panelEntries = [];
  for (const spec of specs) {
    if (!spec || typeof spec !== "object") throw new TypeError("each spec must be an object");
    const { family, body } = spec;
    if (!FAMILY_INDEX.has(family)) throw new RangeError(`unknown panel family '${family}'`);
    if (body === undefined || body === null) throw new TypeError("each spec needs a body");
    const contentSha256 = rowContentValue(body); // SAME algorithm the excluded rows use
    if (seenBody.has(contentSha256)) throw new Error(`duplicate case body within panel (${family})`);
    seenBody.add(contentSha256);
    const caseId = caseIdentity(family, contentSha256);
    if (seenCaseId.has(caseId)) throw new Error(`duplicate caseId ${caseId}`);
    seenCaseId.add(caseId);
    perFamily.set(family, perFamily.get(family) + 1);
    compiled.push({ caseId, family, contentSha256 });

    panelEntries.push({ type: "case-id", value: caseId });
    panelEntries.push({ type: "row-content", value: contentSha256 });
    if (decisionProjection) {
      const projection = decisionProjection(body) || {};
      for (const k of projection.decisionKeys || []) panelEntries.push({ type: "decision-key", value: k });
      for (const s of projection.decisionSignatures || []) panelEntries.push({ type: "decision-signature", value: s });
    }
  }
  for (const f of PANEL_FAMILIES) {
    if (perFamily.get(f) !== CASES_PER_FAMILY) throw new RangeError(`family '${f}' has ${perFamily.get(f)} cases, expected ${CASES_PER_FAMILY}`);
  }

  // Disjointness through the unified model: the panel's case-id / row-content / decision
  // identities must miss the excluded inventory (which carries the same identity types).
  let inventoryReceipt = null;
  if (exclusionEntries) {
    inventoryReceipt = panelVersusInventoryReceipt({ inventoryEntries: exclusionEntries, panelEntries });
  }

  // Canonical order: family declaration order, then caseId. Fixed before measurement.
  compiled.sort((a, b) => (FAMILY_INDEX.get(a.family) - FAMILY_INDEX.get(b.family)) || (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0));
  const contractCases = compiled.map((c) => ({ caseId: c.caseId, family: c.family }));
  const manifest = compiled.map((c) => ({ caseId: c.caseId, family: c.family, contentSha256: c.contentSha256 }));

  return Object.freeze({
    schema: "amos.development-panel.v2",
    seed,
    seedNumeric,                                                          // for the selector's numeric-seed envelope
    families: PANEL_FAMILIES,
    casesPerFamily: CASES_PER_FAMILY,
    panelSize: PANEL_SIZE,
    cases: Object.freeze(contractCases.map(Object.freeze)),               // {caseId, family} for the selector contract
    manifest: Object.freeze(manifest.map(Object.freeze)),                 // adds contentSha256 for provenance
    panelSha256: sha256(canonical(manifest)),                             // binds caseId+family+content
    contractCasesSha256: sha256(canonical(contractCases)),               // binds the {caseId,family} projection alone
    panelVersusInventory: inventoryReceipt,                               // null unless an inventory was supplied
    coverage: "Structural + unified exact-identity disjointness only. Twelve cases per named family, ninety-six total, no exact reuse of excluded rows/decisions/cases. Semantic novelty of task content is the fixture author's disclosed responsibility.",
  });
}

export { caseIdentity as panelCaseIdentity };
