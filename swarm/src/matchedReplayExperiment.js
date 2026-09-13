import { createHash } from "node:crypto";
import { canonicalJson, digest } from "../../src/digest.ts";
import { HolographicWorldV2, UnitaryHolographicMemory } from "./holographicWorldV2.js";
import { sftRow } from "./amosNativeTrainingDataset.js";
import { requireDigest, trainingContent, validateReplayMemory, writeImmutableReplayFile } from "./persistentReplayMemory.js";

const sha256 = value => createHash("sha256").update(value).digest("hex");
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function integer(value, label, max = 1_000_000) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${label} is invalid`);
  return value;
}

/** Preparation only. The native counter and checker receipts remain external trust boundaries. */
export function prepareMatchedReplayExperiment({
  snapshot: snapshotInput, tenantId, parentWeightsSha256, recipeSha256,
  newExperienceIds, excludedLineages, tokenCounts, replaySlots, seed
}) {
  const snapshot = validateReplayMemory(snapshotInput);
  if (tenantId !== snapshot.tenantId) throw new Error("cross-tenant experiment rejected");
  requireDigest(parentWeightsSha256, "parent weights"); requireDigest(recipeSha256, "recipe");
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error("seed is invalid");
  integer(replaySlots, "replaySlots", 64);
  if (!Array.isArray(excludedLineages) || excludedLineages.some(v => typeof v !== "string" || !v)) throw new Error("explicit evaluation exclusions are required");
  if (!Array.isArray(newExperienceIds) || !newExperienceIds.length || new Set(newExperienceIds).size !== newExperienceIds.length) throw new Error("new experience IDs must be nonempty and unique");
  const excluded = new Set(excludedLineages);
  const blocked = record => record.partition !== "training" || !record.example
    || record.verification.status !== "verified" || !record.source.permittedUses.includes("training")
    || record.lineageGroups.some(group => excluded.has(group));
  // Duplicate content never launders a development source, missing permission or exclusion.
  const blockedContent = new Set(snapshot.records.filter(blocked).map(r => r.trainingContentSha256).filter(Boolean));
  const eligible = snapshot.records.filter(r => !blocked(r) && !blockedContent.has(r.trainingContentSha256));
  const byId = new Map(eligible.map(record => [record.id, record]));
  const fresh = newExperienceIds.map(id => {
    if (!byId.has(id)) throw new Error(`new experience ${id} is not eligible for verified training`);
    return byId.get(id);
  });
  const seen = new Set(fresh.map(r => r.trainingContentSha256));
  if (seen.size !== fresh.length) throw new Error("new examples duplicate training content");
  const newLineages = new Set(fresh.flatMap(r => r.lineageGroups));
  const pool = eligible.filter(record => {
    if (seen.has(record.trainingContentSha256) || record.lineageGroups.some(g => newLineages.has(g))) return false;
    seen.add(record.trainingContentSha256); return true;
  });
  if (pool.length < replaySlots) throw new Error("insufficient distinct eligible replay experience");
  requireDigest(tokenCounts?.tokenizerSha256, "tokenizer digest");
  requireDigest(tokenCounts?.counterSourceSha256, "counter source digest");
  if (typeof tokenCounts.synthetic !== "boolean" || !Array.isArray(tokenCounts.entries)) throw new Error("explicit native token-count receipt required");
  const counts = new Map();
  for (const entry of tokenCounts.entries) {
    requireDigest(entry.exampleDigest, "count example digest"); requireDigest(entry.contentSha256, "count content digest");
    integer(entry.tokens, "sequence tokens"); integer(entry.supervisedTokens, "supervised tokens", entry.tokens);
    if (counts.has(entry.exampleDigest)) throw new Error("duplicate token-count identity");
    counts.set(entry.exampleDigest, entry);
  }
  function count(record) {
    const value = counts.get(record.example.digest);
    if (!value || value.contentSha256 !== digest(trainingContent(record.example))) throw new Error(`token count is missing or unbound for ${record.id}`);
    return value;
  }
  [...fresh, ...pool].forEach(count);
  const buckets = new Map();
  for (const record of pool) {
    const c = count(record), key = canonicalJson([record.taskFamily, c.tokens, c.supervisedTokens]);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(record);
  }
  const worlds = new Map(), rankings = new Map();
  function rankHrr(key, query) {
    const cacheKey = canonicalJson([key, query]);
    if (rankings.has(cacheKey)) return rankings.get(cacheKey);
    if (!worlds.has(key)) {
      const world = new HolographicWorldV2({ memory: new UnitaryHolographicMemory(snapshot.config) });
      for (const record of buckets.get(key)) world.observe({ id: record.id, kind: record.taskFamily, text: record.text,
        phase: "observed", receiptStatus: "verified", verifiedBy: record.verification.verifierId,
        evidenceRefs: [`sha256:${record.verification.receiptSha256}`] });
      worlds.set(key, world);
    }
    // At most64 slots: a cached top100 always contains an unused result if the bucket has one.
    const ranked = worlds.get(key).hologramSearch({ kind: buckets.get(key)[0].taskFamily, text: query, phase: "observed" }, { limit: 100 });
    rankings.set(cacheKey, ranked); return ranked;
  }
  const control = [], treatment = [], usedControl = new Set(), usedTreatment = new Set(), schedule = [];
  for (let slot = 0; slot < replaySlots; slot++) {
    const availableKeys = [...buckets.keys()].filter(key =>
      buckets.get(key).some(r => !usedControl.has(r.id)) && buckets.get(key).some(r => !usedTreatment.has(r.id)));
    availableKeys.sort((a, b) => order(digest([seed, slot, a]), digest([seed, slot, b])));
    const key = availableKeys[0];
    if (!key) throw new Error("matched replay buckets exhausted");
    const candidates = buckets.get(key), queryRecord = fresh[slot % fresh.length];
    const a = candidates.filter(r => !usedControl.has(r.id)).sort((x, y) => order(digest([seed, slot, x.id]), digest([seed, slot, y.id])))[0];
    const ranking = rankHrr(key, queryRecord.example.input.user);
    const hit = ranking.results.find(r => !usedTreatment.has(r.id));
    if (!hit) throw new Error("HRR ranking lacks an unused matched candidate");
    const b = byId.get(hit.id);
    control.push(a); treatment.push(b); usedControl.add(a.id); usedTreatment.add(b.id);
    const { tokens, supervisedTokens } = count(a);
    schedule.push({ slot, bucket: JSON.parse(key), queryExperienceId: queryRecord.id, queryInputSha256: digest(queryRecord.example.input.user),
      controlId: a.id, hrrId: b.id, hrrSimilarity: hit.similarity, hrrPresenceScore: ranking.presenceScore, tokens, supervisedTokens });
  }
  function arm(name, selected) {
    const records = [...fresh, ...selected];
    const rows = records.map(record => ({ ...sftRow(record.example), metadata: { ...sftRow(record.example).metadata,
      observationId: record.id, observationDigest: record.digest, sourceKind: record.source.kind,
      sourceModelId: record.source.modelId, verificationReceipt: record.verification.receiptSha256,
      lineageGroups: record.lineageGroups, memorySnapshotDigest: snapshot.digest } }));
    const contents = rows.map(row => canonicalJson(row)).join("\n") + "\n";
    return { name, rows, contents, sha256: sha256(contents), tokens: records.reduce((n, r) => n + count(r).tokens, 0),
      supervisedTokens: records.reduce((n, r) => n + count(r).supervisedTokens, 0),
      replayExperienceIds: selected.map(r => r.id), sourceExperienceDigests: records.map(r => r.digest) };
  }
  const arms = { control: arm("simple-replay", control), hrr: arm("hrr-guided-replay", treatment) };
  if (arms.control.tokens !== arms.hrr.tokens || arms.control.supervisedTokens !== arms.hrr.supervisedTokens) throw new Error("unmatched token exposure");
  const manifest = {
    schema: "amos.matched-replay-experiment.v1", tenantId, snapshotDigest: snapshot.digest,
    parentWeightsSha256, recipeSha256, seed, tokenizerSha256: tokenCounts.tokenizerSha256,
    tokenCountReceiptDigest: digest(tokenCounts), syntheticTokenCounts: tokenCounts.synthetic,
    excludedLineages: [...excluded].sort(), newExperienceIds, replaySlots,
    eligiblePoolDigest: digest(pool.map(r => r.digest)), schedule,
    arms: Object.fromEntries(Object.entries(arms).map(([key, a]) => [key, {
      name: a.name, file: `${key}.training.jsonl`, sha256: a.sha256, rows: a.rows.length,
      tokens: a.tokens, supervisedTokens: a.supervisedTokens, sourceExperienceDigests: a.sourceExperienceDigests
    }])),
    distinctReplaySlots: schedule.filter(s => s.controlId !== s.hrrId).length,
    comparisonHasDifferentReplay: schedule.some(s => s.controlId !== s.hrrId),
    inferenceMemory: "disabled-in-both-arms", matchedExposure: "task-family-sequence-and-supervised-token-buckets",
    counterReceiptScope: "supplied-native-counter-receipt-not-recomputed-here",
    createsQualityEvidence: false, trainingExecuted: false, productionChange: false
  };
  return { manifest: { ...manifest, digest: digest(manifest) }, arms };
}
export function writeMatchedReplayExperiment(directory, experiment) {
  const { digest: expected, ...body } = experiment.manifest;
  if (digest(body) !== expected) throw new Error("experiment manifest changed");
  for (const [key, arm] of Object.entries(experiment.arms)) {
    const declared = experiment.manifest.arms[key];
    if (!declared || sha256(arm.contents) !== declared.sha256) throw new Error("training rows changed");
    writeImmutableReplayFile(directory, declared.file, arm.contents);
  }
  // Publish last. A partial directory has no completion manifest and is safely repeatable.
  return writeImmutableReplayFile(directory, "replay-experiment.json", `${canonicalJson(experiment.manifest)}\n`);
}
