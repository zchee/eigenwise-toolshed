'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { gatewayTestEnvironment, startGateway } = require('./support.js');

// claude-code-proxy's local provider (dev branch, src/providers/local.rs) lists one model when
// CCP_LLAMA_PORT is set and forwards it to llama.cpp's llama-server. These fixtures copy what
// llama-server b12110 sent on 2026-11-25: the /props field that carries a slot's context, the 400 it
// answers an over-long prompt with, and a stream that reports input only in message_start.
const LOCAL_LISTING = [
  { type: 'model', object: 'model', id: 'local/gguf', display_name: 'local/gguf (local)' },
  { type: 'model', object: 'model', id: 'kimi-k3', display_name: 'kimi-k3 (kimi)' },
];

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function request(port, method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: {
        ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

// A llama-server stand-in that answers /props with the given slot context (a number, or a function
// read on every request, for a server restarted with another context).
async function fakeLlamaServer(t, nCtx, { status = 200 } = {}) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/props') {
      res.writeHead(status, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ default_generation_settings: { n_ctx: typeof nCtx === 'function' ? nCtx() : nCtx }, total_slots: 4, model_alias: 'gguf' }));
    }
    res.writeHead(404);
    res.end();
  });
  const port = await listen(server);
  t.after(() => close(server));
  return port;
}

async function closedPort() {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

function llamaStream(inputTokens, cacheReadTokens) {
  const start = { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'gguf', usage: { cache_read_input_tokens: cacheReadTokens, input_tokens: inputTokens, output_tokens: 0 } } };
  const delta = { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } };
  return `event: message_start\ndata: ${JSON.stringify(start)}\n\n`
    + `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`
    + `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } })}\n\n`
    + `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`
    + `event: message_delta\ndata: ${JSON.stringify(delta)}\n\n`
    + 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
}

const LLAMA_OVERFLOW = JSON.stringify({ error: { code: 400, message: 'request (45016 tokens) exceeds the available context size (40960 tokens), try increasing it', type: 'exceed_context_size_error', n_prompt_tokens: 45016, n_ctx: 40960 } });

// Answers /v1/models with LOCAL_LISTING and hands every other request to `respond`, recording it.
async function listingProxy(t, respond) {
  const received = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: LOCAL_LISTING, has_more: false }));
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString()));
      respond(res);
    });
  });
  const port = await listen(server);
  t.after(() => close(server));
  return { port, received };
}

async function spawnShim(t, proxyPort, llamaPort, extraEnv = {}) {
  const environment = gatewayTestEnvironment(t, {
    CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
    CODEX_GATEWAY_REQUEST_LOG: '0',
    CODEX_GATEWAY_ANTHROPIC_UPSTREAM: 'http://127.0.0.1:9',
    CCP_LLAMA_PORT: String(llamaPort),
    ...extraEnv,
  });
  const { port } = await startGateway(t, 'serve-shim', environment);
  const row = await waitFor(async () => {
    const response = await request(port, 'GET', '/v1/models');
    return JSON.parse(response.body).data.find((model) => model.id.startsWith('claude-local/gguf'));
  }, 'shim never advertised the local row');
  return { port, row };
}

