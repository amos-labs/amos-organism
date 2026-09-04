import test from "node:test";
import assert from "node:assert/strict";
import {
  BUSINESS_MEMORY_ARMS,
  BUSINESS_MEMORY_FAMILIES,
  businessMemoryProcedures,
  expectedAnswer,
  generateBusinessMemoryCases,
  gradeBusinessMemoryAnswerText,
  renderArmMessages,
  selectProcedures,
  verifyBusinessMemoryAnswer
} from "../src/businessMemoryBenchmark.js";
import {
  compareBusinessMemoryArms,
  compareBusinessMemoryModels,
  runBusinessMemoryBenchmark
} from "../src/businessMemoryGrading.js";

const manifest = generateBusinessMemoryCases({ seed: "test-seed", pool: "development", worlds: 2, casesPerFamily: 2 });
const worlds = new Map(manifest.worlds.map((world) => [world.id, world]));
const procedures = businessMemoryProcedures();
const worldFor = (testCase) => worlds.get(testCase.worldId);

function fakeWorker({ model, answer }) {
  return {
    model,
    controlId: `fake-${model}`,
    async runCase({ caseId, messages }) {
      const [caseKey, rest] = caseId.split("::");
      const arm = rest.replace(/:.*$/, "");
      const testCase = manifest.cases.find((item) => item.id === caseKey);
      if (!testCase) throw new Error(`fake worker has no case for ${caseId}`);
      const content = answer({ testCase, arm, messages });
      return { message: { role: "assistant", content }, metrics: { outputTokens: 30 } };
    }
  };
}

test("generation is deterministic per seed and separates pools", () => {
  const again = generateBusinessMemoryCases({ seed: "test-seed", pool: "development", worlds: 2, casesPerFamily: 2 });
  assert.equal(again.digest, manifest.digest);
  const holdout = generateBusinessMemoryCases({ seed: "test-seed", pool: "holdout", worlds: 2, casesPerFamily: 2 });
  assert.notEqual(holdout.digest, manifest.digest);
  const developmentIds = new Set(manifest.worlds.map((world) => world.id));
  assert.ok(holdout.worlds.every((world) => !developmentIds.has(world.id)));
  assert.ok(holdout.worlds.every((world, index) => world.digest !== manifest.worlds[index].digest));
  for (const family of BUSINESS_MEMORY_FAMILIES) {
    assert.ok(manifest.cases.some((testCase) => testCase.family === family), `missing family ${family}`);
  }
});

test("every case accepts its expected answer and rejects its distractor", () => {
  for (const testCase of manifest.cases) {
    const world = worldFor(testCase);
    const accepted = verifyBusinessMemoryAnswer({ testCase, world, answer: expectedAnswer(testCase) });
    assert.equal(accepted.passed, true, `${testCase.id}: ${accepted.failures.join("; ")}`);
    const rejected = verifyBusinessMemoryAnswer({ testCase, world, answer: testCase.rejected });
    assert.equal(rejected.passed, false, `${testCase.id} accepted its distractor`);
  }
});

test("the verifier does not string-match prose and tolerates fenced JSON", () => {
  const testCase = manifest.cases.find((item) => item.family === "current-value-after-supersession");
  const world = worldFor(testCase);
  const fenced = "Here you go:\n```json\n" + JSON.stringify(expectedAnswer(testCase)) + "\n```";
  assert.equal(gradeBusinessMemoryAnswerText({ testCase, world, text: fenced }).passed, true);
  const prose = gradeBusinessMemoryAnswerText({ testCase, world, text: `The value is ${testCase.expected.answer}.` });
  assert.equal(prose.passed, false);
  assert.ok(prose.failures[0].startsWith("answer-is-json"));
  const missingGrounding = verifyBusinessMemoryAnswer({
    testCase,
    world,
    answer: { ...expectedAnswer(testCase), grounding: [] }
  });
  assert.equal(missingGrounding.passed, false);
  assert.ok(missingGrounding.failures.some((failure) => failure.startsWith("grounding-cites-record")));
});

test("scope and memory-class verifiers reject leaked values even under the right status", () => {
  const scoped = manifest.cases.find((item) => item.family === "scope-boundary");
  const leak = verifyBusinessMemoryAnswer({
    testCase: scoped,
    world: worldFor(scoped),
    answer: { status: "scope_denied", answer: null, grounding: [], conflict: { claimed: scoped.facts.hiddenValues[0], recorded: null } }
  });
  assert.equal(leak.passed, false);
  assert.ok(leak.failures.some((failure) => failure.startsWith("no-hidden-value-leak")));

  const privateRecall = manifest.cases.find((item) => item.family === "memory-class-recall" && item.facts.visibility === "private-session");
  assert.ok(privateRecall, "expected a private-session recall case");
  const restated = verifyBusinessMemoryAnswer({
    testCase: privateRecall,
    world: worldFor(privateRecall),
    answer: { status: "unknown", answer: null, grounding: [], conflict: { claimed: privateRecall.facts.hiddenValues[0], recorded: null } }
  });
  assert.equal(restated.passed, false);
});

