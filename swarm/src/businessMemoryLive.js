/**
 * Business-memory benchmark, live arm.
 *
 * The synthetic benchmark renders a world into the prompt. The live arm seeds
 * the same generated world into a real AMOS tenant through the governed data
 * verbs (`define_collection`, `create_record`, `update_record`), reads it back
 * through the real read verbs (`record_history`, `search_company_context`,
 * `get_catalog`, `whoami`), and asks the question through whatever model the
 * caller points at, normally the Hosted `/v1/chat/completions` route. The
 * verifiers are the synthetic ones; only the ids are translated back from the
 * Platform's UUIDs to the world's ids before verification.
 *
 * Only the families a single-principal tenant can reproduce are live:
 * current value after supersession, value as of an instant, and a derived
 * total from records. Receipt, note, session, and scope families need
 * synthetic receipts, shared notes, or a second principal and stay synthetic.
 *
 * A world's revisions are written seconds apart, so "as of <date>" questions
 * are rewritten to "as of <RFC 3339 instant>", with the instant chosen between
 * the two live revisions that bracket the world's as-of date. The expected
 * value is unchanged.
 */
import { digestResearchValue } from "./experimentProtocol.js";
import { runResearchInference } from "./modelScaffold.js";
import {
  OUTPUT_CONTRACT,
  current,
  extractJson,
  valueAsOf,
  verifyBusinessMemoryAnswer
} from "./businessMemoryBenchmark.js";
import { visibleText } from "./businessMemoryGrading.js";

export const BUSINESS_MEMORY_LIVE_REPORT_SCHEMA = "amos.business-memory-live-report";
export const BUSINESS_MEMORY_LIVE_SEED_SCHEMA = "amos.business-memory-live-seed";
export const BUSINESS_MEMORY_LIVE_VERSION = 1;
export const LIVE_FAMILIES = Object.freeze([
  "current-value-after-supersession",
  "value-as-of-date",
  "derived-total-from-records"
]);
export const LIVE_ARMS = Object.freeze(["alone", "memory-live"]);
const WORLD_REF_FIELD = "world_ref";
const EVIDENCE_CHAR_LIMIT = 6_000;
const RECORD_LIST_LIMIT = 200;

// ---------------------------------------------------------------------------
// Naming and field definitions

export function liveCollectionName({ worldId, collection }) {
  const tag = String(worldId).toLowerCase().replace(/[^a-z0-9]/g, "");
  const name = String(collection).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!tag || !name) throw new Error("liveCollectionName requires a world id and a collection");
  return `bm_${tag}_${name}`;
}

export function fieldDefinitions(world, collection) {
  const types = new Map();
  for (const record of world.records.filter((item) => item.collection === collection)) {
    for (const revision of record.revisions) {
      for (const [name, value] of Object.entries(revision.fields)) {
        const type = fieldType(value);
        const existing = types.get(name);
        types.set(name, existing && existing !== type ? "text" : type);
      }
    }
  }
  const fields = [...types.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, field_type]) => ({
    name,
    display_name: name,
    field_type,
    required: false
  }));
  fields.push({ name: WORLD_REF_FIELD, display_name: "Benchmark world reference", field_type: "text", required: false });
  return fields;
}

function fieldType(value) {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return "date";
  return "text";
}

// ---------------------------------------------------------------------------
// Seeding

/**
 * Write one generated world into the tenant behind `client`. Idempotent: a
 * record whose `world_ref` already exists in its live collection is reused,
 * never duplicated. Returns the seed map that ties world ids to Platform ids
 * and carries the host-recorded instant of every revision.
 */