function messageBody(model) {
  return JSON.stringify({ model, max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hello' }] });
}

// Module state (the route table and the last llama-server probe) is shared by the in-process tests.
function resetLocalState(t) {
  const { setLocalServerState, setProxyModelRoutes } = require('../lib/proxy-models.js');
  setProxyModelRoutes([{ id: 'local/gguf', provider: 'local' }]);
  setLocalServerState(null);
  t.after(() => { setLocalServerState(null); setProxyModelRoutes([]); });
  return { setLocalServerState };
}

test('CCP_LLAMA_PORT is read the way the proxy parses it', () => {
  const { llamaServerPort } = require('../lib/local-llama.js');
  const tests = {
    'success: a port': { value: '8080', expected: { port: 8080, configured: true } },
    'success: a leading zero, which Rust NonZeroU16 accepts': { value: '08080', expected: { port: 8080, configured: true } },
    'success: the highest port': { value: '65535', expected: { port: 65535, configured: true } },
    'error: unset, so the proxy lists no local row': { value: undefined, expected: { port: null, configured: false } },
    'error: empty, which the proxy lists and then cannot parse': { value: '', expected: { port: null, configured: true, invalid: '' } },
    'error: zero': { value: '0', expected: { port: null, configured: true, invalid: '0' } },
    'error: above u16': { value: '65536', expected: { port: null, configured: true, invalid: '65536' } },
    'error: surrounding whitespace, which Rust parsing refuses': { value: ' 8080', expected: { port: null, configured: true, invalid: ' 8080' } },
    'error: not a number': { value: 'llama', expected: { port: null, configured: true, invalid: 'llama' } },
  };
  for (const [name, { value, expected }] of Object.entries(tests)) {
    assert.deepEqual(llamaServerPort(value === undefined ? {} : { CCP_LLAMA_PORT: value }), expected, name);
  }
});

test('the llama-server probe reads one slot context from /props and reports every failure as state', async (t) => {
  const { fetchUrl } = require('../lib/process-supervision.js');
  const { probeLlamaServer } = require('../lib/local-llama.js');
  const measured = await fakeLlamaServer(t, 40960);
  const router = await fakeLlamaServer(t, 0);
  const failing = await fakeLlamaServer(t, 40960, { status: 503 });
  const refused = await closedPort();
  const tests = {
    'success: a running server': { env: { CCP_LLAMA_PORT: String(measured) }, expected: { port: measured, configured: true, reachable: true, contextWindow: 40960 } },
    'success: router mode answers but reports no window': { env: { CCP_LLAMA_PORT: String(router) }, expected: { port: router, configured: true, reachable: true, contextWindow: null } },
    'error: a server that answers /props with an error': { env: { CCP_LLAMA_PORT: String(failing) }, expected: { port: failing, configured: true, reachable: false, contextWindow: null, error: 'GET /props answered HTTP 503' } },
    'error: nothing listening': { env: { CCP_LLAMA_PORT: String(refused) }, expected: { port: refused, configured: true, reachable: false, contextWindow: null, error: 'ECONNREFUSED' } },
    'error: not configured': { env: {}, expected: { port: null, configured: false, reachable: false, contextWindow: null } },
    'error: not a port': { env: { CCP_LLAMA_PORT: 'x' }, expected: { port: null, configured: true, reachable: false, contextWindow: null, error: 'CCP_LLAMA_PORT=x is not a port' } },
  };
  for (const [name, { env, expected }] of Object.entries(tests)) {
    assert.deepEqual(await probeLlamaServer({ env, fetchUrl }), expected, name);
  }
});

test('an unreachable llama-server keeps its last window, and an unlisted local row clears it', async (t) => {
  const { fetchUrl } = require('../lib/process-supervision.js');
  const { refreshLocalServerState } = require('../lib/local-llama.js');
  const { localServerState } = require('../lib/proxy-models.js');
  resetLocalState(t);
  const routes = [{ id: 'local/gguf', provider: 'local' }];
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ default_generation_settings: { n_ctx: 65536 } }));
  });
  const port = await listen(server);
  const env = { CCP_LLAMA_PORT: String(port) };

  assert.equal((await refreshLocalServerState(routes, { env, fetchUrl })).contextWindow, 65536);
  await close(server);
  const down = await refreshLocalServerState(routes, { env, fetchUrl });
  assert.equal(down.reachable, false, 'the outage is reported');
  assert.equal(down.contextWindow, 65536, 'the window measured before the outage stays, so the picker id does not change');

  const moved = await refreshLocalServerState(routes, { env: { CCP_LLAMA_PORT: String(await closedPort()) }, fetchUrl });
  assert.equal(moved.contextWindow, null, 'a different port is a different server');

  assert.equal(await refreshLocalServerState([{ id: 'kimi-k3', provider: 'kimi' }], { env, fetchUrl }), null);
  assert.equal(localServerState(), null, 'no local row, no local state');
});

