'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { gatewayTestEnvironment, startGateway } = require('./support.js');

// claude-code-proxy's lmstudio provider (dev branch, src/providers/lmstudio.rs) lists every LLM
// downloaded into LM Studio as lmstudio/<model key> and forwards it to LM Studio's local server.
// These fixtures copy what LM Studio 0.4.28 sent on 2026-11-25 with a GGUF model on its llama.cpp
// engine: the /api/v1/models entry of a loaded and an unloaded model, usage whose input_tokens
// already contains its cache_read_input_tokens, and the two shapes of a prompt that does not fit
// (HTTP 500 without streaming, HTTP 200 with an error event as the first frame with it).
const SECRET = 'lmstudio-test-token-never-printed';
const LMSTUDIO_LISTING = [
  { type: 'model', object: 'model', id: 'lmstudio/qwen3-coder-30b', display_name: 'lmstudio/qwen3-coder-30b (lmstudio)' },
  { type: 'model', object: 'model', id: 'lmstudio/ibm/granite-4-micro', display_name: 'lmstudio/ibm/granite-4-micro (lmstudio)' },
  { type: 'model', object: 'model', id: 'lmstudio/qwen/qwen3-4b@q4_k_m', display_name: 'lmstudio/qwen/qwen3-4b@q4_k_m (lmstudio)' },
  { type: 'model', object: 'model', id: 'kimi-k3', display_name: 'kimi-k3 (kimi)' },
];
const LMSTUDIO_ROUTES = LMSTUDIO_LISTING.filter(({ id }) => id.startsWith('lmstudio/')).map(({ id }) => ({ id, provider: 'lmstudio' }));

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
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

// One /api/v1/models entry. `instances` are [id, context_length] pairs, in the order LM Studio
// would list them.
function catalogModel(key, instances = [], type = 'llm') {
  return {
    type,
    publisher: 'example',
    key,
    display_name: key,
    max_context_length: 262144,
    format: 'gguf',
    capabilities: { vision: false, trained_for_tool_use: true },
    loaded_instances: instances.map(([id, contextLength]) => ({
      id,
      config: { context_length: contextLength, eval_batch_size: 2048, parallel: 4, flash_attention: true },
      remaining_ttl_seconds: 900,
    })),
  };
}

// An LM Studio stand-in that answers /api/v1/models with `models` (an array, or a function read on
// every request, for a model reloaded with another context) and records the headers it was sent.
async function fakeLmStudio(t, models, { status = 200, requireToken = null, body = null } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    if (req.method !== 'GET' || req.url !== '/api/v1/models') {
      res.writeHead(404);
      return res.end();
    }
    if (requireToken && req.headers.authorization !== `Bearer ${requireToken}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'An LM Studio API token is required to make requests to this server.', type: 'invalid_api_key' } }));
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body ?? JSON.stringify({ models: typeof models === 'function' ? models() : models }));
  });
  const port = await listen(server);
  t.after(() => close(server));
  return { port, baseUrl: `http://127.0.0.1:${port}`, seen };
}

async function closedPort() {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

// A directory holding the proxy's config.json with the given lmstudio section, or none at all.
function configDirectory(t, lmstudio) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-lmstudio-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  if (lmstudio !== undefined) fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ lmstudio }));
  return directory;
}

function sseFrame(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

// A stream as LM Studio sends it: the same usage in message_start and message_delta, with the
// cached part of the prompt counted in input_tokens and again in cache_read_input_tokens.
function lmStudioStream(promptTokens, cachedTokens, model = 'qwen3-coder-30b') {
  const usage = (outputTokens) => ({ input_tokens: promptTokens, output_tokens: outputTokens, cache_read_input_tokens: cachedTokens });
  return [
    { type: 'message_start', message: { id: 'msg_x', type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null, usage: usage(0) } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: usage(2) },
    { type: 'message_stop' },
  ].map(sseFrame).join('');
}

function overflowError(promptTokens, context) {
  const engine = { error: { code: 400, message: `request (${promptTokens} tokens) exceeds the available context size (${context} tokens), try increasing it`, type: 'exceed_context_size_error', n_prompt_tokens: promptTokens, n_ctx: context } };
  return { type: 'error', error: { type: 'api_error', message: `Engine protocol predict request returned 400: ${JSON.stringify(engine)}` } };
}

const respondWith = {
  stream: (text) => (res) => { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); res.end(text); },
  json: (status, value) => (res) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); },
};

// Answers /v1/models with LMSTUDIO_LISTING and hands every other request to `respond`, recording it.
// `headers` holds the headers of every request, the listing ones included.
async function listingProxy(t, respond) {
  const received = [];
  const headers = [];
  const server = http.createServer((req, res) => {
    headers.push(req.headers);
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: LMSTUDIO_LISTING, has_more: false }));
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString()));
      respond(res, req);
    });
  });
  const port = await listen(server);
  t.after(() => close(server));
  return { port, received, headers };
}

// The settings a developer's shell or config.json could carry are pinned, so the shim under test
// asks the stand-in and never the LM Studio that may be running on this machine.
function lmStudioEnvironment(t, baseUrl, extra = {}) {
  return {
    CCP_LMSTUDIO_ENABLED: '1',
    CCP_LMSTUDIO_BASE_URL: baseUrl,
    CCP_LMSTUDIO_API_KEY: '',
    LM_API_TOKEN: '',
    CCP_CONFIG_DIR: configDirectory(t),
    ...extra,
  };
}

async function spawnShim(t, proxyPort, baseUrl, extraEnv = {}) {
  const environment = gatewayTestEnvironment(t, {
    CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
    CODEX_GATEWAY_REQUEST_LOG: '0',
    CODEX_GATEWAY_ANTHROPIC_UPSTREAM: 'http://127.0.0.1:9',
    ...lmStudioEnvironment(t, baseUrl, extraEnv),
  });
  const { port } = await startGateway(t, 'serve-shim', environment);
  const rows = await waitFor(async () => {
    const response = await request(port, 'GET', '/v1/models');
    const found = JSON.parse(response.body).data.filter((model) => model.id.startsWith('claude-lmstudio/'));
    return found.length ? found : null;
  }, 'shim never advertised an LM Studio row');
  return { port, rows };
}

function messageBody(model, stream = true) {
  return JSON.stringify({ model, max_tokens: 16, stream, messages: [{ role: 'user', content: 'hello' }] });
}

// Module state (the route table and the last LM Studio probe) is shared by the in-process tests.
function resetLmStudioState(t) {
  const { setLmStudioServerState, setProxyModelRoutes } = require('../lib/proxy-models.js');
  setProxyModelRoutes(LMSTUDIO_ROUTES);
  setLmStudioServerState(null);
  t.after(() => { setLmStudioServerState(null); setProxyModelRoutes([]); });
  return { setLmStudioServerState };
}