export async function seedWorldIntoTenant({ client, world, onEvent = null, signal = null }) {
  requireClient(client);
  if (!world?.id || !Array.isArray(world.records)) throw new Error("seedWorldIntoTenant requires a generated world");
  const emit = (event) => { if (onEvent) onEvent(event); };
  const collections = {};
  const records = {};
  const collectionNames = [...new Set(world.records.map((record) => record.collection))].sort();
  for (const collection of collectionNames) {
    const live = liveCollectionName({ worldId: world.id, collection });
    const defined = await client.callTool("define_collection", {
      name: live,
      display_name: `${world.company} ${collection} (benchmark ${world.id})`,
      description: `Seeded from business-memory world ${world.id}; do not edit outside the benchmark seeder.`,
      fields: fieldDefinitions(world, collection)
    }, { signal });
    collections[collection] = { live, collectionId: defined?.id ?? null };
    emit({ kind: "collection", collection, live, collectionId: defined?.id ?? null });

    const listed = await client.callTool("list_records", { collection: live, limit: RECORD_LIST_LIMIT }, { signal });
    const existing = new Map();
    for (const row of listed?.records ?? []) {
      const ref = row?.data?.[WORLD_REF_FIELD];
      if (ref) existing.set(String(ref), row);
    }
    for (const record of world.records.filter((item) => item.collection === collection)) {
      let recordId;
      let created = false;
      if (existing.has(record.id)) {
        recordId = existing.get(record.id).id;
      } else {
        const first = record.revisions[0];
        const createdRow = await client.callTool("create_record", {
          collection: live,
          data: { ...first.fields, [WORLD_REF_FIELD]: record.id }
        }, { signal });
        recordId = createdRow?.id;
        if (!recordId) throw new Error(`create_record returned no id for ${record.id}`);
        created = true;
        for (let index = 1; index < record.revisions.length; index += 1) {
          const previous = record.revisions[index - 1].fields;
          const next = record.revisions[index].fields;
          const changed = {};
          for (const [key, value] of Object.entries(next)) {
            if (JSON.stringify(previous[key]) !== JSON.stringify(value)) changed[key] = value;
          }
          if (Object.keys(changed).length === 0) continue;
          await client.callTool("update_record", { record_id: recordId, data: changed }, { signal });
        }
      }
      const history = await client.callTool("record_history", { record_id: recordId, limit: 50 }, { signal });
      const revisions = (history?.revisions ?? [])
        .filter((row) => row.operation !== "delete")
        .map((row) => ({ revision: row.revision, recordedAt: row.recorded_at, operation: row.operation, changedFields: row.changed_fields ?? [] }))
        .sort((a, b) => a.revision - b.revision);
      records[record.id] = { recordId, collection, live, created, revisions };
      emit({ kind: "record", worldRecordId: record.id, recordId, created, revisions: revisions.length });
    }
  }
  const base = {
    schema: BUSINESS_MEMORY_LIVE_SEED_SCHEMA,
    version: BUSINESS_MEMORY_LIVE_VERSION,
    worldId: world.id,
    worldDigest: world.digest,
    seededAt: new Date().toISOString(),
    collections,
    records,
    byRecordId: Object.fromEntries(Object.entries(records).map(([worldId, entry]) => [entry.recordId, worldId]))
  };
  return { ...base, digest: digestResearchValue(base) };
}

// ---------------------------------------------------------------------------
// Live snapshot (what the Platform says now)

export async function loadLiveSnapshot({ client, seedMap, signal = null }) {
  requireClient(client);
  const identity = await client.callTool("whoami", {}, { signal });
  const catalog = await client.callTool("get_catalog", {}, { signal });
  const records = [];
  for (const [worldRecordId, entry] of Object.entries(seedMap.records)) {
    const history = await client.callTool("record_history", { record_id: entry.recordId, limit: 50 }, { signal });
    const revisions = (history?.revisions ?? [])
      .slice()
      .sort((a, b) => a.revision - b.revision)
      .map((row) => ({
        revision: row.revision,
        operation: row.operation,
        actor: row.actor,
        recorded_at: row.recorded_at,
        changed_fields: row.changed_fields ?? [],
        data: row.data ?? null
      }));
    const latest = revisions.at(-1);
    records.push({
      id: entry.recordId,
      collection: entry.live,
      worldRecordId,
      current: latest?.data ?? null,
      revisions
    });
  }
  return {
    observedAt: new Date().toISOString(),
    identity: {
      role: identity?.role ?? null,
      principal_type: identity?.principal_type ?? null,
      tenant_slug: identity?.tenant_slug ?? null,
      scopes: Array.isArray(identity?.scopes) ? identity.scopes : []
    },
    catalog: {
      collections: (catalog?.collections ?? []).map((item) => (typeof item === "string" ? item : item?.name)).filter(Boolean),
      collectionsOutsideScope: catalog?.collections_outside_scope ?? []
    },
    records
  };
}

