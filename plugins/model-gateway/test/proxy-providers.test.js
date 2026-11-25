'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { gatewayTestEnvironment, startGateway } = require('./support.js');

// The provider-tagged listing claude-code-proxy 0.1.42 serves, trimmed to one or two rows per
// provider, with the Anthropic-style aliases it lists under its alias provider left in. The muse
// rows come from the proxy's dev branch, which lists them after Grok; OpenCode Go registers the
// -contributor variant of a Muse id as its own model. The vertex rows come from the dev branch
// too: a Gemini model under its bare id and again as vertex/<id>, partner models as
// vertex/<publisher>/<id>, and a deployed endpoint from the proxy's own config.json.
const PROXY_LISTING = [
  ['claude-opus-5-5', 'codex'],
  ['haiku', 'codex'],
  ['opus', 'codex'],
  ['gpt-6-astra', 'codex'],
  ['gpt-6-sol', 'codex'],
  ['gpt-6-sol-fast', 'codex'],
  ['cursor-agent', 'cursor'],
  ['grok-4.7', 'grok'],
  ['grok-4.7-build-fast', 'grok'],
  ['grok-4.7-fast', 'grok'],
  ['grok-composer-2.5-fast', 'grok'],
  ['muse-spark-1.3', 'muse'],
  ['muse-spark-1.2', 'muse'],
  ['kimi-k3', 'kimi'],
  ['glm-5.3', 'opencode'],
  ['muse-spark-1.3-contributor', 'opencode'],
  ['opencode-go/kimi-k2.6', 'opencode'],
  ['gemini-4-argon', 'vertex'],
  ['vertex/anthropic/claude-opus-5-5', 'vertex'],
  ['vertex/anthropic/claude-fable-5-2', 'vertex'],
  ['vertex/endpoint/my-llm', 'vertex'],
  ['vertex/gemini-4-argon', 'vertex'],
  ['vertex/mistralai/codestral-2', 'vertex'],
].map(([id, provider]) => ({ type: 'model', object: 'model', id, display_name: `${id} (${provider})` }));

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
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

// Answers /v1/models with PROXY_LISTING and hands every other request to `respond`, recording it.
async function listingProxy(t, respond) {
  const received = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: PROXY_LISTING, has_more: false }));
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      received.push({ headers: req.headers, body });
      respond(body, res);
    });
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port, received };
}

