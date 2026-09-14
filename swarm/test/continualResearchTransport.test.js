import test from 'node:test';
import assert from 'node:assert/strict';
import { createContinualResearchTransport } from '../src/continualResearchTransport.js';

const input = { taskId: 'task-1', messages: [{ role: 'user', content: 'test' }], tools: [], maxOutputTokens: 1536, seed: 14 };
const reply = value => ({ ok: true, status: 200, json: async () => value });
const completion = { choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3 } };
function client(fetchImpl, options = {}) {
  const events = [];
  const transport = createContinualResearchTransport({ baseUrl: 'http://127.0.0.1:8001', model: 'candidate', apiKey: 'test-secret',
    maxRequests: 2, maxMilliseconds: 10000, onEvent: async e => events.push(e), fetchImpl, ...options });
  return { transport, events };
}
test('counts actual serving usage and never writes credentials to evidence', async () => {
  const wires = [];
  const { transport, events } = client(async (url, init) => {
    wires.push({ url: url.pathname, body: JSON.parse(init.body) });
    return reply(url.pathname === '/tokenize' ? { count: 12, max_model_len: 8192 } : completion);
  });
  assert.equal((await transport.request(input)).message.content, 'done');
  assert.equal(transport.accounting().promptTokens, 12);
  assert.equal(transport.accounting().outputTokens, 3);
  assert.equal(transport.accounting().unknownUsageRequests, 0);
  assert.equal(JSON.stringify(events).includes('test-secret'), false);
  assert.equal(wires[1].body.temperature, 0);
  assert.equal(wires[1].body.chat_template_kwargs.enable_thinking, false);
  assert.deepEqual(wires[1].body.messages, input.messages);
});
test('rejects over-context before inference and prevents retry', async () => {
  let calls = 0;
  const { transport } = client(async () => { calls++; return reply({ count: 8000, max_model_len: 8192 }); });
  await assert.rejects(transport.request(input), /Context qualification/);
  await assert.rejects(transport.request(input), /stopped/);
  assert.equal(calls, 1);
  assert.equal(transport.accounting().requests, 0);
  assert.equal(transport.accounting().logicalRequests, 1);
  assert.equal(transport.accounting().tokenizerRequests, 1);
  assert.equal(transport.accounting().unknownUsageRequests, 0);
});
test('records ambiguous inference cost and makes no transport retry', async () => {
  let calls = 0;
  const { transport, events } = client(async url => {
    calls++; if (url.pathname === '/tokenize') return reply({ count: 12, max_model_len: 8192 });
    throw new Error('socket reset');
  });
  await assert.rejects(transport.request(input), /socket reset/);
  await assert.rejects(transport.request(input), /stopped/);
  assert.equal(calls, 2);
  assert.equal(transport.accounting().unknownUsageRequests, 1);
  assert.equal(events.at(-1).retryAllowed, false);
});
test('rejects missing usage and prompt-count drift while preserving known costs and provider evidence', async () => {
  for (const payload of [{ ...completion, usage: undefined }, { ...completion, usage: { prompt_tokens: 13, completion_tokens: 3 } }]) {
    const { transport, events } = client(async url => reply(url.pathname === '/tokenize' ? { count: 12, max_model_len: 8192 } : payload));
    await assert.rejects(transport.request(input), /usage missing|differs/);
    assert.equal(transport.accounting().unknownUsageRequests, payload.usage ? 0 : 1);
    assert.equal(transport.accounting().promptTokens, payload.usage?.prompt_tokens ?? 0);
    assert.equal(transport.accounting().outputTokens, payload.usage?.completion_tokens ?? 0);
    assert.equal(transport.accounting().integrityFailures, 1);
    assert.deepEqual(events.at(-1).providerResponse, payload);
    assert.equal(events.at(-1).promptCountDelta, payload.usage ? 1 : null);
  }
});
test('enforces call and elapsed budgets, and restricts endpoint to loopback', async () => {
  let clock = 0;
  const { transport } = client(async url => reply(url.pathname === '/tokenize' ? { count: 12, max_model_len: 8192 } : completion), { maxRequests: 1, now: () => clock });
  await transport.request(input);
  await assert.rejects(transport.request(input), /budget exhausted/);
  const { transport: timed } = client(async () => { throw new Error('unreachable'); }, { now: () => clock });
  clock = 11000;
  await assert.rejects(timed.request(input), /budget exhausted/);
  for (const baseUrl of ['https://example.com', 'http://127.0.0.1:8001/other', 'http://user:secret@localhost', 'http://localhost?x=1']) {
    assert.throws(() => client(async () => {}, { baseUrl }), /loopback/);
  }
});
test('an evidence write failure prevents dispatch and subsequent attempts', async () => {
  let inference = 0;
  const { transport } = client(async url => {
    if (url.pathname !== '/tokenize') inference++;
    return reply({ count: 12, max_model_len: 8192 });
  }, { onEvent: async e => { if (e.type === 'inference-start') throw new Error('disk write failed'); } });
  await assert.rejects(transport.request(input), /disk write failed/);
  await assert.rejects(transport.request(input), /stopped/);
  assert.equal(inference, 0);
  assert.equal(transport.accounting().requests, 0);
  assert.equal(transport.accounting().logicalRequests, 1);
  assert.equal(transport.accounting().unknownUsageRequests, 0);
});