function probedState(baseUrl, models, extra = {}) {
  return { enabled: true, baseUrl, hasApiKey: false, reachable: true, models: new Map(Object.entries(models)), ...extra };
}

test('LM Studio settings resolve the way the proxy resolves them', (t) => {
  const { lmStudioSettings } = require('../lib/lmstudio.js');
  const fromFile = configDirectory(t, { baseUrl: 'http://localhost:4321/', apiKey: 'from-file' });
  const offInFile = configDirectory(t, { enabled: false });
  const empty = configDirectory(t);
  const invalid = (setting, reason) => ({ enabled: true, invalid: { setting, reason } });
  const tests = {
    'success: nothing set, the default server with no token': { env: {}, directory: empty, expected: { enabled: true, baseUrl: 'http://127.0.0.1:1234', apiKey: null } },
    'success: config.json supplies the server and the token': { env: {}, directory: fromFile, expected: { enabled: true, baseUrl: 'http://localhost:4321', apiKey: 'from-file' } },
    'success: the environment wins over config.json': { env: { CCP_LMSTUDIO_BASE_URL: 'http://[::1]:1235', CCP_LMSTUDIO_API_KEY: 'from-env' }, directory: fromFile, expected: { enabled: true, baseUrl: 'http://[::1]:1235', apiKey: 'from-env' } },
    'success: the proxy token variable wins over LM Studio\'s own': { env: { CCP_LMSTUDIO_API_KEY: 'ccp', LM_API_TOKEN: 'lm' }, directory: empty, expected: { enabled: true, baseUrl: 'http://127.0.0.1:1234', apiKey: 'ccp' } },
    'success: LM Studio\'s own token variable wins over config.json': { env: { LM_API_TOKEN: 'lm' }, directory: fromFile, expected: { enabled: true, baseUrl: 'http://localhost:4321', apiKey: 'lm' } },
    'success: blank values count as not set': { env: { CCP_LMSTUDIO_BASE_URL: '  ', CCP_LMSTUDIO_API_KEY: '' }, directory: fromFile, expected: { enabled: true, baseUrl: 'http://localhost:4321', apiKey: 'from-file' } },
    'success: surrounding whitespace is trimmed': { env: { CCP_LMSTUDIO_BASE_URL: ' http://127.0.0.1:9999 ' }, directory: empty, expected: { enabled: true, baseUrl: 'http://127.0.0.1:9999', apiKey: null } },
    'success: a fully qualified localhost is a loopback host': { env: { CCP_LMSTUDIO_BASE_URL: 'http://LOCALHOST.:1234' }, directory: empty, expected: { enabled: true, baseUrl: 'http://localhost.:1234', apiKey: null } },
    'success: any 127.0.0.0/8 address is a loopback host': { env: { CCP_LMSTUDIO_BASE_URL: 'http://127.8.9.10:1234/' }, directory: empty, expected: { enabled: true, baseUrl: 'http://127.8.9.10:1234', apiKey: null } },
    'success: https to another machine': { env: { CCP_LMSTUDIO_BASE_URL: 'https://lmstudio.example:8443' }, directory: empty, expected: { enabled: true, baseUrl: 'https://lmstudio.example:8443', apiKey: null } },
    'success: an unrecognised enabled value is ignored': { env: { CCP_LMSTUDIO_ENABLED: 'maybe' }, directory: empty, expected: { enabled: true, baseUrl: 'http://127.0.0.1:1234', apiKey: null } },
    'success: the environment turns a provider back on that config.json turned off': { env: { CCP_LMSTUDIO_ENABLED: ' ON ' }, directory: offInFile, expected: { enabled: true, baseUrl: 'http://127.0.0.1:1234', apiKey: null } },
    'error: turned off in config.json': { env: {}, directory: offInFile, expected: { enabled: false } },
    'error: turned off by 0': { env: { CCP_LMSTUDIO_ENABLED: '0' }, directory: empty, expected: { enabled: false } },
    'error: turned off by false': { env: { CCP_LMSTUDIO_ENABLED: 'False' }, directory: empty, expected: { enabled: false } },
    'error: turned off by no': { env: { CCP_LMSTUDIO_ENABLED: 'no' }, directory: empty, expected: { enabled: false } },
    'error: turned off by off': { env: { CCP_LMSTUDIO_ENABLED: 'off' }, directory: empty, expected: { enabled: false } },
    'error: plain http to another machine would send the token in the clear': { env: { CCP_LMSTUDIO_BASE_URL: 'http://lmstudio.example:1234' }, directory: empty, expected: invalid('CCP_LMSTUDIO_BASE_URL', 'must use https (plain http only for a loopback host)') },
    'error: a path such as /v1': { env: { CCP_LMSTUDIO_BASE_URL: 'http://127.0.0.1:1234/v1' }, directory: empty, expected: invalid('CCP_LMSTUDIO_BASE_URL', 'must be a scheme, a host and a port only, without a path such as /v1') },
    'error: a query': { env: { CCP_LMSTUDIO_BASE_URL: 'http://127.0.0.1:1234/?x=1' }, directory: empty, expected: invalid('CCP_LMSTUDIO_BASE_URL', 'must be a scheme, a host and a port only, without a path such as /v1') },
    'error: a fragment': { env: { CCP_LMSTUDIO_BASE_URL: 'http://127.0.0.1:1234/#x' }, directory: empty, expected: invalid('CCP_LMSTUDIO_BASE_URL', 'must be a scheme, a host and a port only, without a path such as /v1') },
    'error: credentials in the URL': { env: { CCP_LMSTUDIO_BASE_URL: 'http://user:pass@127.0.0.1:1234' }, directory: empty, expected: invalid('CCP_LMSTUDIO_BASE_URL', 'must not contain a user name or password') },
    'error: a host and port with no scheme': { env: { CCP_LMSTUDIO_BASE_URL: 'localhost:1234' }, directory: empty, expected: invalid('CCP_LMSTUDIO_BASE_URL', 'the URL has no host') },
    'error: not a URL': { env: { CCP_LMSTUDIO_BASE_URL: 'lm studio' }, directory: empty, expected: invalid('CCP_LMSTUDIO_BASE_URL', 'not a valid URL') },
    'error: a config.json section with a field of the wrong type supplies nothing, as the proxy discards the file': { env: {}, directory: configDirectory(t, { enabled: 'false', baseUrl: 'http://127.0.0.1:4321', apiKey: 'from-file' }), expected: { enabled: true, baseUrl: 'http://127.0.0.1:1234', apiKey: null } },
    'error: a config.json section that is not an object supplies nothing': { env: {}, directory: configDirectory(t, ['http://127.0.0.1:4321']), expected: { enabled: true, baseUrl: 'http://127.0.0.1:1234', apiKey: null } },
    'success: null fields in config.json count as not set': { env: {}, directory: configDirectory(t, { enabled: null, baseUrl: null, apiKey: 'from-file' }), expected: { enabled: true, baseUrl: 'http://127.0.0.1:1234', apiKey: 'from-file' } },
    'error: an invalid server in config.json is named as such': { env: {}, directory: configDirectory(t, { baseUrl: 'ftp://127.0.0.1:1234' }), expected: invalid('lmstudio.baseUrl in config.json', 'must use https (plain http only for a loopback host)') },
  };
  for (const [name, { env, directory, expected }] of Object.entries(tests)) {
    assert.deepEqual(lmStudioSettings({ env, configDirectory: directory }), expected, name);
  }
});

