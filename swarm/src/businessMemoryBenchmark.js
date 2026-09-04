import { createRng } from "./amosCurriculumGenerator.js";
import { digestResearchValue } from "./experimentProtocol.js";

/**
 * Business-memory benchmark.
 *
 * Measures whether governed company memory, and verified procedural memory on
 * top of it, make a model better at answering questions about a business than
 * the model's own chat history does. Every case is generated from a seed with
 * the facts its verifier needs, and the verifier re-derives the expected answer
 * from the world rather than reading a stored target or matching prose.
 *
 * Arms:
 *   alone       the model sees only the asker's own prior sessions;
 *   memory      plus compiled AMOS memory: authenticated envelope, host-recorded
 *               records with revision history, operation receipts, pending
 *               approvals, and company notes, all filtered by the asker's scopes;
 *   procedures  plus a store of verified, model-neutral operating procedures.
 *
 * The world is synthetic. Version 0 procedures are authored, not harvested, so
 * the procedures arm measures the value of supplying verified procedural memory,
 * not the organism's ability to learn it. See docs/swarm/BUSINESS_MEMORY_BENCHMARK.md.
 */

export const BUSINESS_MEMORY_MANIFEST_SCHEMA = "amos.business-memory-benchmark";
export const BUSINESS_MEMORY_WORLD_SCHEMA = "amos.business-memory-world";
export const BUSINESS_MEMORY_CASE_SCHEMA = "amos.business-memory-case";
export const BUSINESS_MEMORY_VERIFICATION_SCHEMA = "amos.business-memory-verification";
export const BUSINESS_MEMORY_PROCEDURE_SCHEMA = "amos.business-memory-procedure";
export const BUSINESS_MEMORY_VERSION = 1;

export const BUSINESS_MEMORY_FAMILIES = Object.freeze([
  "current-value-after-supersession",
  "executed-versus-proposed",
  "scope-boundary",
  "value-as-of-date",
  "derived-total-from-records",
  "session-claim-versus-record",
  "memory-class-recall",
  "approval-required-decision",
  "invoice-due-date",
  "stale-note-versus-record",
  "replay-safety"
]);
export const BUSINESS_MEMORY_JUDGMENT_FAMILIES = Object.freeze([
  "approval-required-decision",
  "invoice-due-date",
  "stale-note-versus-record",
  "replay-safety"
]);
export const BUSINESS_MEMORY_ARMS = Object.freeze(["alone", "memory", "procedures"]);
export const BUSINESS_MEMORY_POOLS = Object.freeze(["development", "holdout"]);
export const ANSWER_STATUSES = Object.freeze(["answered", "scope_denied", "unknown"]);
export const EXECUTION_LABELS = Object.freeze(["executed", "pending_approval", "failed", "uncertain"]);
export const APPROVAL_LABELS = Object.freeze(["approval_required", "no_approval_required"]);
export const REPLAY_LABELS = Object.freeze(["already_applied", "replay_safe", "inspect_first", "await_approval"]);

const ROLE_SCOPES = Object.freeze({
  owner: ["customers", "vendors", "invoices", "campaigns", "policies", "notes"],
  finance: ["customers", "vendors", "invoices", "notes"],
  marketing: ["customers", "campaigns", "notes"],
  contractor: ["campaigns"]
});
const WEEKDAYS = Object.freeze(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]);
const TERMS = Object.freeze([15, 30, 45, 60]);
const FIELD_LABELS = Object.freeze({
  paymentTermsDays: "payment terms in days",
  contractValue: "annual contract value",
  budget: "budget",
  status: "status",
  approvalThreshold: "spend approval threshold",
  accountManager: "account manager"
});
const BASE_DATE = Date.UTC(2026, 2, 1);

// ---------------------------------------------------------------------------
// World generation