test('actual tokenization and inference share one snapshot, and concurrent calls cannot overrun the cap', async () => {
  const mutable = structuredClone(input), wires = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { transport } = client(async (url, init) => {
    wires.push(JSON.parse(init.body));
    if (url.pathname === '/tokenize') { await gate; return reply({ count: 12, max_model_len: 8192 }); }
    return reply(completion);
  }, { maxRequests: 1 });
  const first = transport.request(mutable);
  await assert.rejects(transport.request(input), /one request at a time/);
  mutable.messages[0].content = 'changed after qualification began';
  mutable.tools.push({ unsafe: true });
  release();
  await first;
  assert.deepEqual(wires[0].messages, wires[1].messages);
  assert.deepEqual(wires[1].messages, input.messages);
  assert.equal(Object.hasOwn(wires[1], 'tools'), false);
  assert.equal(transport.accounting().requests, 1);
});

test('late responses fail closed with their raw bytes and known usage retained', async () => {
  let clock = 0;
  const raw = JSON.stringify(completion, null, 2) + '\n';
  const { transport, events } = client(async url => {
    if (url.pathname === '/tokenize') return reply({ count: 12, max_model_len: 8192 });
    clock = 10001;
    return { ok: true, status: 200, text: async () => raw };
  }, { now: () => clock });
  await assert.rejects(transport.request(input), /deadline/);
  assert.equal(transport.accounting().unknownUsageRequests, 0);
  assert.equal(transport.accounting().promptTokens, 12);
  assert.equal(transport.accounting().stopped, true);
  assert.equal(events.at(-1).providerRawText, raw);
  assert.equal(events.at(-1).usageUnknown, false);
});

test('partial usage and malformed responses cannot discard already reported cost', async () => {
  for (const payload of [
    { ...completion, usage: { prompt_tokens: 12 } },
    { ...completion, choices: [] },
    { ...completion, model: 'other-model' },
    { ...completion, usage: { prompt_tokens: 12, completion_tokens: 2000 } }
  ]) {
    const { transport, events } = client(async url => reply(url.pathname === '/tokenize' ? { count: 12, max_model_len: 8192 } : payload));
    await assert.rejects(transport.request(input));
    assert.equal(transport.accounting().promptTokens, 12);
    assert.equal(transport.accounting().outputTokens, payload.usage.completion_tokens ?? 0);
    assert.equal(transport.accounting().unknownUsageRequests, payload.usage.completion_tokens === undefined ? 1 : 0);
    assert.deepEqual(events.at(-1).providerResponse, payload);
  }
});

test('a failed completion receipt keeps known tokens and forbids a new request', async () => {
  const { transport } = client(async url => reply(url.pathname === '/tokenize' ? { count: 12, max_model_len: 8192 } : completion),
    { onEvent: async event => { if (event.type === 'inference-completed') throw new Error('completion disk failure'); } });
  await assert.rejects(transport.request(input), /completion disk failure/);
  assert.equal(transport.accounting().promptTokens, 12);
  assert.equal(transport.accounting().unknownUsageRequests, 0);
  await assert.rejects(transport.request(input), /stopped/);
});