test('the LM Studio probe reads each loaded context and reports every failure as state', async (t) => {
  const { fetchUrl } = require('../lib/process-supervision.js');
  const { probeLmStudio } = require('../lib/lmstudio.js');
  const empty = configDirectory(t);
  const catalog = [
    catalogModel('qwen3-coder-30b', [['qwen3-coder-30b', 65536]]),
    catalogModel('ibm/granite-4-micro'),
    // A second instance under another identifier: a request naming the key goes to the instance
    // whose id is the key, whichever is listed first.
    catalogModel('qwen/qwen3-4b@q4_k_m', [['small-copy', 8192], ['qwen/qwen3-4b@q4_k_m', 131072]]),
    // No instance carries the key as its id, so the smallest loaded context stands in.
    catalogModel('renamed-only', [['first', 40960], ['second', 16384]]),
    catalogModel('loaded-without-a-context', [['loaded-without-a-context', 0]]),
    catalogModel('text-embedding-nomic-embed-text-v1.5', [], 'embedding'),
    { type: 'llm', key: '' },
    { type: 'llm' },
  ];
  const expectedModels = new Map([
    ['qwen3-coder-30b', { loaded: true, contextWindow: 65536 }],
    ['ibm/granite-4-micro', { loaded: false, contextWindow: null }],
    ['qwen/qwen3-4b@q4_k_m', { loaded: true, contextWindow: 131072 }],
    ['renamed-only', { loaded: true, contextWindow: 16384 }],
    ['loaded-without-a-context', { loaded: true, contextWindow: null }],
  ]);
  const open = await fakeLmStudio(t, catalog);
  const locked = await fakeLmStudio(t, catalog, { requireToken: SECRET });
  const old = await fakeLmStudio(t, catalog, { status: 404 });
  const garbled = await fakeLmStudio(t, catalog, { body: '<html>not LM Studio</html>' });
  const refused = `http://127.0.0.1:${await closedPort()}`;
  const none = { baseUrl: null, hasApiKey: false, reachable: false, models: new Map() };
  const tests = {
    'success: a running server': { env: { CCP_LMSTUDIO_BASE_URL: open.baseUrl }, expected: { enabled: true, baseUrl: open.baseUrl, hasApiKey: false, reachable: true, models: expectedModels } },
    'success: a server that requires the token it is given': { env: { CCP_LMSTUDIO_BASE_URL: locked.baseUrl, CCP_LMSTUDIO_API_KEY: SECRET }, expected: { enabled: true, baseUrl: locked.baseUrl, hasApiKey: true, reachable: true, models: expectedModels } },
    'error: a server that requires a token and gets none': { env: { CCP_LMSTUDIO_BASE_URL: locked.baseUrl }, expected: { enabled: true, baseUrl: locked.baseUrl, hasApiKey: false, reachable: true, models: new Map(), authRequired: true } },
    'error: a server that refuses the token it is given': { env: { CCP_LMSTUDIO_BASE_URL: locked.baseUrl, LM_API_TOKEN: 'wrong-token' }, expected: { enabled: true, baseUrl: locked.baseUrl, hasApiKey: true, reachable: true, models: new Map(), authRequired: true } },
    'error: a server without the listing, as before LM Studio 0.4.1': { env: { CCP_LMSTUDIO_BASE_URL: old.baseUrl }, expected: { enabled: true, baseUrl: old.baseUrl, hasApiKey: false, reachable: false, models: new Map(), error: 'GET /api/v1/models answered HTTP 404' } },
    'error: something that is not LM Studio': { env: { CCP_LMSTUDIO_BASE_URL: garbled.baseUrl }, expected: { enabled: true, baseUrl: garbled.baseUrl, hasApiKey: false, reachable: false, models: new Map(), error: 'GET /api/v1/models returned no model list' } },
    'error: nothing listening': { env: { CCP_LMSTUDIO_BASE_URL: refused }, expected: { enabled: true, baseUrl: refused, hasApiKey: false, reachable: false, models: new Map(), error: 'ECONNREFUSED' } },
    'error: turned off': { env: { CCP_LMSTUDIO_ENABLED: 'off', CCP_LMSTUDIO_BASE_URL: open.baseUrl }, expected: { enabled: false, ...none } },
    'error: an invalid server setting is never contacted': { env: { CCP_LMSTUDIO_BASE_URL: `${open.baseUrl}/v1`, CCP_LMSTUDIO_API_KEY: SECRET }, expected: { enabled: true, ...none, invalid: { setting: 'CCP_LMSTUDIO_BASE_URL', reason: 'must be a scheme, a host and a port only, without a path such as /v1' } } },
  };
  for (const [name, { env, expected }] of Object.entries(tests)) {
    const state = await probeLmStudio({ env, configDirectory: empty, fetchUrl });
    assert.deepEqual(state, expected, name);
    assert.doesNotMatch(JSON.stringify({ ...state, models: [...state.models] }), new RegExp(`${SECRET}|wrong-token`), `${name}: the token is not part of the state`);
  }
  assert.deepEqual(open.seen.map(({ url, authorization }) => ({ url, authorization })), [{ url: '/api/v1/models', authorization: undefined }],
    'no token set, no Authorization header; the turned-off and invalid settings sent nothing');
  assert.deepEqual(locked.seen.map(({ authorization }) => authorization), [`Bearer ${SECRET}`, undefined, 'Bearer wrong-token']);
});

