import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, digest } from "../../src/digest.ts";
import { DualChannelHolographicWorld } from "./dualChannelHolographicWorld.js";
import { UnitaryHolographicMemory } from "./holographicWorldV2.js";
import { sftRow, validateAmosSystemTrainingExample } from "./amosNativeTrainingDataset.js";

export const REPLAY_MEMORY_SCHEMA = "amos.persistent-replay-memory.v1";
const SOURCE_KINDS = ["self-execution", "human-demonstration", "document", "external-model"];
const MAX_BYTES = 64 * 1024 * 1024;
const ENCODER = Object.freeze({
  id: "deterministic-hrr-v2-unitary-fft",
  sources: Object.fromEntries(["holographicWorldV2.js", "dualChannelHolographicWorld.js"].map(name =>
    [name, createHash("sha256").update(readFileSync(new URL(name, import.meta.url))).digest("hex")]))
});

export function requireDigest(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
  return value;
}
function text(value, label, maximum = 100_000) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(`${label} is invalid`);
  return value;
}
function id(value, label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(text(value, label, 256))) throw new Error(`${label} is invalid`);
  return value;
}
function enumValue(value, values, label) {
  if (!values.includes(value)) throw new Error(`${label} is invalid`);
  return value;
}
function stringSet(values, label) {
  if (!Array.isArray(values) || !values.length || values.length > 100) throw new Error(`${label} is invalid`);
  return [...new Set(values.map(v => id(v, label)))].sort();
}
export function trainingContent(example) {
  const { messages, tools } = sftRow(validateAmosSystemTrainingExample(example));
  return tools ? { messages, tools } : { messages };
}

/** The caller supplies an independently checked receipt; this module does not grade demonstrations. */
export function createObservedExperience(input) {
  const example = input.example == null ? null : validateAmosSystemTrainingExample(input.example);
  const status = enumValue(input.verification?.status, ["verified", "unverified", "failed"], "verification.status");
  const verification = {
    status,
    receiptSha256: input.verification?.receiptSha256 == null ? null : requireDigest(input.verification.receiptSha256, "receiptSha256"),
    verifierId: input.verification?.verifierId == null ? null : id(input.verification.verifierId, "verifierId"),
    exampleDigest: input.verification?.exampleDigest == null ? null : requireDigest(input.verification.exampleDigest, "verified exampleDigest")
  };
  if (status === "verified" && (!verification.receiptSha256 || !verification.verifierId)) throw new Error("verified experience requires a checker receipt");
  if (status === "verified" && example && verification.exampleDigest !== example.digest) throw new Error("checker receipt must bind the actual example");
  const source = {
    kind: enumValue(input.source?.kind, SOURCE_KINDS, "source.kind"),
    reference: text(input.source?.reference, "source.reference", 4096),
    modelId: input.source?.modelId == null ? null : text(input.source.modelId, "source.modelId", 256),
    permittedUses: stringSet(input.source?.permittedUses, "source.permittedUses"),
    permissionReference: text(input.source?.permissionReference, "source.permissionReference", 4096)
  };
  if (source.permittedUses.some(use => !["memory", "training", "evaluation"].includes(use))) throw new Error("unknown permitted use");
  if (!source.permittedUses.includes("memory")) throw new Error("memory use is required for storage");
  if (["self-execution", "external-model"].includes(source.kind) && !source.modelId) throw new Error("model source requires modelId");
  const record = {
    schema: "amos.observed-experience.v1",
    id: id(input.id, "experience.id"), tenantId: id(input.tenantId, "tenantId"),
    taskFamily: id(input.taskFamily, "taskFamily"),
    lineageGroups: stringSet(input.lineageGroups, "lineageGroups"),
    partition: enumValue(input.partition, ["training", "development"], "partition"),
    text: text(input.text, "experience.text"), source, verification, example,
    trainingContentSha256: example ? digest(trainingContent(example)) : null
  };
  if (example && example.taskFamily !== record.taskFamily) throw new Error("example family differs from experience");
  return { ...record, digest: digest(record) };
}
function validRecord(input) {
  const normalized = createObservedExperience(input);
  if (canonicalJson(input) !== canonicalJson(normalized)) throw new Error("experience content or digest changed");
  return normalized;
}
function configuration(input) {
  const dimension = input?.dimension ?? 256;
  const namespace = input?.namespace ?? "amos-replay-v1";
  new UnitaryHolographicMemory({ dimension, namespace });
  const maxEntries = input?.maxEntries ?? 10_000;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10_000) throw new Error("maxEntries is invalid");
  return { dimension, namespace, maxEntries, encoder: structuredClone(ENCODER) };
}
function rebuild(records, config) {
  const world = new DualChannelHolographicWorld({ memory: new UnitaryHolographicMemory(config) });
  for (const record of records) world.observe({
    id: record.id, kind: record.taskFamily, text: record.text, phase: "observed", polarity: "positive",
    receiptStatus: record.verification.status,
    verifiedBy: record.verification.verifierId ?? "unverified-source",
    evidenceRefs: record.verification.receiptSha256 ? [`sha256:${record.verification.receiptSha256}`] : []
  });
  return world;
}
function snapshotValue(tenantId, config, records, previousDigest) {
  const state = rebuild(records, config).snapshot();
  const snapshot = {
    schema: REPLAY_MEMORY_SCHEMA, tenantId, config, previousDigest, records,
    index: { semanticDigest: state.semanticRepresentationDigest, identityDigest: state.identityRepresentationDigest },
    exactRecordsAuthoritative: true
  };
  if (Buffer.byteLength(canonicalJson(snapshot)) > MAX_BYTES) throw new Error("memory snapshot exceeds byte bound");
  return { ...snapshot, digest: digest(snapshot) };
}

