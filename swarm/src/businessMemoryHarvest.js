import { digestResearchValue } from "./experimentProtocol.js";
import { runResearchInference } from "./modelScaffold.js";
import {
  BUSINESS_MEMORY_PROCEDURE_SCHEMA,
  BUSINESS_MEMORY_VERSION,
  gradeBusinessMemoryAnswerText,
  renderArmMessages
} from "./businessMemoryBenchmark.js";
import { visibleText } from "./businessMemoryGrading.js";

/**
 * Harvest procedural memory from graded failures.
 *
 * For every memory-arm case the model failed, offer one repair attempt whose
 * feedback is the verifier's failure list, never the target. When the repair
 * passes, ask the model to state the general rule it should have applied, with
 * no ids, names, or values. Each candidate rule is then admitted only if adding
 * it alone to the procedures arm produces paired wins and no paired losses on
 * its family's cases in the same (development) pool. Admitted procedures carry
 * lineage back to the case, the repair, and the evaluation that vested them.
 */

export const BUSINESS_MEMORY_PROCEDURE_STORE_SCHEMA = "amos.business-memory-procedure-store";
export const BUSINESS_MEMORY_HARVEST_VERSION = 1;

const ID_PATTERN = /\b[a-z]+-\d{4}\b/i;
const NUMBER_PATTERN = /\b\d{3,}\b/;
const MAX_RULE_WORDS = 45;
const MIN_RULE_WORDS = 6;

export async function harvestBusinessMemoryProcedures({
  worker,
  manifest,
  memoryRuns,
  maxOutputTokens = 600,
  jsonMode = false,
  now = () => new Date(),
  signal = null,
  onEvent = null
}) {
  if (!worker || typeof worker.runCase !== "function") throw new Error("Harvest requires a research worker");
  if (!manifest?.cases?.length) throw new Error("Harvest requires a manifest with cases");
  if (manifest.pool === "holdout") throw new Error("Procedures are never harvested from the holdout pool");
  if (!Array.isArray(memoryRuns)) throw new Error("Harvest requires the memory-arm runs to learn from");
  const worlds = new Map(manifest.worlds.map((world) => [world.id, world]));
  const casesById = new Map(manifest.cases.map((testCase) => [testCase.id, testCase]));
  const startedAt = now().toISOString();
  const emit = (event) => { if (onEvent) onEvent(event); };

  // 1. Repair failures and elicit rules.
  const candidates = [];
  const repairs = [];
  for (const run of memoryRuns.filter((item) => item.arm === "memory" && !item.passed)) {
    if (signal?.aborted) break;
    const testCase = casesById.get(run.caseId);
    const world = worlds.get(testCase.worldId);
    const messages = renderArmMessages({ arm: "memory", testCase, world, procedures: [] });
    const repairMessages = [
      ...messages,
      { role: "assistant", content: run.answerText || "{}" },
      {
        role: "user",
        content:
          "The verifier rejected that answer for these reasons:\n" +
          run.failures.map((failure) => `- ${failure}`).join("\n") +
          "\nReturn a corrected JSON object in the same contract and nothing else."
      }
    ];
    const repaired = await runResearchInference({
      worker,
      caseId: `${testCase.id}::repair`,
      messages: repairMessages,
      dataManifestDigest: manifest.digest,
      maxOutputTokens,
      answerReserveTokens: Math.max(96, Math.floor(maxOutputTokens / 4)),
      responseFormat: jsonMode ? { type: "json_object" } : null,
      signal
    });
    const repairText = visibleText(repaired.message);
    const verification = gradeBusinessMemoryAnswerText({ testCase, world, text: repairText });
    const repairRecord = {
      caseId: testCase.id,
      family: testCase.family,
      originalFailures: run.failures,
      repaired: verification.passed,
      remainingFailures: verification.failures
    };
    repairs.push(repairRecord);
    emit({ kind: "repair", ...repairRecord });
    if (!verification.passed) continue;

    const ruleMessages = [
      ...repairMessages,
      { role: "assistant", content: repairText },
      {
        role: "user",
        content:
          "State the general rule you should have applied from the start, as one sentence of at most " +
          `${MAX_RULE_WORDS} words. Do not mention any specific id, name, date, or amount. ` +
          'Return only JSON: {"rule":"<sentence>"}'
      }
    ];
    const elicited = await runResearchInference({
      worker,
      caseId: `${testCase.id}::rule`,
      messages: ruleMessages,
      dataManifestDigest: manifest.digest,
      maxOutputTokens: 400,
      answerReserveTokens: 128,
      responseFormat: jsonMode ? { type: "json_object" } : null,
      signal
    });
    const rule = extractRule(visibleText(elicited.message));
    const rejection = rejectRule(rule);
    emit({ kind: "rule", caseId: testCase.id, rule, rejection });
    if (rejection) {
      candidates.push({ statement: rule, sourceCaseId: testCase.id, family: testCase.family, tags: [...testCase.collections], rejectedBeforeEvaluation: rejection });
      continue;
    }
    candidates.push({ statement: rule, sourceCaseId: testCase.id, family: testCase.family, tags: [...testCase.collections], rejectedBeforeEvaluation: null });
  }

  // 2. Deduplicate by normalized statement, keeping the first source.
  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = normalize(candidate.statement);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }

  // 3. Evaluate each candidate alone against the memory-arm baseline for its family.
  const admitted = [];
  const rejected = [];
  for (const candidate of unique) {
    if (candidate.rejectedBeforeEvaluation) {
      rejected.push({ ...candidate, reason: candidate.rejectedBeforeEvaluation });
      continue;
    }
    const familyCases = manifest.cases.filter((testCase) => testCase.family === candidate.family);
    const baseline = new Map(memoryRuns.filter((run) => run.arm === "memory").map((run) => [run.caseId, run.passed]));
    const procedure = provisionalProcedure(candidate);
    let wins = 0;
    let losses = 0;
    const evaluatedOn = [];
    for (const testCase of familyCases) {
      if (signal?.aborted) break;
      const world = worlds.get(testCase.worldId);
      const messages = renderArmMessages({ arm: "procedures", testCase, world, procedures: [procedure] });
      const observation = await runResearchInference({
        worker,
        caseId: `${testCase.id}::candidate-${procedure.id}`,
        messages,
        dataManifestDigest: manifest.digest,
        maxOutputTokens,
        answerReserveTokens: Math.max(96, Math.floor(maxOutputTokens / 4)),
        responseFormat: jsonMode ? { type: "json_object" } : null,
        signal
      });
      const passed = gradeBusinessMemoryAnswerText({ testCase, world, text: visibleText(observation.message) }).passed;
      const before = baseline.get(testCase.id) === true;
      if (passed && !before) wins += 1;
      if (!passed && before) losses += 1;
      evaluatedOn.push({ caseId: testCase.id, before, after: passed });
    }
    const lineage = { sourceCaseId: candidate.sourceCaseId, family: candidate.family, evaluatedOn, pairedWins: wins, pairedLosses: losses };
    emit({ kind: "evaluation", procedureId: procedure.id, wins, losses });
    if (wins > 0 && losses === 0) {
      admitted.push({ ...procedure, lineage, digest: undefined });
    } else {
      rejected.push({ ...candidate, reason: losses > 0 ? `regressed ${losses} case(s)` : "no verified lift" , lineage });
    }
  }

  const procedures = admitted.map((procedure) => {
    const { digest, ...rest } = procedure;
    return { ...rest, digest: digestResearchValue(rest) };
  });
  const base = {
    schema: BUSINESS_MEMORY_PROCEDURE_STORE_SCHEMA,
    version: BUSINESS_MEMORY_HARVEST_VERSION,
    origin: "harvested-v1",
    modelId: worker.model,
    controlId: worker.controlId,
    manifestDigest: manifest.digest,
    pool: manifest.pool,
    startedAt,
    completedAt: now().toISOString(),
    repairs,
    candidateCount: unique.length,
    procedures,
    rejected,
    claimBoundary:
      "Procedures were harvested from development-pool repairs and vested on development cases. " +
      "Their value is measured only by the procedures arm on the holdout pool."
  };
  return { ...base, digest: digestResearchValue(base) };
}

