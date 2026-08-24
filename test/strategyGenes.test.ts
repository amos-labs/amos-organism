import assert from "node:assert/strict";
import test from "node:test";
import { StrategyGeneArchive, type StrategyGeneSpec } from "../src/strategyGenes.ts";
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