test("arms expose exactly the memory they claim to", () => {
  for (const testCase of manifest.cases) {
    const world = worldFor(testCase);
    const alone = renderArmMessages({ arm: "alone", testCase, world, procedures })[1].content;
    const memory = renderArmMessages({ arm: "memory", testCase, world, procedures })[1].content;
    const withProcedures = renderArmMessages({ arm: "procedures", testCase, world, procedures })[1].content;
    assert.ok(!alone.includes("Authenticated envelope"));
    assert.ok(!alone.includes("Host-recorded records"));
    assert.ok(memory.includes("Authenticated envelope"));
    assert.ok(!memory.includes("Verified operating procedures"));
    assert.ok(withProcedures.includes("[proc-scope-denial]"));
    // The question may name an entity by id; everything before it must not.
    const aloneContext = alone.split("## Question")[0];
    for (const id of testCase.expected.grounding) {
      assert.ok(memory.includes(id), `${testCase.id}: memory arm must show grounding ${id}`);
      assert.ok(!aloneContext.includes(id), `${testCase.id}: alone arm must not show ${id} outside the question`);
    }
    const memoryContext = memory.split("## Question")[0];
    if (testCase.family === "scope-boundary") {
      assert.ok(!memoryContext.includes(testCase.facts.hiddenRecordId), `${testCase.id}: hidden record rendered to an out-of-scope asker`);
    }
    if (testCase.family === "memory-class-recall" && testCase.facts.visibility === "private-session") {
      assert.ok(!memoryContext.includes(testCase.facts.hiddenValues[0]), `${testCase.id}: private session content rendered to another user`);
    }
    // Sessions belong to their speaker only.
    const asker = world.users.find((user) => user.id === testCase.askerId);
    for (const session of world.sessions.filter((item) => item.userId !== asker.id)) {
      assert.ok(!memory.includes(session.id), `${testCase.id}: another user's session ${session.id} rendered`);
    }
  }
});

test("procedure selection follows the case's collections plus general rules", () => {
  const invoiceCase = manifest.cases.find((item) => item.family === "derived-total-from-records");
  const selected = selectProcedures({ testCase: invoiceCase, procedures }).map((procedure) => procedure.id);
  assert.ok(selected.includes("proc-totals-from-recorded-state"));
  assert.ok(selected.includes("proc-scope-denial"));
  assert.ok(procedures.every((procedure) => procedure.origin === "authored-v0" && /^[a-f0-9]{64}$/.test(procedure.digest)));
});

test("grading separates arms and comparison counts paired wins", async () => {
  const oracle = fakeWorker({ model: "oracle", answer: ({ testCase }) => JSON.stringify(expectedAnswer(testCase)) });
  const oracleReport = await runBusinessMemoryBenchmark({ worker: oracle, manifest, procedures, now: () => new Date("2026-09-04T00:00:00Z") });
  assert.equal(oracleReport.arms.length, BUSINESS_MEMORY_ARMS.length);
  assert.ok(oracleReport.arms.every((summary) => summary.passRate === 1));
  assert.equal(oracleReport.interpretation.qualityClaimAllowed, false);

  const memoryOnly = fakeWorker({
    model: "memory-only",
    answer: ({ testCase, messages }) => messages[1].content.includes("Host-recorded records")
      ? JSON.stringify(expectedAnswer(testCase))
      : JSON.stringify(testCase.rejected)
  });
  const report = await runBusinessMemoryBenchmark({ worker: memoryOnly, manifest, procedures });
  const byArm = Object.fromEntries(report.arms.map((summary) => [summary.arm, summary.passRate]));
  assert.equal(byArm.alone, 0);
  assert.equal(byArm.memory, 1);
  assert.equal(byArm.procedures, 1);
  const comparison = compareBusinessMemoryArms(report);
  const memoryVersusAlone = comparison.comparisons.find((item) => item.baseline === "alone" && item.treatment === "memory");
  assert.equal(memoryVersusAlone.pairedWins, manifest.cases.length);
  assert.equal(memoryVersusAlone.pairedLosses, 0);
  assert.equal(memoryVersusAlone.passRateLift, 1);
  const proceduresVersusMemory = comparison.comparisons.find((item) => item.baseline === "memory" && item.treatment === "procedures");
  assert.equal(proceduresVersusMemory.ties, manifest.cases.length);

  const models = compareBusinessMemoryModels({ candidate: oracleReport, control: report, arm: "alone" });
  assert.equal(models.pairedWins, manifest.cases.length);
  assert.equal(models.passRateLift, 1);
  assert.throws(() => compareBusinessMemoryModels({
    candidate: oracleReport,
    control: { ...report, manifestDigest: "0".repeat(64) },
    arm: "alone"
  }));
});