test('a stopped LM Studio keeps its last windows, and an unlisted provider clears them', async (t) => {
  const { fetchUrl } = require('../lib/process-supervision.js');
  const { refreshLmStudioState } = require('../lib/lmstudio.js');
  const { lmStudioServerState } = require('../lib/proxy-models.js');
  resetLmStudioState(t);
  const empty = configDirectory(t);
  let instances = [['qwen3-coder-30b', 65536]];
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [catalogModel('qwen3-coder-30b', instances)] }));
  });
  const port = await listen(server);
  const env = { CCP_LMSTUDIO_BASE_URL: `http://127.0.0.1:${port}` };
  const refresh = (routes = LMSTUDIO_ROUTES, environment = env) => refreshLmStudioState(routes, { env: environment, configDirectory: empty, fetchUrl });

  assert.equal((await refresh()).models.get('qwen3-coder-30b').contextWindow, 65536);
  instances = [];
  assert.equal((await refresh()).models.get('qwen3-coder-30b').contextWindow, null, 'a server that answers decides afresh: an unloaded model has no window');
  instances = [['qwen3-coder-30b', 40960]];
  assert.equal((await refresh()).models.get('qwen3-coder-30b').contextWindow, 40960);

  await close(server);
  const down = await refresh();
  assert.equal(down.reachable, false, 'the outage is reported');
  assert.equal(down.models.get('qwen3-coder-30b').contextWindow, 40960, 'the window measured before the outage stays, so the picker id does not change');
  assert.equal(lmStudioServerState(), down, 'policy resolution reads the same state');

  const moved = await refresh(LMSTUDIO_ROUTES, { CCP_LMSTUDIO_BASE_URL: `http://127.0.0.1:${await closedPort()}` });
  assert.equal(moved.models.size, 0, 'a different address is a different server');

  assert.equal(await refresh([{ id: 'kimi-k3', provider: 'kimi' }]), null);
  assert.equal(lmStudioServerState(), null, 'no LM Studio row, no LM Studio state');
});

test('an LM Studio row takes the window its model is loaded with, and none until it is loaded', (t) => {
  const { effectiveSentryPolicy, gatewayAdvertisedWindow, gatewayClientModelId, resolveGatewayModelPolicy } = require('../lib/runtime.js');
  const { setLmStudioServerState } = resetLmStudioState(t);
  const picker = 'claude-lmstudio/ibm/granite-4-micro';
  const tests = {
    'success: no probe yet, the unmeasured 200k row': { model: undefined, sentry: 'none', trigger: null, advertised: 200000, id: picker },
    'success: not loaded, the unmeasured 200k row': { model: { loaded: false, contextWindow: null }, sentry: 'none', trigger: null, advertised: 200000, id: picker },
    'error: 8192, below the floor, so no sentry': { model: { loaded: true, contextWindow: 8192 }, sentry: 'none', trigger: null, advertised: 8192, id: picker },
    'success: 32768, the floor': { model: { loaded: true, contextWindow: 32768 }, sentry: 'synthetic-413', trigger: 32768 - 10922, advertised: 32768, id: picker },
    'success: 65536': { model: { loaded: true, contextWindow: 65536 }, sentry: 'synthetic-413', trigger: 65536 - 21845, advertised: 65536, id: picker },
    'success: 131072, where the reserve reaches 40000': { model: { loaded: true, contextWindow: 131072 }, sentry: 'synthetic-413', trigger: 91072, advertised: 131072, id: picker },
    'success: 262144, above 200k, so the [1m] alias': { model: { loaded: true, contextWindow: 262144 }, sentry: 'synthetic-413', trigger: 222144, advertised: 262144, id: `${picker}[1m]` },
    'success: 1048576, capped at the alias client window': { model: { loaded: true, contextWindow: 1048576 }, sentry: 'synthetic-413', trigger: 1008576, advertised: 1000000, id: `${picker}[1m]` },
  };
  for (const [name, { model, sentry, trigger, advertised, id }] of Object.entries(tests)) {
    setLmStudioServerState(model === undefined ? null : probedState('http://127.0.0.1:1234', { 'ibm/granite-4-micro': model, 'qwen3-coder-30b': { loaded: true, contextWindow: 16384 } }));
    for (const spelling of [picker, `${picker}[1m]`, 'lmstudio/ibm/granite-4-micro']) {
      const policy = resolveGatewayModelPolicy(spelling);
      assert.equal(policy.backend, 'lmstudio', name);
      assert.equal(policy.backendId, 'lmstudio/ibm/granite-4-micro', name);
      assert.equal(policy.transport, 'proxy', name);
      assert.equal(policy.sentry, sentry, name);
      assert.equal(effectiveSentryPolicy(policy)?.compactTrigger ?? null, trigger, name);
    }
    assert.equal(gatewayAdvertisedWindow(picker), advertised, name);
    assert.equal(gatewayClientModelId(picker), id, name);
    if (model?.contextWindow) {
      assert.equal(resolveGatewayModelPolicy(picker).measurement,
        `LM Studio /api/v1/models loaded context_length ${model.contextWindow} at http://127.0.0.1:1234, read live`, name);
    }
  }
});