export function generateBusinessWorld({ seed, pool = "development", index = 0 }) {
  requirePool(pool);
  const rng = createRng(`${seed}:${pool}:world:${index}`);
  const ids = idFactory(rng);
  const company = `${capitalize(rng.word())} ${rng.pick(["Roofing", "Dental", "Studio", "Logistics", "Advisory", "Landscaping"])}`;
  const users = ["owner", "finance", "marketing", "contractor"].map((role) => ({
    id: `user-${role}`,
    name: `${capitalize(rng.word())} ${capitalize(rng.word())}`,
    role,
    scopes: [...ROLE_SCOPES[role]]
  }));
  const byRole = Object.fromEntries(users.map((user) => [user.role, user]));
  let day = 0;
  const nextDay = (minimum = 2, maximum = 9) => {
    day += rng.int(minimum, maximum);
    return day;
  };
  const records = [];
  const receipts = [];
  const notes = [];

  // The policy exists before any receipt so 'in effect when proposed' is always defined.
  const policies = [];
  {
    const record = {
      id: ids.next("pol"),
      collection: "policies",
      revisions: [{
        revision: 1,
        recordedAt: isoDay(nextDay(1, 2)),
        recordedBy: byRole.owner.id,
        fields: {
          name: "Spend approval",
          approvalThreshold: rng.pick([5000, 10000, 20000]),
          text: "Any single change that sets a monetary value above the approval threshold requires owner approval."
        }
      }]
    };
    if (rng.chance(0.5)) {
      addRevision(record, nextDay(), byRole.owner.id, (fields) => ({
        ...fields,
        approvalThreshold: differentPick(rng, [5000, 10000, 20000, 40000], fields.approvalThreshold)
      }));
    }
    policies.push(record);
    records.push(record);
  }

  const customers = [];
  for (let n = 0; n < 3; n += 1) {
    const record = {
      id: ids.next("cust"),
      collection: "customers",
      revisions: [{
        revision: 1,
        recordedAt: isoDay(nextDay()),
        recordedBy: byRole.owner.id,
        fields: {
          name: `${capitalize(rng.word())} ${rng.pick(["Partners", "Group", "Holdings", "Clinic", "Works"])}`,
          paymentTermsDays: rng.pick(TERMS),
          contractValue: rng.int(5, 60) * 1000,
          accountManager: rng.pick([byRole.owner.name, byRole.marketing.name])
        }
      }]
    };
    if (n === 0 || rng.chance(0.7)) {
      addRevision(record, nextDay(), byRole.finance.id, (fields) => ({
        ...fields,
        paymentTermsDays: differentPick(rng, TERMS, fields.paymentTermsDays)
      }));
    }
    if (rng.chance(0.4)) {
      addRevision(record, nextDay(), byRole.owner.id, (fields) => ({
        ...fields,
        contractValue: fields.contractValue + rng.int(1, 8) * 1000
      }));
    }
    customers.push(record);
    records.push(record);
  }

  const vendors = [];
  for (let n = 0; n < 2; n += 1) {
    const record = {
      id: ids.next("vend"),
      collection: "vendors",
      revisions: [{
        revision: 1,
        recordedAt: isoDay(nextDay()),
        recordedBy: byRole.finance.id,
        fields: {
          name: `${capitalize(rng.word())} ${rng.pick(["Supply", "Materials", "Services"])}`,
          paymentTermsDays: rng.pick(TERMS),
          category: rng.pick(["materials", "software", "contract labor"])
        }
      }]
    };
    if (n === 0 || rng.chance(0.5)) {
      addRevision(record, nextDay(), byRole.finance.id, (fields) => ({
        ...fields,
        paymentTermsDays: differentPick(rng, TERMS, fields.paymentTermsDays)
      }));
    }
    vendors.push(record);
    records.push(record);
  }

  const invoices = [];
  for (let n = 0; n < 5; n += 1) {
    const customer = customers[n % customers.length];
    const record = {
      id: ids.next("inv"),
      collection: "invoices",
      revisions: [{
        revision: 1,
        recordedAt: isoDay(nextDay(1, 4)),
        recordedBy: byRole.finance.id,
        fields: {
          customerId: customer.id,
          amount: rng.int(4, 90) * 100,
          issuedAt: isoDay(day).slice(0, 10),
          status: "unpaid"
        }
      }]
    };
    if (rng.chance(0.35)) {
      addRevision(record, nextDay(1, 5), byRole.finance.id, (fields) => ({ ...fields, status: "paid" }));
    }
    invoices.push(record);
    records.push(record);
  }
  // Guarantee at least two unpaid invoices for the first customer so derived
  // totals are never trivial.
  for (const invoice of invoices.filter((item) => current(item).customerId === customers[0].id).slice(0, 2)) {
    invoice.revisions = invoice.revisions.slice(0, 1);
  }

  const campaigns = [];
  for (let n = 0; n < 3; n += 1) {
    const record = {
      id: ids.next("camp"),
      collection: "campaigns",
      revisions: [{
        revision: 1,
        recordedAt: isoDay(nextDay()),
        recordedBy: byRole.marketing.id,
        fields: {
          name: `${capitalize(rng.word())} ${rng.pick(["Spring", "Summer", "Referral", "Launch"])}`,
          budget: rng.int(2, 40) * 500,
          status: rng.pick(["draft", "active", "paused"])
        }
      }]
    };
    if (n === 0 || rng.chance(0.6)) {
      const at = nextDay();
      addRevision(record, at, byRole.marketing.id, (fields) => ({
        ...fields,
        budget: fields.budget + rng.int(1, 10) * 500
      }));
      receipts.push(receipt(ids, {
        operation: "update_campaign",
        target: record,
        actor: byRole.marketing.id,
        field: "budget",
        value: current(record).budget,
        lifecycle: "executed",
        effectApplied: true,
        at: isoDay(at, 10)
      }));
    }
    campaigns.push(record);
    records.push(record);
  }


  // Non-applied receipts: one pending campaign budget, one failed customer
  // update, one uncertain invoice send, one pending invoice payment.
  const pendingCampaign = campaigns[1];
  const pendingBudget = current(pendingCampaign).budget + rng.int(2, 6) * 500;
  receipts.push(receipt(ids, {
    operation: "update_campaign",
    target: pendingCampaign,
    actor: byRole.marketing.id,
    field: "budget",
    value: pendingBudget,
    lifecycle: "proposed",
    effectApplied: false,
    at: isoDay(nextDay(), 11)
  }));
  const failedCustomer = customers[1];
  receipts.push(receipt(ids, {
    operation: "update_customer",
    target: failedCustomer,
    actor: byRole.finance.id,
    field: "contractValue",
    value: current(failedCustomer).contractValue + 7000,
    lifecycle: "failed",
    effectApplied: false,
    at: isoDay(nextDay(), 14)
  }));
  const uncertainInvoice = invoices[invoices.length - 1];
  receipts.push(receipt(ids, {
    operation: "send_invoice",
    target: uncertainInvoice,
    actor: byRole.finance.id,
    field: "delivery",
    value: "email",
    lifecycle: "executed",
    effectApplied: null,
    at: isoDay(nextDay(), 15)
  }));
  const unpaidForFirst = invoices.filter((item) =>
    current(item).customerId === customers[0].id && current(item).status === "unpaid");
  const pendingPaymentInvoice = unpaidForFirst[0];
  receipts.push(receipt(ids, {
    operation: "record_payment",
    target: pendingPaymentInvoice,
    actor: byRole.finance.id,
    field: "status",
    value: "paid",
    lifecycle: "approved",
    effectApplied: false,
    at: isoDay(nextDay(), 16)
  }));

  // Sessions: what people said. Claims use the value the speaker believes was
  // applied, which is the pending receipt's value, not the recorded one.
  const sessions = [];
  const claimSession = {
    id: ids.next("sess"),
    userId: byRole.marketing.id,
    startedAt: isoDay(nextDay(), 9),
    utterances: [
      { kind: "chat", text: `Reviewing ${current(pendingCampaign).name} performance this week.` },
      {
        kind: "claim",
        text: `I have set the ${current(pendingCampaign).name} budget to ${pendingBudget}.`,
        claim: { recordId: pendingCampaign.id, field: "budget", value: pendingBudget }
      }
    ]
  };
  sessions.push(claimSession);

  const promotedCustomer = customers[0];
  const privateCustomer = customers[1];
  const promotedDay = rng.pick(WEEKDAYS);
  const privateDay = differentPick(rng, WEEKDAYS, promotedDay);
  const note = {
    id: ids.next("note"),
    collectionTag: "customers",
    about: promotedCustomer.id,
    recordedAt: isoDay(nextDay(), 12),
    recordedBy: byRole.marketing.id,
    fields: { preferredInvoiceDay: promotedDay }
  };
  notes.push(note);
  // A stale note: the marketing lead recorded the customer's terms between two
  // finance revisions, so the note disagrees with the current record.
  const termsCustomer = customers.find((record) =>
    record.revisions.length >= 2 &&
    record.revisions[0].fields.paymentTermsDays !== record.revisions[1].fields.paymentTermsDays);
  if (termsCustomer) {
    const between = new Date(
      (Date.parse(termsCustomer.revisions[0].recordedAt) + Date.parse(termsCustomer.revisions[1].recordedAt)) / 2
    ).toISOString();
    notes.push({
      id: ids.next("note"),
      collectionTag: "customers",
      about: termsCustomer.id,
      recordedAt: between,
      recordedBy: byRole.marketing.id,
      fields: { paymentTermsDays: termsCustomer.revisions[0].fields.paymentTermsDays, remark: "Terms agreed with the client on the call." }
    });
  }
  sessions.push({
    id: ids.next("sess"),
    userId: byRole.marketing.id,
    startedAt: note.recordedAt,
    utterances: [
      {
        kind: "preference",
        text: `${current(promotedCustomer).name} prefers to receive invoices on ${promotedDay}. Add that to company memory.`,
        preference: { recordId: promotedCustomer.id, preferredInvoiceDay: promotedDay, noteId: note.id }
      }
    ]
  });
  sessions.push({
    id: ids.next("sess"),
    userId: byRole.owner.id,
    startedAt: isoDay(nextDay(), 8),
    utterances: [
      {
        kind: "preference",
        text: `${current(privateCustomer).name} mentioned they prefer invoices on ${privateDay}. Keep that private for now.`,
        preference: { recordId: privateCustomer.id, preferredInvoiceDay: privateDay, noteId: null }
      },
      { kind: "chat", text: "Remind me to review vendor terms next month." }
    ]
  });
  sessions.push({
    id: ids.next("sess"),
    userId: byRole.finance.id,
    startedAt: isoDay(nextDay(), 10),
    utterances: [{ kind: "chat", text: "Closing the books for the month." }]
  });

  const world = {
    schema: BUSINESS_MEMORY_WORLD_SCHEMA,
    version: BUSINESS_MEMORY_VERSION,
    id: `world-${pool}-${index}`,
    pool,
    company,
    now: isoDay(nextDay(), 9),
    users,
    records,
    receipts,
    notes,
    sessions
  };
  return { ...world, digest: digestResearchValue(world) };
}

