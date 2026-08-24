import assert from "node:assert/strict";
import test from "node:test";
import { CausalGraph } from "../src/causalGraph.ts";
import { AllowListHostGate, receipt } from "./helpers.ts";

test("duplicate or invalidated contributions are ineligible for settlement", () => {
  const gate = new AllowListHostGate();
  const graph = new CausalGraph(gate);
  for (const id of ["original", "duplicate"]) {
    graph.addContribution({
      id,
      missionId: "m",
      kind: "contribution",
      actorId: id,
      geneId: `gene-${id}`,
      createdAt: "2026-08-24T00:00:00Z",
      authority: "organism",
    });
  }
  const artifactReceipt = gate.allow(receipt("artifact-r", "m", "artifact-harvested"));
  graph.addHostNode(
    {
      id: "artifact",
      missionId: "m",
      kind: "artifact",
      receiptId: artifactReceipt.id,
      createdAt: artifactReceipt.issuedAt,
      authority: "host",
    },
    artifactReceipt,
  );
  for (const sourceId of ["original", "duplicate"]) {
    graph.addHostEdge(
      {
        id: `produced-${sourceId}`,
        missionId: "m",
        sourceId,
        targetId: "artifact",
        kind: "produced",
        receiptId: artifactReceipt.id,
        authority: "host",
      },
      artifactReceipt,
    );
  }
  graph.addHostEdge(
    {
      id: "duplicate-edge",
      missionId: "m",
      sourceId: "duplicate",
      targetId: "original",
      kind: "duplicate-of",
      receiptId: artifactReceipt.id,
      authority: "host",
    },
    artifactReceipt,
  );
  const verifyReceipt = gate.allow(receipt("verify-r", "m", "official-verification"));
  graph.addHostNode(
    {
      id: "verifier",
      missionId: "m",
      kind: "verifier",
      receiptId: verifyReceipt.id,
      outcome: "pass",
      createdAt: verifyReceipt.issuedAt,
      authority: "host",
    },
    verifyReceipt,
  );
  graph.addHostEdge(
    {
      id: "citation",
      missionId: "m",
      sourceId: "artifact",
      targetId: "verifier",
      kind: "cited",
      receiptId: verifyReceipt.id,
      authority: "host",
    },
    verifyReceipt,
  );
  assert.deepEqual(graph.eligibleContributions("verifier"), ["original"]);
});