// ---------------------------------------------------------------------------
// Live cases

/**
 * Turn a synthetic case into its live form. The expected answer and grounding
 * never change; only the as-of date becomes an instant between the two live
 * revisions that bracket the world's as-of date.
 */
export function liveCase({ testCase, world, seedMap }) {
  if (!LIVE_FAMILIES.includes(testCase.family)) {
    throw new Error(`Family ${testCase.family} is not reproducible live`);
  }
  const collections = testCase.collections.map((collection) => seedMap.collections[collection]?.live).filter(Boolean);
  if (testCase.family !== "value-as-of-date") {
    return { ...testCase, liveQuestion: testCase.question, liveAsOf: null, liveCollections: collections };
  }
  const record = world.records.find((item) => item.id === testCase.facts.recordId);
  const seeded = seedMap.records[testCase.facts.recordId];
  if (!record || !seeded) throw new Error(`Case ${testCase.id} references an unseeded record ${testCase.facts.recordId}`);
  const worldInstant = `${testCase.facts.asOf}T23:59:59.000Z`;
  const inEffect = record.revisions.filter((revision) => Date.parse(revision.recordedAt) <= Date.parse(worldInstant)).length;
  const liveAsOf = instantBetween(seeded.revisions, inEffect);
  const liveQuestion = testCase.question.replace(testCase.facts.asOf, liveAsOf);
  if (liveQuestion === testCase.question) throw new Error(`Case ${testCase.id} question does not carry its as-of date`);
  return { ...testCase, liveQuestion, liveAsOf, liveCollections: collections };
}

/**
 * An instant at which exactly `inEffect` live revisions have been recorded:
 * halfway between revision `inEffect` and `inEffect + 1`, or one second after
 * the last one when every revision is in effect.
 */
export function instantBetween(liveRevisions, inEffect) {
  const sorted = [...liveRevisions].sort((a, b) => a.revision - b.revision);
  if (inEffect < 1 || inEffect > sorted.length) {
    throw new Error(`Cannot place an instant with ${inEffect} revisions in effect out of ${sorted.length}`);
  }
  const lower = Date.parse(sorted[inEffect - 1].recordedAt);
  if (inEffect === sorted.length) return new Date(lower + 1_000).toISOString();
  const upper = Date.parse(sorted[inEffect].recordedAt);
  if (!(upper > lower)) throw new Error("Live revisions must have strictly increasing instants");
  return new Date(lower + Math.floor((upper - lower) / 2)).toISOString();
}

// ---------------------------------------------------------------------------
// Rendering

export function renderLiveArmMessages({ arm, liveCase: item, world, snapshot, evidence = null, now = new Date() }) {
  if (!LIVE_ARMS.includes(arm)) throw new Error(`Unknown live arm ${arm}`);
  const company = snapshot?.identity?.tenant_slug ? `the company whose AMOS workspace is ${snapshot.identity.tenant_slug}` : world.company;
  const sections = [];
  if (arm === "alone") {
    sections.push(`The user is the ${snapshot?.identity?.role ?? "owner"} of ${company}. No company records are attached to this message.`);
  } else {
    sections.push([
      "## Authenticated envelope (from AMOS)",
      JSON.stringify({
        workspace: snapshot.identity.tenant_slug,
        role: snapshot.identity.role,
        principal: snapshot.identity.principal_type,
        collections: snapshot.catalog.collections,
        collectionsOutsideScope: snapshot.catalog.collectionsOutsideScope
      })
    ].join("\n"));
    const visible = snapshot.records.filter((record) => item.liveCollections.includes(record.collection));
    sections.push([
      "## Host-recorded records (read through record_history; cite records by their id)",
      ...visible.map((record) => JSON.stringify({
        id: record.id,
        collection: record.collection,
        current: record.current,
        revisions: record.revisions.map((revision) => ({
          revision: revision.revision,
          recorded_at: revision.recorded_at,
          changed_fields: revision.changed_fields,
          data: revision.data
        }))
      }))
    ].join("\n"));
    if (evidence) {
      sections.push(["## Retrieval evidence (search_company_context)", boundedJson(evidence, EVIDENCE_CHAR_LIMIT)].join("\n"));
    }
  }
  sections.push(`## Question\nCurrent instant: ${now.toISOString()}.\n${item.liveQuestion}`);
  return [
    { role: "system", content: `You answer questions about ${company} for its staff, using only the material in the message.\n\n${OUTPUT_CONTRACT}` },
    { role: "user", content: sections.join("\n\n") }
  ];
}

