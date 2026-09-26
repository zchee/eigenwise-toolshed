'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const proxyModels = require(path.join(__dirname, '..', 'lib', 'proxy-models.js'));
const runtime = require(path.join(__dirname, '..', 'lib', 'runtime.js'));
const pins = require(path.join(__dirname, '..', 'lib', 'pins.js'));

// Rows exactly as claude-code-proxy 0.1.42 serves them on /v1/models: one per provider family,
// plus the Anthropic-style aliases it lists under its alias provider.
const PROXY_LISTING = [
  { type: 'model', object: 'model', id: 'claude-opus-5-5', display_name: 'claude-opus-5-5 (codex)' },
  { type: 'model', object: 'model', id: 'haiku', display_name: 'haiku (codex)' },
  { type: 'model', object: 'model', id: 'fable', display_name: 'fable (codex)' },
  { type: 'model', object: 'model', id: 'gpt-6-sol', display_name: 'gpt-6-sol (codex)' },
  { type: 'model', object: 'model', id: 'gpt-6-sol-fast', display_name: 'gpt-6-sol-fast (codex)' },
  { type: 'model', object: 'model', id: 'cursor-agent', display_name: 'cursor-agent (cursor)' },
  { type: 'model', object: 'model', id: 'composer-2.5', display_name: 'composer-2.5 (cursor)' },
  { type: 'model', object: 'model', id: 'grok-4.7', display_name: 'grok-4.7 (grok)' },
  { type: 'model', object: 'model', id: 'grok-composer-2.5-fast', display_name: 'grok-composer-2.5-fast (grok)' },
  { type: 'model', object: 'model', id: 'kimi-k3', display_name: 'kimi-k3 (kimi)' },
  { type: 'model', object: 'model', id: 'k3', display_name: 'k3 (kimi)' },
  { type: 'model', object: 'model', id: 'glm-5.3', display_name: 'glm-5.3 (opencode)' },
  { type: 'model', object: 'model', id: 'opencode-go/kimi-k2.6', display_name: 'opencode-go/kimi-k2.6 (opencode)' },
];

function withRoutes(t, routes) {
  const previous = proxyModels.proxyModelRoutes();
  proxyModels.setProxyModelRoutes(routes);
  t.after(() => proxyModels.setProxyModelRoutes(previous));
}

test('parseProxyModelListing attributes every provider row and drops Anthropic-style aliases', () => {
  assert.deepEqual(proxyModels.parseProxyModelListing(PROXY_LISTING), [
    { id: 'gpt-6-sol', provider: 'codex' },
    { id: 'gpt-6-sol-fast', provider: 'codex' },
    { id: 'cursor-agent', provider: 'cursor' },
    { id: 'composer-2.5', provider: 'cursor' },
    { id: 'grok-4.7', provider: 'grok' },
    { id: 'grok-composer-2.5-fast', provider: 'grok' },
    { id: 'kimi-k3', provider: 'kimi' },
    { id: 'k3', provider: 'kimi' },
    { id: 'glm-5.3', provider: 'opencode' },
    { id: 'opencode-go/kimi-k2.6', provider: 'opencode' },
  ]);
});

test('parseProxyModelListing rejects malformed rows instead of guessing a provider', () => {
  const tests = {
    'error: non-array listing': { rows: { data: [] }, expected: [] },
    'error: missing id': { rows: [{ display_name: 'x (codex)' }], expected: [] },
    'error: display name names a different id': { rows: [{ id: 'glm-5', display_name: 'glm-6 (opencode)' }], expected: [] },
    'error: unattributed non-Codex row': { rows: [{ id: 'glm-5', display_name: 'glm-5' }], expected: [] },
    'success: unattributed Codex row from an older proxy': {
      rows: [{ id: 'gpt-5.4', display_name: 'gpt-5.4' }],
      expected: [{ id: 'gpt-5.4', provider: 'codex' }],
    },
    'success: repeated id keeps its first provider': {
      rows: [{ id: 'k3', display_name: 'k3 (kimi)' }, { id: 'k3', display_name: 'k3 (opencode)' }],
      expected: [{ id: 'k3', provider: 'kimi' }],
    },
  };
  for (const [name, { rows, expected }] of Object.entries(tests)) {
    assert.deepEqual(proxyModels.parseProxyModelListing(rows), expected, name);
  }
});

test('modelsFileRoutes keeps only Codex ids, since nothing else proves a provider without a listing', () => {
  assert.deepEqual(proxyModels.modelsFileRoutes(['gpt-5.4', 'glm-5', 'auto', 7, 'gpt-5.4', 'haiku']), [
    { id: 'gpt-5.4', provider: 'codex' },
  ]);
  assert.deepEqual(proxyModels.modelsFileRoutes('gpt-5.4'), []);
});

test('providerLabel names known providers and capitalizes unknown ones', () => {
  assert.equal(proxyModels.providerLabel('opencode'), 'OpenCode');
  assert.equal(proxyModels.providerLabel('kimi'), 'Kimi');
  assert.equal(proxyModels.providerLabel('mistral'), 'Mistral');
  assert.equal(proxyModels.proxyModelDisplayName('glm-5.3', 'opencode'), 'glm-5.3 (OpenCode)');
});