test('the local row compacts a third of its window early, at most 40000, and has no sentry below 32768', (t) => {
  const { effectiveSentryPolicy, gatewayAdvertisedWindow, gatewayClientModelId, resolveGatewayModelPolicy } = require('../lib/runtime.js');
  const { setLocalServerState } = resetLocalState(t);
  const tests = {
    'success: no probe yet, the unmeasured 200k row': { window: null, sentry: 'none', trigger: null, advertised: 200000, id: 'claude-local/gguf' },
    'success: router mode, the unmeasured 200k row': { window: 0, sentry: 'none', trigger: null, advertised: 200000, id: 'claude-local/gguf' },
    'error: 8192, below the floor, so no sentry': { window: 8192, sentry: 'none', trigger: null, advertised: 8192, id: 'claude-local/gguf' },
    'success: 32768, the floor': { window: 32768, sentry: 'synthetic-413', trigger: 32768 - 10922, advertised: 32768, id: 'claude-local/gguf' },
    'success: 40960': { window: 40960, sentry: 'synthetic-413', trigger: 40960 - 13653, advertised: 40960, id: 'claude-local/gguf' },
    'success: 131072, where the reserve reaches 40000': { window: 131072, sentry: 'synthetic-413', trigger: 91072, advertised: 131072, id: 'claude-local/gguf' },
    'success: 262144, above 200k, so the [1m] alias': { window: 262144, sentry: 'synthetic-413', trigger: 222144, advertised: 262144, id: 'claude-local/gguf[1m]' },
    'success: 2097152, capped at the alias client window': { window: 2097152, sentry: 'synthetic-413', trigger: 2057152, advertised: 1000000, id: 'claude-local/gguf[1m]' },
  };
  for (const [name, { window, sentry, trigger, advertised, id }] of Object.entries(tests)) {
    setLocalServerState(window === null ? null : { port: 8080, configured: true, reachable: true, contextWindow: window || null });
    const policy = resolveGatewayModelPolicy('claude-local/gguf');
    assert.equal(policy.backend, 'local', name);
    assert.equal(policy.transport, 'proxy', name);
    assert.equal(policy.sentry, sentry, name);
    assert.equal(effectiveSentryPolicy(policy)?.compactTrigger ?? null, trigger, name);
    assert.equal(gatewayAdvertisedWindow('claude-local/gguf'), advertised, name);
    assert.equal(gatewayClientModelId('claude-local/gguf'), id, name);
  }
});