test('LM Studio readiness is what its server answered, never a proxy sign-in', (t) => {
  const { describeProxyProviderAuth, getProxyProviderReadiness, proxyProviderAuthState } = require('../lib/commands.js');
  const { setLmStudioServerState } = resetLmStudioState(t);
  const run = () => { throw new Error('`claude-code-proxy lmstudio auth status` always exits 0; no status process may start'); };
  const healthy = { checks: { proxyBinary: true, proxyModels: true, shimRunning: true, servingVersionMatches: true } };
  const directory = configDirectory(t);
  const base = 'http://127.0.0.1:1234';
  const loaded = (contextWindow) => ({ loaded: true, contextWindow });
  const unloaded = { loaded: false, contextWindow: null };
  const tests = {
    'error: turned off where the check runs': { env: { CCP_LMSTUDIO_ENABLED: 'off' }, state: null, expected: 'config-invalid', described: /^NOT CONFIGURED \(claude-code-proxy lists LM Studio models, but the provider is turned off where this check runs.*Use the same CCP_LMSTUDIO_ENABLED where the gateway starts.*model-gateway\.js" stop`, then `node ".*model-gateway\.js" start`\.\)$/ },
    'error: an invalid server setting, and the message names it and the reason': { env: { CCP_LMSTUDIO_BASE_URL: 'http://lmstudio.example:1234' }, state: null, expected: 'config-invalid', described: /^NOT CONFIGURED \(claude-code-proxy lists LM Studio models, but the LM Studio setting CCP_LMSTUDIO_BASE_URL is invalid where this check runs \(must use https \(plain http only for a loopback host\)\)/ },
    'error: not probed in this process': { env: {}, state: null, expected: 'auth-unknown', described: /^status unavailable$/ },
    'error: probed a different server': { env: { CCP_LMSTUDIO_BASE_URL: 'http://127.0.0.1:4321' }, state: probedState(base, {}), expected: 'auth-unknown', described: /^status unavailable$/ },
    'error: server not answering': { env: {}, state: probedState(base, {}, { reachable: false, error: 'ECONNREFUSED' }), expected: 'backend-down', described: /^NOT RUNNING \(LM Studio's server is not answering at http:\/\/127\.0\.0\.1:1234 \(ECONNREFUSED\)\. Start it with `lms server start` or from the LM Studio app's Developer page; LM Studio 0\.4\.1 or later is required\.\)$/ },
    'error: server requires a token and none is set': { env: {}, state: probedState(base, {}, { authRequired: true }), expected: 'auth-missing', described: /^MISSING \(LM Studio at http:\/\/127\.0\.0\.1:1234 requires an API token: set CCP_LMSTUDIO_API_KEY \(or LM_API_TOKEN\) where the gateway starts .*, or lmstudio\.apiKey in .*config\.json; the token comes from LM Studio's server settings\. Then restart the gateway: / },
    'error: server refuses the token that is set': { env: { CCP_LMSTUDIO_API_KEY: SECRET }, state: probedState(base, {}, { authRequired: true, hasApiKey: true }), expected: 'auth-missing', described: /^MISSING \(LM Studio at http:\/\/127\.0\.0\.1:1234 refused the API token it was sent: check CCP_LMSTUDIO_API_KEY/ },
    'success: one model loaded with a guarded window, one not loaded': { env: {}, state: probedState(base, { 'qwen3-coder-30b': loaded(65536), 'ibm/granite-4-micro': unloaded }), expected: 'ready', described: /^LM Studio answering at http:\/\/127\.0\.0\.1:1234, 2 models, 1 loaded \(qwen3-coder-30b context 65536 tokens\); a model that is not loaded is an unmeasured 200k row with no compaction sentry until LM Studio loads it, which it does on the first request with that model's default context: load it first with `lms load <model key> --context-length <tokens>`$/ },
    'success: every model loaded, nothing to add': { env: {}, state: probedState(base, { 'qwen3-coder-30b': loaded(65536) }), expected: 'ready', described: /^LM Studio answering at http:\/\/127\.0\.0\.1:1234, 1 model, 1 loaded \(qwen3-coder-30b context 65536 tokens\)$/ },
    'success: a model loaded below the sentry floor, with a warning that names it': { env: {}, state: probedState(base, { 'qwen3-coder-30b': loaded(65536), 'ibm/granite-4-micro': loaded(4096) }), expected: 'ready', described: /^LM Studio answering at http:\/\/127\.0\.0\.1:1234, 2 models, 2 loaded \(qwen3-coder-30b context 65536 tokens, ibm\/granite-4-micro context 4096 tokens\); WARNING: ibm\/granite-4-micro loaded below 32768, so there is no compaction sentry.*`lms unload <model key>`, then `lms load <model key> --context-length 32768` or more$/ },
    'success: nothing loaded': { env: {}, state: probedState(base, { 'qwen3-coder-30b': unloaded }), expected: 'ready', described: /^LM Studio answering at http:\/\/127\.0\.0\.1:1234, 1 model, 0 loaded; a model that is not loaded is an unmeasured 200k row/ },
  };
  for (const [name, { env, state, expected, described }] of Object.entries(tests)) {
    setLmStudioServerState(state);
    const environment = { ...env, CCP_CONFIG_DIR: directory };
    const authState = proxyProviderAuthState('lmstudio', { run, env: environment, configDirectory: directory });
    assert.equal(authState, expected, name);
    const line = describeProxyProviderAuth('lmstudio', authState, environment);
    assert.match(line, described, name);
    assert.doesNotMatch(line, new RegExp(SECRET), `${name}: the token is never printed`);
    const readiness = getProxyProviderReadiness('lmstudio', healthy, { authState: () => authState });
    assert.equal(readiness.ready, expected === 'ready', name);
    if (expected === 'ready') assert.match(readiness.message, /^LM Studio readiness confirms local binary, \/v1\/models, LM Studio server reachability, shim/, name);
    else assert.doesNotMatch(readiness.message, /auth login|sign-in status/, `${name}: ${readiness.message}`);
  }
});

test('the shim advertises each LM Studio model at the window it is loaded with', async (t) => {
  const lmStudio = await fakeLmStudio(t, [
    catalogModel('qwen3-coder-30b', [['qwen3-coder-30b', 65536]]),
    catalogModel('ibm/granite-4-micro', [['ibm/granite-4-micro', 262144]]),
    catalogModel('qwen/qwen3-4b@q4_k_m'),
    catalogModel('text-embedding-nomic-embed-text-v1.5', [], 'embedding'),
  ]);
  const proxy = await listingProxy(t, respondWith.stream(lmStudioStream(19, 15, 'qwen/qwen3-4b@q4_k_m')));
  const { port, rows } = await spawnShim(t, proxy.port, lmStudio.baseUrl);

  assert.deepEqual(rows, [
    { id: 'claude-lmstudio/qwen3-coder-30b', display_name: 'lmstudio/qwen3-coder-30b (LM Studio)', type: 'model', max_input_tokens: 65536 },
    { id: 'claude-lmstudio/ibm/granite-4-micro[1m]', display_name: 'lmstudio/ibm/granite-4-micro (LM Studio)', type: 'model', max_input_tokens: 262144 },
    { id: 'claude-lmstudio/qwen/qwen3-4b@q4_k_m', display_name: 'lmstudio/qwen/qwen3-4b@q4_k_m (LM Studio)', type: 'model', max_input_tokens: 200000 },
  ]);
  assert.ok(lmStudio.seen.every(({ authorization }) => authorization === undefined), 'no token set, no Authorization header');

  for (const [picker, backend] of [['claude-lmstudio/qwen/qwen3-4b@q4_k_m', 'lmstudio/qwen/qwen3-4b@q4_k_m'], ['claude-lmstudio/ibm/granite-4-micro[1m]', 'lmstudio/ibm/granite-4-micro']]) {
    const response = await request(port, 'POST', '/v1/messages', messageBody(picker));
    assert.equal(response.status, 200, response.body);
    assert.equal(proxy.received.at(-1).model, backend, 'the proxy gets the id it listed');
  }
});

test('the shim sends the LM Studio token to its server and to nothing else', async (t) => {
  const lmStudio = await fakeLmStudio(t, [catalogModel('qwen3-coder-30b', [['qwen3-coder-30b', 65536]])], { requireToken: SECRET });
  const proxy = await listingProxy(t, respondWith.stream(lmStudioStream(19, 15)));
  const { port } = await spawnShim(t, proxy.port, lmStudio.baseUrl, { LM_API_TOKEN: SECRET });
  // The window can only come from a listing the server answered, which it does for the token alone.
  const row = await waitFor(async () => JSON.parse((await request(port, 'GET', '/v1/models')).body).data
    .find((model) => model.id === 'claude-lmstudio/qwen3-coder-30b' && model.max_input_tokens === 65536), 'the probe never read the window');
  assert.equal(row.display_name, 'lmstudio/qwen3-coder-30b (LM Studio)');
  assert.ok(lmStudio.seen.length && lmStudio.seen.every(({ authorization }) => authorization === `Bearer ${SECRET}`), 'every probe carried the token');

  const response = await request(port, 'POST', '/v1/messages', messageBody('claude-lmstudio/qwen3-coder-30b'));
  assert.equal(response.status, 200, response.body);
  assert.ok(proxy.headers.length > 1, 'the proxy saw the listing and the request');
  assert.doesNotMatch(JSON.stringify(proxy.headers), new RegExp(SECRET), 'the proxy holds its own copy of the token; the gateway never sends it one');
});

test('LM Studio usage is counted once: the cached part is not added to an input that already holds it', async (t) => {
  const lmStudio = await fakeLmStudio(t, [catalogModel('qwen3-coder-30b', [['qwen3-coder-30b', 65536]])]);
  const trigger = 65536 - 21845;
  // Each turn is a 30000-token prompt of which LM Studio read 29990 from its cache. Added up as
  // the Messages API means them, that is 59990, past the 43691 trigger; the prompt is 30000.
  const proxy = await listingProxy(t, respondWith.stream(lmStudioStream(30000, 29990)));
  const { port } = await spawnShim(t, proxy.port, lmStudio.baseUrl);
  const session = { 'x-claude-code-session-id': 'lmstudio-inclusive-usage' };

  for (const turn of [1, 2, 3]) {
    const response = await request(port, 'POST', '/v1/messages', messageBody('claude-lmstudio/qwen3-coder-30b'), session);
    assert.equal(response.status, 200, `turn ${turn} at 30000 of ${trigger}: ${response.body}`);
    const usages = response.body.split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5)))
      .map((event) => event.message?.usage ?? event.usage).filter(Boolean);
    assert.deepEqual(usages, [
      { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 29990 },
      { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 29990 },
    ], 'the client reads usage that adds up to the prompt');
  }
  assert.equal(proxy.received.length, 3, 'no turn is refused by the gateway');
});

test('LM Studio usage past the trigger still arms the sentry', async (t) => {
  const lmStudio = await fakeLmStudio(t, [catalogModel('qwen3-coder-30b', [['qwen3-coder-30b', 65536]])]);
  const trigger = 65536 - 21845;
  const proxy = await listingProxy(t, respondWith.stream(lmStudioStream(trigger + 1, trigger - 20)));
  const { port } = await spawnShim(t, proxy.port, lmStudio.baseUrl);
  const session = { 'x-claude-code-session-id': 'lmstudio-sentry' };

  const first = await request(port, 'POST', '/v1/messages', messageBody('claude-lmstudio/qwen3-coder-30b'), session);
  assert.equal(first.status, 200, first.body);
  const second = await request(port, 'POST', '/v1/messages', messageBody('claude-lmstudio/qwen3-coder-30b'), session);
  assert.equal(second.status, 413, `the turn after usage passed ${trigger} gets the compaction signal: ${second.body}`);
  const { error } = JSON.parse(second.body);
  assert.equal(error.type, 'request_too_large');
  assert.ok(error.message.startsWith(`Prompt is too long for the LM Studio context window; compact and retry. (${trigger + 1} tokens > ${trigger} tokens)`), error.message);
  assert.equal(proxy.received.length, 1, 'the refused turn is not forwarded');
});

test('LM Studio usage in a non-streaming answer is corrected the same way', async (t) => {
  const lmStudio = await fakeLmStudio(t, [catalogModel('qwen3-coder-30b', [['qwen3-coder-30b', 65536]])]);
  const answer = { id: 'msg_x', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], model: 'qwen3-coder-30b', stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 3013, output_tokens: 8, cache_read_input_tokens: 2497 } };
  const proxy = await listingProxy(t, respondWith.json(200, answer));
  const { port } = await spawnShim(t, proxy.port, lmStudio.baseUrl);

  const response = await request(port, 'POST', '/v1/messages', messageBody('claude-lmstudio/qwen3-coder-30b', false));

  assert.equal(response.status, 200, response.body);
  assert.deepEqual(JSON.parse(response.body).usage, { input_tokens: 516, output_tokens: 8, cache_read_input_tokens: 2497 });
});

test('usage that cannot be an inclusive count is left as it came', async (t) => {
  const lmStudio = await fakeLmStudio(t, [catalogModel('qwen3-coder-30b', [['qwen3-coder-30b', 65536]])]);
  // An input below its cache read is already the Messages API's meaning.
  const proxy = await listingProxy(t, respondWith.stream(lmStudioStream(22, 3000)));
  const { port } = await spawnShim(t, proxy.port, lmStudio.baseUrl);

  const response = await request(port, 'POST', '/v1/messages', messageBody('claude-lmstudio/qwen3-coder-30b'));

  assert.equal(response.status, 200, response.body);
  assert.match(response.body, /"usage":\{"input_tokens":22,"output_tokens":2,"cache_read_input_tokens":3000\}/);
});

test('a prompt LM Studio refuses without streaming becomes a 413 with its own token counts', async (t) => {
  const lmStudio = await fakeLmStudio(t, [catalogModel('qwen3-coder-30b', [['qwen3-coder-30b', 4096]])]);
  const proxy = await listingProxy(t, respondWith.json(500, overflowError(6017, 4096)));
  const { port } = await spawnShim(t, proxy.port, lmStudio.baseUrl);

  const response = await request(port, 'POST', '/v1/messages', messageBody('claude-lmstudio/qwen3-coder-30b', false));

  assert.equal(response.status, 413, response.body);
  assert.equal(response.headers['x-model-gateway-upstream-status'], '500');
  const { error } = JSON.parse(response.body);
  assert.equal(error.type, 'request_too_large');
  assert.ok(error.message.startsWith('Input exceeds the model context window; compact and retry. (6017 tokens > 4096 tokens)'), error.message);
  assert.deepEqual({ tokens: error.overflow.tokens, tokens_from: error.overflow.tokens_from, limit_tokens: error.overflow.limit_tokens },
    { tokens: 6017, tokens_from: 'upstream', limit_tokens: 4096 });
});

test('a prompt LM Studio refuses inside a 200 stream becomes a real 413', async (t) => {
  const lmStudio = await fakeLmStudio(t, [catalogModel('qwen3-coder-30b', [['qwen3-coder-30b', 4096]])]);
  const tests = {
    'success: the error event arrives at once': (res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(sseFrame(overflowError(6017, 4096))); },
    'success: the error event arrives in two writes, after a comment frame': (res) => {
      const frame = sseFrame(overflowError(6017, 4096));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`: ping\n\n${frame.slice(0, 40)}`);
      setTimeout(() => res.end(frame.slice(40)), 50);
    },
    'success: the engine text is not JSON, so the wording gives the counts': (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sseFrame({ type: 'error', error: { type: 'api_error', message: 'Engine protocol predict request returned 400: request (6017 tokens) exceeds the available context size (4096 tokens), try increasing it [exceed_context_size_error]' } }));
    },
  };
  for (const [name, respond] of Object.entries(tests)) {
    await t.test(name, async (st) => {
      const proxy = await listingProxy(st, respond);
      const { port } = await spawnShim(st, proxy.port, lmStudio.baseUrl);

      const response = await request(port, 'POST', '/v1/messages', messageBody('claude-lmstudio/qwen3-coder-30b'));

      assert.equal(response.status, 413, response.body);
      assert.match(response.headers['content-type'], /^application\/json/);
      assert.equal(response.headers['x-model-gateway-upstream-status'], '200');
      const { error } = JSON.parse(response.body);
      assert.equal(error.type, 'request_too_large');
      assert.ok(error.message.startsWith('Input exceeds the model context window; compact and retry. (6017 tokens > 4096 tokens)'), error.message);
      assert.deepEqual({ tokens: error.overflow.tokens, tokens_from: error.overflow.tokens_from, limit_tokens: error.overflow.limit_tokens },
        { tokens: 6017, tokens_from: 'upstream', limit_tokens: 4096 });
    });
  }
});