async function anthropicUpstream(t) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString()).model);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', model: 'claude-opus-5-5', content: [] }));
    });
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${port}`, received };
}

async function spawnShim(t, proxyPort, anthropicUrl) {
  const environment = gatewayTestEnvironment(t, {
    CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
    CODEX_GATEWAY_REQUEST_LOG: '0',
    CODEX_GATEWAY_ANTHROPIC_UPSTREAM: anthropicUrl,
  });
  const { port } = await startGateway(t, 'serve-shim', environment);
  // The worker reads the proxy listing just after it starts listening; wait for that refresh.
  await waitFor(async () => {
    const response = await request(port, 'GET', '/v1/models');
    return JSON.parse(response.body).data.some((model) => model.id === 'claude-kimi-k3');
  }, 'shim never advertised the proxy listing');
  return { port, home: environment.HOME };
}

function messageBody(model, extra = {}) {
  return JSON.stringify({
    model,
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hello' }],
    ...extra,
  });
}

test('the shim advertises every proxy provider row and none of its Claude aliases', async (t) => {
  const proxy = await listingProxy(t, () => assert.fail('no inference expected'));
  const anthropic = await anthropicUpstream(t);
  const { port } = await spawnShim(t, proxy.port, anthropic.url);

  const listed = JSON.parse((await request(port, 'GET', '/v1/models')).body).data;

  assert.deepEqual(listed, [
    { id: 'claude-gpt-6-astra[1m]', display_name: 'GPT-6-astra (Codex)', type: 'model', max_input_tokens: 272000 },
    { id: 'claude-gpt-6-sol[1m]', display_name: 'GPT-6-sol (Codex)', type: 'model', max_input_tokens: 272000 },
    { id: 'claude-gpt-6-sol-fast[1m]', display_name: 'GPT-6-sol-fast (Codex)', type: 'model', max_input_tokens: 272000 },
    { id: 'claude-grok-4.7[1m]', display_name: 'Grok 4.7', type: 'model', max_input_tokens: 500000 },
    { id: 'claude-grok-4.6[1m]', display_name: 'Grok 4.6', type: 'model', max_input_tokens: 500000 },
    { id: 'claude-grok-4.5[1m]', display_name: 'Grok 4.5', type: 'model', max_input_tokens: 500000 },
    { id: 'claude-cursor-agent', display_name: 'cursor-agent (Cursor)', type: 'model', max_input_tokens: 200000 },
    { id: 'claude-grok-4.7-build-fast[1m]', display_name: 'Grok 4.7 build fast', type: 'model', max_input_tokens: 500000 },
    { id: 'claude-grok-4.7-fast[1m]', display_name: 'Grok 4.7 fast', type: 'model', max_input_tokens: 500000 },
    { id: 'claude-grok-composer-2.5-fast', display_name: 'Grok composer 2.5 fast', type: 'model', max_input_tokens: 200000 },
    { id: 'claude-muse-spark-1.3[1m]', display_name: 'muse-spark-1.3 (Muse)', type: 'model', max_input_tokens: 1000000 },
    { id: 'claude-muse-spark-1.2[1m]', display_name: 'muse-spark-1.2 (Muse)', type: 'model', max_input_tokens: 1000000 },
    { id: 'claude-kimi-k3', display_name: 'kimi-k3 (Kimi)', type: 'model', max_input_tokens: 200000 },
    { id: 'claude-glm-5.3', display_name: 'glm-5.3 (OpenCode)', type: 'model', max_input_tokens: 200000 },
    { id: 'claude-muse-spark-1.3-contributor', display_name: 'muse-spark-1.3-contributor (OpenCode)', type: 'model', max_input_tokens: 200000 },
    { id: 'claude-opencode-go/kimi-k2.6', display_name: 'opencode-go/kimi-k2.6 (OpenCode)', type: 'model', max_input_tokens: 200000 },
    { id: 'claude-gemini-4-argon[1m]', display_name: 'gemini-4-argon (Vertex AI)', type: 'model', max_input_tokens: 1000000 },
    // A Claude model on Vertex AI is a proxy row: the Anthropic-style alias filter reads the
    // proxy's id, which starts with vertex/, not claude-.
    { id: 'claude-vertex/anthropic/claude-opus-5-5[1m]', display_name: 'vertex/anthropic/claude-opus-5-5 (Vertex AI)', type: 'model', max_input_tokens: 1000000 },
    // Claude Code takes any id containing claude-fable- for its own Fable, so Fable on Vertex is
    // advertised as fable-; the display name keeps the id the proxy listed.
    { id: 'claude-vertex/anthropic/fable-5-2[1m]', display_name: 'vertex/anthropic/claude-fable-5-2 (Vertex AI)', type: 'model', max_input_tokens: 1000000 },
    { id: 'claude-vertex/endpoint/my-llm', display_name: 'vertex/endpoint/my-llm (Vertex AI)', type: 'model', max_input_tokens: 200000 },
    { id: 'claude-vertex/mistralai/codestral-2', display_name: 'vertex/mistralai/codestral-2 (Vertex AI)', type: 'model', max_input_tokens: 200000 },
  ]);
  // The proxy lists vertex/gemini-4-argon beside the bare id; one model gets one picker row.
  assert.equal(listed.some((model) => model.id.startsWith('claude-vertex/gemini-')), false);
});

test('only the bare spelling of a Vertex Gemini model is advertised, and only against its own provider', () => {
  const { advertisedProxyRoutes } = require('../lib/proxy-models.js');
  const tests = {
    'success: the vertex/ spelling of a listed Vertex id is dropped': {
      routes: [['gemini-4-argon', 'vertex'], ['vertex/gemini-4-argon', 'vertex']],
      expected: ['gemini-4-argon'],
    },
    'success: a vertex/ id with no bare twin stays': {
      routes: [['vertex/gemini-9-neon', 'vertex'], ['vertex/anthropic/claude-opus-5-5', 'vertex'], ['vertex/endpoint/my-llm', 'vertex']],
      expected: ['vertex/gemini-9-neon', 'vertex/anthropic/claude-opus-5-5', 'vertex/endpoint/my-llm'],
    },
    'success: a bare id another provider serves is not the same model': {
      routes: [['gemini-4-argon', 'gemini'], ['vertex/gemini-4-argon', 'vertex']],
      expected: ['gemini-4-argon', 'vertex/gemini-4-argon'],
    },
    'success: another provider keeps an id that happens to start with vertex/': {
      routes: [['gemini-4-argon', 'vertex'], ['vertex/gemini-4-argon', 'opencode']],
      expected: ['gemini-4-argon', 'vertex/gemini-4-argon'],
    },
    'success: an empty listing': { routes: [], expected: [] },
  };
  for (const [name, { routes, expected }] of Object.entries(tests)) {
    const advertised = advertisedProxyRoutes(routes.map(([id, provider]) => ({ id, provider })));
    assert.deepEqual(advertised.map(({ id }) => id), expected, name);
  }
});

test('a proxy row serving Fable is advertised without the claude-fable- spelling Claude Code reserves', (t) => {
  const { proxyModelRoutes, setProxyModelRoutes } = require('../lib/proxy-models.js');
  const { gatewayBackendModelId, gatewayClientModelId, gatewayDiscoveryModels, resolveGatewayModelPolicy } = require('../lib/runtime.js');
  const saved = proxyModelRoutes();
  t.after(() => setProxyModelRoutes(saved));
  const tests = {
    'success: no listing, a Vertex Fable policy row resolves through its advertised id': {
      routes: [],
      cases: [['claude-vertex/anthropic/fable-5-1[1m]', 'vertex/anthropic/claude-fable-5-1', 'claude-vertex/anthropic/fable-5-1[1m]', 'proxy']],
    },
    'success: a listed Fable route resolves through both spellings and advertises one': {
      routes: [['vertex/anthropic/claude-fable-5-2', 'vertex'], ['opencode-go/claude-fable-5', 'opencode']],
      cases: [
        ['vertex/anthropic/claude-fable-5-2', 'vertex/anthropic/claude-fable-5-2', 'claude-vertex/anthropic/fable-5-2[1m]', 'proxy'],
        ['claude-vertex/anthropic/fable-5-2[1m]', 'vertex/anthropic/claude-fable-5-2', 'claude-vertex/anthropic/fable-5-2[1m]', 'proxy'],
        ['claude-vertex/anthropic/claude-fable-5-2[1m]', 'vertex/anthropic/claude-fable-5-2', 'claude-vertex/anthropic/fable-5-2[1m]', 'proxy'],
        ['claude-opencode-go/fable-5', 'opencode-go/claude-fable-5', 'claude-opencode-go/fable-5', 'proxy'],
      ],
    },
    'success: native Claude ids and other Vertex Claude rows keep their spelling': {
      routes: [['vertex/anthropic/claude-opus-5-5', 'vertex']],
      cases: [
        ['claude-fable-5-2', 'fable-5-2', 'claude-fable-5-2', 'anthropic'],
        ['claude-fable-5-1[1m]', 'fable-5-1', 'claude-fable-5-1', 'anthropic'],
        ['claude-vertex/anthropic/claude-opus-5-5[1m]', 'vertex/anthropic/claude-opus-5-5', 'claude-vertex/anthropic/claude-opus-5-5[1m]', 'proxy'],
      ],
    },
    'success: a listed route spelled like an advertised alias keeps its own spelling': {
      routes: [['vertex/anthropic/claude-fable-5-2', 'vertex'], ['vertex/anthropic/fable-5-2', 'vertex']],
      cases: [
        ['claude-vertex/anthropic/fable-5-2', 'vertex/anthropic/fable-5-2', 'claude-vertex/anthropic/fable-5-2', 'proxy'],
        ['vertex/anthropic/claude-fable-5-2', 'vertex/anthropic/claude-fable-5-2', 'claude-vertex/anthropic/claude-fable-5-2[1m]', 'proxy'],
      ],
    },
  };
  for (const [name, { routes, cases }] of Object.entries(tests)) {
    setProxyModelRoutes(routes.map(([id, provider]) => ({ id, provider })));
    for (const [id, backendId, clientId, transport] of cases) {
      assert.equal(gatewayBackendModelId(id), backendId, `${name}: ${id} backend`);
      assert.equal(gatewayClientModelId(id), clientId, `${name}: ${id} picker id`);
      assert.equal(resolveGatewayModelPolicy(id)?.transport, transport, `${name}: ${id} transport`);
    }
  }

  setProxyModelRoutes([{ id: 'vertex/anthropic/claude-fable-5-2', provider: 'vertex' }]);
  const discovered = gatewayDiscoveryModels([
    { id: 'claude-vertex/anthropic/claude-fable-5-2[1m]', display_name: 'vertex/anthropic/claude-fable-5-2 (Vertex AI)' },
  ]);
  assert.deepEqual(discovered, [{ id: 'claude-vertex/anthropic/fable-5-2[1m]', display_name: 'vertex/anthropic/claude-fable-5-2 (Vertex AI)' }],
    'the discovery cache Claude Code builds /model from never holds a claude-fable- id for a proxy row');
});

test('non-Codex rows reach the proxy under their backend id with credentials and plan tools removed', async (t) => {
  const proxy = await listingProxy(t, (body, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'message', model: body.model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }));
  });
  const anthropic = await anthropicUpstream(t);
  const { port } = await spawnShim(t, proxy.port, anthropic.url);
  const tests = {
    'kimi row': { model: 'claude-kimi-k3', backend: 'kimi-k3' },
    'opencode row carrying its provider prefix': { model: 'claude-opencode-go/kimi-k2.6', backend: 'opencode-go/kimi-k2.6' },
    'cursor row': { model: 'claude-cursor-agent', backend: 'cursor-agent' },
    'Grok row only the proxy serves': { model: 'claude-grok-composer-2.5-fast', backend: 'grok-composer-2.5-fast' },
    'Grok 4.7 Fast alias the proxy resolves upstream': { model: 'claude-grok-4.7-fast[1m]', backend: 'grok-4.7-fast' },
    'Grok 4.7 Fast under its backend id': { model: 'claude-grok-4.7-build-fast[1m]', backend: 'grok-4.7-build-fast' },
    'Muse row': { model: 'claude-muse-spark-1.3[1m]', backend: 'muse-spark-1.3' },
    'OpenCode row named after a Muse model': { model: 'claude-muse-spark-1.3-contributor', backend: 'muse-spark-1.3-contributor' },
    'Vertex Gemini row under its bare id': { model: 'claude-gemini-4-argon[1m]', backend: 'gemini-4-argon' },
    'Vertex Gemini spelling that is listed but not advertised': { model: 'claude-vertex/gemini-4-argon[1m]', backend: 'vertex/gemini-4-argon' },
    'Claude on Vertex goes to the proxy, not to Anthropic, and is filtered like every proxy row': { model: 'claude-vertex/anthropic/claude-opus-5-5[1m]', backend: 'vertex/anthropic/claude-opus-5-5' },
    'Fable on Vertex under its advertised id': { model: 'claude-vertex/anthropic/fable-5-2[1m]', backend: 'vertex/anthropic/claude-fable-5-2' },
    'Fable on Vertex under the id the proxy lists, as an older settings file names it': { model: 'claude-vertex/anthropic/claude-fable-5-2[1m]', backend: 'vertex/anthropic/claude-fable-5-2' },
    'Vertex row without a documented window above 200k': { model: 'claude-vertex/mistralai/codestral-2', backend: 'vertex/mistralai/codestral-2' },
    'Vertex deployed endpoint': { model: 'claude-vertex/endpoint/my-llm', backend: 'vertex/endpoint/my-llm' },
  };

  for (const [name, { model, backend }] of Object.entries(tests)) {
    const before = proxy.received.length;
    const response = await request(port, 'POST', '/v1/messages', messageBody(model, {
      tools: [
        { name: 'EnterPlanMode', input_schema: { type: 'object' } },
        { name: 'Read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
      ],
    }), { authorization: 'Bearer claude-ai-secret', 'x-api-key': 'claude-ai-key' });

    assert.equal(response.status, 200, `${name}: ${response.body}`);
    assert.equal(JSON.parse(response.body).model, model, `${name}: the response names the picker id Claude Code selected`);
    assert.equal(proxy.received.length, before + 1, `${name}: exactly one proxy request`);
    const forwarded = proxy.received.at(-1);
    assert.equal(forwarded.body.model, backend, name);
    assert.deepEqual(forwarded.body.tools.map((tool) => tool.name), ['Read'], `${name}: plan-mode tools are hidden from non-Claude models`);
    assert.equal(forwarded.headers.authorization, undefined, `${name}: claude.ai credentials never reach the proxy`);
    assert.equal(forwarded.headers['x-api-key'], undefined, name);
  }
  assert.deepEqual(anthropic.received, []);
});

test('Claude ids and ids the proxy never listed still go to Anthropic', async (t) => {
  const proxy = await listingProxy(t, () => assert.fail('the proxy must not see Claude traffic'));
  const anthropic = await anthropicUpstream(t);
  const { port } = await spawnShim(t, proxy.port, anthropic.url);

  // The vertex/ prefix alone proves nothing: only the listing or a policy row makes a proxy route.
  const models = ['claude-opus-5-5', 'claude-glm-99', 'claude-vertex/ai21/jamba-2'];
  for (const model of models) {
    const response = await request(port, 'POST', '/v1/messages', messageBody(model));
    assert.equal(response.status, 200, response.body);
  }

  assert.deepEqual(anthropic.received, models);
  assert.deepEqual(proxy.received, []);
});

test('a non-Codex rejection passes through without touching Codex readiness state', async (t) => {
  const proxy = await listingProxy(t, (body, res) => {
    const payload = JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'kimi token expired' } });
    // An OpenAI-style header would count as Codex rejection evidence on a Codex route.
    res.writeHead(401, { 'content-type': 'application/json', 'openai-processing-ms': '3' });
    res.end(payload);
  });
  const anthropic = await anthropicUpstream(t);
  const { port, home } = await spawnShim(t, proxy.port, anthropic.url);

  const response = await request(port, 'POST', '/v1/messages', messageBody('claude-kimi-k3'));

  assert.equal(response.status, 401);
  assert.deepEqual(JSON.parse(response.body).error, { type: 'authentication_error', message: 'kimi token expired' });
  const state = path.join(home, '.claude', 'model-gateway');
  assert.equal(fs.existsSync(path.join(state, 'codex-upstream-blocked.json')), false, 'a Kimi 401 must not block Codex dispatch');
  assert.equal(fs.existsSync(path.join(state, 'codex-upstream-unavailable.json')), false);
});

test('a non-Codex context overflow is normalized so Claude Code compacts', async (t) => {
  const proxy = await listingProxy(t, (body, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'context length exceeded for glm-5.3' } }));
  });
  const anthropic = await anthropicUpstream(t);
  const { port } = await spawnShim(t, proxy.port, anthropic.url);

  const response = await request(port, 'POST', '/v1/messages', messageBody('claude-glm-5.3'));

  assert.equal(response.status, 413, response.body);
  assert.equal(response.headers['x-model-gateway-upstream-status'], '400');
  const { error } = JSON.parse(response.body);
  assert.equal(error.type, 'request_too_large');
  assert.match(error.message, /Input exceeds the model context window; compact and retry\./);
  assert.match(error.message, /> 200000 tokens/);
});

test('proxy provider auth state follows the proxy CLI exit code, and OpenCode follows its API key', (t) => {
  const { proxyConfigDirectory, proxyProviderAuthState } = require('../lib/commands.js');
  const configDirectory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'model-gateway-proxy-config-'));
  t.after(() => fs.rmSync(configDirectory, { recursive: true, force: true }));
  const calls = [];
  const exitWith = (status) => (bin, args) => { calls.push(args); return { status }; };
  const tests = {
    'success: signed in': { provider: 'kimi', run: exitWith(0), expected: 'ready' },
    'error: signed out': { provider: 'cursor', run: exitWith(1), expected: 'auth-missing' },
    'error: status unavailable': { provider: 'kimi', run: exitWith(2), expected: 'auth-unknown' },
    'success: Muse signed in': { provider: 'muse', run: exitWith(0), expected: 'ready' },
    'error: Muse login refused, a new login is the fix': { provider: 'muse', run: exitWith(1), expected: 'auth-missing' },
    'error: Muse key service unavailable': { provider: 'muse', run: exitWith(2), expected: 'auth-unknown' },
    'success: Vertex credentials and settings resolve': { provider: 'vertex', env: { CCP_VERTEX_PROJECT: 'p' }, run: exitWith(0), expected: 'ready' },
    'error: Vertex without a Google access token': { provider: 'vertex', env: { GOOGLE_CLOUD_PROJECT: ' p ' }, run: exitWith(1), expected: 'auth-missing' },
    'error: Vertex with a project and another invalid setting': { provider: 'vertex', env: { CCP_VERTEX_PROJECT: 'p' }, run: exitWith(2), expected: 'config-invalid' },
    'error: Vertex status timed out': { provider: 'vertex', env: { CCP_VERTEX_PROJECT: 'p' }, run: exitWith(null), expected: 'auth-unknown' },
    // No project is exit 2 whatever the token attempt says, so no status process starts: on a
    // machine that never set Vertex AI up that process would wait on Google's metadata server.
    'error: Vertex without a project': { provider: 'vertex', env: {}, run: exitWith(0), expected: 'config-invalid', spawns: false },
    'error: Vertex with only blank project variables': { provider: 'vertex', env: { CCP_VERTEX_PROJECT: '', GOOGLE_CLOUD_PROJECT: '  ' }, run: exitWith(0), expected: 'config-invalid', spawns: false },
    'success: OpenCode key in the proxy env var': { provider: 'opencode', env: { CCP_OPENCODE_API_KEY: 'k' }, expected: 'ready' },
    'success: OpenCode key in the OpenCode env var': { provider: 'opencode', env: { OPENCODE_API_KEY: 'k' }, expected: 'ready' },
    'error: OpenCode without a key': { provider: 'opencode', env: {}, expected: 'auth-missing' },
  };
  for (const [name, { provider, run = exitWith(99), env = {}, expected, spawns = provider !== 'opencode' }] of Object.entries(tests)) {
    const before = calls.length;
    assert.equal(proxyProviderAuthState(provider, { run, env, configDirectory }), expected, name);
    assert.equal(calls.length - before, spawns ? 1 : 0, `${name}: status processes started`);
  }
  assert.deepEqual(calls, [
    ['kimi', 'auth', 'status'], ['cursor', 'auth', 'status'], ['kimi', 'auth', 'status'],
    ['muse', 'auth', 'status'], ['muse', 'auth', 'status'], ['muse', 'auth', 'status'],
    ['vertex', 'auth', 'status'], ['vertex', 'auth', 'status'], ['vertex', 'auth', 'status'], ['vertex', 'auth', 'status'],
  ]);

  fs.writeFileSync(path.join(configDirectory, 'config.json'), JSON.stringify({ opencode: { apiKey: 'from-config' }, vertex: { project: 'from-config' } }));
  assert.equal(proxyProviderAuthState('opencode', { env: {}, configDirectory }), 'ready');
  // A project in the proxy's config.json counts like the variables do, so the status is asked.
  assert.equal(proxyProviderAuthState('vertex', { run: exitWith(0), env: {}, configDirectory }), 'ready');
  assert.deepEqual(calls.at(-1), ['vertex', 'auth', 'status']);

  assert.equal(proxyConfigDirectory({ env: { CCP_CONFIG_DIR: '/custom' }, platform: 'linux', home: '/h' }), '/custom');
  assert.equal(proxyConfigDirectory({ env: {}, platform: 'darwin', home: '/h' }), path.join('/h', '.config', 'claude-code-proxy'));
  assert.equal(proxyConfigDirectory({ env: { XDG_CONFIG_HOME: '/x' }, platform: 'linux', home: '/h' }), path.join('/x', 'claude-code-proxy'));
});

test('proxy provider readiness reuses shared proxy checks before asking about sign-in', () => {
  const { getProxyProviderReadiness } = require('../lib/commands.js');
  const healthy = { proxyBinary: true, proxyModels: true, shimRunning: true, servingVersionMatches: true };
  const tests = {
    'success: every check passes': { checks: healthy, auth: 'ready', state: 'ready', message: /^Kimi readiness confirms local binary, \/v1\/models, authentication/ },
    'error: binary missing wins over sign-in': { checks: { ...healthy, proxyBinary: false }, auth: 'ready', state: 'binary-missing', message: /claude-code-proxy is missing/ },
    'error: proxy down': { checks: { ...healthy, proxyModels: false }, auth: 'ready', state: 'proxy-down', message: /not answering on \/v1\/models/ },
    'error: stale shim': { checks: { ...healthy, servingVersionMatches: false }, auth: 'ready', state: 'serving-version-mismatch', message: /stale shim/ },
    'error: signed out': { checks: healthy, auth: 'auth-missing', state: 'auth-missing', message: /has no Kimi sign-in\. Run `".*" kimi auth login`\./ },
  };
  for (const [name, { checks, auth, state, message }] of Object.entries(tests)) {
    const readiness = getProxyProviderReadiness('kimi', { checks }, { authState: () => auth });
    assert.equal(readiness.state, state, name);
    assert.equal(readiness.ready, state === 'ready', name);
    assert.match(readiness.message, message, name);
  }
  const muse = getProxyProviderReadiness('muse', { checks: healthy }, { authState: () => 'auth-missing' });
  assert.match(muse.message, /has no Muse sign-in\. Run `".*" muse auth login`\./);
  const opencode = getProxyProviderReadiness('opencode', { checks: healthy }, { authState: () => 'auth-missing' });
  assert.match(opencode.message, /OpenCode Go needs an API key: set CCP_OPENCODE_API_KEY or OPENCODE_API_KEY/);
});

test('Vertex AI readiness names gcloud and the project setting, never a proxy login', () => {
  const { describeProxyProviderAuth, getProxyProviderReadiness } = require('../lib/commands.js');
  const healthy = { proxyBinary: true, proxyModels: true, shimRunning: true, servingVersionMatches: true };
  // `claude-code-proxy vertex auth login` only prints the gcloud hint and exits 2, so no message may send the user to it.
  const tests = {
    'success: credentials and settings resolve': {
      auth: 'ready',
      message: /^Vertex AI readiness confirms local binary, \/v1\/models, Google credentials and Vertex settings, shim, and serving-version checks\./,
      doctor: /^authenticated$/,
    },
    'error: no Google access token': {
      auth: 'auth-missing',
      message: /^claude-code-proxy got no Google access token for Vertex AI: Application Default Credentials are missing or expired, or Google could not be reached\. Run `gcloud auth application-default login`, or set GOOGLE_APPLICATION_CREDENTIALS to a credentials file where the gateway starts; `".*" vertex auth status` prints the reason\.$/,
      doctor: /^MISSING \(claude-code-proxy got no Google access token for Vertex AI: .*Run `gcloud auth application-default login`/,
    },
    'error: no project, or another invalid setting': {
      auth: 'config-invalid',
      message: /^claude-code-proxy reports a missing or invalid Vertex AI setting, most often an unset Google Cloud project: set vertex\.project in .*config\.json, or CCP_VERTEX_PROJECT or GOOGLE_CLOUD_PROJECT where the gateway starts\. Run `".*" vertex auth status` to see which setting\.$/,
      doctor: /^NOT CONFIGURED \(claude-code-proxy reports a missing or invalid Vertex AI setting/,
    },
    'error: status did not answer': {
      auth: 'auth-unknown',
      message: /^claude-code-proxy could not report Vertex AI sign-in status\.$/,
      doctor: /^status unavailable$/,
    },
  };
  for (const [name, { auth, message, doctor }] of Object.entries(tests)) {
    const readiness = getProxyProviderReadiness('vertex', { checks: healthy }, { authState: () => auth });
    assert.equal(readiness.state, auth, name);
    assert.equal(readiness.ready, auth === 'ready', name);
    assert.match(readiness.message, message, name);
    assert.doesNotMatch(readiness.message, /vertex auth login/, name);
    assert.match(describeProxyProviderAuth('vertex', auth), doctor, name);
  }
  // Only Vertex gives exit 2 its own meaning; doctor still prints the other providers' lines as before.
  assert.equal(describeProxyProviderAuth('kimi', 'ready'), 'authenticated');
  assert.equal(describeProxyProviderAuth('opencode', 'ready'), 'API key present');
  assert.match(describeProxyProviderAuth('kimi', 'auth-missing'), /^MISSING \(claude-code-proxy has no Kimi sign-in\. Run `".*" kimi auth login`\.\)$/);
  assert.equal(describeProxyProviderAuth('muse', 'auth-unknown'), 'status unavailable');
});

test('the Sidequest catalog lists every proxy provider under its own slug and readiness', (t) => {
  const { buildCatalog } = require('../lib/commands.js');
  const proxyModels = require('../lib/proxy-models.js');
  const previous = proxyModels.proxyModelRoutes();
  proxyModels.setProxyModelRoutes(proxyModels.parseProxyModelListing(PROXY_LISTING));
  t.after(() => proxyModels.setProxyModelRoutes(previous));
  // A missing binary short-circuits every proxy provider before any `auth status` process runs.
  const codexReadiness = {
    ready: false,
    state: 'binary-missing',
    message: 'Codex dispatch refused: claude-code-proxy is missing.',
    checks: { proxyBinary: false, proxyModels: false, shimRunning: false, servingVersionMatches: false },
  };

  const catalog = buildCatalog([
    'claude-gpt-6-sol[1m]',
    'claude-kimi-k3',
    'claude-glm-5.3',
    'claude-opencode-go/kimi-k2.6',
    'claude-cursor-agent',
    'claude-grok-composer-2.5-fast',
    'claude-muse-spark-1.3[1m]',
    'claude-gemini-4-argon[1m]',
    'claude-vertex/anthropic/claude-opus-5-5[1m]',
    'claude-vertex/anthropic/claude-sonnet-5-5[1m]',
    'claude-vertex/mistralai/codestral-2',
    'claude-vertex/endpoint/my-llm',
    'claude-opus-5-5',
  ], codexReadiness);

  // contextWindow follows the saved per-backend cap, so it is checked against the runtime's own answer.
  const { gatewayAdvertisedWindow } = require('../lib/runtime.js');
  for (const model of catalog.models) assert.equal(model.contextWindow, gatewayAdvertisedWindow(model.id), model.id);
  assert.equal(typeof catalog.models[0].contextWindowNote, 'string');
  assert.deepEqual(catalog.models.map(({ contextWindow, contextWindowNote, ...model }) => model), [
    { slug: 'codex-gpt-6-sol', id: 'claude-gpt-6-sol[1m]', label: 'GPT-6 Sol', provider: 'codex' },
    { slug: 'kimi-k3', id: 'claude-kimi-k3', label: 'kimi-k3 (Kimi)', provider: 'kimi' },
    { slug: 'opencode-glm-5-3', id: 'claude-glm-5.3', label: 'glm-5.3 (OpenCode)', provider: 'opencode' },
    { slug: 'opencode-go-kimi-k2-6', id: 'claude-opencode-go/kimi-k2.6', label: 'opencode-go/kimi-k2.6 (OpenCode)', provider: 'opencode' },
    { slug: 'cursor-agent', id: 'claude-cursor-agent', label: 'cursor-agent (Cursor)', provider: 'cursor' },
    { slug: 'grok-composer-2-5-fast', id: 'claude-grok-composer-2.5-fast', label: 'Grok composer 2.5 fast', provider: 'grok' },
    { slug: 'muse-spark-1-3', id: 'claude-muse-spark-1.3[1m]', label: 'muse-spark-1.3 (Muse)', provider: 'muse' },
    { slug: 'vertex-gemini-4-argon', id: 'claude-gemini-4-argon[1m]', label: 'gemini-4-argon (Vertex AI)', provider: 'vertex' },
    // The id's own vertex/ namespace is the provider, so the slug names it once.
    { slug: 'vertex-anthropic-claude-opus-5-5', id: 'claude-vertex/anthropic/claude-opus-5-5[1m]', label: 'vertex/anthropic/claude-opus-5-5 (Vertex AI)', provider: 'vertex' },
    // Past the 32-character limit a slug keeps its first 25 characters and ends in a hash. The board's
    // route table pins slugs, so this exact value must not change.
    { slug: 'vertex-anthropic-claude-s-b52873', id: 'claude-vertex/anthropic/claude-sonnet-5-5[1m]', label: 'vertex/anthropic/claude-sonnet-5-5 (Vertex AI)', provider: 'vertex' },
    { slug: 'vertex-mistralai-codestral-2', id: 'claude-vertex/mistralai/codestral-2', label: 'vertex/mistralai/codestral-2 (Vertex AI)', provider: 'vertex' },
    { slug: 'vertex-endpoint-my-llm', id: 'claude-vertex/endpoint/my-llm', label: 'vertex/endpoint/my-llm (Vertex AI)', provider: 'vertex' },
  ]);
  for (const provider of ['kimi', 'opencode', 'cursor', 'muse', 'vertex']) {
    assert.equal(catalog.providers[provider].state, 'binary-missing', provider);
    assert.equal(catalog.providers[provider].ready, false, provider);
  }
  assert.equal(catalog.providers.codex.state, 'binary-missing');
});

test('the catalog reports Vertex AI as not configured on a machine with no project, without a status process', (t) => {
  const { buildCatalog } = require('../lib/commands.js');
  const proxyModels = require('../lib/proxy-models.js');
  const previous = proxyModels.proxyModelRoutes();
  proxyModels.setProxyModelRoutes(proxyModels.parseProxyModelListing(PROXY_LISTING));
  t.after(() => proxyModels.setProxyModelRoutes(previous));
  // The catalog reads the real process environment, so the project variables are cleared and the
  // proxy's config directory is an empty one for the length of this test.
  const configDirectory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'model-gateway-vertex-config-'));
  const saved = Object.fromEntries(['CCP_VERTEX_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'CCP_CONFIG_DIR'].map((name) => [name, process.env[name]]));
  delete process.env.CCP_VERTEX_PROJECT;
  delete process.env.GOOGLE_CLOUD_PROJECT;
  process.env.CCP_CONFIG_DIR = configDirectory;
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(configDirectory, { recursive: true, force: true });
  });
  // Every shared check passes, so only the provider's own state decides. No claude-code-proxy
  // binary exists under the test home: a status process would fail to start and read as auth-unknown.
  const codexReadiness = {
    ready: true,
    state: 'ready',
    message: 'ready',
    checks: { proxyBinary: true, proxyModels: true, shimRunning: true, servingVersionMatches: true },
  };

  const catalog = buildCatalog(['claude-gemini-4-argon[1m]'], codexReadiness);

  assert.deepEqual(catalog.models.map((model) => [model.id, model.provider, model.contextWindow]), [['claude-gemini-4-argon[1m]', 'vertex', 1000000]]);
  assert.equal(catalog.providers.vertex.ready, false);
  assert.equal(catalog.providers.vertex.state, 'config-invalid');
  assert.match(catalog.providers.vertex.message, /missing or invalid Vertex AI setting, most often an unset Google Cloud project/);
});

test('a shim that starts before the proxy lists the proxy models without waiting for a request', async (t) => {
  // Every listing read fails for a while, the way a proxy that is still starting does. A time
  // window rather than a read count, because the supervisor's own health probes read it too.
  const unavailableUntil = Date.now() + 1500;
  let listingReads = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      listingReads += 1;
      if (Date.now() < unavailableUntil) {
        res.writeHead(503);
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: PROXY_LISTING, has_more: false }));
    }
    res.writeHead(404);
    res.end();
  });
  const proxyPort = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const anthropic = await anthropicUpstream(t);
  const environment = gatewayTestEnvironment(t, {
    CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
    CODEX_GATEWAY_REQUEST_LOG: '0',
    CODEX_GATEWAY_ANTHROPIC_UPSTREAM: anthropic.url,
  });
  const { port } = await startGateway(t, 'serve-shim', environment);

  // One refresh-triggering read is allowed; the retries themselves must bring the listing in,
  // well inside the 60-second cache age a request would otherwise have to wait out.
  const deadline = Date.now() + 10000;
  let ids = [];
  while (Date.now() < deadline) {
    ids = JSON.parse((await request(port, 'GET', '/v1/models')).body).data.map((model) => model.id);
    if (ids.includes('claude-kimi-k3')) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(ids.includes('claude-kimi-k3'), `shim still served the fallback after ${listingReads} listing reads: ${ids.join(', ')}`);
});

test('Grok 4.7 Fast rows reach the proxy and compact 40000 below their 500000 window', async (t) => {
  const tests = {
    'local alias': { model: 'claude-grok-4.7-fast[1m]', backend: 'grok-4.7-fast' },
    'backend id': { model: 'claude-grok-4.7-build-fast[1m]', backend: 'grok-4.7-build-fast' },
  };
  for (const [name, { model, backend }] of Object.entries(tests)) {
    await t.test(name, async (st) => {
      const proxy = await listingProxy(st, (body, res) => {
        // The proxy-path sentry reads usage from the stream, which is how Claude Code asks.
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: {}, usage: { input_tokens: 460001, output_tokens: 1 } })}\n\n`
          + 'event: message_stop\ndata: {"type":"message_stop"}\n\n');
      });
      const anthropic = await anthropicUpstream(st);
      const { port } = await spawnShim(st, proxy.port, anthropic.url);
      const session = { 'x-claude-code-session-id': `grok-fast-sentry-${backend}` };

      const first = await request(port, 'POST', '/v1/messages', messageBody(model), session);
      assert.equal(first.status, 200, `${name}: ${first.body}`);
      assert.equal(proxy.received.length, 1, `${name}: the first turn reaches the proxy`);
      assert.equal(proxy.received[0].body.model, backend, `${name}: the proxy gets the un-prefixed id and resolves the alias itself`);
      assert.equal(anthropic.received.length, 0, `${name}: nothing reaches api.anthropic.com`);

      const second = await request(port, 'POST', '/v1/messages', messageBody(model), session);
      assert.equal(second.status, 413, `${name}: the turn after usage passed 460000 gets the compaction signal: ${second.body}`);
      const error = JSON.parse(second.body).error;
      assert.equal(error.type, 'request_too_large', name);
      assert.match(error.message, /Grok context window.*\(460001 tokens > 460000 tokens\)/, name);
      assert.equal(proxy.received.length, 1, `${name}: the refused turn is not forwarded`);
    });
  }
});

