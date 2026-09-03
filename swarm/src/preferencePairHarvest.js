import { digestResearchValue } from "./experimentProtocol.js";
import { createAmosSystemTrainingExample } from "./amosNativeTrainingDataset.js";
import { createSwarmLearningEpisode } from "./swarmLearningArena.js";

/**
 * Harvest verified training signal from graded model attempts.
 *
 * A first attempt the verifier rejected followed by a repair the verifier
 * accepted is a preference pair from the same prompt. A first-attempt pass is
 * a verified answer. Nothing here is graded by a model; every chosen answer
 * carries the verifier receipt that accepted it, and every rejected answer the
 * receipt that refused it.
 */

export const HARVESTED_PAIR_SCHEMA = "amos.harvested-preference-pair";
export const HARVEST_MANIFEST_SCHEMA = "amos.preference-harvest-manifest";
export const HARVEST_VERSION = 1;

const MISSION_SYSTEM = [
  "You are the AMOS governed system-competence substrate.",
  "Answer the mission from the supplied context only.",
  "Never invent authority, credentials, receipts, tool results, or hidden reasoning."
].join(" ");

/** Pairs and verified answers from a curriculum grading report. */
export function harvestCurriculumGrading({ report, scenariosById }) {
  const pairs = [];
  const verifiedAnswers = [];
  for (const run of report.runs) {
    const scenario = scenariosById.get(run.scenarioId);
    if (!scenario) throw new Error(`Grading run references unknown scenario ${run.scenarioId}`);
    if (scenario.digest !== run.scenarioDigest) throw new Error(`Scenario ${run.scenarioId} digest drifted`);
    if (scenario.pool !== "training") continue;
    const first = run.attempts[0];
    const last = run.attempts.at(-1);
    if (!last.verification.passed) continue;
    const base = {
      source: "curriculum-grading",
      modelId: report.modelId,
      reportDigest: report.digest,
      scenarioId: scenario.id,
      scenarioDigest: scenario.digest,
      family: scenario.family,
      role: scenario.role,
      targetKind: scenario.targetKind,
      prompt: { system: scenario.prompt.system, user: scenario.prompt.user },
      chosen: { text: last.answerText, verificationDigest: last.verification.digest }
    };
    if (run.recovered) {
      pairs.push(withDigest({
        schema: HARVESTED_PAIR_SCHEMA,
        version: HARVEST_VERSION,
        kind: "recovered-pair",
        ...base,
        rejected: {
          text: first.answerText,
          verificationDigest: first.verification.digest,
          failures: first.verification.failures
        }
      }));
    } else {
      verifiedAnswers.push(withDigest({
        schema: HARVESTED_PAIR_SCHEMA,
        version: HARVEST_VERSION,
        kind: "verified-answer",
        ...base,
        rejected: null
      }));
    }
  }
  return { pairs, verifiedAnswers };
}

/** Pairs from a real-Qwen phase probe report: attempt one failed, attempt two passed. */
export function harvestPhaseProbePairs({ report, missionsById }) {
  const pairs = [];
  for (const run of report.runs) {
    if (run.attempts.length < 2) continue;
    const [first, second] = run.attempts;
    if (first.verifierReceipt.passed || !second.verifierReceipt.passed) continue;
    const mission = missionsById.get(run.missionId);
    if (!mission) throw new Error(`Phase probe run references unknown mission ${run.missionId}`);
    pairs.push(withDigest({
      schema: HARVESTED_PAIR_SCHEMA,
      version: HARVEST_VERSION,
      kind: "recovered-pair",
      source: "phase-probe",
      modelId: report.candidateId === run.regimeId ? `qwen:${run.regimeId}` : `qwen:${run.regimeId}`,
      reportDigest: report.digest,
      scenarioId: `${run.regimeId}:${mission.id}`,
      scenarioDigest: digestResearchValue({ mission, regime: run.regimeId }),
      family: mission.family || "amos-owned-mission",
      role: "mission-operator",
      targetKind: "verified-synthesis",
      prompt: { system: MISSION_SYSTEM, user: missionPrompt(mission) },
      chosen: { text: second.answer, verificationDigest: second.verifierReceipt.digest },
      rejected: {
        text: first.answer,
        verificationDigest: first.verifierReceipt.digest,
        failures: first.verifierReceipt.failedCriterionIds.map((id) => `criterion ${id} failed`)
      }
    }));
  }
  return { pairs, verifiedAnswers: [] };
}

/**
 * Record harvested items as training-eligible episodes. Preference pairs carry
 * the rejected answer as the example correction, so the dataset compiler emits
 * them into the preference split automatically.
 */
