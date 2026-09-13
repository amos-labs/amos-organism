import { createHash } from 'node:crypto';
import { compileDevelopmentPanel, PANEL_FAMILIES, CASES_PER_FAMILY, panelCaseIdentity } from './developmentPanelCompiler.js';
import { buildExclusionSet, exclusionReceipt, identityKey, rowContentValue } from './developmentPanelExclusions.js';

// Compose the existing native family adapters. This module makes no model calls and
// never accepts answer-only grading as evidence of successful task execution.
const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, sort(value[k])]));
  return value;
}
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');

function projectedBody(adapter, body) {
  adapter.validateBody(body);
  const projection = adapter.project(body);
  if (!Array.isArray(projection?.decisionKeys) || projection.decisionKeys.length !== 1 ||
      !/^[a-f0-9]{8}$/.test(projection.decisionKeys[0])) throw new Error('each case requires one native decision key');
  if (!Array.isArray(projection.decisionSignatures) || projection.decisionSignatures.length > 1 ||
      projection.decisionSignatures.some(s => !/^[a-f0-9]{64}$/.test(s))) throw new Error('invalid decision signature projection');
  if (projection.signatureChecked === false && projection.decisionSignatures.length) throw new Error('inconsistent signature coverage');
  const content = rowContentValue(body);
  const entries = [
    {type: 'row-content', value: content},
    {type: 'case-id', value: panelCaseIdentity(body.family, content)},
    ...projection.decisionKeys.map(value => ({type: 'decision-key', value})),
    ...projection.decisionSignatures.map(value => ({type: 'decision-signature', value})),
  ];
  return {projection, entries};
}

export function assembleA0Panel({adapters, seed, exclusionEntries, maxCandidatesPerFamily = 4096}) {
  if (!(adapters instanceof Map) || adapters.size !== PANEL_FAMILIES.length || PANEL_FAMILIES.some(f => !adapters.has(f))) {
    throw new Error('all eight reviewed family adapters are required');
  }
  if (!Array.isArray(exclusionEntries) || exclusionEntries.length === 0) throw new Error('nonempty exclusion inventory required');
  if (!Number.isSafeInteger(maxCandidatesPerFamily) || maxCandidatesPerFamily < CASES_PER_FAMILY) throw new Error('invalid candidate bound');
  const excluded = buildExclusionSet(exclusionEntries);
  const selectedIdentities = new Set();
  const specs = [];
  const coverage = {};
  for (const family of PANEL_FAMILIES) {
    const adapter = adapters.get(family);
    if (adapter.FAMILY !== family) throw new Error(`adapter family mismatch: ${family}`);
    const count = coverage[family] = {selected: 0, candidatesExamined: 0, excludedCollisions: 0, panelCollisions: 0, decisionKeys: 0, decisionSignatures: 0};
    for (let index = 0; index < maxCandidatesPerFamily && count.selected < CASES_PER_FAMILY; index++) {
      const body = adapter.generate(seed, index);
      if (body.family !== family || body.index !== index) throw new Error('generator changed requested family/index');
      const {projection, entries} = projectedBody(adapter, body);
      count.candidatesExamined++;
      const keys = entries.map(e => identityKey(e.type, e.value));
      if (keys.some(k => excluded.has(k))) { count.excludedCollisions++; continue; }
      if (keys.some(k => selectedIdentities.has(k))) { count.panelCollisions++; continue; }
      // Bind the case to the actual native fixture before admission, not just a pure oracle.
      const fixture = adapter.createFixture(body);
      if (fixture.fixture?.id !== entries.find(e => e.type === 'case-id').value ||
          typeof fixture.verify !== 'function' || !Array.isArray(fixture.tools) ||
          (fixture.fixture.decisionDigest ?? fixture.fixture.datasetDigest) !== projection.decisionKeys[0]) {
        throw new Error(`native fixture identity/contract mismatch: ${family}`);
      }
      for (const key of keys) selectedIdentities.add(key);
      specs.push({family, body: structuredClone(body)});
      count.selected++;
      count.decisionKeys += projection.decisionKeys.length;
      count.decisionSignatures += projection.decisionSignatures.length;
    }
    if (count.selected !== CASES_PER_FAMILY) throw new Error(`candidate bound exhausted: ${family} (${count.selected}/12)`);
    count.signatureCoverage = count.decisionSignatures === count.selected ? 'all selected cases' : count.decisionSignatures === 0 ? 'not checked' : 'partial';
  }
  const panel = compileDevelopmentPanel(specs, {seed, exclusionEntries, decisionProjection: body => adapters.get(body.family).project(body)});
  const order = new Map(panel.cases.map((c, i) => [c.caseId, i]));
  specs.sort((a, b) => order.get(panelCaseIdentity(a.family, rowContentValue(a.body))) - order.get(panelCaseIdentity(b.family, rowContentValue(b.body))));
  return {
    schema: 'amos.a0-native-panel-package.v1',
    panel, specs, coverage,
    exclusionInventory: exclusionReceipt(exclusionEntries),
    specsSha256: digest(specs),
    admissionRule: 'First twelve per family without excluded or within-panel identity collisions, in deterministic generator order; no measured outcomes used.',
    modelCalls: 0,
    qualityClaimAllowed: false,
    promotionAllowed: false,
    coverageLimit: 'Exact identity exclusion and native contract binding. Variants retain their original task templates; this does not establish semantic novelty or general intelligence.',
  };
}

export function fixturesForA0Package(pkg, adapters) {
  if (pkg?.schema !== 'amos.a0-native-panel-package.v1' || digest(pkg.specs) !== pkg.specsSha256) throw new Error('panel body package digest mismatch');
  const rebuilt = compileDevelopmentPanel(pkg.specs, {seed: pkg.panel.seed, decisionProjection: body => adapters.get(body.family).project(body)});
  if (rebuilt.panelSha256 !== pkg.panel.panelSha256 || canonical(rebuilt.cases) !== canonical(pkg.panel.cases)) throw new Error('panel manifest identity mismatch');
  const bodies = new Map(pkg.specs.map(s => [panelCaseIdentity(s.family, rowContentValue(s.body)), s.body]));
  return pkg.panel.cases.map(c => {
    const fixture = adapters.get(c.family).createFixture(bodies.get(c.caseId));
    if (fixture.fixture?.id !== c.caseId) throw new Error('native executor case mismatch');
    return fixture;
  });
}
