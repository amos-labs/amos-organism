import test from "node:test";
import assert from "node:assert/strict";
import { digestResearchValue } from "../src/experimentProtocol.js";
import { gatewayRecoverySummary, gatewayRecoveryEvidenceFromTrace } from "../src/gatewayRecoveryEvidence.js";

function stages(names = ["candidate:primary", "candidate:alternative", "critic", "critic:recovery", "integrator", "integrator:recovery", "mission:contract-recovery"]) {
  return names.map(stage => ({ stage, messageDigest: digestResearchValue({ output: stage }), inputEvidence: {
    schema: "amos.swarm-input-evidence", version: 1, stage,
    compiledInputSha256: digestResearchValue({ input: stage }), requestPayloadSha256: digestResearchValue({ request: stage })
  } }));
}
function seal(body) { const { digest, ...rest } = body; return { ...rest, digest: digestResearchValue(rest) }; }
function trace() {
  const observations = stages();
  return seal({ schema: "amos.swarm-turn-gateway-trace", version: 1, stages: observations,
    requestDigest: "a".repeat(64), mission: null, recoveryEvidence: gatewayRecoverySummary(observations) });
}

test("all three internal repair paths count while ordinary Swarm work does not", () => {
  const evidence = gatewayRecoveryEvidenceFromTrace(trace());
  assert.equal(evidence.coverage, "complete");
  assert.equal(evidence.unexpectedCorrections, 3);
  assert.deepEqual(evidence.corrections.map(c => c.stage), ["critic:recovery", "integrator:recovery", "mission:contract-recovery"]);
  assert.equal(gatewayRecoverySummary(stages(["candidate:primary", "candidate:alternative", "critic", "integrator"])).unexpectedCorrections, 0);
});

test("legacy input evidence alone never upgrades to complete recovery accounting", () => {
  const old = trace(); delete old.recoveryEvidence;
  const evidence = gatewayRecoveryEvidenceFromTrace(seal(old));
  assert.equal(evidence.coverage, "unknown");
  assert.equal(evidence.unexpectedCorrections, null);
  assert.equal(evidence.requiredRecoveries, null);
  assert.equal(evidence.scope, "gateway-turn");
});

test("incomplete or unsupported stage evidence remains partial, never zero", () => {
  for (const change of [s => { delete s[0].inputEvidence; }, s => { s[0].inputEvidence.version = 2; }, s => { s[0].inputEvidence.stage = "other"; }, s => { s[0].stage = "unaccounted-stage"; }, s => { s[0].messageDigest = null; }, s => { s.push(s[0]); }]) {
    const observations = stages(); change(observations);
    const summary = gatewayRecoverySummary(observations);
    assert.equal(summary.coverage, "partial");
    assert.equal(summary.unexpectedCorrections, null);
  }
  assert.throws(() => gatewayRecoverySummary([]), /bounded gateway/);
});

test("a rehashed zero-correction claim cannot override its actual stage records", () => {
  const forged = trace(); forged.recoveryEvidence.unexpectedCorrections = 0;
  assert.throws(() => gatewayRecoveryEvidenceFromTrace(seal(forged)), /does not match stage evidence/);
  assert.throws(() => gatewayRecoveryEvidenceFromTrace({ ...trace(), digest: "f".repeat(64) }), /digest mismatch/);
});
