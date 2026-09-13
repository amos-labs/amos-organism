import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createStateSkillFixture, STATE_SKILL_VARIANTS } from "../evals/stateSkillFixture.js";
import { projectObservedTaskState } from "../src/observedTaskState.js";
import { buildStateSkillDemonstrations, runStateSkillExperiment } from "../src/stateSkillExperiment.js";

const modelIdentity = { model: "synthetic-request-stub", weightsSha256: "a".repeat(64) };
const ref = path => ({ $ref: path });
const call = (tool, args, saveAs) => ({ type: "call", tool, args, saveAs });
const conditional = (left, equals, then, otherwise = []) => ({ type: "if", left, equals, then, else: otherwise });
const program = steps => ({ schema: "amos.checked-procedure.v1", steps });
const contentResponse = content => ({ message: { role: "assistant", content }, usage: { prompt_tokens: 2, completion_tokens: 1 } });
const toolResponse = (name, args) => ({ message: { role: "assistant", content: null, tool_calls: [
  { id: "synthetic-call", type: "function", function: { name, arguments: JSON.stringify(args) } }
] }, usage: { prompt_tokens: 2, completion_tokens: 1 } });
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// A small, general executable procedure; uncertainty returns to the public-context
// teacher after an explicit reconciliation instead of pretending the update worked.
function checkedTeacherProgram() {
  return program([
    { type: "for_each", items: ref("goal.sites"), as: "target", steps: [
      call("inspect_collection", { name: ref("vars.target.collectionName") }, "collection"),
      conditional(ref("vars.collection.collection"), null, [call("create_collection", { name: ref("vars.target.collectionName") }, "collection")]),
      call("inspect_site", { slug: ref("vars.target.slug") }, "site"),
      conditional(ref("vars.site.site"), null, [call("create_site", { slug: ref("vars.target.slug") }, "site")]),
      call("update_site", { siteId: ref("vars.site.site.id"), expectedRevision: ref("vars.site.site.revision"),
        headline: ref("vars.target.headline"), theme: ref("vars.target.theme"), collectionId: ref("vars.collection.collection.id") }, "updated"),
      conditional(ref("vars.updated.ok"), false, [
        call("inspect_site", { slug: ref("vars.target.slug") }, "site"),
        { type: "return", status: "needs_reasoning", reason: "Inspect the reconciled receipt and decide whether more work remains." }
      ])
    ] },
    { type: "return", status: "completed" }
  ]);
}

function executionPayload(input) { return JSON.parse(input.messages.find(message => message.role === "user").content); }

/** This is a deterministic integration stub, not a model-quality measurement.
 * It consumes only the exact goal and public observation view sent to request(). */
function publicTeacher(input) {
  const { goal, observations } = executionPayload(input);
  const state = observations.mode === "typed" ? observations.state : projectObservedTaskState(observations.events);
  for (const target of goal.sites) {
    const collectionEntry = state.collectionsByName[target.collectionName];
    if (!collectionEntry || collectionEntry.ambiguity) return toolResponse("inspect_collection", { name: target.collectionName });
    if (collectionEntry.value === null) return toolResponse("create_collection", { name: target.collectionName });
    const siteEntry = state.sitesBySlug[target.slug];
    if (!siteEntry || siteEntry.ambiguity || siteEntry.historical === true) return toolResponse("inspect_site", { slug: target.slug });
    if (siteEntry.value === null) return toolResponse("create_site", { slug: target.slug });
    const site = siteEntry.value, collection = collectionEntry.value;
    const conflict = state.errors.some(error => error.name === "update_site" &&
      error.args.siteId === site.id && error.result?.error?.code === "revision_conflict" && error.sourcedAt > siteEntry.sourcedAt);
    if (conflict) return toolResponse("inspect_site", { slug: target.slug });
    if (site.headline === target.headline && site.theme === target.theme && site.collectionId === collection.id && site.status === "draft") continue;
    return toolResponse("update_site", { siteId: site.id, expectedRevision: site.revision,
      headline: target.headline, theme: target.theme, collectionId: collection.id });
  }
  return contentResponse("Completed from public tool receipts.");
}

function teacherRequest(record = []) {
  return async input => {
    record.push({ phase: input.phase, caseId: input.caseId, tools: structuredClone(input.tools), messages: structuredClone(input.messages) });
    return input.phase === "compile" ? contentResponse(JSON.stringify(checkedTeacherProgram())) : publicTeacher(input);
  };
}