test('an LM Studio stream that is not an overflow reaches the client as a 200 stream', async (t) => {
  const lmStudio = await fakeLmStudio(t, [catalogModel('qwen3-coder-30b', [['qwen3-coder-30b', 65536]])]);
  const ordinary = lmStudioStream(19, 0);
  const otherError = sseFrame({ type: 'error', error: { type: 'api_error', message: 'The model has crashed without additional information. (Exit code: 6)' } });
  const tests = {
    'success: an ordinary answer arrives whole': { respond: respondWith.stream(ordinary), expected: ordinary },
    'success: an ordinary answer split inside its first frame': {
      respond: (res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(ordinary.slice(0, 30));
        setTimeout(() => res.end(ordinary.slice(30)), 50);
      },
      expected: ordinary,
    },
    'error: another error event stays an in-band error': { respond: respondWith.stream(otherError), expected: otherError },
    'error: a stream that ends before one frame is complete': { respond: respondWith.stream('event: message_start\ndata: {"type":"mess'), expected: 'event: message_start\ndata: {"type":"mess' },
    'error: an empty stream': { respond: respondWith.stream(''), expected: '' },
  };
  for (const [name, { respond, expected }] of Object.entries(tests)) {
    await t.test(name, async (st) => {
      const proxy = await listingProxy(st, respond);
      const { port } = await spawnShim(st, proxy.port, lmStudio.baseUrl);

      const response = await request(port, 'POST', '/v1/messages', messageBody('claude-lmstudio/qwen3-coder-30b'));

      assert.equal(response.status, 200, response.body);
      assert.match(response.headers['content-type'], /^text\/event-stream/);
      assert.equal(response.body, expected);
    });
  }
});

