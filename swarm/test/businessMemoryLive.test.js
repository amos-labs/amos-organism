import test from "node:test";
import assert from "node:assert/strict";
import { generateBusinessMemoryCases, expectedAnswer, valueAsOf } from "../src/businessMemoryBenchmark.js";
import {
  LIVE_ARMS,
  LIVE_FAMILIES,
  fieldDefinitions,
  gradeLiveAnswerText,
  instantBetween,
  liveCase,
  liveCollectionName,
  loadLiveSnapshot,
  renderLiveArmMessages,
  runLiveBusinessMemoryBenchmark,
  seedWorldIntoTenant,
  translateLiveAnswer
} from "../src/businessMemoryLive.js";
import { AmosMcpClient, parseToolText } from "../src/amosMcpClient.js";

const manifest = generateBusinessMemoryCases({ seed: "live-test-seed", pool: "holdout", worlds: 1, casesPerFamily: 3, families: LIVE_FAMILIES });
const world = manifest.worlds[0];

/** In-memory stand-in for the Platform data verbs, with revision history. */
function fakeTenant() {
  let clock = Date.UTC(2026, 8, 5, 12, 0, 0);
  const tick = () => new Date((clock += 1_500)).toISOString();
  const collections = new Map();
  const records = new Map();
  const tools = {
    whoami: () => ({ principal_type: "api_key", role: "owner", tenant_slug: "northwind-test", scopes: ["data:read", "data:write"] }),
    get_catalog: () => ({ collections: [...collections.keys()].map((name) => ({ name })), collections_outside_scope: [] }),
    define_collection: ({ name, fields }) => {
      const existing = collections.get(name);
      const row = { id: existing?.id ?? `col-${collections.size + 1}`, name, fields };
      collections.set(name, row);
      return row;
    },
    list_records: ({ collection, filter = null, limit = 100 }) => {
      const rows = [...records.values()].filter((row) => row.collection === collection && !row.deleted)
        .filter((row) => !filter || Object.entries(filter).every(([key, value]) => row.data[key] === value))
        .slice(0, limit)
        .map((row) => ({ id: row.id, collection_id: collections.get(collection).id, data: row.data, created_at: row.revisions[0].recorded_at, updated_at: row.revisions.at(-1).recorded_at }));
      return { collection_id: collections.get(collection).id, count: rows.length, records: rows };
    },
    create_record: ({ collection, data }) => {
      if (!collections.has(collection)) throw new Error(`unknown collection ${collection}`);
      const id = `rec-${records.size + 1}`;
      const row = { id, collection, data: { ...data }, revisions: [{ revision: 1, operation: "create", actor: "owner", recorded_at: tick(), changed_fields: Object.keys(data).sort(), data: { ...data } }] };
      records.set(id, row);
      return { id, collection_id: collections.get(collection).id, data: row.data, revision: 1 };
    },
    update_record: ({ record_id, data }) => {
      const row = records.get(record_id);
      if (!row) throw new Error(`unknown record ${record_id}`);
      row.data = { ...row.data, ...data };
      row.revisions.push({ revision: row.revisions.length + 1, operation: "update", actor: "owner", recorded_at: tick(), changed_fields: Object.keys(data).sort(), data: { ...row.data } });
      return { id: record_id, data: row.data, revision: row.revisions.length, changed_fields: Object.keys(data) };
    },
    record_history: ({ record_id }) => {
      const row = records.get(record_id);
      if (!row) throw new Error(`unknown record ${record_id}`);
      return { record_id, revision_count: row.revisions.length, revisions: [...row.revisions].reverse() };
    },
    search_company_context: ({ query, as_of = null }) => ({
      query,
      as_of,
      briefing: { huge: "x".repeat(50) },
      evidence: { structured_records: { results: [...records.values()].slice(0, 2).map((row) => ({ record_id: row.id, data: row.data })) } },
      grounding: { rule: "point in time" }
    })
  };
  const calls = [];
  return {
    records,
    collections,
    calls,
    client: {
      async callTool(name, args = {}) {
        if (!tools[name]) throw new Error(`fake tenant has no tool ${name}`);
        calls.push({ name, args });
        return tools[name](args);
      },
      summary() {
        const out = {};
        for (const call of calls) out[call.name] = (out[call.name] || 0) + 1;
        return out;
      }
    }
  };
}

