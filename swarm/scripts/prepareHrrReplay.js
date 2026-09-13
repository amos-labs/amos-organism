#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createReplayMemory, loadReplayMemory, requireDigest, saveReplayMemory } from "../src/persistentReplayMemory.js";
import { prepareMatchedReplayExperiment, writeMatchedReplayExperiment } from "../src/matchedReplayExperiment.js";

const MAX_BYTES = 64 * 1024 * 1024;
function readBound(reference) {
  if (!isAbsolute(reference?.path ?? "")) throw new Error("bound file path must be absolute");
  requireDigest(reference.sha256, "file hash");
  if (statSync(reference.path).size > MAX_BYTES) throw new Error("input file exceeds bound");
  const bytes = readFileSync(reference.path);
  if (bytes.length > MAX_BYTES || createHash("sha256").update(bytes).digest("hex") !== reference.sha256) throw new Error("input file hash mismatch");
  return JSON.parse(bytes);
}
export function prepareHrrReplay(requestPath, requestSha256) {
  const request = readBound({ path: requestPath, sha256: requestSha256 });
  if (request.schema !== "amos.prepare-hrr-replay.v1" || !isAbsolute(request.outputDirectory ?? "")) throw new Error("invalid preparation request");
  const previous = request.previousMemory ? loadReplayMemory(request.previousMemory.path, request.previousMemory.digest) : null;
  const observations = readBound(request.observations);
  const snapshot = createReplayMemory({ tenantId: request.tenantId, observations, previous, config: request.config });
  const experiment = request.experiment ? prepareMatchedReplayExperiment({ ...request.experiment, tenantId: request.tenantId, snapshot,
    tokenCounts: readBound(request.experiment.tokenCounts) }) : null;
  const memoryPath = saveReplayMemory(resolve(request.outputDirectory, "memory"), snapshot);
  const experimentPath = experiment ? writeMatchedReplayExperiment(resolve(request.outputDirectory, "experiment"), experiment) : null;
  return { schema: "amos.hrr-replay-preparation-receipt.v1", requestSha256, snapshotDigest: snapshot.digest, memoryPath,
    records: snapshot.records.length, experimentPath, experimentDigest: experiment?.manifest.digest ?? null,
    distinctReplaySlots: experiment?.manifest.distinctReplaySlots ?? null,
    modelCalls: 0, trainingExecuted: false, createsQualityEvidence: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4) throw new Error("Usage: node swarm/scripts/prepareHrrReplay.js ABS_REQUEST_JSON RAW_REQUEST_SHA256");
    console.log(JSON.stringify(prepareHrrReplay(process.argv[2], process.argv[3]), null, 2));
  } catch (error) { console.error(JSON.stringify({ status: "failed", error: error.message })); process.exitCode = 1; }
}