test('local readiness is llama-server reachability, never a proxy sign-in', (t) => {
  const { describeProxyProviderAuth, getProxyProviderReadiness, proxyProviderAuthState } = require('../lib/commands.js');
  const { setLocalServerState } = resetLocalState(t);
  const run = () => { throw new Error('the proxy has no `local` CLI group; no status process may start'); };
  const healthy = { checks: { proxyBinary: true, proxyModels: true, shimRunning: true, servingVersionMatches: true } };
  const tests = {
    'error: CCP_LLAMA_PORT unset where the gateway runs': { env: {}, state: null, expected: 'config-invalid', described: /^NOT CONFIGURED \(claude-code-proxy lists local\/gguf, but CCP_LLAMA_PORT is not set where the gateway runs.*model-gateway\.js" stop`, then `node ".*model-gateway\.js" start`\.\)$/ },
    'error: CCP_LLAMA_PORT not a port, and the message names the value': { env: { CCP_LLAMA_PORT: 'abc' }, state: null, expected: 'config-invalid', described: /^NOT CONFIGURED \(claude-code-proxy lists local\/gguf, but CCP_LLAMA_PORT="abc" is not a port where the gateway runs/ },
    'error: not probed in this process': { env: { CCP_LLAMA_PORT: '8080' }, state: null, expected: 'auth-unknown', described: /^status unavailable$/ },
    'error: probed a different port': { env: { CCP_LLAMA_PORT: '8080' }, state: { port: 9090, reachable: true, contextWindow: 65536 }, expected: 'auth-unknown', described: /^status unavailable$/ },
    'error: server not answering': { env: { CCP_LLAMA_PORT: '8080' }, state: { port: 8080, reachable: false, contextWindow: null, error: 'ECONNREFUSED' }, expected: 'backend-down', described: /^NOT RUNNING \(llama-server is not answering on 127\.0\.0\.1:8080 \(ECONNREFUSED\)\. Start it with `llama-server -m <model>\.gguf --jinja --host 127\.0\.0\.1 --port 8080`\.\)$/ },
    'success: answering with a guarded window': { env: { CCP_LLAMA_PORT: '8080' }, state: { port: 8080, reachable: true, contextWindow: 65536 }, expected: 'ready', described: /^llama-server answering on 127\.0\.0\.1:8080, context 65536 tokens$/ },
    'success: answering below the sentry floor, with a warning': { env: { CCP_LLAMA_PORT: '8080' }, state: { port: 8080, reachable: true, contextWindow: 8192 }, expected: 'ready', described: /^llama-server answering on 127\.0\.0\.1:8080, context 8192 tokens; WARNING: below 32768, so there is no compaction sentry.*-c 32768 or more$/ },
    'success: answering in router mode': { env: { CCP_LLAMA_PORT: '8080' }, state: { port: 8080, reachable: true, contextWindow: null }, expected: 'ready', described: /context unknown .*unmeasured 200k row$/ },
  };
  for (const [name, { env, state, expected, described }] of Object.entries(tests)) {
    setLocalServerState(state && { configured: true, ...state });
    const authState = proxyProviderAuthState('local', { run, env });
    assert.equal(authState, expected, name);
    assert.match(describeProxyProviderAuth('local', authState, env), described, name);
    const readiness = getProxyProviderReadiness('local', healthy, { authState: () => authState });
    assert.equal(readiness.ready, expected === 'ready', name);
    if (expected === 'ready') assert.match(readiness.message, /^Local GGUF readiness confirms local binary, \/v1\/models, llama-server reachability, shim/, name);
    else assert.doesNotMatch(readiness.message, /auth login|sign-in status/, `${name}: ${readiness.message}`);
  }
});

test('doctor names a window mismatch between its own environment and the running gateway', (t) => {
  const { localWindowMismatch } = require('../lib/commands.js');
  const { setLocalServerState } = resetLocalState(t);
  const shimRow = (window) => [{ id: 'claude-local/gguf', max_input_tokens: window }];
  setLocalServerState({ port: 8080, configured: true, reachable: true, contextWindow: 40960 });
  assert.equal(localWindowMismatch(shimRow(40960)), null, 'the same window is no mismatch');
  assert.equal(localWindowMismatch([]), null, 'no local row on the gateway is no mismatch');
  assert.match(localWindowMismatch(shimRow(65536)), /^MISMATCH: the running gateway advertises 65536 tokens but this process measured 40960 tokens; CCP_LLAMA_PORT is/);
  setLocalServerState(null);
  assert.match(localWindowMismatch(shimRow(40960)), /advertises 40960 tokens but this process measured no window/);
});

test('the shim advertises the local row at the window its llama-server reports', async (t) => {
  const tests = {
    'success: a 40960 context': { nCtx: 40960, id: 'claude-local/gguf', window: 40960 },
    'success: a 262144 context gets the [1m] alias': { nCtx: 262144, id: 'claude-local/gguf[1m]', window: 262144 },
    'success: router mode stays an unmeasured row': { nCtx: 0, id: 'claude-local/gguf', window: 200000 },
  };
  for (const [name, { nCtx, id, window }] of Object.entries(tests)) {
    await t.test(name, async (st) => {
      const llamaPort = await fakeLlamaServer(st, nCtx);
      const proxy = await listingProxy(st, (res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(llamaStream(1, 0)); });
      const { row } = await spawnShim(st, proxy.port, llamaPort);
      assert.deepEqual(row, { id, display_name: 'local/gguf (Local GGUF)', type: 'model', max_input_tokens: window }, name);
    });
  }
});

test('a llama-server stream that reports input only in message_start still arms the sentry', async (t) => {
  const llamaPort = await fakeLlamaServer(t, 40960);
  const trigger = 40960 - 13653;
  // The input arrives as llama-server sends a cached prompt: most of it as cache reads.
  const proxy = await listingProxy(t, (res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(llamaStream(22, trigger - 21)); });
  const { port } = await spawnShim(t, proxy.port, llamaPort);
  const session = { 'x-claude-code-session-id': 'local-sentry' };

  const first = await request(port, 'POST', '/v1/messages', messageBody('claude-local/gguf'), session);
  assert.equal(first.status, 200, first.body);
  assert.equal(proxy.received.length, 1, 'the first turn reaches the proxy');
  assert.equal(proxy.received[0].model, 'local/gguf', 'the proxy gets the id it listed');

  const second = await request(port, 'POST', '/v1/messages', messageBody('claude-local/gguf'), session);
  assert.equal(second.status, 413, `the turn after usage passed ${trigger} gets the compaction signal: ${second.body}`);
  const { error } = JSON.parse(second.body);
  assert.equal(error.type, 'request_too_large');
  assert.ok(error.message.startsWith(`Prompt is too long for the Local GGUF context window; compact and retry. (${trigger + 1} tokens > ${trigger} tokens)`), error.message);
  assert.equal(proxy.received.length, 1, 'the refused turn is not forwarded');
});

test('a local row below the sentry floor forwards every turn', async (t) => {
  const llamaPort = await fakeLlamaServer(t, 16384);
  const proxy = await listingProxy(t, (res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(llamaStream(22, 16000)); });
  const { port, row } = await spawnShim(t, proxy.port, llamaPort);
  assert.equal(row.max_input_tokens, 16384, 'the row is measured, so its lack of a sentry is the floor, not a missing probe');
  const session = { 'x-claude-code-session-id': 'local-no-sentry' };
  for (const turn of [1, 2]) {
    const response = await request(port, 'POST', '/v1/messages', messageBody('claude-local/gguf'), session);
    assert.equal(response.status, 200, `turn ${turn}: ${response.body}`);
  }
  assert.equal(proxy.received.length, 2, 'no turn is refused by the gateway');
});

test('llama-server context overflow becomes a 413 with its own token counts', async (t) => {
  const llamaPort = await fakeLlamaServer(t, 40960);
  const proxy = await listingProxy(t, (res) => {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { code: 400, message: 'request (45016 tokens) exceeds the available context size (40960 tokens), try increasing it', type: 'exceed_context_size_error', n_prompt_tokens: 45016, n_ctx: 40960 } }));
  });
  const { port } = await spawnShim(t, proxy.port, llamaPort);

  const response = await request(port, 'POST', '/v1/messages', messageBody('claude-local/gguf'));

  assert.equal(response.status, 413, response.body);
  assert.equal(response.headers['x-model-gateway-upstream-status'], '400');
  const { error } = JSON.parse(response.body);
  assert.equal(error.type, 'request_too_large');
  assert.ok(error.message.startsWith('Input exceeds the model context window; compact and retry. (45016 tokens > 40960 tokens)'), error.message);
  assert.deepEqual({ tokens: error.overflow.tokens, tokens_from: error.overflow.tokens_from, limit_tokens: error.overflow.limit_tokens },
    { tokens: 45016, tokens_from: 'upstream', limit_tokens: 40960 });
});