test("development demonstrations replay exactly in fresh isolated worlds and contain both timeout outcomes", async () => {
  const seed = 83401, demonstrations = await buildStateSkillDemonstrations({ seed });
  assert.equal(demonstrations.length, 3);
  for (const [index, variant] of ["fresh", "timeout-applied", "timeout-unapplied"].entries()) {
    const demonstration = demonstrations[index];
    const world = createStateSkillFixture({ seed: seed + index, split: "development", variant });
    assert.equal(demonstration.id, world.id); assert.deepEqual(demonstration.goal, world.goal);
    assert.equal(world.verify().pass, false);
    for (const event of demonstration.events) assert.deepEqual(world.execute(event.name, event.args), event.result);
    assert.equal(world.verify().pass, true); assert.equal(demonstration.verified, true);
    assert.ok(demonstration.events.every(event => event.name !== "publish_site"));
  }
  assert.equal(demonstrations[1].events.filter(event => event.name === "update_site").length, 1);
  assert.equal(demonstrations[2].events.filter(event => event.name === "update_site").length, 2);
  assert.deepEqual(await buildStateSkillDemonstrations({ seed }), demonstrations);
});

test("all four arms complete every fixture with a teacher stub that sees only public context", async () => {
  const requests = [], events = [];
  const report = await runStateSkillExperiment({ request: teacherRequest(requests), modelIdentity, seed: 94213,
    onEvent: event => { events.push(structuredClone(event)); } });
  assert.equal(report.results.length, STATE_SKILL_VARIANTS.length * 4);
  for (const row of report.results) {
    assert.equal(row.pass, true, `${row.arm}/${row.variant}: ${row.error ?? JSON.stringify(row.verification)}`);
    assert.equal(row.verification.evidenceComplete, true); assert.equal(row.verification.unsafeRetries, 0);
    assert.equal(row.verification.publishAttempts, 0); assert.equal(row.verification.unintendedChanges, false);
  }
  for (const summary of Object.values(report.byArm)) assert.equal(summary.passed, summary.total);
  assert.equal(report.compilation.length, 2); assert.ok(report.compilation.every(entry => entry.valid));
  assert.equal(report.weightsChanged, false); assert.equal(report.neuralRecurrenceTested, false);
  assert.equal(report.actualGpuTimeMeasured, false);
  const firstCase = events.findIndex(event => event.type === "case-start");
  assert.ok(firstCase > events.findLastIndex(event => event.type === "compilation"));
  const firstExecute = requests.findIndex(item => item.phase === "execute");
  assert.ok(firstExecute > requests.findLastIndex(item => item.phase === "compile"));
  for (const entry of report.compilation) assert.equal(entry.programSha256, digest(entry.program));
  assert.ok(report.results.filter(row => row.variant === "timeout-unapplied" && row.skill).every(row => row.modelCalls > 0),
    "unknown outcomes can return to the same bounded model loop for recovery");
});

test("completion prose and checked-program completed claims cannot write or certify private state", async () => {
  const request = async input => input.phase === "compile"
    ? contentResponse(JSON.stringify(program([{ type: "return", status: "completed" }])))
    : contentResponse(JSON.stringify({ done: true, pass: true, sites: executionPayload(input).goal.sites }));
  const report = await runStateSkillExperiment({ request, modelIdentity, variants: ["fresh"], seed: 330 });
  assert.equal(report.results.length, 4);
  for (const row of report.results) {
    assert.equal(row.pass, false); assert.equal(row.verification.taskStateAchieved, false);
    assert.equal(row.toolCalls, 0); assert.equal(row.verification.checks[0].exists, false);
  }
});

test("every malformed, rejected and failed compilation stays visible and failed arms remain in denominator", async () => {
  const executionRequests = [];
  const tooLarge = program(Array.from({ length: 1000 }, () => ({ type: "return", status: "completed" })));
  const request = async input => {
    if (input.phase !== "compile") { executionRequests.push(input.caseId); return publicTeacher(input); }
    if (input.caseId === "compile-C-1") return contentResponse("not JSON");
    if (input.caseId === "compile-C-2") return contentResponse(JSON.stringify(program([call("run_javascript", {}, "x")])));
    if (input.caseId === "compile-D-1") throw new Error("Synthetic transport outage");
    return contentResponse(JSON.stringify(tooLarge));
  };
  const recorded = [];
  const report = await runStateSkillExperiment({ request, modelIdentity, variants: ["fresh", "existing-site"], seed: 331,
    onEvent: event => { if (event.type === "compilation") recorded.push(structuredClone(event)); } });
  assert.equal(report.compilation.length, 4); assert.equal(recorded.length, 4);
  assert.ok(report.compilation.every(entry => entry.valid === false && entry.error));
  assert.equal(report.compilation[0].response.message.content, "not JSON");
  assert.match(report.compilation[1].error, /unknown tool/);
  assert.match(report.compilation[2].error, /Synthetic transport outage/);
  assert.match(report.compilation[3].error, /maxNodes/);
  assert.equal(report.compilation[3].response.message.content, JSON.stringify(tooLarge));
  for (const arm of ["C", "D"]) {
    assert.equal(report.byArm[arm].total, 2); assert.equal(report.byArm[arm].passed, 0);
    assert.equal(report.byArm[arm].compilationRequests, 2);
    assert.ok(report.results.filter(row => row.arm === arm).every(row => row.termination === "compilation-failed" && row.toolCalls === 0));
    assert.ok(executionRequests.every(caseId => !caseId.includes(`-${arm}-turn-`)));
  }
});