export async function recordHarvestedPairs({
  store,
  items,
  treatmentId = "amos-native-harvested-pairs-v1",
  sourceClass = "internal-authorized",
  generatedAt = new Date()
}) {
  if (!store || typeof store.putBlob !== "function" || typeof store.recordEpisode !== "function") {
    throw new Error("An open swarm learning store is required");
  }
  const episodeDigests = [];
  let recorded = 0;
  let skippedDuplicates = 0;
  for (const [position, item] of items.entries()) {
    validateHarvestedItem(item);
    const episodeId = `harvest-${item.source}-${item.digest.slice(0, 24)}`;
    if (await hasEpisode(store, episodeId)) { skippedDuplicates += 1; continue; }
    const example = createAmosSystemTrainingExample({
      id: `${episodeId}-example`,
      sourceEpisodeId: episodeId,
      taskFamily: item.family,
      role: item.role,
      input: item.prompt,
      target: { kind: item.targetKind, content: item.chosen.text },
      ...(item.rejected ? {
        correction: {
          rejectedContent: item.rejected.text,
          verifierSignal: `Independent verifier rejected this answer: ${item.rejected.failures.join("; ")}`
        }
      } : {}),
      safeguards: {
        credentialsRemoved: true,
        tenantFactsRemoved: true,
        hiddenReasoningExcluded: true,
        independentVerifierSelected: true,
        licensedForTraining: true
      }
    });
    const exampleDigest = await store.putBlob(`${JSON.stringify(example)}\n`);
    const itemDigest = await store.putBlob(`${JSON.stringify(item)}\n`);
    const ecology = { schema: "amos.harvest-ecology-receipt", version: 1, source: item.source, modelId: item.modelId, assignments: [{ role: item.role, status: "verified" }] };
    const ecologyDigest = await store.putBlob(`${JSON.stringify(ecology)}\n`);
    const started = new Date(new Date(generatedAt).getTime() + position * 1_000);
    const episode = createSwarmLearningEpisode({
      id: episodeId,
      treatmentId,
      partition: "operations",
      task: { source: `amos-${item.source}`, name: item.family, ref: item.scenarioId, checksum: item.scenarioDigest },
      model: { provider: "amos", name: item.modelId, agent: "amos-graded-substrate", agentVersion: "1", sharedBackbone: true },
      execution: { status: "completed", startedAt: started.toISOString(), finishedAt: new Date(started.getTime() + 1_000).toISOString(), exception: null },
      verifier: {
        kind: item.source === "phase-probe" ? "candidate-independent-amos-owned-concept-verifier" : "amos-executable-contract-verifier",
        status: "passed",
        score: 1,
        evidenceRefs: [`verification:${item.chosen.verificationDigest}`, ...(item.rejected ? [`verification:${item.rejected.verificationDigest}`] : [])]
      },
      artifacts: [{ ref: `blob:sha256:${itemDigest}/harvested.json`, kind: "amos-harvested-pair", status: "collected", digest: itemDigest }],
      traces: [{ ref: `blob:sha256:${exampleDigest}/example.json`, kind: "amos-system-training-example", status: "collected", digest: exampleDigest }],
      ecology: { ref: `blob:sha256:${ecologyDigest}/ecology.json`, digest: ecologyDigest, status: "completed", agentCount: 1, assignmentCount: 1 },
      curriculumSignals: [item.family, item.kind, `source:${item.source}`],
      dataPolicy: {
        sourceClass,
        permittedUses: ["evaluation", "research", "training"],
        trainingApproved: true,
        contaminationTags: ["amos-owned", `harvest:${item.source}`, `model:${item.modelId}`]
      }
    });
    const stored = await store.recordEpisode(episode);
    episodeDigests.push(stored.digest);
    recorded += 1;
  }
  const base = {
    schema: HARVEST_MANIFEST_SCHEMA,
    version: HARVEST_VERSION,
    treatmentId,
    recorded,
    skippedDuplicates,
    pairs: items.filter(({ kind }) => kind === "recovered-pair").length,
    verifiedAnswers: items.filter(({ kind }) => kind === "verified-answer").length,
    episodeDigests: episodeDigests.sort()
  };
  return { ...base, digest: digestResearchValue(base) };
}

export function validateHarvestedItem(input) {
  const item = input;
  if (item?.schema !== HARVESTED_PAIR_SCHEMA || item?.version !== HARVEST_VERSION) throw new Error("Unsupported harvested item");
  if (!["recovered-pair", "verified-answer"].includes(item.kind)) throw new Error("Unsupported harvested item kind");
  if (!item.chosen?.text || !/^[a-f0-9]{64}$/.test(item.chosen?.verificationDigest || "")) throw new Error("Harvested item requires a verified chosen answer");
  if (item.kind === "recovered-pair" && (!item.rejected?.text || !Array.isArray(item.rejected.failures) || item.rejected.failures.length === 0)) {
    throw new Error("A recovered pair requires a rejected answer with verifier failures");
  }
  if (item.kind === "recovered-pair" && item.rejected.text === item.chosen.text) throw new Error("A pair cannot prefer an answer over itself");
  const { digest, ...rest } = item;
  if (digestResearchValue(rest) !== digest) throw new Error("Harvested item digest does not match");
  return item;
}

async function hasEpisode(store, id) {
  if (typeof store.hasEpisode === "function") return store.hasEpisode(id);
  const episodes = await store.listEpisodes();
  return episodes.some((episode) => episode.id === id);
}

function missionPrompt(mission) {
  return [
    `Mission: ${mission.objective}`,
    `Context: ${mission.context}`,
    "Success criteria:",
    ...(mission.successCriteria || []).map((criterion, index) => `${index + 1}. ${criterion}`),
    "Answer with the reconciled result and cite the controlling source."
  ].join("\n");
}

function withDigest(value) {
  return { ...value, digest: digestResearchValue(value) };
}
