import test from "node:test";
import assert from "node:assert/strict";
import { SwarmTurnOrchestrator } from "../src/swarmTurnGateway.js";
import { digestResearchValue } from "../src/experimentProtocol.js";

test("the swarm turn gateway fans out proposals, critiques them, and returns one integrated action", async () => {
  const calls = [];
  const traces = [];
  const fetchImpl = async (_url, init) => {
    const payload = JSON.parse(init.body);
    calls.push(payload);
    const index = calls.length;
    return new Response(JSON.stringify({
      id: `response-${index}`,
      model: payload.model,
      choices: [{
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: `response ${index}` }
      }],
      usage: { prompt_tokens: 10 * index, completion_tokens: index, total_tokens: 11 * index }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  let tick = 0;
  const gateway = new SwarmTurnOrchestrator({
    backendBaseUrl: "http://127.0.0.1:18080",
    backendModel: "qwen-test",
    backendApiKey: "secret",
    fetchImpl,
    now: () => new Date("2026-08-23T12:00:00.000Z"),
    monotonicNow: () => tick += 25,
    onTrace: (trace) => traces.push(trace)
  });

  const result = await gateway.complete({
    model: "gateway-alias",
    messages: [
      { role: "system", content: "Use the terminal protocol." },
      { role: "user", content: "Fix the failing task." }
    ],
    max_tokens: 2_000,
    temperature: 0.4
  });

  assert.equal(calls.length, 4);
  assert.match(calls[0].messages[0].content, /PRIVATE AMOS ROLE/);
  assert.match(calls[1].messages[0].content, /different approach/);
  assert.equal(Object.hasOwn(calls[2], "response_format"), false);
  assert.match(calls[2].messages.at(-1).content, /PRIVATE CANDIDATE BOARD/);
  assert.match(calls[3].messages.at(-1).content, /PRIVATE VERIFIER CRITIQUE/);
  assert.equal(result.choices[0].message.content, "response 4");
  assert.deepEqual(result.usage, {
    prompt_tokens: 100,
    completion_tokens: 10,
    total_tokens: 110
  });
  assert.equal(result.amos_swarm.stageCount, 4);
  assert.equal(traces.length, 1);
  assert.match(traces[0].digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(traces[0].stages.map((stage) => stage.stage), [
    "candidate:primary",
    "candidate:alternative",
    "critic",
    "integrator"
  ]);
});

test("the swarm turn gateway rejects streaming rather than returning a false stream", async () => {
  const gateway = new SwarmTurnOrchestrator({
    backendBaseUrl: "http://127.0.0.1:18080/v1",
    backendModel: "qwen-test",
    fetchImpl: async () => assert.fail("the backend must not be called")
  });
  await assert.rejects(
    gateway.complete({
      model: "gateway-alias",
      stream: true,
      messages: [{ role: "user", content: "hello" }]
    }),
    /streaming is not supported/
  );
});

test("the swarm turn gateway recovers a reasoning-only integration without replaying candidates", async () => {
  const calls = [];
  const gateway = new SwarmTurnOrchestrator({
    backendBaseUrl: "http://127.0.0.1:18080",
    backendModel: "qwen-test",
    internalMaxTokens: 1_024,
    fetchImpl: async (_url, init) => {
      const payload = JSON.parse(init.body);
      calls.push(payload);
      const index = calls.length;
      const exhausted = index === 4;
      return new Response(JSON.stringify({
        id: `response-${index}`,
        model: payload.model,
        choices: [{
          index: 0,
          finish_reason: exhausted ? "length" : "stop",
          message: exhausted
            ? { role: "assistant", content: null, reasoning: "unfinished reasoning" }
            : { role: "assistant", content: `visible response ${index}` }
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  const result = await gateway.complete({
    model: "gateway-alias",
    messages: [{ role: "user", content: "Fix the task." }],
    max_tokens: 256
  });

  assert.equal(calls.length, 5);
  assert.equal(calls[4].enable_thinking, false);
  assert.deepEqual(calls[4].chat_template_kwargs, { enable_thinking: false });
  assert.equal(calls[4].max_tokens, 1_024);
  assert.equal(result.choices[0].message.content, "visible response 5");
  assert.equal(result.amos_swarm.stageCount, 5);
  assert.deepEqual(result.usage, {
    prompt_tokens: 50,
    completion_tokens: 25,
    total_tokens: 75
  });
});

test("the swarm turn gateway recovers an exhausted critic before integration", async () => {
  const calls = [];
  const gateway = new SwarmTurnOrchestrator({
    backendBaseUrl: "http://127.0.0.1:18080",
    backendModel: "qwen-test",
    internalMaxTokens: 1_024,
    fetchImpl: async (_url, init) => {
      const payload = JSON.parse(init.body);
      calls.push(payload);
      const index = calls.length;
      const exhaustedCritic = index === 3;
      return new Response(JSON.stringify({
        id: `response-${index}`,
        model: payload.model,
        choices: [{
          index: 0,
          finish_reason: exhaustedCritic ? "length" : "stop",
          message: exhaustedCritic
            ? { role: "assistant", content: null, reasoning: "unfinished critique" }
            : { role: "assistant", content: `visible response ${index}` }
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  const result = await gateway.complete({
    model: "gateway-alias",
    messages: [{ role: "user", content: "Fix the task." }],
    max_tokens: 256
  });

  assert.equal(calls.length, 5);
  assert.equal(calls[3].enable_thinking, false);
  assert.match(calls[4].messages.at(-1).content, /visible response 4/);
  assert.equal(result.choices[0].message.content, "visible response 5");
  assert.equal(result.amos_swarm.stageCount, 5);
});

test("the swarm turn gateway budgets private evidence inside the backend context", async () => {
  const calls = [];
  const traces = [];
  const gateway = new SwarmTurnOrchestrator({
    backendBaseUrl: "http://127.0.0.1:18080",
    backendModel: "qwen-test",
    backendContextTokens: 32_768,
    contextSafetyTokens: 1_024,
    internalMaxTokens: 4_096,
    onTrace: (trace) => traces.push(trace),
    fetchImpl: async (_url, init) => {
      const payload = JSON.parse(init.body);
      calls.push(payload);
      const index = calls.length;
      const content = index < 4 ? `response-${index}-${"x".repeat(20_000)}` : "final";
      return new Response(JSON.stringify({
        id: `response-${index}`,
        model: payload.model,
        choices: [{
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content }
        }],
        usage: { prompt_tokens: 22_000, completion_tokens: 100, total_tokens: 22_100 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  const result = await gateway.complete({
    model: "gateway-alias",
    messages: [{ role: "user", content: "Solve the state-heavy task." }],
    max_tokens: 4_096
  });

  const evidenceCharacterBudget = (32_768 - 22_000 - 4_096 - 1_024) * 3;
  assert.equal(calls.length, 4);
  assert.ok(calls[2].messages.at(-1).content.length <= evidenceCharacterBudget);
  assert.ok(calls[3].messages.at(-1).content.length <= evidenceCharacterBudget);
  assert.equal(calls[3].max_tokens, 4_096);
  assert.equal(result.choices[0].message.content, "final");
  assert.equal(traces[0].contextBudget.basePromptTokens, 22_000);
  assert.equal(
    traces[0].contextBudget.integrator.maximumEvidenceCharacters,
    evidenceCharacterBudget
  );
});

test("the swarm turn gateway reduces private-stage output near the context boundary", async () => {
  const calls = [];
  const gateway = new SwarmTurnOrchestrator({
    backendBaseUrl: "http://127.0.0.1:18080",
    backendModel: "qwen-test",
    backendContextTokens: 32_768,
    contextSafetyTokens: 1_024,
    internalMaxTokens: 4_096,
    fetchImpl: async (_url, init) => {
      const payload = JSON.parse(init.body);
      calls.push(payload);
      const index = calls.length;
      return new Response(JSON.stringify({
        id: `response-${index}`,
        model: payload.model,
        choices: [{
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: `response ${index}` }
        }],
        usage: { prompt_tokens: 30_000, completion_tokens: 10, total_tokens: 30_010 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  await gateway.complete({
    model: "gateway-alias",
    messages: [{ role: "user", content: "Return one bounded action." }],
    max_tokens: 4_096
  });

  assert.equal(calls[2].max_tokens, 1_488);
  assert.equal(calls[3].max_tokens, 1_488);
  assert.ok(calls[2].messages.at(-1).content.length <= 768);
  assert.ok(calls[3].messages.at(-1).content.length <= 768);
});

test("the swarm turn gateway returns a completed candidate when private stages cannot fit", async () => {
  const calls = [];
  const traces = [];
  const gateway = new SwarmTurnOrchestrator({
    backendBaseUrl: "http://127.0.0.1:18080",
    backendModel: "qwen-test",
    backendContextTokens: 32_768,
    contextSafetyTokens: 1_024,
    internalMaxTokens: 4_096,
    onTrace: (trace) => traces.push(trace),
    fetchImpl: async (_url, init) => {
      const payload = JSON.parse(init.body);
      calls.push(payload);
      const index = calls.length;
      return new Response(JSON.stringify({
        id: `response-${index}`,
        model: payload.model,
        choices: [{
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: `candidate ${index}` }
        }],
        usage: { prompt_tokens: 31_500, completion_tokens: 100, total_tokens: 31_600 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  const result = await gateway.complete({
    model: "gateway-alias",
    messages: [{ role: "user", content: "Compact the nearly full context." }],
    max_tokens: 4_096
  });

  assert.equal(calls.length, 2);
  assert.equal(result.choices[0].message.content, "candidate 1");
  assert.equal(result.amos_swarm.mode, "direct-context-fallback");
  assert.equal(result.amos_swarm.stageCount, 2);
  assert.equal(traces[0].contextBudget.critic.availableTokens, 244);
  assert.equal(traces[0].contextBudget.integrator, null);
});

test("the swarm gateway implements the Platform Mission worker contract and self-heals malformed plans", async () => {
  const calls = [];
  const traces = [];
  const validPlan = {
    decision: "tool",
    summary: "Run the next bounded prospecting batch",
    verb: "run_prospecting_batch",
    args: { campaign_id: "campaign-1", batch_size: 25 },
    checkpoint: { next_offset: 25 }
  };
  const gateway = new SwarmTurnOrchestrator({
    backendBaseUrl: "http://127.0.0.1:18080",
    backendModel: "qwen-test",
    internalMaxTokens: 1_024,
    onTrace: (trace) => traces.push(trace),
    fetchImpl: async (_url, init) => {
      const payload = JSON.parse(init.body);
      calls.push(payload);
      const index = calls.length;
      const content = index === 5
        ? JSON.stringify(validPlan)
        : index === 4
          ? "I think the mission should keep researching."
          : `candidate evidence ${index}`;
      return new Response(JSON.stringify({
        id: `response-${index}`,
        model: payload.model,
        choices: [{
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content }
        }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  const missionEnvelope = {
    contract: "amos-mission-worker:2026-09-06",
    mission: {
      tenant_id: "tenant-1",
      mission_id: "mission-1",
      contract_id: "contract-1",
      objective: "Find the next qualified contacts",
      completion_condition: { kind: "metric_threshold", target: 500 },
      verification_policy: {
        schema_version: "1",
        requirements: [{ id: "completion_condition" }]
      },
      allowed_operations: [{ operation: "run_prospecting_batch" }],
      budgets: { max_tool_calls: 20 },
      checkpoint: {},
      recent_steps: [],
      operation_schemas: {},
      open_decision_answer: null,
      recovery_feedback: {
        kind: "usage_accounting",
        no_company_effect: true,
        safe_to_retry: true
      },
      planner_attempt: 2
    },
    output_schema: {
      tool: { decision: "tool", summary: "...", verb: "...", args: {}, checkpoint: {} }
    }
  };

  const result = await gateway.complete({
    model: "amos-swarm",
    messages: [
      { role: "system", content: "Return one governed Mission plan." },
      { role: "user", content: JSON.stringify(missionEnvelope) }
    ],
    max_tokens: 1_024
  });

  assert.equal(calls.length, 5);
  assert.equal(calls[4].enable_thinking, false);
  assert.match(calls[4].messages.at(-1).content, /immutable AMOS Mission worker contract/);
  assert.deepEqual(JSON.parse(result.choices[0].message.content), validPlan);
  assert.equal(result.amos_swarm.mission.missionId, "mission-1");
  assert.equal(result.amos_swarm.mission.contractId, "contract-1");
  assert.equal(result.amos_swarm.mission.planDecision, "tool");
  assert.equal(result.amos_swarm.mission.contractSatisfied, true);
  assert.equal(result.amos_swarm.mission.recoveryKind, "usage_accounting");
  assert.match(result.amos_swarm.mission.recoveryFeedbackDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(traces[0].stages.map(({ stage }) => stage), [
    "candidate:primary",
    "candidate:alternative",
    "critic",
    "integrator",
    "mission:contract-recovery"
  ]);
  assert.equal(traces[0].mission.verificationPolicyDigest.length, 64);
  assert.equal(traces[0].mission.plannerAttempt, 2);
  assert.equal(traces[0].mission.recoveryKind, "usage_accounting");
});

test("shadow mode sends the final-stage request to the shadow model and records the pair without touching the primary answer", async () => {
  const calls = [];
  const shadows = [];
  const fetchImpl = async (_url, init) => {
    const payload = JSON.parse(init.body);
    calls.push(payload);
    const index = calls.length;
    const content = payload.model === "adapter-test" ? `shadow answer ${index}` : `response ${index}`;
    return new Response(JSON.stringify({
      id: `response-${index}`,
      model: payload.model,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const gateway = new SwarmTurnOrchestrator({
    backendBaseUrl: "http://127.0.0.1:18080",
    backendModel: "qwen-test",
    fetchImpl,
    shadowModel: "adapter-test",
    onShadow: (record) => { shadows.push(record); },
    now: () => new Date("2026-09-05T12:00:00.000Z")
  });
  const completion = await gateway.complete({
    model: "amos-swarm",
    messages: [{ role: "user", content: "Reconcile the vendor statements." }],
    max_tokens: 256
  });
  await gateway.drainShadows();
  assert.ok(!completion.choices[0].message.content.includes("shadow"), "the Mission receives the primary answer");
  assert.equal(shadows.length, 1);
  const [record] = shadows;
  assert.equal(record.schema, "amos.swarm-turn-shadow");
  assert.equal(record.primary.model, "qwen-test");
  assert.equal(record.shadow.model, "adapter-test");
  // A plain chat request carries no consenting tenant: the pair is digest-only.
  assert.equal(record.textCaptured, false);
  assert.equal(record.textPolicy, "digest-only");
  assert.equal(record.shadow.text, null);
  assert.equal(record.primary.text, null);
  assert.match(record.shadow.textDigest, /^[a-f0-9]{64}$/);
  assert.match(record.primary.textDigest, /^[a-f0-9]{64}$/);
  assert.ok(record.shadow.textLength > 0);
  assert.equal(record.servedToMission, "primary");
  assert.equal(record.agreement, false);
  const shadowCalls = calls.filter((payload) => payload.model === "adapter-test");
  assert.equal(shadowCalls.length, 1);
  assert.equal(shadowCalls[0].messages.length, calls.find((payload) => payload.model === "qwen-test" && payload.messages.length === shadowCalls[0].messages.length).messages.length, "the shadow gets the very same final-stage prompt");
});

test("a failing shadow backend is recorded as an error and never affects the primary completion", async () => {
  let calls = 0;
  const shadows = [];
  const fetchImpl = async (_url, init) => {
    const payload = JSON.parse(init.body);
    calls += 1;
    if (payload.model === "adapter-test") return new Response("upstream exploded", { status: 503 });
    return new Response(JSON.stringify({
      id: `r${calls}`, model: payload.model,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: `response ${calls}` } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const gateway = new SwarmTurnOrchestrator({ backendBaseUrl: "http://127.0.0.1:18080", backendModel: "qwen-test", fetchImpl, shadowModel: "adapter-test", onShadow: (record) => { shadows.push(record); } });
  const completion = await gateway.complete({ model: "amos-swarm", messages: [{ role: "user", content: "hello" }] });
  await gateway.drainShadows();
  assert.ok(completion.choices[0].message.content.startsWith("response"));
  assert.equal(shadows.length, 1);
  assert.equal(shadows[0].shadow.text, null);
  assert.match(shadows[0].shadow.error, /503/);
  assert.equal(shadows[0].shadow.inputEvidence.compiledInputSha256, shadows[0].inputEvidence.compiledInputSha256);
});

test("shadow and trace input evidence follows the actual served response through recovery and fallback", async () => {
  const validPlan = { decision: "tool", summary: "Read inventory", verb: "inventory.read", args: {}, checkpoint: {} };
  for (const [mode, expectedStage, expectedPrimaryCalls] of [
    ["normal", "integrator", 4],
    ["integration-recovery", "integrator:recovery", 5],
    ["contract-recovery", "mission:contract-recovery", 5],
    ["both-recoveries", "mission:contract-recovery", 6],
    ["primary-fallback", "candidate:primary", 2],
    ["alternative-fallback", "candidate:alternative", 2]
  ]) {
    const calls = [], traces = [], shadows = [];
    const isMission = mode === "contract-recovery" || mode === "both-recoveries";
    let primaryCalls = 0;
    const gateway = new SwarmTurnOrchestrator({
      backendBaseUrl: "http://127.0.0.1:18080", backendModel: "base", backendApiKey: "private-backend-key-1700",
      shadowModel: "adapter", internalMaxTokens: 1024, onTrace: trace => traces.push(trace), onShadow: shadow => shadows.push(shadow),
      fetchImpl: async (_url, init) => {
        const payload = JSON.parse(init.body);
        calls.push(payload);
        const index = payload.model === "base" ? ++primaryCalls : 0;
        const exhausted = ((mode === "integration-recovery" || mode === "both-recoveries") && index === 4) || (mode === "alternative-fallback" && index === 1);
        const correctedPlan = isMission && index === expectedPrimaryCalls;
        return new Response(JSON.stringify({
          id: "upstream-reuses-response-id", model: payload.model,
          choices: [{ index: 0, finish_reason: exhausted ? "length" : "stop", message: { role: "assistant", content: exhausted ? null : correctedPlan ? JSON.stringify(validPlan) : `visible-${index}` } }],
          usage: { prompt_tokens: mode.endsWith("-fallback") ? 31500 : 10, completion_tokens: 2, total_tokens: mode.endsWith("-fallback") ? 31502 : 12 }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
    });
    const content = isMission ? JSON.stringify({
      contract: "amos-mission-worker:2026-09-06",
      mission: { tenant_id: "tenant-no-text-capture", mission_id: "mission-input-evidence", contract_id: "contract-input-evidence", objective: "private-mission-text-1700", verification_policy: { schema_version: "1", requirements: [{ id: "done" }] }, planner_attempt: 1 },
      output_schema: { tool: { decision: "tool", summary: "...", verb: "...", args: {}, checkpoint: {} } }
    }) : "private-mission-text-1700";
    const result = await gateway.complete({ model: "swarm", messages: [{ role: "user", content }], max_tokens: 256, reasoning_effort: "high" });
    await gateway.drainShadows();
    assert.equal(primaryCalls, expectedPrimaryCalls, mode);
    const primaryPayload = calls.filter(c => c.model === "base").at(mode === "primary-fallback" ? 0 : -1);
    const shadowPayloads = calls.filter(c => c.model === "adapter");
    assert.equal(shadowPayloads.length, 1, mode);
    assert.deepEqual(shadowPayloads[0], { ...primaryPayload, model: "adapter" }, `${mode}: shadow must receive the request that produced the served response`);
    const { model, ...compiledInput } = primaryPayload;
    const evidence = traces[0].inputEvidence;
    assert.equal(evidence.schema, "amos.swarm-input-evidence");
    assert.equal(evidence.version, 1);
    assert.equal(evidence.stage, expectedStage, mode);
    assert.equal(evidence.compiledInputSha256, digestResearchValue(compiledInput), mode);
    assert.equal(evidence.requestPayloadSha256, digestResearchValue(primaryPayload), mode);
    assert.deepEqual(traces[0].stages.find(s => s.stage === expectedStage).inputEvidence, evidence);
    assert.deepEqual(shadows[0].inputEvidence, evidence);
    assert.equal(shadows[0].shadow.inputEvidence.compiledInputSha256, evidence.compiledInputSha256);
    assert.equal(shadows[0].shadow.inputEvidence.requestPayloadSha256, digestResearchValue(shadowPayloads[0]));
    assert.notEqual(shadows[0].shadow.inputEvidence.requestPayloadSha256, evidence.requestPayloadSha256);
    const { digest: traceDigest, ...traceBody } = traces[0];
    assert.equal(traceDigest, digestResearchValue(traceBody));
    const { digest: shadowDigest, ...shadowBody } = shadows[0];
    assert.equal(shadowDigest, digestResearchValue(shadowBody));
    assert.equal(result.amos_swarm.traceDigest, traceDigest);
    assert.equal(shadows[0].servedToMission, "primary");
    assert.equal(shadows[0].textCaptured, false);
    const logged = JSON.stringify({ traces, shadows });
    assert.equal(logged.includes("private-mission-text-1700"), false);
    assert.equal(logged.includes("private-backend-key-1700"), false);
  }
});

test("concurrent completions bind their own inputs even when upstream response IDs repeat", async () => {
  const calls = [], traces = [];
  const gateway = new SwarmTurnOrchestrator({
    backendBaseUrl: "http://127.0.0.1:18080", backendModel: "base", onTrace: trace => traces.push(trace),
    fetchImpl: async (_url, init) => {
      const payload = JSON.parse(init.body); calls.push(payload);
      await new Promise(resolve => setImmediate(resolve));
      const tag = payload.messages.find(m => m.role === "user").content;
      return new Response(JSON.stringify({ id: "shared-id", model: "base", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: tag } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }), { status: 200 });
    }
  });
  const tags = ["request-alpha", "request-beta"];
  const results = await Promise.all(tags.map(content => gateway.complete({ model: "swarm", messages: [{ role: "user", content }] })));
  for (const [index, result] of results.entries()) {
    const trace = traces.find(t => t.digest === result.amos_swarm.traceDigest);
    const payload = calls.filter(c => c.messages.find(m => m.role === "user").content === tags[index]).at(-1);
    assert.equal(trace.inputEvidence.requestPayloadSha256, digestResearchValue(payload));
    assert.equal(result.choices[0].message.content, tags[index]);
  }
  assert.notEqual(traces[0].inputEvidence.compiledInputSha256, traces[1].inputEvidence.compiledInputSha256);
});

test("shadow pairs keep full answer text only for tenants on the consent allowlist", async () => {
  const validPlan = {
    decision: "tool",
    summary: "Run the next bounded prospecting batch",
    verb: "run_prospecting_batch",
    args: { campaign_id: "campaign-1", batch_size: 25 },
    checkpoint: { next_offset: 25 }
  };
  const envelope = (tenantId) => ({
    contract: "amos-mission-worker:2026-09-06",
    mission: {
      tenant_id: tenantId,
      mission_id: "mission-9",
      contract_id: "contract-9",
      objective: "Find the next qualified contacts",
      completion_condition: { kind: "metric_threshold", target: 500 },
      verification_policy: { schema_version: "1", requirements: [{ id: "completion_condition" }] },
      allowed_operations: [{ operation: "run_prospecting_batch" }],
      budgets: { max_tool_calls: 20 },
      checkpoint: {},
      recent_steps: [],
      operation_schemas: {},
      open_decision_answer: null,
      recovery_feedback: null,
      planner_attempt: 1
    },
    output_schema: { tool: { decision: "tool", summary: "...", verb: "...", args: {}, checkpoint: {} } }
  });
  const run = async (tenantId, shadowTextTenants) => {
    const shadows = [];
    const fetchImpl = async (_url, init) => {
      const payload = JSON.parse(init.body);
      return new Response(JSON.stringify({
        id: "response",
        model: payload.model,
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(validPlan) } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const gateway = new SwarmTurnOrchestrator({
      backendBaseUrl: "http://127.0.0.1:18080",
      backendModel: "qwen-test",
      fetchImpl,
      shadowModel: "adapter-test",
      shadowTextTenants,
      onShadow: (record) => { shadows.push(record); }
    });
    await gateway.complete({ model: "amos-swarm", messages: [{ role: "user", content: JSON.stringify(envelope(tenantId)) }], max_tokens: 512 });
    await gateway.drainShadows();
    assert.equal(shadows.length, 1);
    return shadows[0];
  };

  const consenting = await run("tenant-consented", ["tenant-consented", "tenant-other"]);
  assert.equal(consenting.textCaptured, true);
  assert.equal(consenting.textPolicy, "consenting-tenant");
  assert.equal(consenting.mission.tenantId, "tenant-consented");
  assert.equal(consenting.mission.missionId, "mission-9");
  assert.deepEqual(JSON.parse(consenting.primary.text), validPlan);
  assert.deepEqual(JSON.parse(consenting.shadow.text), validPlan);
  assert.equal(consenting.agreement, true);

  const stranger = await run("tenant-customer", ["tenant-consented"]);
  assert.equal(stranger.textCaptured, false);
  assert.equal(stranger.mission.tenantId, "tenant-customer");
  assert.equal(stranger.primary.text, null);
  assert.equal(stranger.shadow.text, null);
  assert.equal(stranger.primary.textDigest, consenting.primary.textDigest, "digests still allow agreement analysis");
  assert.equal(stranger.agreement, true);

  const nobody = await run("tenant-customer", []);
  assert.equal(nobody.textCaptured, false);
  assert.throws(() => new SwarmTurnOrchestrator({ backendBaseUrl: "http://127.0.0.1:18080", backendModel: "qwen-test", shadowTextTenants: "tenant-1" }), /array/);
});
