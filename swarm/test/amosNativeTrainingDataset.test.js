import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  compileAmosNativeTrainingDataset,
  createAmosSystemTrainingExample,
  writeAmosNativeTrainingDataset,
  sftRow
} from "../src/amosNativeTrainingDataset.js";
import { createSwarmLearningEpisode } from "../src/swarmLearningArena.js";
import { openSwarmLearningStore } from "../src/swarmLearningStore.js";

const plan = {
  schema: "amos.swarm-substrate-adapter-training",
  id: "adapter-test-v1",
  base: { model: "qwen-test" },
  data: {
    minimumTrainingEpisodes: 1,
    minimumValidationEpisodes: 1,
    minimumHoldoutEpisodes: 1,
    minimumTaskFamilies: 3
  }
};

function exampleInput(id, episodeId, family, correction = false) {
  return {
    id,
    sourceEpisodeId: episodeId,
    taskFamily: family,
    role: "tool-specialist",
    input: {
      system: "Follow the governed AMOS tool contract.",
      user: `Produce the verified ${family} transition.`
    },
    target: { kind: "tool-call", content: `{"operation":"${family}"}` },
    correction: correction ? {
      rejectedContent: "{}",
      verifierSignal: "required operation was absent"
    } : null,
    safeguards: {
      credentialsRemoved: true,
      tenantFactsRemoved: true,
      hiddenReasoningExcluded: true,
      independentVerifierSelected: true,
      licensedForTraining: true
    }
  };
}

async function recordTrainingEpisode(store, index, family, correction = false, dataPolicy = null) {
  const id = `episode-${index}`;
  const example = createAmosSystemTrainingExample(
    exampleInput(`example-${index}`, id, family, correction)
  );
  const exampleDigest = await store.putBlob(`${JSON.stringify(example)}\n`);
  return store.recordEpisode(createSwarmLearningEpisode({
    id,
    treatmentId: "amos-native-fixture",
    partition: dataPolicy?.sourceClass === "public-benchmark" ? "development" : "operations",
    task: { source: "amos-missions", name: family, ref: `mission:${index}`, checksum: null },
    model: {
      provider: "amos",
      name: "qwen-test",
      agent: "amos-holographic-swarm",
      agentVersion: "1",
      sharedBackbone: true
    },
    execution: {
      status: "completed",
      startedAt: "2026-08-23T10:00:00Z",
      finishedAt: "2026-08-23T10:01:00Z",
      exception: null
    },
    verifier: {
      kind: "fixture-verifier",
      status: "passed",
      score: 1,
      evidenceRefs: [`receipt:${index}`]
    },
    artifacts: [{
      ref: `artifact:${index}`,
      kind: "fixture",
      status: "collected",
      digest: String(index).padStart(64, "a").slice(-64)
    }],
    traces: [{
      ref: `blob:sha256:${exampleDigest}/example.json`,
      kind: "amos-system-training-example",
      status: "collected",
      digest: exampleDigest
    }],
    ecology: {
      ref: `ecology:${index}`,
      digest: String(index).padStart(64, "b").slice(-64),
      status: "completed",
      agentCount: 3,
      assignmentCount: 4
    },
    curriculumSignals: [],
    dataPolicy: dataPolicy || {
      sourceClass: "internal-authorized",
      permittedUses: ["evaluation", "research", "training"],
      trainingApproved: true,
      contaminationTags: []
    }
  }));
}

test("AMOS system training examples require every privacy and verification safeguard", () => {
  const input = exampleInput("example-1", "episode-1", "tool-use");
  input.safeguards.hiddenReasoningExcluded = false;
  assert.throws(() => createAmosSystemTrainingExample(input), /hiddenReasoningExcluded/);
});

test("the exporter produces immutable family-disjoint SFT and preference datasets", async () => {
  const root = await mkdtemp(join(tmpdir(), "amos-native-store-"));
  const output = await mkdtemp(join(tmpdir(), "amos-native-output-"));
  const store = await openSwarmLearningStore(root);
  await recordTrainingEpisode(store, 1, "tool-use", true);
  await recordTrainingEpisode(store, 2, "artifact-build");
  await recordTrainingEpisode(store, 3, "recovery");

  const dataset = await compileAmosNativeTrainingDataset({ store, plan });
  assert.equal(dataset.ready, true);
  assert.deepEqual(dataset.manifest.blockers, []);
  assert.equal(dataset.manifest.counts.examples, 3);
  assert.equal(dataset.manifest.counts.preferencePairs, 1);
  assert.equal(dataset.manifest.safeguards.publicBenchmarksExcluded, true);

  const written = await writeAmosNativeTrainingDataset(output, dataset);
  const manifest = JSON.parse(await readFile(join(written.output, "dataset-manifest.json"), "utf8"));
  assert.equal(manifest.digest, dataset.manifest.digest);
  assert.match(await readFile(join(output, "training.sft.jsonl"), "utf8"), /messages/);
  await writeAmosNativeTrainingDataset(output, dataset);
});