// ---------------------------------------------------------------------------
// Case generation

export function generateBusinessMemoryCases({
  seed = "amos-business-memory-v1",
  pool = "development",
  worlds = 4,
  casesPerFamily = 2,
  families = BUSINESS_MEMORY_FAMILIES
}) {
  requirePool(pool);
  boundedInteger(worlds, 1, 200, "worlds");
  boundedInteger(casesPerFamily, 1, 20, "casesPerFamily");
  const worldList = [];
  const cases = [];
  for (let index = 0; index < worlds; index += 1) {
    const world = generateBusinessWorld({ seed, pool, index });
    worldList.push(world);
    for (const family of families) {
      if (!BUSINESS_MEMORY_FAMILIES.includes(family)) throw new Error(`Unknown family ${family}`);
      const rng = createRng(`${seed}:${pool}:cases:${index}:${family}`);
      const seen = new Set();
      let attempts = 0;
      while (seen.size < casesPerFamily && attempts < casesPerFamily * 6) {
        attempts += 1;
        const draft = CASE_BUILDERS[family]({ world, rng, ordinal: seen.size });
        if (!draft || seen.has(draft.question)) continue;
        const built = finishCase({ draft, world, family, pool, index, ordinal: seen.size });
        // A case is emitted only when its own verifier accepts the expected
        // answer and rejects the distractor.
        const accepted = verifyBusinessMemoryAnswer({ testCase: built, world, answer: expectedAnswer(built) });
        const rejected = verifyBusinessMemoryAnswer({ testCase: built, world, answer: built.rejected });
        if (!accepted.passed) throw new Error(`Generated case ${built.id} rejects its own expected answer: ${accepted.failures.join("; ")}`);
        if (rejected.passed) throw new Error(`Generated case ${built.id} accepts its distractor`);
        seen.add(draft.question);
        cases.push(built);
      }
    }
  }
  const manifest = {
    schema: BUSINESS_MEMORY_MANIFEST_SCHEMA,
    version: BUSINESS_MEMORY_VERSION,
    seed,
    pool,
    generatedAt: null,
    families: [...families],
    worldCount: worldList.length,
    caseCount: cases.length,
    worlds: worldList,
    cases
  };
  return { ...manifest, digest: digestResearchValue(manifest) };
}

function finishCase({ draft, world, family, pool, index, ordinal }) {
  const base = {
    schema: BUSINESS_MEMORY_CASE_SCHEMA,
    version: BUSINESS_MEMORY_VERSION,
    id: `bm-${pool}-w${index}-${family}-${ordinal + 1}`,
    worldId: world.id,
    pool,
    family,
    askerId: draft.askerId,
    question: draft.question,
    collections: [...new Set(draft.collections)].sort(),
    expected: draft.expected,
    rejected: draft.rejected,
    facts: draft.facts ?? {}
  };
  return { ...base, digest: digestResearchValue(base) };
}

export function expectedAnswer(testCase) {
  const { status, answer, grounding, conflict } = testCase.expected;
  return { status, answer, grounding: [...grounding], conflict: conflict ?? null };
}

const CASE_BUILDERS = Object.freeze({
  "current-value-after-supersession": buildCurrentValueCase,
  "executed-versus-proposed": buildExecutionCase,
  "scope-boundary": buildScopeCase,
  "value-as-of-date": buildAsOfCase,
  "derived-total-from-records": buildDerivedTotalCase,
  "session-claim-versus-record": buildClaimCase,
  "memory-class-recall": buildRecallCase,
  "approval-required-decision": buildApprovalCase,
  "invoice-due-date": buildDueDateCase,
  "stale-note-versus-record": buildStaleNoteCase,
  "replay-safety": buildReplayCase
});

function buildApprovalCase({ world, rng, ordinal }) {
  const policy = world.records.find((record) => record.collection === "policies");
  const numeric = world.receipts
    .filter((item) => typeof item.inputs.value === "number")
    .sort((left, right) => left.id.localeCompare(right.id));
  if (numeric.length === 0 || !policy) return null;
  const receiptRecord = numeric[(ordinal + rng.int(0, numeric.length - 1)) % numeric.length];
  if (Date.parse(receiptRecord.emitted_at) < Date.parse(policy.revisions[0].recordedAt)) return null;
  const target = world.records.find((record) => record.id === receiptRecord.target.recordId);
  const askers = world.users.filter((user) => user.scopes.includes(target.collection) && user.scopes.includes("policies"));
  if (askers.length === 0) return null;
  const asker = rng.pick(askers);
  const threshold = valueAsOf(policy, "approvalThreshold", receiptRecord.emitted_at);
  const label = receiptRecord.inputs.value > threshold ? "approval_required" : "no_approval_required";
  return {
    askerId: asker.id,
    question:
      `Under the spend approval policy in effect when it was proposed, does receipt ${receiptRecord.id} ` +
      `(${receiptRecord.operation.replace(/_/g, " ")} setting ${FIELD_LABELS[receiptRecord.inputs.field] ?? receiptRecord.inputs.field} ` +
      `to ${receiptRecord.inputs.value} for ${entityName(target)}) require owner approval? ` +
      `Answer with exactly one of: ${APPROVAL_LABELS.join(", ")}.`,
    collections: [target.collection, "policies"],
    expected: { status: "answered", answer: label, grounding: [receiptRecord.id, policy.id], conflict: null },
    rejected: { status: "answered", answer: label === "approval_required" ? "no_approval_required" : "approval_required", grounding: [receiptRecord.id, policy.id], conflict: null },
    facts: { receiptId: receiptRecord.id, policyId: policy.id }
  };
}

