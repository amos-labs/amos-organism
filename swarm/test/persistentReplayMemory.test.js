import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { digest } from "../../src/digest.ts";
import { createAmosSystemTrainingExample } from "../src/amosNativeTrainingDataset.js";
import { createObservedExperience, createReplayMemory, loadReplayMemory, recallReplayMemory, saveReplayMemory, trainingContent, validateReplayMemory, writeImmutableReplayFile } from "../src/persistentReplayMemory.js";
import { prepareMatchedReplayExperiment, writeMatchedReplayExperiment } from "../src/matchedReplayExperiment.js";

const hash = text => createHash("sha256").update(text).digest("hex");
const tenantId = "owned-synthetic";
function experience(id, text = `calendar date exercise ${id}`, overrides = {}) {
  const example = createAmosSystemTrainingExample({ id: `example-${id}`, sourceEpisodeId: `episode-${id}`, taskFamily: "calendar", role: "operator",
    input: { system: "Use verified evidence.", user: text }, target: { kind: "verified-synthesis", content: `Verified answer ${id}` },
    safeguards: { credentialsRemoved: true, tenantFactsRemoved: true, hiddenReasoningExcluded: true, independentVerifierSelected: true, licensedForTraining: true } });
  return createObservedExperience({ id, tenantId, taskFamily: "calendar", text, lineageGroups: [`lineage-${id}`], partition: "training", example,
    source: { kind: "human-demonstration", reference: `fixture:${id}`, permittedUses: ["memory", "training"], permissionReference: "owned-synthetic-fixture" },
    verification: { status: "verified", receiptSha256: hash(`receipt-${id}`), verifierId: "fixture-checker", exampleDigest: example.digest }, ...overrides });
}
function fixture() {
  const observations = [experience("new", "month end calendar leap February"),
    ...Array.from({ length: 8 }, (_, i) => experience(`old-${i}`, i === 3 ? "month end calendar leap February worked example" : `inventory quarterly accounts ${i}`))];
  return createReplayMemory({ tenantId, observations, config: { dimension: 64, namespace: "replay-test" } });
}
function request(snapshot, changes = {}) {
  return { snapshot, tenantId, parentWeightsSha256: hash("S6"), recipeSha256: hash("recipe"), newExperienceIds: ["new"],
    excludedLineages: [], replaySlots: 3, seed: 7,
    tokenCounts: { tokenizerSha256: hash("tokenizer"), counterSourceSha256: hash("counter"), synthetic: true,
      entries: [...new Map(snapshot.records.filter(r => r.example).map(r => [r.example.digest, { exampleDigest: r.example.digest, contentSha256: digest(trainingContent(r.example)), tokens: 50, supervisedTokens: 5 }])).values()] }, ...changes };
}
function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), "amos-replay-")); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
}

