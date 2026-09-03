#!/usr/bin/env node
/**
 * Extract the AMOS platform's MCP tool definitions into an immutable, digested
 * catalog the curriculum generator can draw from. Reads `json!({...})` blocks
 * that carry an `inputSchema` from the platform's Rust MCP modules. Blocks that
 * embed Rust expressions and do not parse as JSON are counted and skipped.
 *
 * Descriptions are product documentation, not tenant data; they are truncated
 * and never include examples or credentials.
 */
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const platformRoot = resolve(option("--platform") || "../amos-managed-platform");
const outputPath = resolve(option("--output") || "swarm/benchmarks/amos-tool-catalog-v1.json");
const reservedFraction = Number(option("--reserved-fraction") || 0.2);
const mcpDir = join(platformRoot, "src", "mcp");

const READ_PREFIXES = ["list_", "get_", "read_", "search_", "describe_", "preview_", "show_", "check_", "inspect_", "find_", "explain_", "compare_", "summarize_", "resolve_", "whoami", "overview", "status_"];
const CONSEQUENTIAL_MARKERS = ["send", "pay", "spend", "publish", "delete", "charge", "refund", "launch", "deploy", "email", "sms", "invite", "transfer", "purchase", "cancel", "revoke", "grant", "mint", "wire"];

const files = (await readdir(mcpDir)).filter((name) => name.endsWith(".rs")).sort();
const tools = [];
let skipped = 0;
for (const file of files) {
  const source = await readFile(join(mcpDir, file), "utf8");
  for (const block of jsonMacroBlocks(source)) {
    if (!block.includes('"inputSchema"')) continue;
    let parsed;
    try {
      parsed = JSON.parse(block);
    } catch {
      skipped += 1;
      continue;
    }
    if (typeof parsed?.name !== "string" || typeof parsed?.inputSchema !== "object") continue;
    tools.push({
      name: parsed.name,
      domain: basename(file, ".rs"),
      description: String(parsed.description || "").replace(/\s+/g, " ").trim().slice(0, 240),
      authority: classifyAuthority(parsed.name, parsed.description || ""),
      inputSchema: parsed.inputSchema
    });
  }
}
const byName = new Map();
for (const tool of tools) if (!byName.has(tool.name)) byName.set(tool.name, tool);
const ordered = [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
for (const tool of ordered) {
  const hash = createHash("sha256").update(`reserve:${tool.name}`).digest();
  tool.reserved = hash[0] / 256 < reservedFraction;
}
const base = {
  schema: "amos.tool-catalog",
  version: 1,
  id: basename(outputPath, ".json"),
  source: {
    repository: "amos-managed-platform",
    path: "src/mcp",
    files: files.length,
    skippedUnparsableBlocks: skipped
  },
  rights: {
    owner: "amos-labs",
    sourceClass: "amos-owned",
    tenantFactsIncluded: false,
    credentialsIncluded: false,
    trainingApproved: true
  },
  reservedFraction,
  counts: {
    tools: ordered.length,
    reserved: ordered.filter(({ reserved }) => reserved).length,
    byAuthority: Object.fromEntries(["read", "write", "consequential"].map((tag) => [
      tag, ordered.filter(({ authority }) => authority === tag).length
    ])),
    domains: new Set(ordered.map(({ domain }) => domain)).size
  },
  tools: ordered
};
const catalog = { ...base, digest: createHash("sha256").update(JSON.stringify(base)).digest("hex") };
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output: outputPath, ...catalog.counts, skippedUnparsableBlocks: skipped, digest: catalog.digest }, null, 2));

function* jsonMacroBlocks(source) {
  let index = 0;
  while ((index = source.indexOf("json!(", index)) !== -1) {
    const start = index + "json!(".length;
    let depth = 0;
    let end = -1;
    let inString = false;
    for (let cursor = start; cursor < source.length; cursor += 1) {
      const char = source[cursor];
      if (inString) {
        if (char === "\\") cursor += 1;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "(" || char === "{" || char === "[") depth += 1;
      else if (char === ")" || char === "}" || char === "]") {
        if (depth === 0) { end = cursor; break; }
        depth -= 1;
      }
    }
    if (end === -1) return;
    yield source.slice(start, end).trim();
    index = end;
  }
}

function classifyAuthority(name, description) {
  const lower = `${name} ${description}`.toLowerCase();
  if (CONSEQUENTIAL_MARKERS.some((marker) => name.toLowerCase().includes(marker)) ||
      /requires? (human )?approval|consequential|irreversible/.test(lower)) {
    return "consequential";
  }
  if (READ_PREFIXES.some((prefix) => name.toLowerCase().startsWith(prefix)) || /read-only|does not (modify|change|write)/.test(lower)) {
    return "read";
  }
  return "write";
}

function option(name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
