#!/usr/bin/env node
// Regenerate the learning-selection-snapshot compatibility fixtures consumed by
// the Platform (resume_company.procedures) and the gateway compiler.
//   node scripts/generateLearningSelectionSnapshotFixture.ts
import { writeFileSync } from "node:fs";
import { createLearningSelectionSnapshot, emptyLearningSelectionSnapshot } from "../src/learningSelectionSnapshot.ts";
import { digest } from "../src/digest.ts";

const fixtures = new URL("../test/fixtures/", import.meta.url);
const runtimes = [
  { modelId: "amos-qwen38-27b-fp8", adapterArtifactSha256: null, runtimeRevision: "e31eb568681d3a718b7aaa5ce646b6711494b186" },
  { modelId: "stage1-implicit-r32-s3", adapterArtifactSha256: "2a08c46b3c6bcc0ab6df79a0d71374481eb46360ebacd6950eac43cea20d0e32", runtimeRevision: "e31eb568681d3a718b7aaa5ce646b6711494b186" }
];
const common = { generatedAt: "2026-09-05T20:00:00.000Z", sourceChainDigest: digest({ fixture: "learning-selection-snapshot", chain: "empty-event-chain" }), compatibleRuntimes: runtimes, permittedUseScope: ["strategy_learning"] };

const populated = createLearningSelectionSnapshot({
  ...common,
  id: "snapshot-fixture-populated-v1",
  tokenBound: 2048,
  procedures: [
    {
      id: "gene:recover-reserved-tool-boundary",
      version: 1,
      digest: digest({ gene: "recover-reserved-tool-boundary", v: 1 }),
      guidance: "guide",
      applicability: { phases: ["execute", "recover"], artifactClasses: ["tool-call"], failureModes: ["authority-boundary"], toolFamilies: ["finance"], roles: ["planner"], tenantScope: "any" },
      contentRef: `gene:recover-reserved-tool-boundary@${digest({ gene: "recover-reserved-tool-boundary", v: 1 })}`,
      tokens: 180,
      evidence: { verifiedPasses: 7, verifiedFailures: 1, uncreditedAttempts: 2, meanVerifiedQuality: 0.91, lastVerifiedAt: "2026-09-05T10:35:00.000Z" }
    },
    {
      id: "gene:replay-completed-effect",
      version: 2,
      digest: digest({ gene: "replay-completed-effect", v: 2 }),
      guidance: "avoid",
      applicability: { phases: ["execute"], artifactClasses: ["tool-call"], failureModes: ["duplicate-effect"], toolFamilies: [], roles: ["planner"], tenantScope: "any" },
      contentRef: `gene:replay-completed-effect@${digest({ gene: "replay-completed-effect", v: 2 })}`,
      tokens: 96,
      evidence: { verifiedPasses: 0, verifiedFailures: 4, uncreditedAttempts: 0, meanVerifiedQuality: null, lastVerifiedAt: "2026-09-04T22:10:00.000Z" }
    }
  ]
});
const empty = emptyLearningSelectionSnapshot({ ...common, id: "snapshot-fixture-empty-v1" });

writeFileSync(new URL("learning-selection-snapshot.v1.json", fixtures), `${JSON.stringify(populated, null, 2)}\n`);
writeFileSync(new URL("learning-selection-snapshot.empty.v1.json", fixtures), `${JSON.stringify(empty, null, 2)}\n`);
console.log(`populated ${populated.digest.slice(0, 16)} procedureSnapshot ${populated.procedureSnapshotSha256.slice(0, 16)}; empty procedureSnapshot ${empty.procedureSnapshotSha256}`);