test("exact experience and both HRR indices survive a real process restart", t => {
  const dir = temporary(t), snapshot = fixture(), path = saveReplayMemory(dir, snapshot);
  const query = { tenantId, taskFamily: "calendar", text: "month end calendar leap February", limit: 3 };
  const expected = recallReplayMemory(snapshot, query);
  assert.ok(expected.results.every(r => Number.isFinite(r.score)));
  const code = `import { loadReplayMemory, recallReplayMemory } from './swarm/src/persistentReplayMemory.js'; console.log(JSON.stringify(recallReplayMemory(loadReplayMemory(process.argv[1],process.argv[2]),JSON.parse(process.argv[3]))));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code, path, snapshot.digest, JSON.stringify(query)], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), expected);
  assert.deepEqual(loadReplayMemory(path, snapshot.digest).records, snapshot.records);
  assert.equal(saveReplayMemory(dir, snapshot), path);
  assert.deepEqual(readdirSync(dir), [`${snapshot.digest}.json`]);
});

test("new generations inherit exact records, deduplicate restart input and preserve the parent", t => {
  const dir = temporary(t), parent = fixture(), original = saveReplayMemory(dir, parent);
  const unchanged = createReplayMemory({ tenantId, previous: parent, observations: [parent.records[0]] });
  assert.equal(unchanged.digest, parent.digest);
  const child = createReplayMemory({ tenantId, previous: parent, observations: [experience("next")] });
  assert.equal(child.previousDigest, parent.digest); assert.equal(child.records.length, parent.records.length + 1);
  saveReplayMemory(dir, child); assert.deepEqual(loadReplayMemory(original, parent.digest), parent);
  const conflict = experience(parent.records[0].id, "different experience");
  assert.throws(() => createReplayMemory({ tenantId, previous: parent, observations: [conflict] }), /collision/);
});

test("tampering, encoder drift, wrong generation and cross-tenant recall are refused", t => {
  const dir = temporary(t), snapshot = fixture(), path = saveReplayMemory(dir, snapshot);
  for (const change of [s => { s.records[0].text = "tampered"; }, s => { s.index.semanticDigest = hash("other"); }, s => { s.config.encoder.sources["holographicWorldV2.js"] = hash("new-code"); }]) {
    const changed = structuredClone(snapshot); change(changed); assert.throws(() => validateReplayMemory(changed));
  }
  assert.throws(() => loadReplayMemory(path, hash("different")), /generation/);
  assert.throws(() => recallReplayMemory(snapshot, { tenantId: "other", taskFamily: "calendar", text: "query" }), /cross-tenant/);
  assert.throws(() => createReplayMemory({ tenantId: "other", observations: snapshot.records }), /cross-tenant/);
  assert.throws(() => createReplayMemory({ tenantId, observations: snapshot.records, config: { maxEntries: 1 } }), /capacity/);
  assert.throws(() => writeImmutableReplayFile(dir, `${snapshot.digest}.json`, "overwrite"));
  assert.deepEqual(loadReplayMemory(path, snapshot.digest), snapshot);
});

test("books can enter memory without becoming successful training demonstrations", () => {
  const reference = experience("reference", "Reference chapter on calendar arithmetic", { example: null,
    source: { kind: "document", reference: "book:licensed", permittedUses: ["memory"], permissionReference: "reference-only" },
    verification: { status: "unverified" } });
  const snapshot = createReplayMemory({ tenantId, previous: fixture(), observations: [reference] });
  assert.equal(snapshot.records.find(r => r.id === "reference").example, null);
  assert.throws(() => prepareMatchedReplayExperiment(request(snapshot, { newExperienceIds: ["reference"] })), /not eligible/);
  assert.throws(() => experience("not-bound", "text", { verification: { status: "verified", verifierId: "checker", receiptSha256: hash("receipt"), exampleDigest: hash("wrong") } }), /bind the actual example/);
  assert.throws(() => experience("sealed", "text", { partition: "sealed" }), /partition/);
});

test("matched arms preserve new learning and exact replay exposure; choices reproduce after restart", t => {
  const dir = temporary(t), snapshot = fixture(), result = prepareMatchedReplayExperiment(request(snapshot));
  assert.equal(result.arms.control.tokens, result.arms.hrr.tokens);
  assert.equal(result.arms.control.supervisedTokens, result.arms.hrr.supervisedTokens);
  assert.deepEqual(result.arms.control.rows[0], result.arms.hrr.rows[0]);
  assert.equal(new Set(result.arms.hrr.replayExperienceIds).size, 3);
  assert.equal(result.arms.hrr.replayExperienceIds[0], "old-3");
  assert.ok(result.manifest.distinctReplaySlots > 0);
  const path = saveReplayMemory(dir, snapshot);
  assert.deepEqual(prepareMatchedReplayExperiment(request(loadReplayMemory(path, snapshot.digest))), result);
  const output = join(dir, "experiment"); writeMatchedReplayExperiment(output, result); writeMatchedReplayExperiment(output, result);
  assert.equal(hash(readFileSync(join(output, "hrr.training.jsonl"))), result.manifest.arms.hrr.sha256);
  assert.equal(result.manifest.createsQualityEvidence, false);
});

test("excluded lineage, development copies, failed demonstrations and duplicate content cannot leak into replay", () => {
  const parent = fixture(), source = parent.records.find(r => r.id === "old-3");
  const developmentCopy = createObservedExperience({ ...source, id: "development-copy", partition: "development", lineageGroups: ["dev-lineage"] });
  const failed = experience("failed", "month end calendar leap February", { verification: { status: "failed" } });
  const noTraining = experience("no-training", "month end calendar leap February", { source: { kind: "human-demonstration", reference: "fixture:read", permittedUses: ["memory"], permissionReference: "memory-only" } });
  const snapshot = createReplayMemory({ tenantId, previous: parent, observations: [developmentCopy, failed, noTraining] });
  const result = prepareMatchedReplayExperiment(request(snapshot, { excludedLineages: ["lineage-old-0"] }));
  for (const arm of Object.values(result.arms)) {
    assert.ok(!arm.replayExperienceIds.some(id => ["development-copy", "old-3", "failed", "no-training", "old-0"].includes(id)));
  }
  assert.throws(() => prepareMatchedReplayExperiment(request(snapshot, { excludedLineages: ["lineage-new"] })), /not eligible/);
});

test("native token receipts are required and bind content; heterogeneous buckets remain exactly matched", () => {
  const input = request(fixture());
  input.tokenCounts.entries.forEach((entry, i) => { entry.tokens += i % 3; entry.supervisedTokens += i % 2; });
  const result = prepareMatchedReplayExperiment(input);
  assert.equal(result.arms.control.tokens, result.arms.hrr.tokens);
  assert.equal(result.arms.control.supervisedTokens, result.arms.hrr.supervisedTokens);
  const missing = structuredClone(input); missing.tokenCounts.entries.pop();
  assert.throws(() => prepareMatchedReplayExperiment(missing), /missing or unbound/);
  const wrong = structuredClone(input); wrong.tokenCounts.entries[0].contentSha256 = hash("wrong");
  assert.throws(() => prepareMatchedReplayExperiment(wrong), /missing or unbound/);
  assert.throws(() => prepareMatchedReplayExperiment({ ...input, excludedLineages: null }), /exclusions/);
});

test("CLI prepares complete artifacts and repeats exactly across independent invocations", t => {
  const dir = temporary(t), snapshot = fixture(), settings = request(snapshot);
  const observations = join(dir, "observations.json"), counts = join(dir, "counts.json"), path = join(dir, "request.json");
  writeFileSync(observations, JSON.stringify(snapshot.records)); writeFileSync(counts, JSON.stringify(settings.tokenCounts));
  const { snapshot: _snapshot, tokenCounts: _counts, tenantId: _tenant, ...experiment } = settings;
  writeFileSync(path, JSON.stringify({ schema: "amos.prepare-hrr-replay.v1", tenantId, config: snapshot.config,
    observations: { path: observations, sha256: hash(readFileSync(observations)) },
    experiment: { ...experiment, tokenCounts: { path: counts, sha256: hash(readFileSync(counts)) } }, outputDirectory: join(dir, "output") }));
  const argv = [resolve("swarm/scripts/prepareHrrReplay.js"), path, hash(readFileSync(path))];
  const first = spawnSync(process.execPath, argv, { encoding: "utf8" }), second = spawnSync(process.execPath, argv, { encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr); assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout); assert.equal(JSON.parse(first.stdout).modelCalls, 0);
  writeFileSync(counts, "{}");
  const changed = spawnSync(process.execPath, argv, { encoding: "utf8" });
  assert.equal(changed.status, 1); assert.match(changed.stderr, /hash mismatch/);
});

test("observed native tool demonstrations keep actions/results as context and the correct target", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/desktop-training-trace-fixtures-20260908.json", import.meta.url))).examples[0];
  const make = name => {
    const m = fixture.messages;
    const example = createAmosSystemTrainingExample({ id: `tool-${name}`, sourceEpisodeId: `tool-episode-${name}`, taskFamily: "calendar", role: "operator",
      input: { system: m[0].content, user: `${m[1].content}\nScenario ${name}`, toolTrace: { contextTurns: m.slice(2, -1), tools: fixture.tools } },
      target: { kind: "verified-synthesis", content: m.at(-1).content },
      safeguards: { credentialsRemoved: true, tenantFactsRemoved: true, hiddenReasoningExcluded: true, independentVerifierSelected: true, licensedForTraining: true } });
    return experience(name, example.input.user, { example,
      source: { kind: "external-model", modelId: "synthetic-teacher-fixture", reference: `fixture:tool-${name}`, permittedUses: ["memory", "training"], permissionReference: "synthetic-test-only" },
      verification: { status: "verified", receiptSha256: hash(`tool-receipt-${name}`), verifierId: "native-fixture-checker", exampleDigest: example.digest } });
  };
  const snapshot = createReplayMemory({ tenantId, observations: [make("new"), make("old-a"), make("old-b")] });
  const result = prepareMatchedReplayExperiment(request(snapshot, { replaySlots: 1 }));
  const row = result.arms.hrr.rows[1], example = snapshot.records.find(r => r.id === result.arms.hrr.replayExperienceIds[0]).example;
  assert.deepEqual(row.tools, example.input.toolTrace.tools);
  assert.deepEqual(row.messages.slice(2, -1), example.input.toolTrace.contextTurns);
  assert.deepEqual(row.messages.at(-1), { role: "assistant", content: example.target.content });
  assert.equal(row.metadata.sourceKind, "external-model");
  assert.equal(row.metadata.sourceModelId, "synthetic-teacher-fixture");
});

test("concurrent snapshot publishers converge and abandoned temporary files are never read", async t => {
  const dir = temporary(t), snapshot = fixture(), input = join(dir, "input.json"), output = join(dir, "memory");
  writeFileSync(input, JSON.stringify(snapshot));
  const code = `import {readFileSync} from 'node:fs'; import {saveReplayMemory} from './swarm/src/persistentReplayMemory.js'; console.log(saveReplayMemory(process.argv[1],JSON.parse(readFileSync(process.argv[2]))));`;
  const { spawn } = await import("node:child_process");
  const run = () => new Promise((accept, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, output, input]);
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject); child.on("close", status => status === 0 ? accept(stdout.trim()) : reject(new Error(stderr)));
  });
  const paths = await Promise.all([run(), run()]); assert.equal(paths[0], paths[1]);
  writeFileSync(join(output, ".interrupted.tmp"), '{"partial":');
  assert.deepEqual(loadReplayMemory(paths[0], snapshot.digest), snapshot);
  assert.equal(saveReplayMemory(output, snapshot), paths[0]);
});