test("licensed public development examples mix into training and remain excluded from evaluation", async () => {
  const root = await mkdtemp(join(tmpdir(), "amos-native-mixed-"));
  const store = await openSwarmLearningStore(root);
  await recordTrainingEpisode(store, 1, "tool-use", true, {
    sourceClass: "public-benchmark",
    permittedUses: ["research", "training"],
    trainingApproved: true,
    contaminationTags: [
      "license:apache-2.0:terminal-bench-3.0.0-production-planning",
      "exclude-eval:terminal-bench-3.0.0:production-planning"
    ]
  });
  await recordTrainingEpisode(store, 2, "artifact-build");
  await recordTrainingEpisode(store, 3, "recovery");

  const dataset = await compileAmosNativeTrainingDataset({ store, plan });
  assert.equal(dataset.ready, true);
  assert.equal(dataset.manifest.counts.publicBenchmarkEpisodes, 1);
  assert.equal(dataset.manifest.safeguards.publicBenchmarksExcluded, false);
  assert.equal(dataset.manifest.safeguards.publicBenchmarkEvaluationReuseForbidden, true);
  assert.deepEqual(dataset.manifest.evaluationExclusions, [
    "exclude-eval:terminal-bench-3.0.0:production-planning"
  ]);
});

test("the current public-benchmark-only store stays safely data-gated", async () => {
  const root = await mkdtemp(join(tmpdir(), "amos-native-empty-"));
  const store = await openSwarmLearningStore(root);
  const dataset = await compileAmosNativeTrainingDataset({ store, plan });
  assert.equal(dataset.ready, false);
  assert.ok(dataset.manifest.blockers.includes("training-examples:0/1"));
  await assert.rejects(
    () => writeAmosNativeTrainingDataset(join(root, "output"), dataset),
    /unqualified/
  );
});

// Actual native Desktop tool-trajectory fixtures (frozen Agent 764847a0), copied byte-for-byte from
// coordination/artifacts/pilot-dataset-review-20260908/desktop-training-trace-fixtures.json.
const NATIVE_TRACE = JSON.parse(
  await readFile(new URL("./fixtures/desktop-training-trace-fixtures-20260908.json", import.meta.url), "utf8"),
);

// Map a native trajectory (system, user, [assistant call, tool result]..., final assistant) to an
// AMOS training-example input: everything before the final assistant is masked context.
function traceExampleInput(fixture, id) {
  const messages = fixture.messages;
  const final = messages.at(-1);
  return {
    id, sourceEpisodeId: `episode-${id}`, taskFamily: "calculator-runway", role: "tool-specialist",
    input: {
      system: messages[0].content,
      user: messages[1].content,
      toolTrace: { contextTurns: structuredClone(messages.slice(2, -1)), tools: structuredClone(fixture.tools) }
    },
    target: { kind: "tool-call", content: final.content },
    correction: null,
    safeguards: { credentialsRemoved: true, tenantFactsRemoved: true, hiddenReasoningExcluded: true, independentVerifierSelected: true, licensedForTraining: true }
  };
}

test("the compiler emits a real native Desktop tool trajectory verbatim with parsed tool arguments", () => {
  const fixture = NATIVE_TRACE.examples[0];
  const example = createAmosSystemTrainingExample(traceExampleInput(fixture, "example-native-usd"));
  const row = sftRow(example);
  // system, user, (assistant call, tool result) x2, final assistant target.
  assert.deepEqual(row.messages.map((m) => m.role), ["system", "user", "assistant", "tool", "assistant", "tool", "assistant"]);
  const call = row.messages[2];
  assert.equal(call.content, null, "an assistant tool-call turn keeps its null content");
  assert.equal(typeof call.tool_calls[0].function.arguments, "object", "string arguments are parsed to an object for the template");
  assert.equal(call.tool_calls[0].function.name, "desktop_calculate");
  assert.equal(row.messages[3].role, "tool");
  assert.ok(typeof row.messages[3].tool_call_id === "string" && row.messages[3].tool_call_id.length > 0, "tool turns keep their tool_call_id");
  assert.equal(row.messages.at(-1).content, fixture.messages.at(-1).content, "the final assistant is the supervised target");
  assert.deepEqual(row.tools, fixture.tools);
  // Deterministic, self-validating digest.
  assert.equal(createAmosSystemTrainingExample(traceExampleInput(fixture, "example-native-usd")).digest, example.digest);
});

test("both native trace fixtures compile and preserve their masked tool context", () => {
  for (const fixture of NATIVE_TRACE.examples) {
    const example = createAmosSystemTrainingExample(traceExampleInput(fixture, `example-${fixture.id}`));
    const row = sftRow(example);
    assert.equal(row.messages[0].role, "system");
    assert.equal(row.messages.at(-1).role, "assistant");
    assert.ok(row.tools.length >= 1);
    // Every masked assistant call preserves a parsed-object arguments payload.
    for (const m of row.messages.slice(2, -1)) {
      if (m.role === "assistant" && m.tool_calls) {
        for (const c of m.tool_calls) assert.equal(typeof c.function.arguments, "object");
      }
    }
  }
});