test("prose answers are graded as failures and recovery is attempted", async () => {
  let calls = 0;
  const chatty = fakeWorker({
    model: "chatty",
    answer: () => {
      calls += 1;
      return "I believe the value is probably thirty days.";
    }
  });
  const report = await runBusinessMemoryBenchmark({ worker: chatty, manifest, arms: ["alone"], procedures });
  assert.equal(report.arms[0].passRate, 0);
  assert.ok(report.runs.every((run) => run.recoveryTriggered));
  assert.equal(calls, manifest.cases.length * 2);
});

test("harvest repairs with verifier feedback only, elicits general rules, and admits only vested candidates", async () => {
  const { harvestBusinessMemoryProcedures, loadProcedureStore, rejectRule } = await import("../src/businessMemoryHarvest.js");
  const { BUSINESS_MEMORY_JUDGMENT_FAMILIES } = await import("../src/businessMemoryBenchmark.js");
  const judgment = new Set(BUSINESS_MEMORY_JUDGMENT_FAMILIES);
  // A substrate that fails judgment families unless a harvested rule is present,
  // repairs when told why, and never learns the replay-safety rule.
  const worker = {
    model: "learner",
    controlId: "fake-learner",
    async runCase({ caseId, messages }) {
      const [caseKey, phase] = caseId.split("::");
      const testCase = manifest.cases.find((item) => item.id === caseKey);
      const text = messages.map((message) => String(message.content)).join("\n");
      if (phase.startsWith("rule")) {
        return { message: { role: "assistant", content: JSON.stringify({ rule: `Apply the ${testCase.family} rule before answering.` }) }, metrics: { outputTokens: 20 } };
      }
      const repairing = text.includes("The verifier rejected that answer");
      const hasRule = text.includes(`Apply the ${testCase.family} rule`) && testCase.family !== "replay-safety";
      const knows = !judgment.has(testCase.family) || repairing || hasRule;
      assert.ok(!text.includes(JSON.stringify(testCase.expected)), "the target must never reach the model");
      return {
        message: { role: "assistant", content: JSON.stringify(knows ? expectedAnswer(testCase) : testCase.rejected) },
        metrics: { outputTokens: 30 }
      };
    }
  };
  const baseline = await runBusinessMemoryBenchmark({ worker, manifest, arms: ["memory"], procedures: [] });
  const failed = baseline.runs.filter((run) => !run.passed);
  assert.ok(failed.length > 0);
  const store = await harvestBusinessMemoryProcedures({ worker, manifest, memoryRuns: baseline.runs, now: () => new Date("2026-09-04T00:00:00Z") });
  assert.equal(store.repairs.length, failed.length);
  assert.ok(store.repairs.every((repair) => repair.repaired));
  const admittedFamilies = new Set(store.procedures.map((procedure) => procedure.lineage.family));
  assert.ok(admittedFamilies.has("approval-required-decision"));
  assert.ok(!admittedFamilies.has("replay-safety"), "a rule with no verified lift is not admitted");
  assert.ok(store.rejected.some((item) => item.family === "replay-safety" && item.reason === "no verified lift"));
  assert.ok(store.procedures.every((procedure) => procedure.lineage.pairedLosses === 0 && procedure.lineage.pairedWins > 0));
  const loaded = loadProcedureStore(JSON.parse(JSON.stringify(store)));
  assert.equal(loaded.length, store.procedures.length);
  assert.throws(() => loadProcedureStore({ ...store, procedures: [{ ...store.procedures[0], statement: "tampered" }] }));
  assert.equal(rejectRule("Always cite the record camp-1234 when you answer."), "rule names a specific record id");
  assert.equal(rejectRule("Approval is always required for any amount above 2500."), "rule contains a specific amount or date");
  assert.equal(rejectRule("Compare the proposed value with the threshold in effect at proposal time."), null);
  assert.equal(rejectRule('{"rule":"When'), "rule is not plain prose");
  assert.equal(rejectRule("Check the date."), "rule has fewer than 6 words");
  await assert.rejects(() => harvestBusinessMemoryProcedures({ worker, manifest: { ...manifest, pool: "holdout" }, memoryRuns: baseline.runs }));
});