test('a llama-server overflow with its exact limit never lowers the trigger below the window', async (t) => {
  const llamaPort = await fakeLlamaServer(t, 40960);
  // turn 1 uses 20000, turn 2 overflows the server, turn 3 (after compaction) uses 15000.
  const answers = [
    (res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(llamaStream(20, 19980)); },
    (res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(LLAMA_OVERFLOW); },
    (res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(llamaStream(15, 14985)); },
    (res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(llamaStream(15, 14995)); },
  ];
  const proxy = await listingProxy(t, (res) => answers.shift()(res));
  const { port } = await spawnShim(t, proxy.port, llamaPort);
  const session = { 'x-claude-code-session-id': 'local-overflow-ceiling' };
  const statuses = [];
  for (let turn = 0; turn < 4; turn++) {
    statuses.push((await request(port, 'POST', '/v1/messages', messageBody('claude-local/gguf'), session)).status);
  }
  // A learned ceiling of 20000 would put the trigger at 6347 and refuse turn 4 with 15000 used.
  assert.deepEqual(statuses, [200, 413, 200, 200]);
  assert.equal(proxy.received.length, 4, 'every turn reached the proxy');
});

test('a llama-server restarted with another context moves the sentry trigger at the next refresh', async (t) => {
  let nCtx = 65536;
  const llamaPort = await fakeLlamaServer(t, () => nCtx);
  // 30000 is under 65536's trigger (43691) and over 40960's (27307).
  const proxy = await listingProxy(t, (res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(llamaStream(30, 29970)); });
  const { port } = await spawnShim(t, proxy.port, llamaPort, { CODEX_GATEWAY_MODELS_REFRESH_MS: '100' });
  const session = { 'x-claude-code-session-id': 'local-window-change' };

  for (const turn of [1, 2]) {
    const response = await request(port, 'POST', '/v1/messages', messageBody('claude-local/gguf'), session);
    assert.equal(response.status, 200, `turn ${turn} at 65536: ${response.body}`);
  }
  nCtx = 40960;
  await waitFor(async () => {
    const response = await request(port, 'GET', '/v1/models');
    return JSON.parse(response.body).data.find((model) => model.id === 'claude-local/gguf')?.max_input_tokens === 40960;
  }, 'the shim never advertised the new window');

  const refused = await request(port, 'POST', '/v1/messages', messageBody('claude-local/gguf'), session);
  assert.equal(refused.status, 413, refused.body);
  assert.ok(JSON.parse(refused.body).error.message.startsWith('Prompt is too long for the Local GGUF context window; compact and retry. (30000 tokens > 27307 tokens)'), refused.body);
});
