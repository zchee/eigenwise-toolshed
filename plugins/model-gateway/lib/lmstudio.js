'use strict';

// claude-code-proxy's lmstudio provider (src/providers/lmstudio.rs on the proxy's dev branch) lists
// every LLM downloaded into LM Studio as lmstudio/<model key> and forwards Anthropic Messages
// requests to LM Studio's local server untranslated. A model's window is the context it is loaded
// with, which only LM Studio knows, so the gateway asks the server the proxy uses. Its settings are
// resolved here the way the proxy resolves them, from this process's environment (the proxy
// inherits the gateway's) and the proxy's config.json. `claude-code-proxy lmstudio auth status`
// checks nothing and always exits 0, so readiness comes from the same question.

const { lmStudioServerState, setLmStudioServerState } = require('./proxy-models.js');
const { proxyConfigDirectory, readProxyConfig } = require('./proxy-config.js');

const LMSTUDIO_PROVIDER = 'lmstudio';
const LMSTUDIO_MODEL_PREFIX = 'lmstudio/';
const LMSTUDIO_DEFAULT_BASE_URL = 'http://127.0.0.1:1234';
const LMSTUDIO_ENABLED_ENV = 'CCP_LMSTUDIO_ENABLED';
const LMSTUDIO_BASE_URL_ENV = 'CCP_LMSTUDIO_BASE_URL';
const LMSTUDIO_API_KEY_ENV = 'CCP_LMSTUDIO_API_KEY';
// The variable LM Studio's own documentation uses; the proxy reads it after its own.
const LM_STUDIO_TOKEN_ENV = 'LM_API_TOKEN';

// A blank value counts as not set, as it does for the proxy.
function setting(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function enabledFromEnv(raw) {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  return ['0', 'false', 'no', 'off'].includes(value) ? false : null;
}

function isLoopbackHost(hostname) {
  if (hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname)) return true;
  return hostname.replace(/\.$/, '').toLowerCase() === 'localhost';
}

// The origin of an LM Studio server URL, or the reason the proxy refuses it. The URL receives the
// API token, so it must be https, or plain http only to a loopback host, and name nothing but a
// scheme, a host and a port (config.rs validate_token_endpoint and lmstudio_origin).
function lmStudioOrigin(value) {
  let url;
  try { url = new URL(value); } catch { return { reason: 'not a valid URL' }; }
  if (!url.hostname) return { reason: 'the URL has no host' };
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    return { reason: 'must use https (plain http only for a loopback host)' };
  }
  if (url.username || url.password) return { reason: 'must not contain a user name or password' };
  if (!['', '/'].includes(url.pathname) || /[?#]/.test(url.href)) {
    return { reason: 'must be a scheme, a host and a port only, without a path such as /v1' };
  }
  return { origin: url.origin };
}

// The lmstudio section of config.json as the proxy's typed reader takes it: enabled a boolean,
// baseUrl and apiKey strings, each optional or null. One field of another type fails the proxy's
// parse of the whole file, which then counts as no config, so such a section supplies nothing here
// either; taking the fields that happen to be well typed would name a server the proxy does not
// use. A type error in another section has the same effect on the proxy and is not seen here.
function lmStudioFileConfig(section) {
  if (section === null || section === undefined) return {};
  const optional = (value, type) => value === undefined || value === null || typeof value === type;
  const wellTyped = typeof section === 'object' && !Array.isArray(section)
    && optional(section.enabled, 'boolean') && optional(section.baseUrl, 'string') && optional(section.apiKey, 'string');
  return wellTyped ? section : {};
}

// { enabled: false }, { enabled: true, baseUrl, apiKey }, or { enabled: true, invalid: { setting,
// reason } }: env over config.json over the default, as config.rs resolve_lmstudio_settings. The
// proxy lists and routes nothing when the provider is off, and reports an invalid setting by name
// on every listing and request instead of hiding the provider.
function lmStudioSettings({ env = process.env, configDirectory = proxyConfigDirectory({ env }) } = {}) {
  const file = lmStudioFileConfig(readProxyConfig(configDirectory)?.lmstudio);
  const enabled = enabledFromEnv(env[LMSTUDIO_ENABLED_ENV]) ?? file.enabled ?? true;
  if (!enabled) return { enabled: false };

  const fromEnv = setting(env[LMSTUDIO_BASE_URL_ENV]);
  const fromFile = fromEnv ? null : setting(file.baseUrl);
  const { origin, reason } = lmStudioOrigin(fromEnv || fromFile || LMSTUDIO_DEFAULT_BASE_URL);
  if (!origin) {
    return { enabled: true, invalid: { setting: fromEnv ? LMSTUDIO_BASE_URL_ENV : 'lmstudio.baseUrl in config.json', reason } };
  }
  const apiKey = setting(env[LMSTUDIO_API_KEY_ENV]) || setting(env[LM_STUDIO_TOKEN_ENV]) || setting(file.apiKey);
  return { enabled: true, baseUrl: origin, apiKey };
}