test("a plain example still renders three messages with no tools key and an unchanged digest", () => {
  const withoutTrace = createAmosSystemTrainingExample(exampleInput("example-plain", "episode-plain", "revenue"));
  assert.equal(withoutTrace.input.toolTrace, undefined, "no toolTrace key is added when none is supplied");
  const row = sftRow(withoutTrace);
  assert.deepEqual(row.messages.map((m) => m.role), ["system", "user", "assistant"]);
  assert.ok(!("tools" in row), "a tool-free row carries no tools key");
});

test("malformed tool traces are rejected: trailing assistant, empty turns/tools, non-JSON args, misplaced fields", () => {
  const fixture = NATIVE_TRACE.examples[0];
  const base = () => traceExampleInput(fixture, "example-bad");
  const withTrace = (mutate) => { const input = base(); mutate(input.input.toolTrace); return () => createAmosSystemTrainingExample(input); };
  assert.throws(withTrace((t) => t.contextTurns.push({ role: "assistant", content: "premature" })), /must not end with an assistant turn/);
  assert.throws(withTrace((t) => { t.tools = []; }), /tools must be a non-empty array/);
  assert.throws(withTrace((t) => { t.contextTurns[0].tool_calls[0].function.arguments = "{not json"; }), /arguments is not valid JSON/);
  assert.throws(withTrace((t) => { t.contextTurns[1].tool_calls = [{ function: { name: "x", arguments: {} } }]; }), /tool_calls is only valid on an assistant turn/);
});

// A corrected-tool-call example: mask the failed call + its error, supervise the corrected call.
function correctedCallExampleInput(fixture, id) {
  const m = fixture.messages;
  return {
    id, sourceEpisodeId: `episode-${id}`, taskFamily: "calculator-runway", role: "tool-specialist",
    input: { system: m[0].content, user: m[1].content, toolTrace: { contextTurns: structuredClone(m.slice(2, 4)), tools: structuredClone(fixture.tools) } },
    target: { kind: "tool-call", content: m[4].content, toolCalls: structuredClone(m[4].tool_calls) },
    correction: null,
    safeguards: { credentialsRemoved: true, tenantFactsRemoved: true, hiddenReasoningExcluded: true, independentVerifierSelected: true, licensedForTraining: true }
  };
}

test("a structured corrected-tool-call target supervises the tool_calls message with parsed args", () => {
  const fixture = NATIVE_TRACE.examples[0];
  const example = createAmosSystemTrainingExample(correctedCallExampleInput(fixture, "example-corrected-usd"));
  const row = sftRow(example);
  assert.deepEqual(row.messages.map((m) => m.role), ["system", "user", "assistant", "tool", "assistant"]);
  const final = row.messages.at(-1);
  assert.equal(final.content, null, "the corrected-call target keeps null content");
  assert.equal(typeof final.tool_calls[0].function.arguments, "object", "the target's string arguments are parsed to an object");
  assert.equal(final.tool_calls[0].function.name, "desktop_calculate");
  assert.deepEqual(row.tools, example.input.toolTrace.tools);
});

test("a first-call example (zero intermediate turns) supervises the tool call directly", () => {
  const fixture = NATIVE_TRACE.examples[0];
  const m = fixture.messages;
  const example = createAmosSystemTrainingExample({
    id: "example-firstcall", sourceEpisodeId: "e", taskFamily: "calc", role: "tool-specialist",
    input: { system: m[0].content, user: m[1].content, toolTrace: { contextTurns: [], tools: structuredClone(fixture.tools) } },
    target: { kind: "tool-call", toolCalls: structuredClone(m[2].tool_calls) },
    correction: null,
    safeguards: { credentialsRemoved: true, tenantFactsRemoved: true, hiddenReasoningExcluded: true, independentVerifierSelected: true, licensedForTraining: true }
  });
  const row = sftRow(example);
  assert.deepEqual(row.messages.map((mm) => mm.role), ["system", "user", "assistant"]);
  assert.ok(row.messages.at(-1).tool_calls.length >= 1);
  assert.equal(row.messages.at(-1).content, null);
});

test("a structured target requires a toolTrace tool schema", () => {
  assert.throws(() => createAmosSystemTrainingExample({
    id: "x", sourceEpisodeId: "e", taskFamily: "calc", role: "tool-specialist",
    input: { system: "s", user: "u" },
    target: { kind: "tool-call", toolCalls: [{ function: { name: "calc", arguments: {} } }] },
    correction: null,
    safeguards: { credentialsRemoved: true, tenantFactsRemoved: true, hiddenReasoningExcluded: true, independentVerifierSelected: true, licensedForTraining: true }
  }), /toolCalls requires an input.toolTrace/);
});