test('Muse rows reach the proxy and compact 40000 below their 1007997 window', async (t) => {
  const proxy = await listingProxy(t, (body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: {}, usage: { input_tokens: 967998, output_tokens: 1 } })}\n\n`
      + 'event: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
  const anthropic = await anthropicUpstream(t);
  const { port } = await spawnShim(t, proxy.port, anthropic.url);
  const session = { 'x-claude-code-session-id': 'muse-sentry' };

  const first = await request(port, 'POST', '/v1/messages', messageBody('claude-muse-spark-1.3[1m]'), session);
  assert.equal(first.status, 200, first.body);
  assert.equal(proxy.received.length, 1, 'the first turn reaches the proxy');
  assert.equal(proxy.received[0].body.model, 'muse-spark-1.3', 'the proxy gets the un-prefixed Muse id');
  assert.equal(anthropic.received.length, 0, 'nothing reaches api.anthropic.com');

  const second = await request(port, 'POST', '/v1/messages', messageBody('claude-muse-spark-1.3[1m]'), session);
  assert.equal(second.status, 413, `the turn after usage passed 967997 gets the compaction signal: ${second.body}`);
  const { error } = JSON.parse(second.body);
  assert.equal(error.type, 'request_too_large');
  assert.match(error.message, /^Prompt is too long for the Muse context window; compact and retry\. \(967998 tokens > 967997 tokens\)/);
  assert.equal(proxy.received.length, 1, 'the refused turn is not forwarded');
});

test('Vertex AI rows reach the proxy and compact 40000 below their documented window', async (t) => {
  const tests = {
    'Gemini, a window above the [1m] client window': { model: 'claude-gemini-4-argon[1m]', backend: 'gemini-4-argon', trigger: 1008576 },
    'Claude on Vertex, a window equal to the client window': { model: 'claude-vertex/anthropic/claude-opus-5-5[1m]', backend: 'vertex/anthropic/claude-opus-5-5', trigger: 960000 },
    // Not in the fixture listing: a policy row routes to the proxy by itself, as a Muse row does.
    'Gemma, a window far below the [1m] client window': { model: 'claude-vertex/google/gemma-4-26b-a4b-it-maas[1m]', backend: 'vertex/google/gemma-4-26b-a4b-it-maas', trigger: 222144 },
  };
  for (const [name, { model, backend, trigger }] of Object.entries(tests)) {
    await t.test(name, async (st) => {
      const proxy = await listingProxy(st, (body, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: {}, usage: { input_tokens: trigger + 1, output_tokens: 1 } })}\n\n`
          + 'event: message_stop\ndata: {"type":"message_stop"}\n\n');
      });
      const anthropic = await anthropicUpstream(st);
      const { port } = await spawnShim(st, proxy.port, anthropic.url);
      const session = { 'x-claude-code-session-id': `vertex-sentry-${backend}` };

      const first = await request(port, 'POST', '/v1/messages', messageBody(model), session);
      assert.equal(first.status, 200, `${name}: ${first.body}`);
      assert.equal(proxy.received.length, 1, `${name}: the first turn reaches the proxy`);
      assert.equal(proxy.received[0].body.model, backend, `${name}: the proxy gets the id it listed`);
      assert.equal(anthropic.received.length, 0, `${name}: nothing reaches api.anthropic.com`);

      const second = await request(port, 'POST', '/v1/messages', messageBody(model), session);
      assert.equal(second.status, 413, `${name}: the turn after usage passed ${trigger} gets the compaction signal: ${second.body}`);
      const { error } = JSON.parse(second.body);
      assert.equal(error.type, 'request_too_large', name);
      assert.ok(error.message.startsWith(`Prompt is too long for the Vertex AI context window; compact and retry. (${trigger + 1} tokens > ${trigger} tokens)`), `${name}: ${error.message}`);
      assert.equal(proxy.received.length, 1, `${name}: the refused turn is not forwarded`);
    });
  }
});

test('a Vertex AI row with no policy row has no sentry and forwards every turn', async (t) => {
  const proxy = await listingProxy(t, (body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: {}, usage: { input_tokens: 190000, output_tokens: 1 } })}\n\n`
      + 'event: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
  const anthropic = await anthropicUpstream(t);
  const { port } = await spawnShim(t, proxy.port, anthropic.url);
  const session = { 'x-claude-code-session-id': 'vertex-unmeasured' };

  // Mistral's documented window is below Claude Code's 200000 unknown-model window, so the row is
  // an unmeasured one: the backend's own overflow error is the only compaction signal.
  for (const turn of [1, 2]) {
    const response = await request(port, 'POST', '/v1/messages', messageBody('claude-vertex/mistralai/codestral-2'), session);
    assert.equal(response.status, 200, `turn ${turn}: ${response.body}`);
    assert.equal(proxy.received.length, turn, `turn ${turn} reaches the proxy`);
  }
});