test("the arm order rotates through all four positions across a complete block", async () => {
  const report = await runStateSkillExperiment({ request: teacherRequest(), modelIdentity, seed: 431,
    variants: ["fresh", "existing-collection", "existing-site", "stale-observation"] });
  assert.deepEqual(report.results.map(row => row.arm), [
    "A", "B", "C", "D", "B", "C", "D", "A", "C", "D", "A", "B", "D", "A", "B", "C"
  ]);
  assert.deepEqual(report.order, report.results.map(row => row.caseId));
  for (let index = 0; index < 4; index++) {
    const paired = report.results.slice(index * 4, (index + 1) * 4);
    assert.equal(new Set(paired.map(row => row.fixtureId)).size, 1);
    assert.equal(new Set(paired.map(row => row.seed)).size, 1);
    assert.ok(paired.every(row => row.pass), "each arm starts with its own reset world");
  }
});

test("all arms receive the same demonstrations; normalized stale evidence is equivalent and no hidden variant or oracle is sent", async () => {
  const requests = [], events = [];
  await runStateSkillExperiment({ request: teacherRequest(requests), modelIdentity, variants: ["stale-observation", "timeout-applied"], seed: 511,
    onEvent: event => { events.push(structuredClone(event)); } });
  const demoDigests = new Set(requests.map(input => digest(executionPayload(input).demonstrations)));
  assert.equal(demoDigests.size, 1);
  const initial = arm => requests.find(input => input.phase === "execute" && input.caseId.endsWith(`-${arm}-turn-0`));
  const history = executionPayload(initial("A")), typed = executionPayload(initial("B"));
  assert.deepEqual(history.goal, typed.goal);
  assert.deepEqual(projectObservedTaskState(history.observations.events), typed.observations.state);
  assert.equal(history.observations.events[0].name, "inspect_site", "historical tool entries must normalize to the public event schema");
  assert.equal(history.observations.events[0].historical, true);
  assert.match(history.observations.events[0].observedAt, /^2026-/);
  assert.equal(typed.observations.state.sitesBySlug[history.goal.sites[0].slug].historical, true);
  const privateNames = new Set(["snapshotForTesting", "verification", "taskStateAchieved", "timeoutInjected", "unresolvedSiteIds", "variant"]);
  function audit(value) {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) { assert.equal(privateNames.has(key), false, `private key: ${key}`); audit(child); }
  }
  for (const input of requests) {
    audit(executionPayload(input));
    assert.ok(input.tools.every(tool => !["verify", "snapshotForTesting"].includes(tool.function.name)));
    assert.equal(input.caseId.includes("timeout-applied"), false);
    assert.equal(input.caseId.includes("stale-observation"), false);
    if (JSON.stringify(input.messages).includes("Another editor's revision")) {
      const view = executionPayload(input).observations;
      const currentReceipt = view?.mode === "history"
        ? view.events.some(event => event.name === "inspect_site" && event.result.site?.headline === "Another editor's revision")
        : Object.values(view?.state.sitesBySlug ?? {}).some(entry => entry.value?.headline === "Another editor's revision");
      assert.equal(currentReceipt, true, "the changed hidden headline is exposed only as an actual inspection receipt");
    }
  }
  assert.ok(events.some(event => event.type === "case-result" && event.verification), "the oracle remains available to host reporting only");
});

test("shared tool caps bound programs and direct execution without silently dropping failed cases", async () => {
  const report = await runStateSkillExperiment({ request: teacherRequest(), modelIdentity, seed: 661,
    variants: ["fresh"], maxToolCallsPerTask: 1 });
  assert.equal(report.results.length, 4);
  for (const row of report.results) { assert.equal(row.pass, false); assert.equal(row.toolCalls, 1); }
  assert.ok(report.results.filter(row => row.skill).every(row => row.programResult.status === "budget_exhausted"));
});