test('a first event that stalls past the wait gets the stream heartbeat back, and still arrives whole', async (t) => {
  const lmStudio = await fakeLmStudio(t, [catalogModel('qwen3-coder-30b', [['qwen3-coder-30b', 65536]])]);
  const ordinary = lmStudioStream(19, 0);
  let headAt = null;
  // The first frame starts and then stalls, so the wait for a whole first event runs out. From then
  // on the stream is relayed as any other, which includes the heartbeat that keeps a silent stream
  // open; the heartbeat is also the first thing that sends the status line.
  const proxy = await listingProxy(t, (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(ordinary.slice(0, 30));
    setTimeout(() => res.end(ordinary.slice(30)), 400);
  });
  const { port } = await spawnShim(t, proxy.port, lmStudio.baseUrl, { CODEX_GATEWAY_LMSTUDIO_FIRST_EVENT_WAIT_MS: '50', CODEX_GATEWAY_SSE_HEARTBEAT_S: '0.1' });

  const started = Date.now();
  const response = await new Promise((resolve, reject) => {
    const body = messageBody('claude-lmstudio/qwen3-coder-30b');
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/messages', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      headAt = Date.now() - started;
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString(), endedAt: Date.now() - started }));
    });
    req.on('error', reject);
    req.end(body);
  });

  assert.equal(response.status, 200, response.body);
  assert.ok(response.body.startsWith(': ping\n\n'), 'a heartbeat went out while the first frame was stalled');
  assert.equal(response.body.replaceAll(': ping\n\n', ''), ordinary, 'the heartbeat never lands inside a frame');
  assert.ok(headAt < response.endedAt - 150, `the status line went out at ${headAt} ms, not at ${response.endedAt} ms with the rest of the stream`);
});

test('an overflow that arrives after the wait stays an in-band error on a 200 stream', async (t) => {
  const lmStudio = await fakeLmStudio(t, [catalogModel('qwen3-coder-30b', [['qwen3-coder-30b', 4096]])]);
  const frame = sseFrame(overflowError(6017, 4096));
  // Once the wait has run out the stream is relayed, so its status can no longer become a 413.
  const proxy = await listingProxy(t, (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    setTimeout(() => res.end(frame), 300);
  });
  const { port } = await spawnShim(t, proxy.port, lmStudio.baseUrl, { CODEX_GATEWAY_LMSTUDIO_FIRST_EVENT_WAIT_MS: '50', CODEX_GATEWAY_SSE_HEARTBEAT_S: '0' });

  const response = await request(port, 'POST', '/v1/messages', messageBody('claude-lmstudio/qwen3-coder-30b'));

  assert.equal(response.status, 200, response.body);
  assert.equal(response.body, frame);
});

test('other providers\' streams are not held for a first event', async (t) => {
  const lmStudio = await fakeLmStudio(t, [catalogModel('qwen3-coder-30b', [['qwen3-coder-30b', 65536]])]);
  // The same overflow text from a provider that is not LM Studio stays what it was: an in-band
  // error on a stream whose status line already went out.
  const frame = sseFrame(overflowError(6017, 4096));
  const proxy = await listingProxy(t, respondWith.stream(frame));
  const { port } = await spawnShim(t, proxy.port, lmStudio.baseUrl);

  const response = await request(port, 'POST', '/v1/messages', messageBody('claude-kimi-k3'));

  assert.equal(response.status, 200, response.body);
  assert.equal(response.body, frame);
});

