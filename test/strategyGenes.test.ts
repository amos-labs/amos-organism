import assert from "node:assert/strict";
import test from "node:test";
import { StrategyGeneArchive, type StrategyGeneSpec } from "../src/strategyGenes.ts";
import { MemoryEventStore } from "../src/eventStore.ts";
import { AllowListHostGate, receipt } from "./helpers.ts";

const base: StrategyGeneSpec = {
  name: "deliver-first",
  preconditions: {
    phases: ["construction"],
    artifactClasses: ["document"],
    failureModes: [],
    toolFamilies: ["editor"],
  },
  rolePolicy: { builder: ["editor"] },
  retrievalRecipe: ["read contract"],
  procedure: ["create required artifact", "validate artifact"],
  stopConditions: ["verifier passes"],
  rightsTags: ["amos-owned"],
  contaminationTags: [],
};

test("strategy genes are content-addressed and preserve mutation lineage", () => {
  const gate = new AllowListHostGate();
  const archive = new StrategyGeneArchive(gate);
  const firstReceipt = gate.allow(receipt("gene-1-r", "m1", "gene-approved"));
  const first = archive.register(base, [], firstReceipt);
  const repeated = archive.register(base, [], firstReceipt);
  assert.equal(repeated.id, first.id);

  const mutationReceipt = gate.allow(receipt("gene-2-r", "m2", "gene-approved"));
  const mutation = archive.register(
    { ...base, procedure: [...base.procedure, "repair only verifier-cited gaps"] },
    [first.id],
    mutationReceipt,
  );
  assert.notEqual(mutation.id, first.id);
  assert.deepEqual(mutation.parentIds, [first.id]);
});

test("novelty protects an archive slot but does not alter fitness", () => {
  const gate = new AllowListHostGate();
  const archive = new StrategyGeneArchive(gate);
  const r = gate.allow(receipt("genes", "m", "gene-approved"));
  const strong = archive.register(base, [], r);
  const similar = archive.register({ ...base, name: "similar", procedure: [...base.procedure, "stop"] }, [], r);
  const novel = archive.register(
    { ...base, name: "novel", procedure: ["challenge assumptions", "construct independent proof"] },
    [],
    r,
  );
  const retained = archive.retentionSet(
    { [strong.id]: 10, [similar.id]: 9, [novel.id]: 0 },
    2,
    1,
  );
  assert.equal(retained[0], strong.id);
  assert.equal(retained[1], novel.id);
});

test("mission context selects, expresses, and mutates reusable genes without self-grading", () => {
  const gate = new AllowListHostGate();
  const archive = new StrategyGeneArchive(gate);
  const approved = gate.allow(receipt("gene", "seed", "gene-approved"));
  const matching = archive.register(base, [], approved);
  archive.register({
    ...base,
    name: "unrelated",
    preconditions: { ...base.preconditions, phases: ["planning"] },
  }, [], approved);
  const context = {
    missionId: "mission-2",
    role: "builder",
    phase: "construction",
    artifactClasses: ["document"],
    failureModes: [],
    toolFamilies: ["editor"],
  };

  assert.deepEqual(archive.select(context).map(({ gene }) => gene.id), [matching.id]);
  const expression = archive.express(
    context,
    gate.allow(receipt("express", "mission-2", "gene-expressed")),
  );
  assert.deepEqual(expression.selections.map(({ geneId }) => geneId), [matching.id]);
  assert.equal(archive.requireExpressed(expression.id, matching.id, "mission-2").id, expression.id);
  const variations = archive.generateVariations(context, 3);
  assert.ok(variations.length >= 2);
  assert.ok(variations.every(({ researchOnly }) => researchOnly));
  assert.ok(variations.every(({ parentIds }) => parentIds.includes(matching.id)));
  assert.equal(archive.list().length, 2, "variation proposals are not self-admitted");
});

test("the verified event chain rehydrates genes, expressions, and outcomes", () => {
  const gate = new AllowListHostGate();
  const source = new StrategyGeneArchive(gate);
  const geneReceipt = gate.allow(receipt("gene", "seed", "gene-approved"));
  const gene = source.register(base, [], geneReceipt);
  const context = {
    missionId: "mission-3",
    role: "builder",
    phase: "construction",
    artifactClasses: ["document"],
    failureModes: [],
    toolFamilies: ["editor"],
  };
  const expression = source.express(
    context,
    gate.allow(receipt("express", "mission-3", "gene-expressed")),
  );
  const outcome = source.recordOutcome(
    {
      geneId: gene.id,
      missionId: "mission-3",
      verifiedQuality: 0.8,
      fitnessVested: 4,
      verifierOutcome: "pass",
    },
    gate.allow(receipt("verified", "mission-3", "official-verification")),
  );
  const store = new MemoryEventStore();
  store.append({
    id: "gene-event",
    type: "gene.admitted",
    missionId: "seed",
    occurredAt: gene.createdAt,
    authority: "host",
    hostReceiptId: geneReceipt.id,
    payload: { gene },
  });
  store.append({
    id: "expression-event",
    type: "gene.expressed",
    missionId: "mission-3",
    occurredAt: expression.expressedAt,
    authority: "host",
    payload: { expression },
  });
  store.append({
    id: "outcome-event",
    type: "gene.outcome-recorded",
    missionId: "mission-3",
    occurredAt: "2026-08-24T00:00:00.000Z",
    authority: "host",
    payload: { outcome },
  });

  const restored = new StrategyGeneArchive(gate);
  restored.replay(store.events());
  assert.deepEqual(restored.list(), [gene]);
  assert.deepEqual(restored.expressions("mission-3"), [expression]);
  assert.deepEqual(restored.outcomes(gene.id), [outcome]);
  assert.equal(restored.select(context)[0]?.gene.id, gene.id);
});