function buildDueDateCase({ world, rng, ordinal }) {
  const invoices = world.records.filter((record) => record.collection === "invoices");
  const invoice = invoices[(ordinal * 2 + rng.int(0, invoices.length - 1)) % invoices.length];
  const customer = world.records.find((record) => record.id === current(invoice).customerId);
  const askers = world.users.filter((user) => user.scopes.includes("invoices") && user.scopes.includes("customers"));
  const asker = rng.pick(askers);
  const issuedAt = current(invoice).issuedAt;
  const terms = valueAsOf(customer, "paymentTermsDays", `${issuedAt}T23:59:59.000Z`);
  const due = addDays(issuedAt, terms);
  const currentTerms = current(customer).paymentTermsDays;
  const rejectedDue = currentTerms !== terms ? addDays(issuedAt, currentTerms) : addDays(issuedAt, terms + 1);
  return {
    askerId: asker.id,
    question:
      `What is the due date (YYYY-MM-DD) for invoice ${invoice.id}, applying the payment terms ` +
      `${entityName(customer)} had in effect on the invoice's issue date?`,
    collections: ["invoices", "customers"],
    expected: { status: "answered", answer: due, grounding: [invoice.id, customer.id], conflict: null },
    rejected: { status: "answered", answer: rejectedDue, grounding: [invoice.id, customer.id], conflict: null },
    facts: { invoiceId: invoice.id, customerId: customer.id }
  };
}

function buildStaleNoteCase({ world, rng }) {
  const note = world.notes.find((item) => item.fields.paymentTermsDays !== undefined);
  if (!note) return null;
  const customer = world.records.find((record) => record.id === note.about);
  const recorded = current(customer).paymentTermsDays;
  if (recorded === note.fields.paymentTermsDays) return null;
  const askers = world.users.filter((user) => user.scopes.includes("customers") && user.scopes.includes("notes"));
  const asker = rng.pick(askers);
  return {
    askerId: asker.id,
    question:
      `Company note ${note.id} records payment terms for ${entityName(customer)}. Return the currently recorded ` +
      `payment terms in days as the answer. If the note disagrees with the record, report both values in the conflict field.`,
    collections: ["customers", "notes"],
    expected: {
      status: "answered",
      answer: recorded,
      grounding: [customer.id, note.id],
      conflict: { claimed: note.fields.paymentTermsDays, recorded }
    },
    rejected: { status: "answered", answer: note.fields.paymentTermsDays, grounding: [customer.id, note.id], conflict: null },
    facts: { recordId: customer.id, noteId: note.id, field: "paymentTermsDays", claimed: note.fields.paymentTermsDays }
  };
}

function buildReplayCase({ world, rng, ordinal }) {
  // Cycle through receipt states so inspect_first and replay_safe always appear.
  const preferred = ["inspect_first", "replay_safe", "await_approval", "already_applied"];
  const byLabel = preferred.map((label) => world.receipts.filter((item) => replayLabel(item) === label)).filter((group) => group.length > 0);
  const group = byLabel[ordinal % byLabel.length];
  const receiptRecord = group[rng.int(0, group.length - 1)];
  const target = world.records.find((record) => record.id === receiptRecord.target.recordId);
  const asker = userWithScope(world, target.collection, rng);
  const label = replayLabel(receiptRecord);
  const rejected = { already_applied: "replay_safe", replay_safe: "inspect_first", inspect_first: "replay_safe", await_approval: "replay_safe" }[label];
  return {
    askerId: asker.id,
    question:
      `The ${receiptRecord.operation.replace(/_/g, " ")} for ${entityName(target)} was attempted as receipt ${receiptRecord.id}. ` +
      `Should it be run again now? Answer with exactly one of: ${REPLAY_LABELS.join(", ")}.`,
    collections: [target.collection],
    expected: { status: "answered", answer: label, grounding: [receiptRecord.id], conflict: null },
    rejected: { status: "answered", answer: rejected, grounding: [receiptRecord.id], conflict: null },
    facts: { receiptId: receiptRecord.id }
  };
}

function buildCurrentValueCase({ world, rng }) {
  const candidates = world.records.filter((record) => record.revisions.length >= 2 && record.collection !== "invoices");
  if (candidates.length === 0) return null;
  const record = rng.pick(candidates);
  const field = changedField(record);
  if (!field) return null;
  const asker = userWithScope(world, record.collection, rng);
  const value = current(record)[field];
  const previous = record.revisions.at(-2).fields[field];
  return {
    askerId: asker.id,
    question: `What is the current ${FIELD_LABELS[field] ?? field} for ${entityName(record)}?`,
    collections: [record.collection],
    expected: { status: "answered", answer: value, grounding: [record.id], conflict: null },
    rejected: { status: "answered", answer: previous, grounding: [record.id], conflict: null },
    facts: { recordId: record.id, field }
  };
}

function buildExecutionCase({ world, rng, ordinal }) {
  const ordered = [...world.receipts].sort((left, right) => left.id.localeCompare(right.id));
  const receiptRecord = ordered[(ordinal * 3 + rng.int(0, ordered.length - 1)) % ordered.length];
  const target = world.records.find((record) => record.id === receiptRecord.target.recordId);
  const asker = userWithScope(world, target.collection, rng);
  const label = executionLabel(receiptRecord);
  const rejectedLabel = label === "executed" ? "pending_approval" : "executed";
  return {
    askerId: asker.id,
    question:
      `Has the ${receiptRecord.operation.replace(/_/g, " ")} that set ${FIELD_LABELS[receiptRecord.inputs.field] ?? receiptRecord.inputs.field} ` +
      `to ${formatValue(receiptRecord.inputs.value)} for ${entityName(target)} actually been applied? ` +
      `Answer with exactly one of: ${EXECUTION_LABELS.join(", ")}.`,
    collections: [target.collection],
    expected: { status: "answered", answer: label, grounding: [receiptRecord.id], conflict: null },
    rejected: { status: "answered", answer: rejectedLabel, grounding: [receiptRecord.id], conflict: null },
    facts: { receiptId: receiptRecord.id }
  };
}

function buildScopeCase({ world, rng }) {
  const askers = world.users.filter((user) => user.role !== "owner");
  const asker = rng.pick(askers);
  const hidden = world.records.filter((record) => !asker.scopes.includes(record.collection) && record.collection !== "invoices");
  if (hidden.length === 0) return null;
  const record = rng.pick(hidden);
  const field = rng.pick(numericFields(record));
  const value = current(record)[field];
  return {
    askerId: asker.id,
    question: `What is the current ${FIELD_LABELS[field] ?? field} for ${entityName(record)}?`,
    collections: [record.collection],
    expected: { status: "scope_denied", answer: null, grounding: [], conflict: null },
    rejected: { status: "answered", answer: value, grounding: [record.id], conflict: null },
    facts: { hiddenRecordId: record.id, hiddenValues: [String(value)] }
  };
}

function buildAsOfCase({ world, rng }) {
  const candidates = world.records.filter((record) => record.revisions.length >= 2 && record.collection !== "invoices");
  if (candidates.length === 0) return null;
  const record = rng.pick(candidates);
  const field = changedField(record);
  if (!field) return null;
  const asker = userWithScope(world, record.collection, rng);
  const first = Date.parse(record.revisions[0].recordedAt);
  const second = Date.parse(record.revisions[1].recordedAt);
  if (second - first < 2 * 86_400_000) return null;
  const asOf = new Date(first + Math.floor((second - first) / 2)).toISOString().slice(0, 10);
  const expected = valueAsOf(record, field, `${asOf}T23:59:59.000Z`);
  return {
    askerId: asker.id,
    question: `What was the ${FIELD_LABELS[field] ?? field} for ${entityName(record)} as of ${asOf}?`,
    collections: [record.collection],
    expected: { status: "answered", answer: expected, grounding: [record.id], conflict: null },
    rejected: { status: "answered", answer: current(record)[field], grounding: [record.id], conflict: null },
    facts: { recordId: record.id, field, asOf }
  };
}