test("live collection names and field definitions are derived from the world", () => {
  assert.equal(liveCollectionName({ worldId: "world-holdout-0", collection: "customers" }), "bm_worldholdout0_customers");
  const fields = fieldDefinitions(world, "invoices");
  const byName = Object.fromEntries(fields.map((field) => [field.name, field.field_type]));
  assert.equal(byName.amount, "number");
  assert.equal(byName.issuedAt, "date");
  assert.equal(byName.status, "text");
  assert.equal(byName.world_ref, "text");
});

test("seeding writes every record and revision and is idempotent", async () => {
  const tenant = fakeTenant();
  const first = await seedWorldIntoTenant({ client: tenant.client, world });
  assert.equal(Object.keys(first.records).length, world.records.length);
  for (const record of world.records) {
    const seeded = first.records[record.id];
    assert.ok(seeded.created, `${record.id} created`);
    assert.equal(seeded.revisions.length, record.revisions.length, `${record.id} revision count`);
    assert.equal(tenant.records.get(seeded.recordId).data.world_ref, record.id);
    assert.deepEqual(
      Object.fromEntries(Object.entries(tenant.records.get(seeded.recordId).data).filter(([key]) => key !== "world_ref")),
      record.revisions.at(-1).fields
    );
  }
  const created = tenant.calls.filter((call) => call.name === "create_record").length;
  const second = await seedWorldIntoTenant({ client: tenant.client, world });
  assert.equal(tenant.calls.filter((call) => call.name === "create_record").length, created, "no new records on reseed");
  assert.equal(Object.keys(second.records).length, world.records.length);
  assert.ok(Object.values(second.records).every((entry) => entry.created === false));
  assert.deepEqual(Object.values(second.records).map((entry) => entry.recordId).sort(), Object.values(first.records).map((entry) => entry.recordId).sort());
});

test("as-of instants land between the right live revisions", async () => {
  const revisions = [
    { revision: 1, recordedAt: "2026-09-05T12:00:00.000Z" },
    { revision: 2, recordedAt: "2026-09-05T12:00:10.000Z" },
    { revision: 3, recordedAt: "2026-09-05T12:00:20.000Z" }
  ];
  assert.equal(instantBetween(revisions, 1), "2026-09-05T12:00:05.000Z");
  assert.equal(instantBetween(revisions, 2), "2026-09-05T12:00:15.000Z");
  assert.equal(instantBetween(revisions, 3), "2026-09-05T12:00:21.000Z");
  assert.throws(() => instantBetween(revisions, 0));

  const tenant = fakeTenant();
  const seedMap = await seedWorldIntoTenant({ client: tenant.client, world });
  const asOfCases = manifest.cases.filter((testCase) => testCase.family === "value-as-of-date");
  assert.ok(asOfCases.length > 0);
  for (const testCase of asOfCases) {
    const item = liveCase({ testCase, world, seedMap });
    assert.ok(item.liveAsOf, "live as-of instant set");
    assert.ok(item.liveQuestion.includes(item.liveAsOf));
    assert.ok(!item.liveQuestion.includes(testCase.facts.asOf));
    // The live record's data at the live instant equals the world's expected value.
    const row = tenant.records.get(seedMap.records[testCase.facts.recordId].recordId);
    const liveRecord = { revisions: row.revisions.map((revision) => ({ recordedAt: revision.recorded_at, fields: revision.data })) };
    assert.equal(valueAsOf(liveRecord, testCase.facts.field, item.liveAsOf), testCase.expected.answer);
  }
});

