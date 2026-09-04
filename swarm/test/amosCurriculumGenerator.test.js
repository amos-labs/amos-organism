import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  AMOS_CURRICULUM_FAMILIES,
  generateCurriculumScenario,
  generateCurriculumScenarios,
  gradeCurriculumAnswerText,
  recordCurriculumScenarios,
  validateAgainstSchema,
  validateToolCatalog,
  verifyCurriculumAnswer
} from "../src/amosCurriculumGenerator.js";
import { compileAmosNativeTrainingDataset } from "../src/amosNativeTrainingDataset.js";
import { openSwarmLearningStore } from "../src/swarmLearningStore.js";

const swarmRoot = fileURLToPath(new URL("..", import.meta.url));
const catalog = JSON.parse(await readFile(join(swarmRoot, "benchmarks/amos-tool-catalog-v1.json"), "utf8"));
const plan = JSON.parse(await readFile(join(swarmRoot, "benchmarks/swarm-qwen-adapter-training-v1.json"), "utf8"));

test("the committed tool catalog is real, digested, and free of tenant facts", () => {
  const validated = validateToolCatalog(catalog);
  assert.ok(validated.tools.length >= 40);
  assert.equal(validated.rights.tenantFactsIncluded, false);
  assert.ok(validated.tools.some(({ reserved }) => reserved === true));
  assert.ok(validated.tools.some(({ authority }) => authority === "consequential"));
  assert.throws(() => validateToolCatalog({ ...catalog, tools: catalog.tools.slice(1) }), /digest does not match/);
});

test("generation is deterministic per seed and differs across seeds", () => {
  const first = generateCurriculumScenario({ catalog, family: AMOS_CURRICULUM_FAMILIES[3], index: 7, seed: "alpha" });
  const again = generateCurriculumScenario({ catalog, family: AMOS_CURRICULUM_FAMILIES[3], index: 7, seed: "alpha" });
  const other = generateCurriculumScenario({ catalog, family: AMOS_CURRICULUM_FAMILIES[3], index: 7, seed: "beta" });
  assert.equal(first.digest, again.digest);
  assert.notEqual(first.digest, other.digest);
  assert.notEqual(first.prompt.user, other.prompt.user);
});

test("every family emits a target its verifier accepts and a rejected output it refuses", () => {
  const scenarios = generateCurriculumScenarios({ catalog, scenariosPerFamily: 12, seed: "test" });
  assert.equal(scenarios.length, AMOS_CURRICULUM_FAMILIES.length * 12);
  for (const scenario of scenarios) {
    assert.equal(verifyCurriculumAnswer({ scenario, answer: scenario.target }).passed, true, scenario.id);
    const rejected = verifyCurriculumAnswer({ scenario, answer: scenario.rejected });
    assert.equal(rejected.passed, false, scenario.id);
    assert.ok(rejected.failures.length > 0);
    assert.equal(rejected.evaluator, "amos-executable-contract-verifier");
  }
  assert.equal(new Set(scenarios.map(({ prompt }) => prompt.user)).size, scenarios.length);
});

test("holdout pool draws only reserved tools and always revises the schema", () => {
  const reserved = new Set(catalog.tools.filter(({ reserved: flag }) => flag).map(({ name }) => name));
  const scenarios = generateCurriculumScenarios({ catalog, scenariosPerFamily: 6, seed: "holdout", pool: "holdout" });
  for (const scenario of scenarios) {
    for (const tool of scenario.toolsUsed) assert.ok(reserved.has(tool), `${scenario.id} used unreserved ${tool}`);
    if (scenario.family === "emit-valid-typed-tool-arguments") assert.notEqual(scenario.facts.schemaRevision, null);
  }
  const training = generateCurriculumScenarios({ catalog, scenariosPerFamily: 6, seed: "holdout", pool: "training" });
  for (const scenario of training) {
    for (const tool of scenario.toolsUsed) assert.ok(!reserved.has(tool), `${scenario.id} leaked reserved ${tool}`);
  }
});

test("the verifier grades semantics, not surface form", () => {
  const scenario = generateCurriculumScenario({ catalog, family: "recover-without-replaying-completed-actions", index: 3, seed: "semantics" });
  const reordered = {
    ...scenario.target,
    preserveReceipts: [...scenario.target.preserveReceipts].reverse(),
    doNotReplay: [...scenario.target.doNotReplay].reverse()
  };
  assert.equal(verifyCurriculumAnswer({ scenario, answer: reordered }).passed, true);
  const overBound = { ...scenario.target, maxRetries: scenario.facts.hostRetryBound + 1 };
  const verdict = verifyCurriculumAnswer({ scenario, answer: overBound });
  assert.equal(verdict.passed, false);
  assert.ok(verdict.failures.some((failure) => failure.startsWith("within-host-bound")));
});