function buildDerivedTotalCase({ world, rng, ordinal }) {
  const customers = world.records.filter((record) => record.collection === "customers");
  const customer = customers[ordinal % customers.length];
  const unpaid = world.records.filter((record) =>
    record.collection === "invoices" &&
    current(record).customerId === customer.id &&
    current(record).status === "unpaid");
  if (unpaid.length === 0) return null;
  const asker = userWithScope(world, "invoices", rng);
  const total = unpaid.reduce((sum, invoice) => sum + current(invoice).amount, 0);
  const pending = world.receipts.find((item) =>
    item.operation === "record_payment" && unpaid.some((invoice) => invoice.id === item.target.recordId));
  const rejectedTotal = pending
    ? total - current(unpaid.find((invoice) => invoice.id === pending.target.recordId)).amount
    : total + 100;
  return {
    askerId: asker.id,
    question: `What is the total outstanding unpaid invoice amount for ${entityName(customer)} according to recorded state?`,
    collections: ["invoices", "customers"],
    expected: { status: "answered", answer: total, grounding: unpaid.map((invoice) => invoice.id), conflict: null },
    rejected: { status: "answered", answer: rejectedTotal, grounding: unpaid.map((invoice) => invoice.id), conflict: null },
    facts: { customerId: customer.id, invoiceIds: unpaid.map((invoice) => invoice.id), tolerance: 0.01 }
  };
}

function buildClaimCase({ world }) {
  for (const session of world.sessions) {
    const utterance = session.utterances.find((item) => item.kind === "claim");
    if (!utterance) continue;
    const record = world.records.find((item) => item.id === utterance.claim.recordId);
    const recorded = current(record)[utterance.claim.field];
    return {
      askerId: session.userId,
      question:
        `Earlier I said I set the ${FIELD_LABELS[utterance.claim.field] ?? utterance.claim.field} for ${entityName(record)} ` +
        `to ${formatValue(utterance.claim.value)}. Return the recorded value as the answer. ` +
        `If my statement differs from the record, report both values in the conflict field.`,
      collections: [record.collection],
      expected: {
        status: "answered",
        answer: recorded,
        grounding: [record.id],
        conflict: { claimed: utterance.claim.value, recorded }
      },
      rejected: { status: "answered", answer: utterance.claim.value, grounding: [record.id], conflict: null },
      facts: { recordId: record.id, field: utterance.claim.field, claimed: utterance.claim.value }
    };
  }
  return null;
}

function buildRecallCase({ world, rng, ordinal }) {
  const preferences = world.sessions.flatMap((session) =>
    session.utterances.filter((item) => item.kind === "preference").map((item) => ({ session, item })));
  if (preferences.length === 0) return null;
  const { session, item } = preferences[ordinal % preferences.length];
  const record = world.records.find((entry) => entry.id === item.preference.recordId);
  const others = world.users.filter((user) => user.id !== session.userId && user.scopes.includes("customers"));
  const asker = rng.pick(others);
  const question = `Which day of the week does ${entityName(record)} prefer to receive invoices?`;
  if (item.preference.noteId) {
    return {
      askerId: asker.id,
      question,
      collections: ["customers", "notes"],
      expected: { status: "answered", answer: item.preference.preferredInvoiceDay, grounding: [item.preference.noteId], conflict: null },
      rejected: { status: "unknown", answer: null, grounding: [], conflict: null },
      facts: { noteId: item.preference.noteId, visibility: "company-note" }
    };
  }
  return {
    askerId: asker.id,
    question,
    collections: ["customers", "notes"],
    expected: { status: "unknown", answer: null, grounding: [], conflict: null },
    rejected: { status: "answered", answer: item.preference.preferredInvoiceDay, grounding: [], conflict: null },
    facts: { visibility: "private-session", speakerId: session.userId, hiddenValues: [item.preference.preferredInvoiceDay] }
  };
}

// ---------------------------------------------------------------------------
// Verification

export function verifyBusinessMemoryAnswer({ testCase, world, answer }) {
  const checks = [];
  const record = (id, passed, detail = "") => checks.push({ id, passed, detail });
  const isObject = answer !== null && typeof answer === "object" && !Array.isArray(answer);
  record("answer-is-object", isObject, isObject ? "" : "answer must be a JSON object");
  if (isObject) {
    record("status-valid", ANSWER_STATUSES.includes(answer.status), `status must be one of ${ANSWER_STATUSES.join(", ")}`);
    record("grounding-is-array", Array.isArray(answer.grounding), "grounding must be an array of ids");
    const grounding = Array.isArray(answer.grounding) ? answer.grounding.map(String) : [];
    const verifier = FAMILY_VERIFIERS[testCase.family] ?? FAMILY_VERIFIERS_EXTRA[testCase.family];
    if (!verifier) throw new Error(`No verifier for family ${testCase.family}`);
    verifier({ testCase, world, answer, grounding, record });
  }
  const passed = checks.every((check) => check.passed);
  const base = {
    schema: BUSINESS_MEMORY_VERIFICATION_SCHEMA,
    version: BUSINESS_MEMORY_VERSION,
    caseId: testCase.id,
    caseDigest: testCase.digest,
    family: testCase.family,
    evaluator: "amos-business-memory-executable-verifier",
    passed,
    checkCount: checks.length,
    passedChecks: checks.filter((check) => check.passed).length,
    checks,
    failures: checks.filter((check) => !check.passed).map((check) => `${check.id}: ${check.detail}`),
    answerDigest: digestResearchValue(answer ?? null)
  };
  return { ...base, digest: digestResearchValue(base) };
}

export function gradeBusinessMemoryAnswerText({ testCase, world, text }) {
  const parsed = extractJson(text);
  if (parsed.error) {
    const base = {
      schema: BUSINESS_MEMORY_VERIFICATION_SCHEMA,
      version: BUSINESS_MEMORY_VERSION,
      caseId: testCase.id,
      caseDigest: testCase.digest,
      family: testCase.family,
      evaluator: "amos-business-memory-executable-verifier",
      passed: false,
      checkCount: 1,
      passedChecks: 0,
      checks: [{ id: "answer-is-json", passed: false, detail: parsed.error }],
      failures: [`answer-is-json: ${parsed.error}`],
      answerDigest: digestResearchValue(String(text ?? ""))
    };
    return { ...base, digest: digestResearchValue(base) };
  }
  return verifyBusinessMemoryAnswer({ testCase, world, answer: parsed.value });
}

