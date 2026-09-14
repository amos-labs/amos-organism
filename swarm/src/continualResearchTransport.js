import { createHash } from 'node:crypto';
const hash = text => createHash('sha256').update(text).digest('hex');

/** One attempt per inference. A transport failure stops the panel with unknown cost recorded. */
export function createContinualResearchTransport({ baseUrl, model, apiKey, maxRequests, maxMilliseconds,
  onEvent, fetchImpl = fetch, now = () => Date.now() }) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Research endpoint must be a loopback origin');
  if (typeof apiKey !== 'string' || !apiKey.trim() || typeof model !== 'string' || !model || typeof onEvent !== 'function') throw new Error('Transport identity and event sink required');
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 10000 || !Number.isSafeInteger(maxMilliseconds) || maxMilliseconds < 1000 || maxMilliseconds > 36_000_000) throw new Error('Bounded transport budget required');
  const started = now(), deadline = started + maxMilliseconds;
  let requests = 0, logicalRequests = 0, tokenizerRequests = 0, promptTokens = 0, outputTokens = 0;
  let unknown = 0, failedRequests = 0, integrityFailures = 0, stopped = false, inFlight = false;
  return {
    accounting: () => ({ requests, logicalRequests, tokenizerRequests, promptTokens, outputTokens, unknownUsageRequests: unknown,
      failedRequests, integrityFailures,
      elapsedMilliseconds: now() - started, stopped }),
    async request({ taskId, messages, tools, maxOutputTokens, seed, signal }) {
      if (stopped || inFlight || logicalRequests >= maxRequests || now() >= deadline) throw new Error('Transport stopped or budget exhausted (one request at a time)');
      if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 1536 || !Number.isInteger(seed) ||
          !Array.isArray(messages) || !Array.isArray(tools)) throw new Error('Invalid inference settings');
      // One detached snapshot supplies tokenizer and inference; callers cannot change a qualified prompt while awaiting I/O.
      const input = JSON.parse(JSON.stringify({ messages, tools }));
      const requestId = `${taskId}:${++logicalRequests}`;
      inFlight = true;
      const abort = AbortSignal.any([AbortSignal.timeout(Math.max(1, Math.min(120000, deadline - now()))), ...(signal ? [signal] : [])]);
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
      const tokenBody = JSON.stringify({ model, messages: input.messages, ...(input.tools.length ? { tools: input.tools } : {}), add_generation_prompt: true, chat_template_kwargs: { enable_thinking: false } });
      const body = JSON.stringify({ model, messages: input.messages, ...(input.tools.length ? { tools: input.tools, parallel_tool_calls: false } : {}), stream: false,
        temperature: 0, seed, max_tokens: maxOutputTokens, enable_thinking: false, chat_template_kwargs: { enable_thinking: false } });
      let tokenResponse = null, payload = null, rawResponse = null, responseStatus = null, dispatched = false;
      let observedPromptTokens = null, observedOutputTokens = null, integrityFailure = false;
      const began = now();
      const checkActive = () => { abort.throwIfAborted(); if (now() >= deadline) throw new Error('Transport deadline exhausted'); };
      const invalid = message => { integrityFailure = true; throw new Error(message); };
      try {
        checkActive();
        await onEvent({ type: 'logical-request-start', requestId, taskId, maxOutputTokens, seed });
        await onEvent({ type: 'tokenizer-start', requestId, requestSha256: hash(tokenBody), startedAt: new Date(now()).toISOString() });
        checkActive();
        tokenizerRequests++;
        tokenResponse = await fetchImpl(new URL('/tokenize', url), { method: 'POST', headers, body: tokenBody,
          signal: AbortSignal.any([abort, AbortSignal.timeout(10000)]), redirect: 'error' });
        if (!tokenResponse.ok) throw new Error(`Tokenizer HTTP ${tokenResponse.status}`);
        tokenResponse = await tokenResponse.json();
        if (!Number.isSafeInteger(tokenResponse.count) || tokenResponse.count < 0 || !Number.isSafeInteger(tokenResponse.max_model_len) || tokenResponse.max_model_len < 1 ||
            tokenResponse.count + maxOutputTokens > Math.min(8192, tokenResponse.max_model_len)) throw new Error('Context qualification failed');
        checkActive();
        await onEvent({ type: 'tokenizer-passed', requestId, requestSha256: hash(tokenBody), count: tokenResponse.count, maximum: tokenResponse.max_model_len });
        // Durably record intent before transport. An uncertain append also prevents a new dispatch.
        await onEvent({ type: 'inference-start', requestId, requestSha256: hash(body), body: JSON.parse(body), startedAt: new Date(now()).toISOString() });
        checkActive();
        requests++; unknown++; dispatched = true;
        const response = await fetchImpl(new URL('/v1/chat/completions', url), { method: 'POST', headers, body, signal: abort, redirect: 'error' });
        responseStatus = response.status;
        if (typeof response.text === 'function') { rawResponse = await response.text(); payload = JSON.parse(rawResponse); }
        else payload = await response.json(); // CPU test doubles may expose only json().
        const usage = payload.usage;
        if (Number.isSafeInteger(usage?.prompt_tokens) && usage.prompt_tokens >= 0) { observedPromptTokens = usage.prompt_tokens; promptTokens += observedPromptTokens; }
        if (Number.isSafeInteger(usage?.completion_tokens) && usage.completion_tokens >= 0) { observedOutputTokens = usage.completion_tokens; outputTokens += observedOutputTokens; }
        if (observedPromptTokens !== null && observedOutputTokens !== null) unknown--;
        if (!response.ok) throw new Error(`Inference HTTP ${response.status}`);
        if (observedPromptTokens === null || observedOutputTokens === null) invalid('Inference usage missing');
        if (observedPromptTokens !== tokenResponse.count) invalid('Serving prompt count differs from tokenizer');
        if (observedOutputTokens > maxOutputTokens) invalid('Serving output count exceeds request budget');
        if (payload.model !== undefined && payload.model !== model) invalid('Serving model identity differs');
        const message = payload.choices?.[0]?.message;
        if (!Array.isArray(payload.choices) || payload.choices.length !== 1 || !message || message.role !== 'assistant' ||
            (message.content !== null && typeof message.content !== 'string')) invalid('Assistant response missing or malformed');
        if (!['stop', 'tool_calls', 'length'].includes(payload.choices[0].finish_reason)) invalid('Invalid serving finish reason');
        checkActive();
        const result = { message, providerResponse: payload, promptTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens,
          finishReason: payload.choices[0].finish_reason, wallMilliseconds: now() - began };
        await onEvent({ type: 'inference-completed', requestId, responseStatus, providerRawText: rawResponse,
          providerResponseSha256: hash(rawResponse ?? JSON.stringify(payload)), promptCountDelta: observedPromptTokens - tokenResponse.count, result });
        checkActive();
        return result;
      } catch (error) {
        failedRequests++; stopped = true;
        if (integrityFailure) integrityFailures++;
        // Returned usage is still cost even if the provider response cannot be used for grading.
        // Missing usage remains unknown; no retry is inferred from a malformed or late response.
        try {
          await onEvent({ type: dispatched ? 'inference-failed' : 'request-failed', requestId,
            error: String(error.message).replaceAll(apiKey, '[redacted]'), inferenceDispatched: dispatched, responseStatus,
            tokenizerResponse: tokenResponse, providerResponse: payload, providerRawText: rawResponse,
            providerResponseSha256: rawResponse !== null || payload !== null ? hash(rawResponse ?? JSON.stringify(payload)) : null,
            promptTokens: observedPromptTokens, outputTokens: observedOutputTokens,
            promptCountDelta: observedPromptTokens !== null && Number.isSafeInteger(tokenResponse?.count) ? observedPromptTokens - tokenResponse.count : null,
            usageUnknown: dispatched && (observedPromptTokens === null || observedOutputTokens === null),
            integrityFailure, retryAllowed: false, wallMilliseconds: now() - began });
        } catch { /* A failed evidence sink leaves the panel stopped and its dispatch intent unresolved. */ }
        throw error;
      } finally { inFlight = false; }
    }
  };
}
