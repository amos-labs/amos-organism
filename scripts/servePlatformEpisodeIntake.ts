#!/usr/bin/env node
/**
 * Private intake endpoint for Platform Mission learning episodes.
 *
 *   AMOS_ORGANISM_INTAKE_BEARER_TOKEN=... node scripts/servePlatformEpisodeIntake.ts \
 *     --events .amos-organism/events.jsonl \
 *     --kms-key-id arn:aws:kms:us-east-1:...:key/... \
 *     --public-key organism-kms-public-key.der.b64 \
 *     --port 8787
 *
 * Fetch the public key once with:
 *   aws kms get-public-key --key-id <key> --query PublicKey --output text > organism-kms-public-key.der.b64
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FileEventStore } from "../src/eventStore.ts";
import {
  createPlatformEpisodeRequestListener,
  PlatformEpisodeReceiver,
  publicKeyFromKmsDer,
  type KmsSigningAlgorithm,
} from "../src/platformEpisodeReceiver.ts";

const args = process.argv.slice(2);
const eventsPath = resolve(option("--events") ?? ".amos-organism/platform-events.jsonl");
const keyId = requiredOption("--kms-key-id");
const publicKeyPath = resolve(requiredOption("--public-key"));
const port = Number(option("--port") ?? 8787);
const host = option("--host") ?? "127.0.0.1";
const algorithms = (option("--algorithms") ?? "ECDSA_SHA_256").split(",").map((value) => value.trim()) as KmsSigningAlgorithm[];
const bearerToken = process.env.AMOS_ORGANISM_INTAKE_BEARER_TOKEN ?? null;

const keyText = readFileSync(publicKeyPath, "utf8");
const publicKey = keyText.includes("-----BEGIN") ? keyText : publicKeyFromKmsDer(keyText);
const store = new FileEventStore(eventsPath);
const receiver = new PlatformEpisodeReceiver(store, { publicKey, expectedKeyId: keyId, allowedAlgorithms: algorithms, bearerToken });
const server = createServer(createPlatformEpisodeRequestListener(receiver));
server.listen(port, host, () => {
  process.stderr.write(`${JSON.stringify({
    at: new Date().toISOString(),
    event: "listening",
    host,
    port,
    events: eventsPath,
    keyId,
    algorithms,
    bearerRequired: bearerToken !== null,
    existingEvents: store.events().length,
  })}\n`);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

function option(name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function requiredOption(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}