export function loadProcedureStore(input) {
  if (!input || input.schema !== BUSINESS_MEMORY_PROCEDURE_STORE_SCHEMA || input.version !== BUSINESS_MEMORY_HARVEST_VERSION) {
    throw new Error("Unsupported business-memory procedure store");
  }
  if (!Array.isArray(input.procedures)) throw new Error("Procedure store requires a procedures array");
  for (const procedure of input.procedures) {
    if (procedure.schema !== BUSINESS_MEMORY_PROCEDURE_SCHEMA) throw new Error(`Procedure ${procedure.id} has the wrong schema`);
    if (typeof procedure.statement !== "string" || !procedure.statement.trim()) throw new Error(`Procedure ${procedure.id} has no statement`);
    if (!Array.isArray(procedure.tags) || procedure.tags.length === 0) throw new Error(`Procedure ${procedure.id} has no tags`);
    const { digest, ...rest } = procedure;
    if (digestResearchValue(rest) !== digest) throw new Error(`Procedure ${procedure.id} digest does not match its contents`);
  }
  return input.procedures;
}

function provisionalProcedure(candidate) {
  const body = {
    schema: BUSINESS_MEMORY_PROCEDURE_SCHEMA,
    version: BUSINESS_MEMORY_VERSION,
    origin: "harvested",
    statement: candidate.statement.trim(),
    tags: [...new Set(candidate.tags)].sort()
  };
  return { id: `proc-h-${digestResearchValue(body).slice(0, 10)}`, ...body };
}

function extractRule(text) {
  const source = String(text ?? "").trim();
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(source.slice(start, end + 1));
      if (typeof parsed.rule === "string") return parsed.rule.trim();
    } catch {
      // fall through to plain text
    }
  }
  return source.replace(/^```(?:json)?|```$/g, "").trim();
}

export function rejectRule(rule) {
  if (!rule) return "empty rule";
  if (/[{}"\\]/.test(rule)) return "rule is not plain prose";
  const words = rule.split(/\s+/).length;
  if (words < MIN_RULE_WORDS) return `rule has fewer than ${MIN_RULE_WORDS} words`;
  if (words > MAX_RULE_WORDS) return `rule exceeds ${MAX_RULE_WORDS} words`;
  if (ID_PATTERN.test(rule)) return "rule names a specific record id";
  if (NUMBER_PATTERN.test(rule)) return "rule contains a specific amount or date";
  return null;
}

function normalize(text) {
  return String(text ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}
