import { digestResearchValue } from "./experimentProtocol.js";
import { createMissionTreatment, EMPTY_PROCEDURE_SNAPSHOT_SHA256 } from "./missionComparisonProtocol.js";

/**
 * Shadow diagnostics: the Organism-side ingestion step between the gateway's
 * shadow log, the Platform's terminal-Mission episodes and Codex's comparison
 * v2. It joins a shadow pair to the Mission it belonged to (missionId +
 * plannerAttempt) and to the Mission's independently checked outcome, and it
 * names the two treatments (base vs adapter) in the comparison-v2 vocabulary.
 *
 * It never produces comparator evidence. A shadow answer was not executed and
 * has no Mission verdict; the report says so in every row. What it does give:
 * agreement and compiled-input parity per Mission turn, which turns were
 * attributable, and the observed task identities a future preregistered paired
 * run can draw from.
 */
export const SHADOW_DIAGNOSTICS_SCHEMA = "amos.shadow-diagnostics";
export const SHADOW_DIAGNOSTICS_VERSION = 1;
const EPISODE_EVENT_TYPES = new Set(["platform.experience-verified", "platform.experience-negative"]);

/** Base and adapter treatments for a ledger candidate; the only changed dimension is weights. */
export function treatmentPairFromCandidate({
  candidate,
  baseModelId,
  baseArtifactSha256,
  adapterArtifactSha256,
  runtimeRevision,
  promptCompilerSha256,
  schedulerPolicySha256,
  inferenceConfigSha256,
  procedureSnapshotSha256 = EMPTY_PROCEDURE_SNAPSHOT_SHA256,
  encoderSha256 = null
}) {
  if (candidate?.schema !== "amos.adapter-candidate") throw new Error("candidate must be an amos.adapter-candidate ledger record");
  const shared = { procedureSnapshotSha256, runtimeRevision, promptCompilerSha256, schedulerPolicySha256, inferenceConfigSha256, encoderSha256 };
  const baseline = createMissionTreatment({ model: { modelId: requiredText(baseModelId, "baseModelId"), baseArtifactSha256, adapter: null }, ...shared });
  const adapter = createMissionTreatment({
    model: {
      modelId: requiredText(baseModelId, "baseModelId"),
      baseArtifactSha256,
      adapter: { artifactSha256: adapterArtifactSha256, uri: candidate.adapterUri, trainingContractSha256: candidate.training.contractDigest }
    },
    ...shared
  });
  return { baseline, candidate: adapter, changedDimensions: ["weights"], candidateId: candidate.id, candidateDigest: candidate.digest };
}

export function parseJsonl(text) {
  return String(text).split("\n").map((line) => line.trim()).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`line ${index + 1} is not JSON`); }
  });
}