function boundedJson(value, limit) {
  const text = JSON.stringify(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}…(truncated ${text.length - limit} chars)`;
}

/** Strip the sections of a search result that are not evidence. */
export function compactEvidence(searchResult) {
  if (!searchResult || typeof searchResult !== "object") return null;
  const { briefing, ...rest } = searchResult;
  return rest;
}

// ---------------------------------------------------------------------------
// Verification bridge

export function translateLiveAnswer({ answer, seedMap }) {
  if (!answer || typeof answer !== "object" || !Array.isArray(answer.grounding)) return answer;
  const grounding = answer.grounding.map((entry) => {
    const key = String(entry);
    if (seedMap.byRecordId[key]) return seedMap.byRecordId[key];
    return key;
  });
  return { ...answer, grounding: [...new Set(grounding)] };
}

export function gradeLiveAnswerText({ testCase, world, seedMap, text }) {
  const parsed = extractJson(text);
  if (parsed.error) {
    return { passed: false, failures: [`answer-is-json: ${parsed.error}`], answerDigest: digestResearchValue(String(text ?? "")), translated: null };
  }
  const translated = translateLiveAnswer({ answer: parsed.value, seedMap });
  const verification = verifyBusinessMemoryAnswer({ testCase, world, answer: translated });
  return { passed: verification.passed, failures: verification.failures, answerDigest: verification.answerDigest, translated };
}

// ---------------------------------------------------------------------------
// Running

export async function runLiveBusinessMemoryBenchmark({
  worker,
  client,
  manifest,
  world,
  seedMap,
  snapshot,
  arms = LIVE_ARMS,
  maxOutputTokens = 600,
  evidenceLimit = 4,
  now = () => new Date(),
  signal = null,
  onCase = null
}) {
  if (!worker || typeof worker.runCase !== "function") throw new Error("Live grading requires a research worker");
  requireClient(client);
  for (const arm of arms) if (!LIVE_ARMS.includes(arm)) throw new Error(`Unknown live arm ${arm}`);
  const cases = manifest.cases.filter((testCase) => testCase.worldId === world.id && LIVE_FAMILIES.includes(testCase.family));
  if (cases.length === 0) throw new Error("No live-reproducible cases for this world");
  const startedAt = now().toISOString();
  const runs = [];
  for (const arm of arms) {
    for (const testCase of cases) {
      if (signal?.aborted) break;
      const item = liveCase({ testCase, world, seedMap });
      let evidence = null;
      let evidenceCalls = 0;
      if (arm === "memory-live") {
        const args = { query: item.liveQuestion.slice(0, 256), limit: evidenceLimit };
        if (item.liveAsOf) args.as_of = item.liveAsOf;
        evidence = compactEvidence(await client.callTool("search_company_context", args, { signal }));
        evidenceCalls = 1;
      }
      const messages = renderLiveArmMessages({ arm, liveCase: item, world, snapshot, evidence, now: now() });
      const promptChars = messages.reduce((total, message) => total + String(message.content).length, 0);
      const observation = await runResearchInference({
        worker,
        caseId: `${testCase.id}::${arm}`,
        messages,
        dataManifestDigest: manifest.digest,
        repetition: 1,
        maxOutputTokens,
        answerReserveTokens: Math.max(96, Math.floor(maxOutputTokens / 4)),
        responseFormat: null,
        promptSessionId: `business-memory-live-${worker.model}-${arm}-${testCase.id}`,
        visibleAnswerValidator: (message) => looksLikeJson(visibleText(message)),
        signal
      });
      const answerText = visibleText(observation.message);
      const graded = gradeLiveAnswerText({ testCase, world, seedMap, text: answerText });
      const run = {
        caseId: testCase.id,
        caseDigest: testCase.digest,
        family: testCase.family,
        arm,
        passed: graded.passed,
        failures: graded.failures,
        answerDigest: graded.answerDigest,
        liveAsOf: item.liveAsOf,
        promptChars,
        evidenceCalls,
        outputTokens: observation.metrics?.outputTokens ?? null,
        wallMilliseconds: observation.metrics?.wallMilliseconds ?? null,
        recoveryTriggered: observation.recoveryTriggered,
        translatedGrounding: graded.translated?.grounding ?? null,
        answerText
      };
      runs.push(run);
      if (onCase) onCase(run);
    }
  }
  const armSummaries = arms.map((arm) => summarizeArm(arm, runs.filter((run) => run.arm === arm)));
  const paired = arms.includes("alone") && arms.includes("memory-live") ? pairArms(runs, "alone", "memory-live") : null;
  const base = {
    schema: BUSINESS_MEMORY_LIVE_REPORT_SCHEMA,
    version: BUSINESS_MEMORY_LIVE_VERSION,
    modelId: worker.model,
    controlId: worker.controlId,
    manifestDigest: manifest.digest,
    worldId: world.id,
    seedDigest: seedMap.digest,
    snapshotObservedAt: snapshot.observedAt,
    families: [...LIVE_FAMILIES],
    caseCount: cases.length,
    startedAt,
    completedAt: now().toISOString(),
    arms: armSummaries,
    paired,
    mcpCalls: client.summary(),
    runs,
    claimBoundary: [
      "Live arm: real tenant, real governed writes and reads, real Hosted route where the worker is Hosted.",
      "Only three families are reproducible with one principal; receipt, note, session, and scope families remain synthetic.",
      "As-of questions are asked at an RFC 3339 instant between live revisions, not at the world's calendar date.",
      "Single repetition; not a holdout claim about model quality."
    ]
  };
  return { ...base, digest: digestResearchValue(base) };
}

function summarizeArm(arm, runs) {
  const passed = runs.filter((run) => run.passed).length;
  const families = {};
  for (const run of runs) {
    const entry = (families[run.family] ||= { cases: 0, passed: 0 });
    entry.cases += 1;
    if (run.passed) entry.passed += 1;
  }
  return {
    arm,
    cases: runs.length,
    passed,
    passRate: runs.length ? passed / runs.length : null,
    promptCharsMean: runs.length ? runs.reduce((total, run) => total + run.promptChars, 0) / runs.length : null,
    families
  };
}

function pairArms(runs, baseline, treatment) {
  const byCase = new Map();
  for (const run of runs) {
    const entry = byCase.get(run.caseId) ?? {};
    entry[run.arm] = run.passed;
    byCase.set(run.caseId, entry);
  }
  let wins = 0;
  let losses = 0;
  let ties = 0;
  for (const entry of byCase.values()) {
    if (entry[baseline] === undefined || entry[treatment] === undefined) continue;
    if (entry[treatment] && !entry[baseline]) wins += 1;
    else if (!entry[treatment] && entry[baseline]) losses += 1;
    else ties += 1;
  }
  return { baseline, treatment, pairedWins: wins, pairedLosses: losses, ties };
}

function looksLikeJson(text) {
  return /\{[\s\S]*\}/.test(String(text ?? ""));
}

function requireClient(client) {
  if (!client || typeof client.callTool !== "function" || typeof client.summary !== "function") {
    throw new Error("A live client with callTool() and summary() is required");
  }
}

export { current, valueAsOf };
