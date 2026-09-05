/**
 * Minimal JSON-RPC client for the AMOS Platform MCP endpoint.
 *
 * One method, `callTool(name, args)`, posts a `tools/call` request with the
 * caller's bearer credential and returns the parsed JSON the tool wrote into
 * its first text content block. Every call is appended to `calls` (name, wall
 * time, outcome) so a run can report exactly which verbs it exercised. The
 * credential is held in memory only; it is never logged or serialized.
 */
import { performance } from "node:perf_hooks";

export class AmosMcpClient {
  constructor({
    baseUrl,
    apiKey,
    fetchImpl = globalThis.fetch,
    requestTimeoutMs = 60_000,
    monotonicNow = () => performance.now()
  }) {
    if (typeof baseUrl !== "string" || !/^https?:\/\//.test(baseUrl)) {
      throw new Error("AmosMcpClient requires an http(s) baseUrl");
    }
    if (typeof apiKey !== "string" || apiKey.length < 8) {
      throw new Error("AmosMcpClient requires an API key");
    }
    if (typeof fetchImpl !== "function") throw new Error("AmosMcpClient requires fetch");
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.endpoint = `${this.baseUrl}/mcp`;
    this.requestTimeoutMs = requestTimeoutMs;
    this.fetch = fetchImpl;
    this.monotonicNow = monotonicNow;
    this.calls = [];
    this.nextId = 1;
    Object.defineProperty(this, "apiKey", { value: apiKey, enumerable: false, writable: false });
  }

  async callTool(name, args = {}, { signal = null } = {}) {
    if (typeof name !== "string" || !name) throw new Error("callTool requires a tool name");
    const id = this.nextId++;
    const started = this.monotonicNow();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    let outcome = "ok";
    try {
      const response = await this.fetch(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
        signal: controller.signal
      });
      if (!response.ok) {
        outcome = `http_${response.status}`;
        throw new Error(`MCP ${name} failed with HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      }
      const payload = await response.json();
      if (payload.error) {
        outcome = "rpc_error";
        throw new Error(`MCP ${name} returned an error: ${JSON.stringify(payload.error).slice(0, 300)}`);
      }
      const result = payload.result ?? {};
      const text = Array.isArray(result.content)
        ? result.content.filter((block) => block?.type === "text").map((block) => block.text).join("\n")
        : "";
      if (result.isError) {
        outcome = "tool_error";
        throw new Error(`MCP ${name} reported an error: ${text.slice(0, 300)}`);
      }
      return parseToolText(text);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      this.calls.push({ name, milliseconds: Math.round(this.monotonicNow() - started), outcome });
    }
  }

  summary() {
    const byName = {};
    for (const call of this.calls) {
      const entry = (byName[call.name] ||= { calls: 0, errors: 0, milliseconds: 0 });
      entry.calls += 1;
      entry.milliseconds += call.milliseconds;
      if (call.outcome !== "ok") entry.errors += 1;
    }
    return byName;
  }
}

export function parseToolText(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return { text: trimmed };
  }
}