test('an LM Studio overflow with its exact limit never lowers the trigger below the window', async (t) => {
  const lmStudio = await fakeLmStudio(t, [catalogModel('qwen3-coder-30b', [['qwen3-coder-30b', 40960]])]);
  // turn 1 uses 20000, turn 2 overflows the model, turn 3 (after compaction) and turn 4 use 15000.
  const answers = [
    respondWith.stream(lmStudioStream(20000, 19980)),
    respondWith.stream(sseFrame(overflowError(45016, 40960))),
    respondWith.stream(lmStudioStream(15000, 14985)),
    respondWith.stream(lmStudioStream(15000, 14995)),
  ];
  const proxy = await listingProxy(t, (res) => answers.shift()(res));
  const { port } = await spawnShim(t, proxy.port, lmStudio.baseUrl);
  const session = { 'x-claude-code-session-id': 'lmstudio-overflow-ceiling' };
  const statuses = [];
  for (let turn = 0; turn < 4; turn++) {
    statuses.push((await request(port, 'POST', '/v1/messages', messageBody('claude-lmstudio/qwen3-coder-30b'), session)).status);
  }
  // A learned ceiling of 20000 would put the trigger at 6347 and refuse turn 4 with 15000 used.
  assert.deepEqual(statuses, [200, 413, 200, 200]);
  assert.equal(proxy.received.length, 4, 'every turn reached the proxy');
});

test('a model reloaded with another context moves its row and its sentry trigger at the next refresh', async (t) => {
  let context = 65536;
  const lmStudio = await fakeLmStudio(t, () => [catalogModel('qwen3-coder-30b', context ? [['qwen3-coder-30b', context]] : [])]);
  // 30000 is under 65536's trigger (43691) and over 40960's (27307).
  const proxy = await listingProxy(t, respondWith.stream(lmStudioStream(30000, 29970)));
  const { port } = await spawnShim(t, proxy.port, lmStudio.baseUrl, { CODEX_GATEWAY_MODELS_REFRESH_MS: '100' });
  const session = { 'x-claude-code-session-id': 'lmstudio-window-change' };
  const advertised = async () => JSON.parse((await request(port, 'GET', '/v1/models')).body).data.find((model) => model.id === 'claude-lmstudio/qwen3-coder-30b')?.max_input_tokens;

  for (const turn of [1, 2]) {
    const response = await request(port, 'POST', '/v1/messages', messageBody('claude-lmstudio/qwen3-coder-30b'), session);
    assert.equal(response.status, 200, `turn ${turn} at 65536: ${response.body}`);
  }
  context = 0;
  await waitFor(async () => (await advertised()) === 200000, 'an unloaded model never went back to the unmeasured row');
  const unguarded = await request(port, 'POST', '/v1/messages', messageBody('claude-lmstudio/qwen3-coder-30b'), session);
  assert.equal(unguarded.status, 200, `an unloaded model has no window to guard: ${unguarded.body}`);

  context = 40960;
  await waitFor(async () => (await advertised()) === 40960, 'the shim never advertised the new window');
  const refused = await request(port, 'POST', '/v1/messages', messageBody('claude-lmstudio/qwen3-coder-30b'), session);
  assert.equal(refused.status, 413, refused.body);
  assert.ok(JSON.parse(refused.body).error.message.startsWith('Prompt is too long for the LM Studio context window; compact and retry. (30000 tokens > 27307 tokens)'), refused.body);
});

test('a model key that ends like a Codex service tier keeps its own sentry state', async (t) => {
  const { codexContextWindowModelId } = require('../lib/runtime.js');
  const tests = {
    'success: a Codex tier id shares its base model': { id: 'claude-gpt-6.1-sol-fast[1m]', expected: 'gpt-6.1-sol' },
    'success: a Codex ultrafast tier id shares its base model': { id: 'gpt-6-astra-ultrafast', expected: 'gpt-6-astra' },
    'success: an LM Studio key ending in -fast is its own model': { id: 'claude-lmstudio/qwen3-coder-30b-fast', expected: 'lmstudio/qwen3-coder-30b-fast' },
    'success: an LM Studio key ending in -ultrafast is its own model': { id: 'lmstudio/tiny-ultrafast', expected: 'lmstudio/tiny-ultrafast' },
  };
  for (const [name, { id, expected }] of Object.entries(tests)) assert.equal(codexContextWindowModelId(id), expected, name);

  // Two models whose keys differ only by that ending, both loaded with 65536. One turn of 45000 on
  // the first is past its trigger (43691); the second model has used nothing in this session.
  const listing = [
    { type: 'model', object: 'model', id: 'lmstudio/qwen3-coder-30b', display_name: 'lmstudio/qwen3-coder-30b (lmstudio)' },
    { type: 'model', object: 'model', id: 'lmstudio/qwen3-coder-30b-fast', display_name: 'lmstudio/qwen3-coder-30b-fast (lmstudio)' },
  ];
  const lmStudio = await fakeLmStudio(t, listing.map(({ id }) => id.slice('lmstudio/'.length)).map((key) => catalogModel(key, [[key, 65536]])));
  const received = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: listing, has_more: false }));
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString()).model);
      respondWith.stream(lmStudioStream(45000, 0))(res);
    });
  });
  const proxyPort = await listen(server);
  t.after(() => close(server));
  const { port } = await spawnShim(t, proxyPort, lmStudio.baseUrl);
  const session = { 'x-claude-code-session-id': 'lmstudio-tier-like-key' };
  const turn = async (model) => (await request(port, 'POST', '/v1/messages', messageBody(model), session)).status;

  assert.equal(await turn('claude-lmstudio/qwen3-coder-30b'), 200);
  assert.equal(await turn('claude-lmstudio/qwen3-coder-30b-fast'), 200, 'the other model\'s usage does not refuse this one\'s first turn');
  assert.equal(await turn('claude-lmstudio/qwen3-coder-30b'), 413, 'the first model is past its own trigger');
  assert.deepEqual(received, ['lmstudio/qwen3-coder-30b', 'lmstudio/qwen3-coder-30b-fast']);
});

test('a listing without LM Studio rows never contacts an LM Studio server', async (t) => {
  const { fetchUrl } = require('../lib/process-supervision.js');
  const { refreshLmStudioState } = require('../lib/lmstudio.js');
  resetLmStudioState(t);
  const lmStudio = await fakeLmStudio(t, [catalogModel('qwen3-coder-30b', [['qwen3-coder-30b', 65536]])]);
  const env = { CCP_LMSTUDIO_BASE_URL: lmStudio.baseUrl };
  for (const routes of [[], [{ id: 'kimi-k3', provider: 'kimi' }, { id: 'local/gguf', provider: 'local' }], null]) {
    assert.equal(await refreshLmStudioState(routes, { env, configDirectory: configDirectory(t), fetchUrl }), null);
  }
  assert.equal(lmStudio.seen.length, 0);
});