/** Join shadow records to Platform episode events. Rows without a Mission or without an episode stay, marked unattributable. */
export function joinShadowWithEpisodes({ shadowRecords, episodeEvents = [], treatments = null, now = new Date(), maxRows = 5000 }) {
  if (!Array.isArray(shadowRecords)) throw new Error("shadowRecords must be an array");
  const episodesByMission = new Map();
  for (const event of episodeEvents) {
    if (!EPISODE_EVENT_TYPES.has(event?.type) || !event?.missionId) continue;
    const list = episodesByMission.get(event.missionId) ?? [];
    list.push(event);
    episodesByMission.set(event.missionId, list);
  }
  const rows = [];
  const seen = new Set();
  for (const record of shadowRecords) {
    if (record?.schema !== "amos.swarm-turn-shadow") continue;
    const mission = record.mission ?? null;
    const missionId = mission?.missionId ?? null;
    const plannerAttempt = mission?.plannerAttempt ?? null;
    const key = missionId ? `${missionId}#${plannerAttempt}#${record.requestDigest}` : `chat#${record.requestDigest}#${record.completedAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const episodes = missionId ? (episodesByMission.get(missionId) ?? []) : [];
    const terminal = episodes.at(-1) ?? null;
    const primaryInput = record.primary?.inputEvidence?.compiledInputSha256 ?? null;
    const shadowInput = record.shadow?.inputEvidence?.compiledInputSha256 ?? null;
    rows.push({
      missionId,
      plannerAttempt,
      tenantId: mission?.tenantId ?? null,
      contractId: mission?.contractId ?? null,
      completedAt: record.completedAt,
      stage: record.stage,
      requestDigest: record.requestDigest,
      primaryModel: record.primary?.model ?? null,
      shadowModel: record.shadow?.model ?? null,
      shadowError: record.shadow?.error ?? null,
      agreement: record.agreement ?? null,
      textCaptured: record.textCaptured === true,
      compiledInputParity: primaryInput && shadowInput ? primaryInput === shadowInput : null,
      compiledInputSha256: shadowInput ?? primaryInput,
      planDecision: mission?.planDecision ?? null,
      episode: terminal
        ? {
          eventId: terminal.id,
          type: terminal.type,
          terminalStatus: terminal.payload?.terminalStatus ?? null,
          verifiedOutcome: terminal.type === "platform.experience-verified",
          hostReceiptId: terminal.hostReceiptId ?? null,
          episodeCount: episodes.length
        }
        : null,
      attribution: !missionId ? "no-mission" : terminal ? "mission-terminal-episode" : "mission-without-episode",
      evidenceClass: "diagnostic-only",
      executedArms: ["primary"],
      comparatorEligible: false
    });
    if (rows.length >= maxRows) break;
  }
  const attributed = rows.filter((row) => row.attribution === "mission-terminal-episode");
  const withAgreement = attributed.filter((row) => row.agreement !== null);
  const parityKnown = rows.filter((row) => row.compiledInputParity !== null);
  const byStatus = {};
  for (const row of attributed) {
    const status = row.episode.terminalStatus ?? "unknown";
    const bucket = byStatus[status] ?? (byStatus[status] = { turns: 0, agree: 0, disagree: 0, shadowErrors: 0 });
    bucket.turns += 1;
    if (row.agreement === true) bucket.agree += 1;
    else if (row.agreement === false) bucket.disagree += 1;
    if (row.shadowError) bucket.shadowErrors += 1;
  }
  const tasksObserved = [...new Map(attributed.map((row) => {
    const source = episodesByMission.get(row.missionId).at(-1).payload?.source ?? {};
    const task = source.task ?? {};
    const taskSha256 = digestResearchValue({ objectiveDigest: task.objectiveDigest ?? null, completionConditionDigest: task.completionConditionDigest ?? null, contractDigest: task.contractDigest ?? null });
    return [taskSha256, { taskSha256, missionId: row.missionId, tenantId: row.tenantId, operationKeys: task.operationKeys ?? [], terminalStatus: row.episode.terminalStatus }];
  })).values()];
  const body = {
    schema: SHADOW_DIAGNOSTICS_SCHEMA,
    version: SHADOW_DIAGNOSTICS_VERSION,
    generatedAt: new Date(now).toISOString(),
    treatments,
    counts: {
      shadowRecords: shadowRecords.length,
      rows: rows.length,
      noMission: rows.filter((row) => row.attribution === "no-mission").length,
      missionWithoutEpisode: rows.filter((row) => row.attribution === "mission-without-episode").length,
      attributed: attributed.length,
      agreementRate: withAgreement.length ? round(withAgreement.filter((row) => row.agreement === true).length / withAgreement.length) : null,
      compiledInputParityRate: parityKnown.length ? round(parityKnown.filter((row) => row.compiledInputParity).length / parityKnown.length) : null,
      shadowErrors: rows.filter((row) => row.shadowError).length,
      textCapturedRows: rows.filter((row) => row.textCaptured).length,
      comparatorEligiblePairs: 0
    },
    agreementByTerminalStatus: byStatus,
    tasksObserved,
    rows,
    interpretation: {
      unexecutedShadowAnswersAreEvidence: false,
      shadowArmExecuted: false,
      comparatorEligibleReason: "a shadow answer was never executed and has no Mission verdict; comparison v2 needs two independently executed arms with host receipts",
      agreementMeaning: "how often the adapter would have proposed the same plan bytes as the served base on the same compiled input; a diagnostic, not a quality claim",
      tasksObservedMeaning: "task identities seen in shadow, usable as candidates for a future preregistered paired run; observing them here does not register anything"
    }
  };
  return { ...body, digest: digestResearchValue(body) };
}

function requiredText(value, label) { const text = String(value ?? "").trim(); if (!text) throw new Error(`${label} is required`); return text; }
function round(value) { return Math.round(value * 10000) / 10000; }