test("the compiler and runtime apply the same admitted procedure-complexity limit", async () => {
  const admitted = program([
    { type: "return", status: "needs_reasoning", reason: "Public fallback requested." },
    ...Array.from({ length: 180 }, () => ({ type: "return", status: "completed" }))
  ]);
  const request = async input => input.phase === "compile" ? contentResponse(JSON.stringify(admitted)) : publicTeacher(input);
  const report = await runStateSkillExperiment({ request, modelIdentity, seed: 662, variants: ["fresh"] });
  assert.ok(report.compilation.every(entry => entry.valid));
  for (const row of report.results.filter(row => row.skill)) {
    assert.equal(row.programResult.status, "needs_reasoning");
    assert.equal(row.programResult.error, undefined, "runtime must not revalidate with a smaller hidden AST cap");
    assert.equal(row.pass, true);
  }
});

test("failed execution requests are surfaced and counted rather than treated as zero attempts", async () => {
  const request = async input => {
    if (input.phase === "compile") return contentResponse(JSON.stringify(program([{ type: "return", status: "needs_reasoning" }])));
    throw new Error("Synthetic failed inference");
  };
  const report = await runStateSkillExperiment({ request, modelIdentity, seed: 771, variants: ["fresh"] });
  assert.equal(report.results.length, 4);
  for (const row of report.results) {
    assert.equal(row.pass, false); assert.match(row.error, /Synthetic failed inference/);
    assert.equal(row.modelCalls, 1, "failed inference still spends an attempt");
  }
});

test("a malformed proposed publish cannot disappear from the forbidden-action outcome", async () => {
  const seen = new Set();
  const request = async input => {
    if (input.phase === "compile") return contentResponse(JSON.stringify(program([{ type: "return", status: "needs_reasoning" }])));
    const caseId = input.caseId.replace(/-turn-\d+$/, "");
    if (!seen.has(caseId)) {
      seen.add(caseId);
      return { message: { role: "assistant", content: null, tool_calls: [
        { id: "forbidden-proposal", type: "function", function: { name: "publish_site", arguments: "{invalid json" } }
      ] } };
    }
    return publicTeacher(input);
  };
  const report = await runStateSkillExperiment({ request, modelIdentity, seed: 772, variants: ["fresh"] });
  for (const row of report.results) {
    assert.equal(row.verification.taskStateAchieved, true, "the valid work still completes after the rejected proposal");
    assert.equal(row.pass, false, "a forbidden action proposal still violates the goal");
    assert.ok(row.verification.publishAttempts >= 1);
  }
});

test("local arm-budget rejection is not misreported as dispatched inference", async () => {
  const dispatched = [];
  const request = async input => {
    dispatched.push({ phase: input.phase, caseId: input.caseId });
    return input.phase === "compile"
      ? contentResponse(JSON.stringify(program([{ type: "return", status: "needs_reasoning" }])))
      : publicTeacher(input);
  };
  const report = await runStateSkillExperiment({ request, modelIdentity, seed: 773, variants: ["fresh"], maxModelCallsPerTask: 1 });
  for (const row of report.results) {
    const actual = dispatched.filter(item => item.phase === "execute" && item.caseId.startsWith(`${row.caseId}-turn-`)).length;
    assert.equal(row.modelCalls, actual, `${row.arm}: rejected before dispatch is not a model call`);
  }
  for (const arm of ["A", "B", "C", "D"]) {
    const actual = dispatched.filter(item => item.caseId.startsWith(`compile-${arm}-`) || item.caseId.includes(`-${arm}-turn-`));
    assert.equal(report.byArm[arm].totalModelRequests, actual.length);
    assert.equal(report.byArm[arm].compilationRequests, actual.filter(item => item.phase === "compile").length);
  }
  const invalidDispatches = [];
  const invalid = await runStateSkillExperiment({ modelIdentity, seed: 774, variants: ["fresh"], maxModelCallsPerTask: 1,
    request: async input => {
      invalidDispatches.push({ phase: input.phase, caseId: input.caseId });
      return input.phase === "compile" ? contentResponse("invalid JSON") : publicTeacher(input);
    } });
  for (const arm of ["C", "D"]) {
    assert.equal(invalid.byArm[arm].compilationRequests,
      invalidDispatches.filter(item => item.caseId.startsWith(`compile-${arm}-`)).length,
      "a blocked compilation retry stays in the ledger without becoming a transport request");
  }
});