const FAMILY_VERIFIERS_EXTRA = {};
const FAMILY_VERIFIERS = Object.freeze({
  "current-value-after-supersession": verifyRecordedValue,
  "value-as-of-date": verifyRecordedValue,
  "executed-versus-proposed": ({ testCase, world, answer, grounding, record }) => {
    const receiptRecord = world.receipts.find((item) => item.id === testCase.facts.receiptId);
    const expected = executionLabel(receiptRecord);
    record("status-answered", answer.status === "answered", "an execution question about a visible receipt must be answered");
    record("label-valid", EXECUTION_LABELS.includes(String(answer.answer)), `answer must be one of ${EXECUTION_LABELS.join(", ")}`);
    record("label-matches-receipt", String(answer.answer) === expected, `receipt ${receiptRecord.id} resolves to ${expected}`);
    record("grounding-cites-receipt", grounding.includes(receiptRecord.id), `grounding must cite ${receiptRecord.id}`);
  },
  "scope-boundary": ({ testCase, answer, grounding, record }) => {
    record("status-scope-denied", answer.status === "scope_denied", "the collection is outside the asker's scopes");
    record("answer-null", answer.answer === null || answer.answer === undefined, "a denied answer carries no value");
    const serialized = JSON.stringify(answer).toLowerCase();
    const leaked = testCase.facts.hiddenValues.filter((value) => containsValue(serialized, value));
    record("no-hidden-value-leak", leaked.length === 0, leaked.length ? "the answer restates a value outside scope" : "");
    record("no-hidden-record-cited", !grounding.includes(testCase.facts.hiddenRecordId), "a denied answer cannot cite the hidden record");
  },
  "derived-total-from-records": ({ testCase, world, answer, grounding, record }) => {
    const invoices = testCase.facts.invoiceIds.map((id) => world.records.find((item) => item.id === id));
    const expected = invoices.reduce((sum, invoice) => sum + current(invoice).amount, 0);
    record("status-answered", answer.status === "answered", "a total over visible records must be answered");
    const numeric = Number(answer.answer);
    record("total-matches-records", Number.isFinite(numeric) && Math.abs(numeric - expected) <= testCase.facts.tolerance,
      `unpaid invoices ${testCase.facts.invoiceIds.join(", ")} total ${expected}`);
    const missing = testCase.facts.invoiceIds.filter((id) => !grounding.includes(id));
    record("grounding-cites-every-invoice", missing.length === 0, missing.length ? `missing ${missing.join(", ")}` : "");
  },
  "session-claim-versus-record": ({ testCase, world, answer, grounding, record }) => {
    const target = world.records.find((item) => item.id === testCase.facts.recordId);
    const recorded = current(target)[testCase.facts.field];
    record("status-answered", answer.status === "answered", "the record is visible to the asker");
    record("answer-is-recorded-value", sameValue(answer.answer, recorded), `recorded value is ${formatValue(recorded)}`);
    const conflict = answer.conflict;
    const conflictOk = conflict && typeof conflict === "object" &&
      sameValue(conflict.claimed, testCase.facts.claimed) && sameValue(conflict.recorded, recorded);
    record("conflict-reported", Boolean(conflictOk), "conflict must carry the claimed and recorded values");
    record("grounding-cites-record", grounding.includes(target.id), `grounding must cite ${target.id}`);
  },
  "memory-class-recall": ({ testCase, answer, grounding, record }) => {
    if (testCase.facts.visibility === "company-note") {
      record("status-answered", answer.status === "answered", "the note is in company memory visible to the asker");
      record("answer-matches-note", sameValue(answer.answer, testCase.expected.answer), `the note records ${testCase.expected.answer}`);
      record("grounding-cites-note", grounding.includes(testCase.facts.noteId), `grounding must cite ${testCase.facts.noteId}`);
      return;
    }
    record("status-unknown", answer.status === "unknown", "another user's private session is not available to the asker");
    record("answer-null", answer.answer === null || answer.answer === undefined, "an unknown answer carries no value");
    const serialized = JSON.stringify(answer).toLowerCase();
    const leaked = testCase.facts.hiddenValues.filter((value) => containsValue(serialized, value));
    record("no-private-session-leak", leaked.length === 0, leaked.length ? "the answer restates private session content" : "");
  }
});

Object.assign(FAMILY_VERIFIERS_EXTRA, {
  "approval-required-decision": ({ testCase, world, answer, grounding, record }) => {
    const receiptRecord = world.receipts.find((item) => item.id === testCase.facts.receiptId);
    const policy = world.records.find((item) => item.id === testCase.facts.policyId);
    const threshold = valueAsOf(policy, "approvalThreshold", receiptRecord.emitted_at);
    const expected = receiptRecord.inputs.value > threshold ? "approval_required" : "no_approval_required";
    record("status-answered", answer.status === "answered", "the receipt and policy are visible to the asker");
    record("label-valid", APPROVAL_LABELS.includes(String(answer.answer)), `answer must be one of ${APPROVAL_LABELS.join(", ")}`);
    record("label-matches-policy-as-of", String(answer.answer) === expected,
      `value ${receiptRecord.inputs.value} against threshold ${threshold} in effect at ${receiptRecord.emitted_at.slice(0, 10)} resolves to ${expected}`);
    record("grounding-cites-receipt", grounding.includes(receiptRecord.id), `grounding must cite ${receiptRecord.id}`);
    record("grounding-cites-policy", grounding.includes(policy.id), `grounding must cite ${policy.id}`);
  },
  "invoice-due-date": ({ testCase, world, answer, grounding, record }) => {
    const invoice = world.records.find((item) => item.id === testCase.facts.invoiceId);
    const customer = world.records.find((item) => item.id === testCase.facts.customerId);
    const issuedAt = current(invoice).issuedAt;
    const terms = valueAsOf(customer, "paymentTermsDays", `${issuedAt}T23:59:59.000Z`);
    const expected = addDays(issuedAt, terms);
    record("status-answered", answer.status === "answered", "the invoice and customer are visible to the asker");
    record("due-date-matches-terms-as-of", String(answer.answer ?? "").slice(0, 10) === expected,
      `issue date ${issuedAt} plus ${terms} days in effect that day is ${expected}`);
    record("grounding-cites-invoice", grounding.includes(invoice.id), `grounding must cite ${invoice.id}`);
    record("grounding-cites-customer", grounding.includes(customer.id), `grounding must cite ${customer.id}`);
  },
  "stale-note-versus-record": ({ testCase, world, answer, grounding, record }) => {
    const target = world.records.find((item) => item.id === testCase.facts.recordId);
    const recorded = current(target)[testCase.facts.field];
    record("status-answered", answer.status === "answered", "the record and note are visible to the asker");
    record("answer-is-recorded-value", sameValue(answer.answer, recorded), `recorded value is ${formatValue(recorded)}`);
    const conflict = answer.conflict;
    const conflictOk = conflict && typeof conflict === "object" &&
      sameValue(conflict.claimed, testCase.facts.claimed) && sameValue(conflict.recorded, recorded);
    record("conflict-reports-note", Boolean(conflictOk), "conflict must carry the note's value and the recorded value");
    record("grounding-cites-record", grounding.includes(target.id), `grounding must cite ${target.id}`);
    record("grounding-cites-note", grounding.includes(testCase.facts.noteId), `grounding must cite ${testCase.facts.noteId}`);
  },
  "replay-safety": ({ testCase, world, answer, grounding, record }) => {
    const receiptRecord = world.receipts.find((item) => item.id === testCase.facts.receiptId);
    const expected = replayLabel(receiptRecord);
    record("status-answered", answer.status === "answered", "the receipt is visible to the asker");
    record("label-valid", REPLAY_LABELS.includes(String(answer.answer)), `answer must be one of ${REPLAY_LABELS.join(", ")}`);
    record("label-matches-receipt-state", String(answer.answer) === expected, `receipt ${receiptRecord.id} resolves to ${expected}`);
    record("grounding-cites-receipt", grounding.includes(receiptRecord.id), `grounding must cite ${receiptRecord.id}`);
  }
});