test("approval scenarios fail both over-asking and under-asking", () => {
  const scenarios = generateCurriculumScenarios({ catalog, scenariosPerFamily: 40, seed: "approval", families: ["request-approval-only-at-real-authority-boundaries"] });
  const executes = scenarios.filter(({ target }) => target.transition === "execute");
  const requests = scenarios.filter(({ target }) => target.transition === "request-approval");
  assert.ok(executes.length >= 5 && requests.length >= 5, "both decisions must appear");
  const overAsk = { transition: "request-approval", tool: executes[0].target.tool, authority: "write:anything", execute: false };
  assert.equal(verifyCurriculumAnswer({ scenario: executes[0], answer: overAsk }).passed, false);
  const underAsk = { transition: "execute", tool: requests[0].target.tool, execute: true, approvalRequested: false };
  assert.equal(verifyCurriculumAnswer({ scenario: requests[0], answer: underAsk }).passed, false);
});

test("raw model text is graded after JSON extraction and fails closed without JSON", () => {
  const scenario = generateCurriculumScenario({ catalog, family: "integrate-specialists-into-verifiable-result", index: 2, seed: "text" });
  const fenced = `Here is the result:\n\`\`\`json\n${JSON.stringify(scenario.target)}\n\`\`\``;
  assert.equal(gradeCurriculumAnswerText({ scenario, text: fenced }).passed, true);
  const prose = gradeCurriculumAnswerText({ scenario, text: "I integrated everything and it looks complete." });
  assert.equal(prose.passed, false);
  assert.equal(prose.checks[0].id, "answer-is-json");
});

test("the schema validator enforces the subset the catalog uses", () => {
  const schema = {
    type: "object", additionalProperties: false, required: ["id", "limit"],
    properties: { id: { type: "string", format: "uuid" }, limit: { type: "integer", minimum: 1, maximum: 10 }, tags: { type: "array", items: { enum: ["a", "b"] } } }
  };
  assert.deepEqual(validateAgainstSchema({ id: "123e4567-e89b-42d3-a456-426614174000", limit: 3, tags: ["a"] }, schema), []);
  const errors = validateAgainstSchema({ id: "nope", limit: 11, tags: ["z"], extra: 1 }, schema);
  assert.ok(errors.some((error) => error.includes("UUID")));
  assert.ok(errors.some((error) => error.includes("above 10")));
  assert.ok(errors.some((error) => error.includes("one of")));
  assert.ok(errors.some((error) => error.includes("not permitted")));
});

test("recorded scenarios clear the stage-one data gate with the real plan minimums", async () => {
  const root = await mkdtemp(join(tmpdir(), "amos-curriculum-store-"));
  const store = await openSwarmLearningStore(root);
  const scenarios = generateCurriculumScenarios({ catalog, scenariosPerFamily: 64, seed: "gate" });
  const manifest = await recordCurriculumScenarios({ store, scenarios, catalog });
  assert.equal(manifest.scenarioCount, 512);
  assert.equal(manifest.safeguards.verifierIndependentOfTarget, true);

  const dataset = await compileAmosNativeTrainingDataset({ store, plan });
  assert.deepEqual(dataset.manifest.blockers, []);
  assert.equal(dataset.ready, true);
  assert.ok(dataset.manifest.counts.trainingExamples >= 200);
  assert.ok(dataset.manifest.counts.validationExamples >= 50);
  assert.ok(dataset.manifest.counts.holdoutExamples >= 50);
  assert.equal(dataset.manifest.counts.taskFamilies, 8);
  assert.ok(dataset.manifest.counts.preferencePairs >= 200);

  const excluded = await compileAmosNativeTrainingDataset({ store, plan, excludeTreatmentIds: ["amos-native-stage1-curriculum-v1"] });
  assert.equal(excluded.manifest.counts.examples, 0);

  const holdout = generateCurriculumScenarios({ catalog, scenariosPerFamily: 2, seed: "gate", pool: "holdout" });
  await recordCurriculumScenarios({ store, scenarios: holdout, catalog });
  const episodes = await store.listEpisodes();
  const protectedEpisodes = episodes.filter(({ partition }) => partition === "validation");
  assert.equal(protectedEpisodes.length, 16);
  assert.ok(protectedEpisodes.every(({ trainingEligibility }) => trainingEligibility.eligible === false));
});