function loadedContext(instance) {
  const length = instance?.config?.context_length;
  return Number.isSafeInteger(length) && length > 0 ? length : null;
}

// GET /api/v1/models lists every downloaded model with max_context_length, which is the most the
// model supports, and loaded_instances, whose config.context_length is the context an instance was
// loaded with. That loaded context is the most one request can use, whatever config.parallel says:
// an instance loaded with 4096 and parallel 4 took a 3017-token prompt and refused a 6017-token
// one against n_ctx 4096 (LM Studio 0.4.28, llama.cpp engine, 2026-11-25). A request naming the
// model key went to the instance whose id is that key, measured with a second instance loaded
// under another identifier. Which instance answers when none carries the key as its id is not
// measured, so the smallest loaded context stands in. An unloaded model has no window: LM Studio
// loads it on its first request with that model's own default context.
function modelWindow(key, instances) {
  const named = instances.find((instance) => instance?.id === key);
  if (named) return loadedContext(named);
  const windows = instances.map(loadedContext).filter((window) => window !== null);
  return windows.length ? Math.min(...windows) : null;
}

// Model key -> { loaded, contextWindow }. Embedding models are left out, as the proxy leaves them
// out of its listing: they cannot answer a Messages request. A Map, because a key is whatever the
// model's publisher named it.
function modelsFromCatalog(entries) {
  const models = new Map();
  for (const entry of entries) {
    if (entry?.type !== 'llm' || typeof entry.key !== 'string' || !entry.key) continue;
    const instances = Array.isArray(entry.loaded_instances) ? entry.loaded_instances : [];
    models.set(entry.key, { loaded: instances.length > 0, contextWindow: modelWindow(entry.key, instances) });
  }
  return models;
}

// { enabled, baseUrl, hasApiKey, reachable, models, invalid?, authRequired?, error? }. Never throws:
// a stopped or refusing server is a readiness state, not a failure of the caller. The token goes
// out as a header only and is never part of the state, so nothing that prints the state can leak it.
async function probeLmStudio({ env = process.env, configDirectory, fetchUrl, timeout = 1500 } = {}) {
  const settings = lmStudioSettings({ env, configDirectory: configDirectory ?? proxyConfigDirectory({ env }) });
  const none = { baseUrl: null, hasApiKey: false, reachable: false, models: new Map() };
  if (!settings.enabled) return { enabled: false, ...none };
  if (settings.invalid) return { enabled: true, ...none, invalid: settings.invalid };
  const { baseUrl, apiKey } = settings;
  const state = { enabled: true, baseUrl, hasApiKey: Boolean(apiKey), reachable: false, models: new Map() };
  try {
    const response = await fetchUrl(`${baseUrl}/api/v1/models`, { timeout, headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} });
    if (response.status === 401 || response.status === 403) return { ...state, reachable: true, authRequired: true };
    if (response.status !== 200) return { ...state, error: `GET /api/v1/models answered HTTP ${response.status}` };
    let catalog = null;
    try { catalog = JSON.parse(response.body.toString()); } catch { /* not LM Studio */ }
    if (!Array.isArray(catalog?.models)) return { ...state, error: 'GET /api/v1/models returned no model list' };
    return { ...state, reachable: true, models: modelsFromCatalog(catalog.models) };
  } catch (error) {
    return { ...state, error: error?.code || error?.message || String(error) };
  }
}

// Probes LM Studio when the listing has one of its rows and records the answer for policy
// resolution. The proxy lists the models on this machine's disk while a loopback server is
// stopped, so rows outlive the server; a server that stops answering at the same address keeps the
// windows of its last answer, the way a failed listing refresh keeps the last listing, because
// dropping them would change each row's picker id (with or without [1m]) for the length of an
// outage. A server that answers decides afresh, so an unloaded model loses its window.
async function refreshLmStudioState(routes, { env = process.env, configDirectory, fetchUrl } = {}) {
  if (!Array.isArray(routes) || !routes.some(({ provider }) => provider === LMSTUDIO_PROVIDER)) {
    setLmStudioServerState(null);
    return null;
  }
  const previous = lmStudioServerState();
  const state = await probeLmStudio({ env, configDirectory, fetchUrl });
  if (!state.reachable && state.baseUrl !== null && previous?.baseUrl === state.baseUrl) state.models = previous.models;
  setLmStudioServerState(state);
  return lmStudioServerState();
}

module.exports = {
  LMSTUDIO_API_KEY_ENV,
  LMSTUDIO_BASE_URL_ENV,
  LMSTUDIO_DEFAULT_BASE_URL,
  LMSTUDIO_ENABLED_ENV,
  LMSTUDIO_MODEL_PREFIX,
  LMSTUDIO_PROVIDER,
  LM_STUDIO_TOKEN_ENV,
  lmStudioOrigin,
  lmStudioSettings,
  probeLmStudio,
  refreshLmStudioState,
};