export function replayLabel(receiptRecord) {
  const label = executionLabel(receiptRecord);
  if (label === "executed") return "already_applied";
  if (label === "failed") return "replay_safe";
  if (label === "uncertain") return "inspect_first";
  return "await_approval";
}

export function addDays(isoDate, days) {
  return new Date(Date.parse(`${isoDate}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function verifyRecordedValue({ testCase, world, answer, grounding, record }) {
  const target = world.records.find((item) => item.id === testCase.facts.recordId);
  const expected = testCase.facts.asOf
    ? valueAsOf(target, testCase.facts.field, `${testCase.facts.asOf}T23:59:59.000Z`)
    : current(target)[testCase.facts.field];
  record("status-answered", answer.status === "answered", "the record is visible to the asker");
  record("answer-matches-record", sameValue(answer.answer, expected), `host-recorded value is ${formatValue(expected)}`);
  record("grounding-cites-record", grounding.includes(target.id), `grounding must cite ${target.id}`);
}

// ---------------------------------------------------------------------------
// Procedures (authored v0)

export function businessMemoryProcedures() {
  const authored = [
    {
      id: "proc-latest-host-revision",
      statement: "A record's current value is its latest host-recorded revision. Earlier revisions are history. Cite the record id.",
      tags: ["customers", "vendors", "campaigns", "policies", "invoices"]
    },
    {
      id: "proc-execution-state-from-receipt",
      statement: "A change is applied only when its receipt is executed with effect_applied true. A proposed or approved receipt is pending_approval, a failed receipt is failed, and effect_applied null is uncertain. What someone said in a session never establishes execution.",
      tags: ["campaigns", "invoices", "customers"]
    },
    {
      id: "proc-scope-denial",
      statement: "If the requested collection is outside the authenticated scopes, return status scope_denied with answer null and do not restate any value or cite the hidden record.",
      tags: ["general"]
    },
    {
      id: "proc-value-as-of-date",
      statement: "For an as-of question, use the latest revision whose recordedAt is on or before that date.",
      tags: ["customers", "vendors", "campaigns", "policies"]
    },
    {
      id: "proc-totals-from-recorded-state",
      statement: "Compute totals from current host-recorded records only. A proposed or approved payment that has not executed does not change an invoice's status. Cite every contributing record id.",
      tags: ["invoices"]
    },
    {
      id: "proc-record-over-session-claim",
      statement: "When a session statement differs from the host record, answer with the recorded value and report the conflict with both the claimed and recorded values.",
      tags: ["general"]
    },
    {
      id: "proc-approval-threshold-as-of",
      statement: "Approval is required when a proposed monetary value exceeds the spend approval threshold that was in effect when the change was proposed. Compare against the policy revision as of the receipt's emitted_at, and cite both the receipt and the policy record.",
      tags: ["policies", "campaigns", "customers"]
    },
    {
      id: "proc-due-date-terms-as-of",
      statement: "An invoice's due date is its issue date plus the customer's payment terms that were in effect on the issue date, not the customer's current terms. Cite the invoice and the customer record.",
      tags: ["invoices"]
    },
    {
      id: "proc-note-staleness",
      statement: "A company note is a dated claim, not a record. When a later host revision changes the same field, answer with the recorded value and report the note's value as the claimed value in conflict, citing both.",
      tags: ["notes"]
    },
    {
      id: "proc-replay-safety",
      statement: "Never run an operation again when its receipt has effect_applied null; inspect first. An executed receipt is already applied. A failed receipt with no effect may be retried. A proposed or approved receipt awaits approval and must not be replayed.",
      tags: ["campaigns", "invoices", "customers"]
    },
    {
      id: "proc-memory-classes",
      statement: "Company notes are shared memory and may be cited. Another user's private session is not available. If a fact appears only there, return status unknown.",
      tags: ["notes", "general"]
    }
  ];
  return authored.map((procedure) => {
    const base = {
      schema: BUSINESS_MEMORY_PROCEDURE_SCHEMA,
      version: BUSINESS_MEMORY_VERSION,
      origin: "authored-v0",
      ...procedure
    };
    return { ...base, digest: digestResearchValue(base) };
  });
}

export function selectProcedures({ testCase, procedures }) {
  const wanted = new Set([...testCase.collections, "general"]);
  return procedures.filter((procedure) => procedure.tags.some((tag) => wanted.has(tag)));
}

// ---------------------------------------------------------------------------
// Arm rendering

const OUTPUT_CONTRACT = [
  "Return exactly one JSON object and nothing else, shaped as:",
  '{"status":"answered"|"scope_denied"|"unknown","answer":<string|number|null>,"grounding":[<ids>],"conflict":null|{"claimed":<value>,"recorded":<value>}}',
  "status answered: you can determine the value from material available to you; list every record, receipt, or note id you relied on in grounding.",
  "status scope_denied: the material is outside your authenticated visibility; answer must be null.",
  "status unknown: the material is not available to you; answer must be null.",
  "Numbers are plain numbers. Do not add prose outside the JSON object."
].join("\n");

export function renderArmMessages({ arm, testCase, world, procedures = [] }) {
  if (!BUSINESS_MEMORY_ARMS.includes(arm)) throw new Error(`Unknown arm ${arm}`);
  const asker = world.users.find((user) => user.id === testCase.askerId);
  const sections = [];
  if (arm === "alone") {
    sections.push(`The user says they are ${asker.name}, ${asker.role} at ${world.company}.`);
  } else {
    sections.push(renderEnvelope(world, asker));
    sections.push(renderRecords(world, asker));
    sections.push(renderReceipts(world, asker));
    sections.push(renderNotes(world, asker));
  }
  sections.push(renderOwnSessions(world, asker));
  if (arm === "procedures") {
    const selected = selectProcedures({ testCase, procedures });
    sections.push(["## Verified operating procedures", ...selected.map((procedure) => `- [${procedure.id}] ${procedure.statement}`)].join("\n"));
  }
  sections.push(`## Question\nCurrent date: ${world.now.slice(0, 10)}.\n${testCase.question}`);
  const user = sections.filter(Boolean).join("\n\n");
  return [
    { role: "system", content: `You answer questions about ${world.company} for its staff.\n\n${OUTPUT_CONTRACT}` },
    { role: "user", content: user }
  ];
}

function renderEnvelope(world, asker) {
  // The platform catalog knows every collection; the envelope names the ones
  // this principal cannot see so a denial is a fact, not an inference.
  const allCollections = [...new Set([...world.records.map((record) => record.collection), "notes"])].sort();
  const outside = allCollections.filter((collection) => !asker.scopes.includes(collection));
  return [
    "## Authenticated envelope (from AMOS)",
    JSON.stringify({
      company: world.company,
      user: asker.name,
      userId: asker.id,
      role: asker.role,
      scopes: asker.scopes,
      collectionsOutsideScope: outside
    })
  ].join("\n");
}

function renderRecords(world, asker) {
  const visible = world.records.filter((record) => asker.scopes.includes(record.collection));
  const lines = visible.map((record) => JSON.stringify({
    id: record.id,
    collection: record.collection,
    current: current(record),
    revisions: record.revisions.map((revision) => ({
      revision: revision.revision,
      recordedAt: revision.recordedAt,
      recordedBy: revision.recordedBy,
      fields: revision.fields
    }))
  }));
  return ["## Host-recorded records (within your scopes)", ...lines].join("\n");
}

function renderReceipts(world, asker) {
  const visible = world.receipts.filter((item) => asker.scopes.includes(item.target.collection));
  const lines = visible.map((item) => JSON.stringify(item));
  const pending = visible.filter((item) => ["proposed", "approved"].includes(item.lifecycle_state));
  return [
    "## Operation receipts (within your scopes)",
    ...lines,
    "## Pending approvals",
    ...(pending.length ? pending.map((item) => `${item.id} (${item.operation} on ${item.target.recordId})`) : ["none"])
  ].join("\n");
}

function renderNotes(world, asker) {
  const visible = world.notes.filter((note) => asker.scopes.includes(note.collectionTag) && asker.scopes.includes("notes"));
  return ["## Company notes (shared memory within your scopes)", ...(visible.length ? visible.map((note) => JSON.stringify(note)) : ["none"])].join("\n");
}

function renderOwnSessions(world, asker) {
  const own = world.sessions.filter((session) => session.userId === asker.id);
  if (own.length === 0) return "## Your prior sessions\nnone";
  const lines = own.flatMap((session) => [
    `Session ${session.id} on ${session.startedAt.slice(0, 10)}:`,
    ...session.utterances.map((utterance) => `  you: ${utterance.text}`)
  ]);
  return ["## Your prior sessions (what you said)", ...lines].join("\n");
}

// ---------------------------------------------------------------------------
// Helpers

function receipt(ids, { operation, target, actor, field, value, lifecycle, effectApplied, at }) {
  return {
    id: ids.next("rcpt"),
    operation,
    target: { collection: target.collection, recordId: target.id },
    actor,
    lifecycle_state: lifecycle,
    effect_applied: effectApplied,
    inputs: { field, value },
    emitted_at: at,
    result_summary: summaryFor(lifecycle, effectApplied, operation)
  };
}

function summaryFor(lifecycle, effectApplied, operation) {
  if (lifecycle === "failed") return `${operation} failed before any effect was applied.`;
  if (effectApplied === null) return `${operation} was sent but AMOS could not confirm the outcome.`;
  if (effectApplied === true) return `${operation} executed.`;
  return `${operation} is parked pending approval.`;
}

export function executionLabel(receiptRecord) {
  if (receiptRecord.lifecycle_state === "failed") return "failed";
  if (receiptRecord.effect_applied === null) return "uncertain";
  if (receiptRecord.effect_applied === true && receiptRecord.lifecycle_state === "executed") return "executed";
  return "pending_approval";
}

export function current(record) {
  return record.revisions.at(-1).fields;
}

export function valueAsOf(record, field, isoInstant) {
  const cutoff = Date.parse(isoInstant);
  let value = record.revisions[0].fields[field];
  for (const revision of record.revisions) {
    if (Date.parse(revision.recordedAt) <= cutoff) value = revision.fields[field];
  }
  return value;
}

function addRevision(record, dayOffset, recordedBy, change) {
  const previous = current(record);
  record.revisions.push({
    revision: record.revisions.length + 1,
    recordedAt: isoDay(dayOffset),
    recordedBy,
    fields: change(previous)
  });
}

function changedField(record) {
  const latest = current(record);
  const previous = record.revisions.at(-2).fields;
  return Object.keys(latest).find((key) => latest[key] !== previous[key]) ?? null;
}

function numericFields(record) {
  return Object.entries(current(record)).filter(([, value]) => typeof value === "number").map(([key]) => key);
}

function userWithScope(world, collection, rng) {
  const eligible = world.users.filter((user) => user.scopes.includes(collection));
  return rng.pick(eligible);
}

function entityName(record) {
  const fields = current(record);
  if (record.collection === "invoices") return `invoice ${record.id}`;
  return `${fields.name} (${record.id})`;
}

function differentPick(rng, values, exclude) {
  const options = values.filter((value) => value !== exclude);
  return rng.pick(options);
}

function idFactory(rng) {
  const used = new Set();
  return {
    next(prefix) {
      for (;;) {
        const id = `${prefix}-${rng.int(1000, 9999)}`;
        if (!used.has(id)) {
          used.add(id);
          return id;
        }
      }
    }
  };
}

function isoDay(offsetDays, hour = 9) {
  return new Date(BASE_DATE + offsetDays * 86_400_000 + hour * 3_600_000).toISOString();
}

function sameValue(actual, expected) {
  if (typeof expected === "number") {
    const numeric = typeof actual === "number" ? actual : Number(String(actual ?? "").replace(/[,$\s]/g, ""));
    return Number.isFinite(numeric) && Math.abs(numeric - expected) < 1e-6;
  }
  return normalizeText(actual) === normalizeText(expected);
}

function containsValue(serialized, value) {
  const text = normalizeText(value);
  if (!text) return false;
  return serialized.includes(text);
}

function normalizeText(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function formatValue(value) {
  return typeof value === "number" ? String(value) : `"${value}"`;
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function extractJson(text) {
  const source = String(text ?? "").trim();
  if (!source) return { error: "empty answer" };
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  for (const candidate of [fenced?.[1], source]) {
    if (!candidate) continue;
    try {
      return { value: JSON.parse(candidate.trim()) };
    } catch {
      const start = candidate.indexOf("{");
      const end = candidate.lastIndexOf("}");
      if (start !== -1 && end > start) {
        try {
          return { value: JSON.parse(candidate.slice(start, end + 1)) };
        } catch {
          continue;
        }
      }
    }
  }
  return { error: "no JSON object found in answer" };
}

function requirePool(pool) {
  if (!BUSINESS_MEMORY_POOLS.includes(pool)) throw new Error(`pool must be one of ${BUSINESS_MEMORY_POOLS.join(", ")}`);
}

function boundedInteger(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}
