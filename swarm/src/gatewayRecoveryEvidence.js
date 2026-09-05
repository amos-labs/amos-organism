import { digestResearchValue } from "./experimentProtocol.js";

const SCHEMA = "amos.swarm-recovery-evidence";
const CORRECTION_STAGES = new Set(["critic:recovery", "integrator:recovery", "mission:contract-recovery"]);
const SHA256 = /^[a-f0-9]{64}$/;

/** Accounting for a successfully returned gateway turn, never a whole Mission.
 * Ordinary candidate/critic/integrator calls are planned work. The three explicit
 * repair paths are unexpected corrections, even when their final answer is valid.
 */
export function gatewayRecoverySummary(stages) {
  if (!Array.isArray(stages) || stages.length < 1 || stages.length > 1000) throw Error("Expected bounded gateway stage evidence");
  const seen = new Set();
  const complete = stages.every(s => {
    if (typeof s?.stage !== "string" || seen.has(s.stage)) return false;
    seen.add(s.stage);
    const known = /^candidate:.+$/.test(s.stage) || ["critic", "integrator"].includes(s.stage) || CORRECTION_STAGES.has(s.stage);
    const e = s.inputEvidence;
    return known && e?.schema === "amos.swarm-input-evidence" && e.version === 1 && e.stage === s.stage &&
      isSha(e.compiledInputSha256) && isSha(e.requestPayloadSha256) && isSha(s.messageDigest);
  });
  return {
    schema: SCHEMA, version: 1, scope: "gateway-turn", coverage: complete ? "complete" : "partial",
    unexpectedCorrections: complete ? stages.filter(s => CORRECTION_STAGES.has(s.stage)).length : null,
    requiredRecoveries: complete ? 0 : null,
    corrections: complete ? stages.filter(s => CORRECTION_STAGES.has(s.stage)).map(s => ({
      stage: s.stage, compiledInputSha256: s.inputEvidence.compiledInputSha256,
      requestPayloadSha256: s.inputEvidence.requestPayloadSha256, outputMessageSha256: s.messageDigest
    })) : []
  };
}

/** Recompute returned metadata from the full trace. The host must authenticate
 * that trace; hashing does not prove which service ran it. Older traces cannot
 * acquire complete recovery coverage merely by having an output or input digest.
 */
export function gatewayRecoveryEvidenceFromTrace(input) {
  const trace = structuredClone(input);
  if (trace?.schema !== "amos.swarm-turn-gateway-trace" || trace.version !== 1) throw Error("Expected a gateway trace");
  const { digest, ...body } = trace;
  if (!isSha(digest) || digestResearchValue(body) !== digest) throw Error("Gateway trace digest mismatch");
  if (!isSha(trace.requestDigest)) throw Error("Missing gateway request identity");
  let summary;
  if (trace.recoveryEvidence === undefined) {
    summary = { schema: SCHEMA, version: 1, scope: "gateway-turn", coverage: "unknown", unexpectedCorrections: null, requiredRecoveries: null, corrections: [] };
  } else {
    summary = gatewayRecoverySummary(trace.stages);
    if (digestResearchValue(summary) !== digestResearchValue(trace.recoveryEvidence)) throw Error("Gateway recovery summary does not match stage evidence");
  }
  const m = trace.mission;
  const evidence = { ...summary, traceDigest: digest, requestDigest: trace.requestDigest,
    mission: m ? { tenantId: m.tenantId ?? null, missionId: m.missionId ?? null, contractId: m.contractId ?? null, plannerAttempt: m.plannerAttempt ?? null } : null,
    evidenceRefs: [`gateway-trace:${digest}`]
  };
  return { ...evidence, digest: digestResearchValue(evidence) };
}

function isSha(value) { return typeof value === "string" && SHA256.test(value); }