test("live rendering exposes Platform ids, translation maps them back, and expected answers verify", async () => {
  const tenant = fakeTenant();
  const seedMap = await seedWorldIntoTenant({ client: tenant.client, world });
  const snapshot = await loadLiveSnapshot({ client: tenant.client, seedMap });
  assert.equal(snapshot.records.length, world.records.length);
  for (const testCase of manifest.cases) {
    const item = liveCase({ testCase, world, seedMap });
    const alone = renderLiveArmMessages({ arm: "alone", liveCase: item, world, snapshot });
    const memory = renderLiveArmMessages({ arm: "memory-live", liveCase: item, world, snapshot, evidence: { evidence: { x: 1 } } });
    assert.ok(!alone[1].content.includes("rec-"), "alone arm carries no record ids");
    assert.ok(memory[1].content.includes("record_history"));
    assert.ok(memory[1].content.includes("Retrieval evidence"));
    for (const worldId of testCase.expected.grounding) {
      assert.ok(memory[1].content.includes(seedMap.records[worldId].recordId), `${testCase.id} renders ${worldId}`);
    }
    // A model that cites Platform ids passes once translated.
    const expected = expectedAnswer(testCase);
    const cited = { ...expected, grounding: expected.grounding.map((worldId) => seedMap.records[worldId].recordId) };
    const translated = translateLiveAnswer({ answer: cited, seedMap });
    assert.deepEqual([...translated.grounding].sort(), [...expected.grounding].sort());
    const graded = gradeLiveAnswerText({ testCase, world, seedMap, text: JSON.stringify(cited) });
    assert.ok(graded.passed, `${testCase.id}: ${graded.failures.join("; ")}`);
    const wrong = gradeLiveAnswerText({ testCase, world, seedMap, text: JSON.stringify({ ...cited, answer: testCase.rejected.answer }) });
    assert.ok(!wrong.passed, `${testCase.id} rejects its distractor`);
  }
});

test("the live runner grades both arms, calls search per memory case, and pairs them", async () => {
  const tenant = fakeTenant();
  const seedMap = await seedWorldIntoTenant({ client: tenant.client, world });
  const snapshot = await loadLiveSnapshot({ client: tenant.client, seedMap });
  const worker = {
    model: "fake-live",
    controlId: "fake-live",
    async runCase({ caseId, messages }) {
      const [caseKey, rest] = caseId.split("::");
      const arm = rest.replace(/:.*$/, "");
      const testCase = manifest.cases.find((item) => item.id === caseKey);
      const expected = expectedAnswer(testCase);
      const content = arm === "alone"
        ? JSON.stringify({ status: "unknown", answer: null, grounding: [], conflict: null })
        : JSON.stringify({ ...expected, grounding: expected.grounding.map((worldId) => seedMap.records[worldId].recordId) });
      assert.ok(messages[1].content.includes("## Question"));
      return { message: { role: "assistant", content }, metrics: { outputTokens: 20 } };
    }
  };
  const searchesBefore = tenant.calls.filter((call) => call.name === "search_company_context").length;
  const report = await runLiveBusinessMemoryBenchmark({ worker, client: tenant.client, manifest, world, seedMap, snapshot, arms: LIVE_ARMS });
  const cases = manifest.cases.length;
  assert.equal(report.caseCount, cases);
  assert.equal(report.runs.length, cases * 2);
  const alone = report.arms.find((summary) => summary.arm === "alone");
  const memory = report.arms.find((summary) => summary.arm === "memory-live");
  assert.equal(alone.passed, 0);
  assert.equal(memory.passed, cases);
  assert.equal(report.paired.pairedWins, cases);
  assert.equal(report.paired.pairedLosses, 0);
  assert.equal(tenant.calls.filter((call) => call.name === "search_company_context").length - searchesBefore, cases);
  const asOfSearch = tenant.calls.find((call) => call.name === "search_company_context" && call.args.as_of);
  assert.ok(asOfSearch, "as-of cases pass as_of to search");
  assert.ok(report.mcpCalls.search_company_context >= cases);
  assert.ok(!JSON.stringify(report).includes("briefing"), "briefing is stripped from evidence");
});

test("the MCP client posts tools/call with a bearer token and never serializes the key", async () => {
  const seen = [];
  const client = new AmosMcpClient({
    baseUrl: "https://example.test/",
    apiKey: "amos_k_secret_value_1234",
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] } }) };
    }
  });
  const result = await client.callTool("whoami", {});
  assert.deepEqual(result, { ok: true });
  assert.equal(seen[0].url, "https://example.test/mcp");
  assert.equal(seen[0].init.headers.authorization, "Bearer amos_k_secret_value_1234");
  assert.equal(JSON.parse(seen[0].init.body).params.name, "whoami");
  assert.ok(!JSON.stringify(client).includes("secret_value"));
  assert.deepEqual(client.summary().whoami.calls, 1);
  assert.deepEqual(parseToolText("not json"), { text: "not json" });
  await assert.rejects(
    new AmosMcpClient({ baseUrl: "https://example.test", apiKey: "amos_k_secret_value_1234", fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "denied" }] } }) }) }).callTool("get_record", { record_id: "x" }),
    /reported an error/
  );
});