test('proxy routes resolve to a 200k unmeasured policy under the provider name', (t) => {
  withRoutes(t, proxyModels.parseProxyModelListing(PROXY_LISTING));
  const tests = {
    'kimi row': { id: 'claude-kimi-k3', backend: 'kimi', backendId: 'kimi-k3', clientId: 'claude-kimi-k3' },
    'opencode row with a provider prefix': {
      id: 'claude-opencode-go/kimi-k2.6', backend: 'opencode', backendId: 'opencode-go/kimi-k2.6', clientId: 'claude-opencode-go/kimi-k2.6',
    },
    'cursor row': { id: 'claude-cursor-agent', backend: 'cursor', backendId: 'cursor-agent', clientId: 'claude-cursor-agent' },
    'grok row only the proxy serves': {
      id: 'claude-grok-composer-2.5-fast', backend: 'grok', backendId: 'grok-composer-2.5-fast', clientId: 'claude-grok-composer-2.5-fast',
    },
  };
  for (const [name, { id, backend, backendId, clientId }] of Object.entries(tests)) {
    const policy = runtime.resolveGatewayModelPolicy(id);
    assert.equal(policy.backend, backend, name);
    assert.equal(policy.transport, 'proxy', name);
    assert.equal(policy.backendId, backendId, name);
    assert.equal(policy.sentry, 'none', name);
    assert.equal(runtime.gatewayAdvertisedWindow(id), runtime.CODEX_UNKNOWN_MODEL_WINDOW, name);
    assert.equal(runtime.gatewayClientModelId(id), clientId, name);
    assert.equal(runtime.gatewayClientModelId(backendId), clientId, `${name} from its backend id`);
  }
});

test('native Grok, Codex, and Anthropic ids keep their transports when the proxy lists them too', (t) => {
  withRoutes(t, proxyModels.parseProxyModelListing(PROXY_LISTING));
  const tests = {
    'measured native Grok row': { id: 'claude-grok-4.7[1m]', backend: 'grok', transport: 'grok' },
    'measured Codex row': { id: 'claude-gpt-6-astra[1m]', backend: 'codex', transport: 'proxy' },
    'unmeasured Codex fast row': { id: 'claude-gpt-6-sol-fast[1m]', backend: 'codex', transport: 'proxy' },
    'Claude model the proxy aliases': { id: 'claude-opus-5-5[1m]', backend: 'anthropic', transport: 'anthropic' },
    'policy table default key is not a model': { id: 'claude-default', backend: 'anthropic', transport: 'anthropic' },
  };
  for (const [name, { id, backend, transport }] of Object.entries(tests)) {
    const policy = runtime.resolveGatewayModelPolicy(id);
    assert.equal(policy.backend, backend, name);
    assert.equal(policy.transport, transport, name);
  }
});

test('proxyRouteFromId claims only ids the proxy serves', (t) => {
  withRoutes(t, proxyModels.parseProxyModelListing(PROXY_LISTING));
  const tests = {
    'success: kimi': { id: 'claude-kimi-k3', expected: { provider: 'kimi', base: 'kimi-k3' } },
    'success: opencode prefix form': { id: 'claude-opencode-go/kimi-k2.6', expected: { provider: 'opencode', base: 'opencode-go/kimi-k2.6' } },
    'success: proxy-only Grok row': { id: 'claude-grok-composer-2.5-fast', expected: { provider: 'grok', base: 'grok-composer-2.5-fast' } },
    'success: Codex with [1m]': { id: 'claude-gpt-6-sol[1m]', expected: { provider: 'codex', base: 'gpt-6-sol' } },
    'success: legacy Codex prefix': { id: 'claude-codex-gpt-5.4', expected: { provider: 'codex', base: 'gpt-5.4' } },
    'success: dispatch model': { id: 'claude-codex-auto', expected: { provider: 'codex', base: 'auto' } },
    'error: native Grok row': { id: 'claude-grok-4.7[1m]', expected: null },
    'error: Claude model': { id: 'claude-opus-5-5', expected: null },
    'error: bare proxy id without the gateway prefix': { id: 'kimi-k3', expected: null },
    'error: id the proxy never listed': { id: 'claude-glm-99', expected: null },
    'error: legacy prefix on a non-Codex id': { id: 'claude-codex-kimi-k3', expected: null },
  };
  for (const [name, { id, expected }] of Object.entries(tests)) {
    assert.deepEqual(pins.proxyRouteFromId(id), expected, name);
  }
  assert.equal(pins.codexBaseFromId('claude-kimi-k3'), null);
  assert.equal(pins.codexBaseFromId('claude-gpt-6-sol[1m]'), 'gpt-6-sol');
  assert.equal(pins.isGatewayModelId('claude-glm-5.3'), true);
  assert.equal(pins.isGatewayModelId('claude-opus-5-5'), false);
});

test('without a listing only Codex ids route to the proxy', (t) => {
  withRoutes(t, []);
  assert.deepEqual(pins.proxyRouteFromId('claude-gpt-5.4'), { provider: 'codex', base: 'gpt-5.4' });
  assert.equal(pins.proxyRouteFromId('claude-kimi-k3'), null);
  assert.equal(runtime.resolveGatewayModelPolicy('claude-kimi-k3').backend, 'anthropic');
});
