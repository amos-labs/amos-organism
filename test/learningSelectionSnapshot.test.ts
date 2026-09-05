import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  createLearningSelectionSnapshot,
  EMPTY_PROCEDURE_SNAPSHOT_SHA256,
  emptyLearningSelectionSnapshot,
  procedureFromStrategyGene,
  validateLearningSelectionSnapshot,
} from "../src/learningSelectionSnapshot.ts";
import { digest } from "../src/digest.ts";
// The sentinel Codex documents for comparison v2 treatments (docs/swarm/VERIFIED_MISSION_COMPARISON.md).
const COMPARATOR_SENTINEL = "3729e785172fb2d92b3a51f2d2f0efc409540291fd0497a569aaa2baefeadde3";
import type { GeneOutcome, StrategyGene } from "../src/strategyGenes.ts";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

test("the empty snapshot carries the same sentinel the comparator's treatments use, byte for byte", () => {
  assert.equal(EMPTY_PROCEDURE_SNAPSHOT_SHA256, COMPARATOR_SENTINEL);
  const empty = validateLearningSelectionSnapshot(fixture("learning-selection-snapshot.empty.v1.json"));
  assert.equal(empty.procedureSnapshotSha256, COMPARATOR_SENTINEL);
  assert.deepEqual(empty.procedures, []);
});

test("the populated fixture validates, is digest-stable, and refuses tampering", () => {
  const raw = fixture("learning-selection-snapshot.v1.json") as Record<string, unknown>;
  const snapshot = validateLearningSelectionSnapshot(raw);
  assert.equal(snapshot.procedures.length, 2);
  assert.deepEqual(snapshot.procedures.map((procedure) => procedure.guidance), ["guide", "avoid"]);
  assert.notEqual(snapshot.procedureSnapshotSha256, EMPTY_PROCEDURE_SNAPSHOT_SHA256);
  const tampered = { ...raw, procedures: [(raw.procedures as unknown[])[0]] };
  assert.throws(() => validateLearningSelectionSnapshot(tampered), /procedureSnapshotSha256/);
  const evidenceEdit = structuredClone(raw) as { procedures: Array<{ evidence: { verifiedPasses: number } }> };
  evidenceEdit.procedures[0]!.evidence.verifiedPasses = 700;
  assert.throws(() => validateLearningSelectionSnapshot(evidenceEdit), /digest/);
});

test("procedure order does not change identity and the token bound is enforced", () => {
  const base = validateLearningSelectionSnapshot(fixture("learning-selection-snapshot.v1.json"));
  const reversed = createLearningSelectionSnapshot({ ...base, procedures: [...base.procedures].reverse() });
  assert.equal(reversed.digest, base.digest);
  assert.throws(() => createLearningSelectionSnapshot({ ...base, tokenBound: 100 }), /tokenBound/);
  assert.throws(() => createLearningSelectionSnapshot({ ...base, compatibleRuntimes: [] }), /compatibleRuntimes/);
});

test("strategy genes map to procedures only with verified outcomes; all-fail becomes avoid", () => {
  const gene: StrategyGene = {
    id: "gene-1",
    digest: digest({ gene: 1 }),
    parentIds: [],
    approvedByReceiptId: "receipt-1",
    createdAt: "2026-09-01T00:00:00.000Z",
    name: "recover from reserved tool",
    preconditions: { phases: ["recover"], artifactClasses: ["tool-call"], failureModes: ["authority-boundary"], toolFamilies: ["finance"] },
    rolePolicy: { planner: ["propose"] },
    retrievalRecipe: ["look up the reserved tool's replacement"],
    procedure: ["request the boundary change", "retry with the allowed verb"],
    stopConditions: ["verifier passes"],
    rightsTags: ["amos-owned"],
    contaminationTags: []
  };
  const outcome = (verifierOutcome: GeneOutcome["verifierOutcome"], quality: number): GeneOutcome => ({ geneId: gene.id, missionId: "m", verifiedQuality: quality, fitnessVested: 0, verifierOutcome, receiptId: "r" });
  assert.equal(procedureFromStrategyGene(gene, [outcome("uncredited", 0)]), null);
  const guide = procedureFromStrategyGene(gene, [outcome("pass", 0.8), outcome("pass", 1), outcome("uncredited", 0)]);
  assert.equal(guide?.guidance, "guide");
  assert.equal(guide?.evidence.meanVerifiedQuality, 0.9);
  assert.equal(guide?.evidence.uncreditedAttempts, 1);
  assert.deepEqual(guide?.applicability.roles, ["planner"]);
  const avoid = procedureFromStrategyGene(gene, [outcome("fail", 0), outcome("fail", 0)]);
  assert.equal(avoid?.guidance, "avoid");
  assert.equal(avoid?.evidence.meanVerifiedQuality, null);
  const snapshot = emptyLearningSelectionSnapshot({ id: "s", generatedAt: new Date("2026-09-05T20:00:00Z"), sourceChainDigest: digest({}), compatibleRuntimes: [{ modelId: "m", adapterArtifactSha256: null, runtimeRevision: "abc" }], permittedUseScope: ["strategy_learning"] });
  assert.equal(snapshot.tokenBound, 0);
});