/** Immutable generations: concurrent writers cannot overwrite a published memory snapshot. */
export function createReplayMemory({ tenantId, observations = [], previous = null, config = null }) {
  id(tenantId, "tenantId");
  if (!Array.isArray(observations)) throw new Error("observations must be an array");
  const prior = previous ? validateReplayMemory(previous) : null;
  if (prior && prior.tenantId !== tenantId) throw new Error("tenant differs from previous snapshot");
  const normalizedConfig = configuration(config ?? prior?.config);
  if (prior && canonicalJson(prior.config) !== canonicalJson(normalizedConfig)) throw new Error("encoder/config changes require an explicit new experiment");
  const records = new Map((prior?.records ?? []).map(record => [record.id, record]));
  for (const value of observations) {
    const record = validRecord(value);
    if (record.tenantId !== tenantId) throw new Error("cross-tenant experience rejected");
    if (records.has(record.id) && records.get(record.id).digest !== record.digest) throw new Error("experience ID collision");
    records.set(record.id, record);
  }
  if (records.size > normalizedConfig.maxEntries) throw new Error("memory capacity exceeded; exact experience must not be silently evicted");
  const ordered = [...records.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (prior && canonicalJson(ordered) === canonicalJson(prior.records)) return prior;
  return snapshotValue(tenantId, normalizedConfig, ordered, prior?.digest ?? null);
}
export function validateReplayMemory(input) {
  if (input?.schema !== REPLAY_MEMORY_SCHEMA) throw new Error("invalid replay memory schema");
  const config = configuration(input.config);
  if (canonicalJson(config) !== canonicalJson(input.config)) throw new Error("encoder source/config mismatch");
  if (!Array.isArray(input.records) || input.records.length > config.maxEntries) throw new Error("invalid memory records");
  if (input.previousDigest !== null) requireDigest(input.previousDigest, "previousDigest");
  const records = input.records.map(validRecord);
  if (new Set(records.map(r => r.id)).size !== records.length || records.some(r => r.tenantId !== input.tenantId)) throw new Error("duplicate or cross-tenant records");
  if (records.some((r, i) => i && records[i - 1].id >= r.id)) throw new Error("records are not in canonical order");
  const expected = snapshotValue(id(input.tenantId, "tenantId"), config, records, input.previousDigest);
  if (canonicalJson(expected) !== canonicalJson(input)) throw new Error("memory content, index or digest changed");
  return expected;
}
export function recallReplayMemory(snapshotInput, { tenantId, taskFamily, text: query, limit = 5 }) {
  const snapshot = validateReplayMemory(snapshotInput);
  if (tenantId !== snapshot.tenantId) throw new Error("cross-tenant query rejected");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid recall limit");
  const retrieval = rebuild(snapshot.records, snapshot.config).retrieve({ kind: id(taskFamily, "query.taskFamily"), text: text(query, "query.text"), phase: "observed", receiptStatus: "verified" }, { limit });
  return {
    snapshotDigest: snapshot.digest, retrievalEvidenceOnly: true,
    presenceScore: retrieval.semantic.presenceScore,
    results: retrieval.semantic.results.map(hit => ({ score: hit.similarity, experience: structuredClone(snapshot.records.find(r => r.id === hit.id)) }))
  };
}
export function writeImmutableReplayFile(directory, name, contents) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error("invalid immutable filename");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const destination = join(directory, name), temporary = join(directory, `.${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, contents); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    try { linkSync(temporary, destination); }
    catch (error) {
      if (error.code !== "EEXIST" || !readFileSync(destination).equals(Buffer.from(contents))) throw error;
    }
    const directoryFd = openSync(directory, "r");
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  } finally { rmSync(temporary, { force: true }); }
  return destination;
}
export function saveReplayMemory(directory, input) {
  const snapshot = validateReplayMemory(input);
  return writeImmutableReplayFile(directory, `${snapshot.digest}.json`, `${canonicalJson(snapshot)}\n`);
}
export function loadReplayMemory(path, expectedDigest) {
  requireDigest(expectedDigest, "expected memory digest");
  if (statSync(path).size > MAX_BYTES) throw new Error("memory file exceeds byte bound");
  const bytes = readFileSync(path);
  if (bytes.length > MAX_BYTES) throw new Error("memory file exceeds byte bound");
  const snapshot = validateReplayMemory(JSON.parse(bytes));
  if (snapshot.digest !== expectedDigest) throw new Error("unexpected memory generation");
  return snapshot;
}
