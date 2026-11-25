'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const grokBackend = require('./grok-backend.js');
const { writeFileAtomically } = require('./atomic-file.js');
const {
  CODEX_FAMILY_RE, advertisedProxyModelPart, lmStudioServerState, localServerState, proxyModelProvider, proxyRouteIdForAdvertisedPart,
} = require('./proxy-models.js');
const { LOCAL_PROVIDER } = require('./local-llama.js');
const { LMSTUDIO_MODEL_PREFIX, LMSTUDIO_PROVIDER } = require('./lmstudio.js');

const WIN = process.platform === 'win32';
const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const STATE = path.join(os.homedir(), '.claude', 'model-gateway');
const LOGS = path.join(STATE, 'logs');
const BIN_DIR = path.join(STATE, 'bin');
const WIRING_CONFIG_PATH = path.join(STATE, 'wiring.json');
const PROJECT_WIRING_REGISTRY_PATH = path.join(STATE, 'wired-projects.json');
const SHIM_FAILURE_PATH = path.join(STATE, 'shim-supervisor-failure.txt');
const CODEX_UPSTREAM_BLOCK_PATH = path.join(STATE, 'codex-upstream-blocked.json');
const PROXY_BIN = path.join(BIN_DIR, WIN ? 'claude-code-proxy.exe' : 'claude-code-proxy');
const PUBLIC_SHIM_PORT = Number(process.env.CODEX_GATEWAY_PORT || 18764);
const SHIM_PORT = Number(process.env.CODEX_GATEWAY_WORKER_PORT || PUBLIC_SHIM_PORT);
const PROXY_PORT = Number(process.env.CODEX_GATEWAY_PROXY_PORT || 18765);
const PREFIX = 'claude-';
const GROK_PREFIX = 'claude-grok-';
const LEGACY_CODEX_PREFIX = 'claude-codex-';
const DISPATCH_MODEL_ID = 'claude-codex-auto';
const GROK_ENDPOINT = process.env.CODEX_GATEWAY_GROK_ENDPOINT || grokBackend.GROK_ENDPOINT;
const REPO = 'raine/claude-code-proxy';
const MIN_PROXY_VERSION = '0.1.14';
const ANTHROPIC_UPSTREAM = process.env.CODEX_GATEWAY_ANTHROPIC_UPSTREAM || 'https://api.anthropic.com';
const REQUEST_ROUTE_LOG = process.env.CODEX_GATEWAY_REQUEST_LOG !== '0';
const REQUEST_ROUTE_LOG_PATH = process.env.CODEX_GATEWAY_REQUEST_LOG_PATH || path.join(LOGS, 'request-routes.jsonl');
const LIFECYCLE_LOG_PATH = path.join(LOGS, 'lifecycle.jsonl');
const DISPATCH_ROUTE_CACHE_PATH = process.env.CODEX_GATEWAY_DISPATCH_CACHE_PATH || path.join(STATE, 'dispatch-routes.json');
const LIST_DISPATCH_MODEL = process.env.CODEX_GATEWAY_LIST_DISPATCH_MODEL === '1';
const ROUTE_TELEMETRY_ENABLED = process.env.CLAUDE_CODE_PROPAGATE_TRACEPARENT === '1';
const ROUTE_TELEMETRY_TIMEOUT_MS = 500;
const TRACE_HEADERS = ['traceparent', 'tracestate', 'baggage'];
const AUTH_HEADERS = ['authorization', 'proxy-authorization', 'x-api-key', 'cookie'];
const COMPAT_HOST = 'api.anthropic.com';
const COMPAT_PORT = Number(process.env.CODEX_GATEWAY_COMPAT_PORT || 80);
const DEFAULT_BASE_URL = `http://127.0.0.1:${PUBLIC_SHIM_PORT}`;
const SOCKET_PATH = process.env.CODEX_GATEWAY_SOCKET_PATH || (WIN
  ? '\\\\.\\pipe\\model-gateway'
  : path.join(STATE, 'gateway.sock'));
const COMPAT_BASE_URL = `http://${COMPAT_HOST}`;
const HOSTS_BLOCK_START = '# >>> model-gateway RC compatibility >>>';
const HOSTS_BLOCK_END = '# <<< model-gateway RC compatibility <<<';
const HOSTS_BLOCK_LINE = `127.0.0.1 ${COMPAT_HOST}`;
const CODEX_UNKNOWN_MODEL_WINDOW = 200000;
// The [1m] picker alias gives Claude Code a 1000000-token client window, so a row whose backend
// takes more still advertises 1000000.
const PICKER_ALIAS_CLIENT_WINDOW = 1000000;

// Google Cloud Vertex AI models, served only by claude-code-proxy's vertex provider. The proxy
// lists each Gemini model under its bare id and again as vertex/<id>; every other family is
// vertex/<publisher>/<id>. A registered model has a row only when a source documents a window above
// Claude Code's 200000 unknown-model window. Mistral, gpt-oss, Grok 4.3 and the two dated Claude
// ids are documented at or below it, DeepSeek has no documented window, and a deployed endpoint
// (vertex/endpoint/<name>) serves whatever its owner deployed, so all of those stay unmeasured
// 200000 rows. transport is explicit so a request is forwarded to the proxy and doctor does not
// expect these rows when no live listing proves the proxy serves them.
const VERTEX_GEMINI_IDS = Object.freeze([
  'gemini-4-argon', 'gemini-4-carbon', 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash',
  'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview',
]);
const VERTEX_WINDOW_EVIDENCE = Object.freeze([
  ['models.dev google-vertex 2026-11-12', [
    [1048576, VERTEX_GEMINI_IDS.flatMap((id) => [id, `vertex/${id}`])],
    [1000000, [
      'claude-fable-5-2', 'claude-fable-5-1', 'claude-fable-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8',
      'claude-opus-4-7', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-haiku-5-5', 'claude-opus-4-6', 'claude-sonnet-4-6',
    ].map((id) => `vertex/anthropic/${id}`)],
    [524288, ['vertex/xai/grok-4.7', 'vertex/xai/grok-4.6']],
    [2000000, ['vertex/xai/grok-4.20-reasoning', 'vertex/xai/grok-4.20-non-reasoning']],
    [1000000, ['vertex/zai-org/glm-5.2-maas']],
    [262144, ['vertex/google/gemma-4-26b-a4b-it-maas']],
    [524288, ['vertex/meta/llama-4-maverick-17b-128e-instruct-maas']],
    [1310720, ['vertex/meta/llama-4-scout-17b-16e-instruct-maas']],
  ]],
  ['claude-code-proxy dev c31326c 2026-11-12 docs/providers/vertex.md, quoting Google\'s input limit', [
    [922000, ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna'].map((id) => `vertex/openai/${id}`)],
    [1048576, ['muse-spark-1.3', 'muse-wonder-1.0', 'muse-ember-1.0'].map((id) => `vertex/meta/${id}`)],
  ]],
]);

function vertexWindowPolicyRows() {
  return Object.fromEntries(VERTEX_WINDOW_EVIDENCE.flatMap(([source, windows]) => windows.flatMap(([backendWindow, backendIds]) => backendIds
    .map((backendId) => [backendId, Object.freeze({
      backend: 'vertex',
      transport: 'proxy',
      backendId,
      backendWindow,
      measurement: `${source} (context ${backendWindow}); not a live probe`,
      pickerAlias: `claude-${backendId}[1m]`,
      advertisedWindow: Math.min(backendWindow, PICKER_ALIAS_CLIENT_WINDOW),
      sentry: 'synthetic-413',
    })]))));
}

const MODEL_WINDOW_POLICY = Object.freeze({
  default: Object.freeze({
    backend: 'codex',
    backendId: 'default',
    backendWindow: 920000,
    measurement: 'unmeasured default for Codex proxy rows absent from this table',
    pickerAliasTemplate: 'claude-{backendId}[1m]',
    advertisedWindow: 920000,
    sentry: 'synthetic-413',
  }),
  'gpt-5.6-sol': Object.freeze({
    backend: 'codex',
    backendId: 'gpt-5.6-sol',
    backendWindow: 920012,
    measurement: 'measured 2026-09-05: 920012 accepted; 935012 refused',
    pickerAlias: 'claude-gpt-5.6-sol[1m]',
    advertisedWindow: 920000,
    sentry: 'synthetic-413',
  }),
  'gpt-5.6-terra': Object.freeze({
    backend: 'codex',
    backendId: 'gpt-5.6-terra',
    backendWindow: 920012,
    measurement: 'measured 2026-09-05: 920012 accepted; 935012 refused',
    pickerAlias: 'claude-gpt-5.6-terra[1m]',
    advertisedWindow: 920000,
    sentry: 'synthetic-413',
  }),
  'gpt-5.6-luna': Object.freeze({
    backend: 'codex',
    backendId: 'gpt-5.6-luna',
    backendWindow: 920012,
    measurement: 'measured 2026-09-05: 920012 accepted; 935012 refused',
    pickerAlias: 'claude-gpt-5.6-luna[1m]',
    advertisedWindow: 920000,
    sentry: 'synthetic-413',
  }),
  'gpt-6-astra': Object.freeze({
    backend: 'codex',
    backendId: 'gpt-6-astra',
    backendWindow: 920012,
    measurement: 'measured 2026-09-05: 920012 accepted; 935012 refused',
    pickerAlias: 'claude-gpt-6-astra[1m]',
    advertisedWindow: 920000,
    sentry: 'synthetic-413',
  }),
  'gpt-6.1-sol': Object.freeze({
    backend: 'codex',
    backendId: 'gpt-6.1-sol',
    backendWindow: 920012,
    measurement: 'measured 2026-09-30: 920012 accepted; 935012 refused',
    pickerAlias: 'claude-gpt-6.1-sol[1m]',
    advertisedWindow: 920000,
    sentry: 'synthetic-413',
  }),
  'grok-4.7': Object.freeze({
    backend: 'grok',
    backendId: 'grok-4.7',
    backendWindow: 500000,
    measurement: 'models.dev xai/grok-4.7 2026-10-17 (context 500000) and Grok CLI models_cache.json 2026-09-23 (500000); the Grok CLI README calls its 256000 default an auto-compact threshold with 500000 selectable, not a backend limit; not a live probe',
    pickerAlias: 'claude-grok-4.7[1m]',
    advertisedWindow: 500000,
    sentry: 'synthetic-413',
  }),
  // Grok 4.7 Fast is served only by claude-code-proxy, which sends both ids upstream as
  // grok-4.7-build-fast; this plugin's Grok backend would get a 404 for grok-4.7-fast. transport
  // is explicit because a 'grok' backend otherwise means this plugin's Grok backend.
  'grok-4.7-fast': Object.freeze({
    backend: 'grok',
    transport: 'proxy',
    backendId: 'grok-4.7-fast',
    backendWindow: 500000,
    measurement: 'same model as grok-4.7 per claude-code-proxy grok-4.7-fast branch; window from grok-4.7 (models.dev 2026-10-17, Grok CLI README 2026-10-16); not a live probe',
    pickerAlias: 'claude-grok-4.7-fast[1m]',
    advertisedWindow: 500000,
    sentry: 'synthetic-413',
  }),
  'grok-4.7-build-fast': Object.freeze({
    backend: 'grok',
    transport: 'proxy',
    backendId: 'grok-4.7-build-fast',
    backendWindow: 500000,
    measurement: 'same model as grok-4.7 per claude-code-proxy grok-4.7-fast branch; window from grok-4.7 (models.dev 2026-10-17, Grok CLI README 2026-10-16); not a live probe',
    pickerAlias: 'claude-grok-4.7-build-fast[1m]',
    advertisedWindow: 500000,
    sentry: 'synthetic-413',
  }),
  'grok-4.6': Object.freeze({
    backend: 'grok',
    backendId: 'grok-4.6',
    backendWindow: 500000,
    measurement: 'measured 2026-09-15 from Grok CLI models_cache.json (context_window 500000)',
    pickerAlias: 'claude-grok-4.6[1m]',
    advertisedWindow: 500000,
    sentry: 'synthetic-413',
  }),
  'grok-4.5': Object.freeze({
    backend: 'grok',
    backendId: 'grok-4.5',
    backendWindow: 500000,
    measurement: 'measured 2026-09-05 from grok-backend.js GROK_MODELS',
    pickerAlias: 'claude-grok-4.5[1m]',
    advertisedWindow: 500000,
    sentry: 'synthetic-413',
  }),
  // Meta's Muse Code models, served only by claude-code-proxy's muse provider. All five share one
  // window, so they are one row shape. They advertise the [1m] alias's 1000000 client window, which
  // stays under the backend's 1007997. transport is explicit so a request is forwarded to the proxy
  // and doctor does not expect these rows when no live listing proves the proxy serves them.
  ...Object.fromEntries(['muse-spark-1.3', 'muse-spark-1.2', 'muse-wonder-1.0', 'muse-wonder-full-1.0', 'muse-ember-1.0']
    .map((backendId) => [backendId, Object.freeze({
      backend: 'muse',
      transport: 'proxy',
      backendId,
      backendWindow: 1007997,
      measurement: 'claude-code-proxy dev 1b2e80b 2026-11-10 docs/providers/muse.md (context 1007997, max output 128000 for every Muse model); not a live probe',
      pickerAlias: `claude-${backendId}[1m]`,
      advertisedWindow: 1000000,
      sentry: 'synthetic-413',
    })])),
  ...vertexWindowPolicyRows(),
  anthropic: Object.freeze({
    backend: 'anthropic',
    backendId: 'anthropic',
    backendWindow: null,
    measurement: 'upstream-managed native Anthropic passthrough',
    pickerAlias: 'claude-anthropic',
    advertisedWindow: null,
    sentry: 'none',
  }),
});
const CODEX_CONTEXT_WINDOWS = MODEL_WINDOW_POLICY;

// One persisted setting per backend, shared by the orchestrator and every executor: the gateway sees the same
// model ids from both, and no request header tells them apart.
const CONTEXT_WINDOW_PATH = path.join(STATE, 'context-window.json');
const CONTEXT_WINDOW_BACKENDS = Object.freeze(['claude', 'codex', 'grok']);
const COMPACT_AT_BACKENDS = Object.freeze(['codex', 'grok']);
const DEFAULT_CONTEXT_WINDOWS = Object.freeze({ claude: 'full', codex: 272000, grok: 'full' });
const CODEX_BILLING_RULE = 'OpenAI bills input above 272k tokens at 2x';
const CODEX_DOUBLE_BILLING_THRESHOLD = 272000;
// One turn of growth: a response plus the tool results that answer it. The sentry keeps this much headroom.
const CODEX_COMPACT_HEADROOM = 40000;
// Claude Code 2.1.286's compaction instructions are about 7.3k characters; 5k tokens covers them with room.
const COMPACTION_PROMPT_TOKENS = 5000;
// Claude Code never reads max_input_tokens for a [1m] gateway row (its discovery cache keeps only id and name),
// so a cap is enforced by the gateway's synthetic-413 sentry. The sentry refuses turn k+1 once turn k's input
// passed the trigger, so turn k can already be one turn of growth past it, and the compaction turn that follows
// resends all of that plus one more turn and the compaction prompt. Cap C therefore compacts past
// C - 2 * 40000 - 5000: 272000 compacts past 187000. Turn growth is unbounded, so this reserve
// cannot guarantee that crossing turns or compaction requests stay below the cap.
const CAP_COMPACTION_MARGIN = 2 * CODEX_COMPACT_HEADROOM + COMPACTION_PROMPT_TOKENS;
const CONTEXT_WINDOW_MAX = 1000000;
// Claude caps go into Claude Code's own autoCompactWindow, which takes 100k-1M. A gateway cap has to leave the
// sentry at least 100k to compact past, or a session would compact on its system prompt alone.
const CONTEXT_WINDOW_MIN = Object.freeze({ claude: 100000, codex: 100000 + CAP_COMPACTION_MARGIN, grok: 100000 + CAP_COMPACTION_MARGIN });

function parseContextWindowValue(backend, value) {
  if (value === 'full') return 'full';
  const tokens = Number(value);
  return Number.isInteger(tokens) && tokens >= CONTEXT_WINDOW_MIN[backend] && tokens <= CONTEXT_WINDOW_MAX ? tokens : null;
}

// CODEX_GATEWAY_CONTEXT_WINDOW predates the saved setting and still works, below it.
function resolveContextWindow(backend, saved, env) {
  const savedValue = parseContextWindowValue(backend, saved?.[backend]);
  if (savedValue !== null) return { value: savedValue, source: 'saved' };
  const envValue = backend === 'codex' ? parseContextWindowValue(backend, env.CODEX_GATEWAY_CONTEXT_WINDOW) : null;
  if (envValue !== null) return { value: envValue, source: 'CODEX_GATEWAY_CONTEXT_WINDOW' };
  return { value: DEFAULT_CONTEXT_WINDOWS[backend], source: 'default' };
}

function readSavedContextWindows(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function parseCompactAtValue(value) {
  if (!['string', 'number'].includes(typeof value)) return null;
  const tokens = Number(value);
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : null;
}

function validateCompactAtSettings(compactAt = {}) {
  for (const [backend, value] of Object.entries(compactAt)) {
    if (!COMPACT_AT_BACKENDS.includes(backend)) {
      throw new Error(`unsupported compactAt.${backend}: direct compaction maxima are supported for Codex and Grok only; use --claude <tokens|full> for the native window`);
    }
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid compactAt.${backend}: use a positive whole token count`);
  }
}

function resolveContextWindowSetting(backend, saved, env) {
  const setting = resolveContextWindow(backend, saved, env);
  const compactAt = saved?.compactAt?.[backend];
  if (compactAt !== undefined) setting.compactAt = parseCompactAtValue(compactAt);
  return setting;
}

function readContextWindowSettings({ file = CONTEXT_WINDOW_PATH, env = process.env } = {}) {
  const saved = readSavedContextWindows(file);
  validateCompactAtSettings(saved?.compactAt);
  return Object.fromEntries(CONTEXT_WINDOW_BACKENDS.map((backend) => [backend, resolveContextWindowSetting(backend, saved, env)]));
}

function writeContextWindowSettings(values, file = CONTEXT_WINDOW_PATH) {
  validateCompactAtSettings(values.compactAt);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomically(file, JSON.stringify(values, null, 2) + '\n');
}

const CONTEXT_WINDOWS = readContextWindowSettings();
const configuredCompactTrigger = Number(process.env.CODEX_GATEWAY_COMPACT_TRIGGER);

function contextWindowCap(backend, windows = CONTEXT_WINDOWS) {
  const value = windows[backend]?.value;
  return Number.isInteger(value) ? value : null;
}

function contextWindowCompactAt(backend, windows = CONTEXT_WINDOWS) {
  return windows[backend]?.compactAt ?? null;
}

function gatewayCompactTrigger(cap, compactAt) {
  if (compactAt !== null && compactAt !== undefined) return Math.min(compactAt, cap ?? Infinity);
  return cap ? cap - CAP_COMPACTION_MARGIN : null;
}

function gatewayCompactionCandidates(compactTrigger, cap, compactAt) {
  if (compactAt !== null) return [{ compactTrigger: gatewayCompactTrigger(cap, compactAt), source: 'compact-at' }];
  const triggers = [];
  if (Number.isFinite(compactTrigger) && compactTrigger > 0) triggers.push({ compactTrigger, source: 'env' });
  if (cap) triggers.push({ compactTrigger: gatewayCompactTrigger(cap, null), source: 'cap' });
  return triggers;
}

// Rows measured against a fixed backend keep the 40000-token reserve. A row whose window is set by
// the user's own server (the local llama-server row) carries a reserve scaled to that window.
function sentryHeadroom(policy) {
  return Number.isSafeInteger(policy?.compactHeadroom) && policy.compactHeadroom > 0 ? policy.compactHeadroom : CODEX_COMPACT_HEADROOM;
}

function sentryBackendWindow(policy) {
  const backendWindow = policy.backendWindow;
  if (!Number.isFinite(backendWindow) || backendWindow <= sentryHeadroom(policy)) {
    throw new Error(`model-gateway: invalid sentry backend window for ${policy.backendId}`);
  }
  return backendWindow;
}

function effectiveSentryPolicy(policy, compactTrigger = configuredCompactTrigger, cap = contextWindowCap(policy?.backend), compactAt = contextWindowCompactAt(policy?.backend)) {
  if (policy?.sentry !== 'synthetic-413') return null;
  const backendWindow = sentryBackendWindow(policy);
  const triggers = [{ compactTrigger: backendWindow - sentryHeadroom(policy), source: 'derived' },
    ...gatewayCompactionCandidates(compactTrigger, cap, compactAt)];
  const [lowest] = triggers.sort((left, right) => left.compactTrigger - right.compactTrigger);
  return { backendWindow, ...lowest };
}

function codexBillingNote(cap, compactAt = null) {
  if (compactAt !== null) return `${CODEX_BILLING_RULE}; the crossing turn and compaction request can still exceed 272k and pay double`;
  return cap && cap <= CODEX_DOUBLE_BILLING_THRESHOLD
    ? `${CODEX_BILLING_RULE}; the crossing turn and compaction request can still exceed 272k and pay double`
    : `${CODEX_BILLING_RULE}; requests past 272k pay double`;
}

// A picker id is claude-<advertised spelling>; the spelling differs from the backend id only for
// routes advertisedProxyModelPart renames. The table's own rows resolve without a live listing.
function gatewayBackendModelId(id) {
  const part = typeof id === 'string' ? id.replace(/\[1m\]$/, '').replace(/^claude-/, '') : '';
  if (proxyModelProvider(part)) return part;
  return proxyRouteIdForAdvertisedPart(part) ?? policyIdForAdvertisedPart(part) ?? part;
}

let policyIdsByAdvertisedPart = null;

function policyIdForAdvertisedPart(part) {
  if (Object.hasOwn(MODEL_WINDOW_POLICY, part)) return null;
  policyIdsByAdvertisedPart ??= new Map(Object.keys(MODEL_WINDOW_POLICY)
    .filter((policyId) => advertisedProxyModelPart(policyId) !== policyId)
    .map((policyId) => [advertisedProxyModelPart(policyId), policyId]));
  return policyIdsByAdvertisedPart.get(part) ?? null;
}

// claude-code-proxy lists a Codex model's service tiers as suffixed ids (`-fast` for priority,
// `-ultrafast` where the model offers it). A tier changes latency and price, not the model, so a
// suffixed id shares its base model's window policy.
const CODEX_SERVICE_TIER_SUFFIX = /-(?:ultra)?fast$/;

// Only a Codex id carries a tier: another provider's id ending the same way is a model of its own
// (an LM Studio model key is whatever its publisher chose), and must not share sentry state with
// the id that lacks the ending.
function codexContextWindowModelId(id) {
  const backendId = gatewayBackendModelId(id);
  const baseId = backendId.startsWith('gpt-') ? backendId.replace(CODEX_SERVICE_TIER_SUFFIX, '') : backendId;
  return baseId || 'default';
}

// A row served by a model server on the user's own machine (the local llama-server row, an LM
// Studio model) has the window that server was started or loaded with, read live. Claude Code's own
// first request measured 12732 tokens on 2026-11-25 (Claude Code 2.1.332, no MCP servers, Qwen3
// tokenizer through llama-server b12110). The sentry keeps a third of the window (at most the usual
// 40000) for the turn that crosses the trigger, the compaction prompt and the summary, because the
// compaction request resends the whole conversation to the same server. Below 32768 the trigger
// would sit within a few thousand tokens of that first request, so such a row gets no sentry;
// doctor reports it and an overflow still comes back as a 413.
const LOCAL_MIN_SENTRY_WINDOW = 32768;

function localCompactHeadroom(window) {
  return Math.min(CODEX_COMPACT_HEADROOM, Math.floor(window / 3));
}

// null when the server reported no usable window, which leaves the row an unmeasured one.
function liveWindowPolicy(backend, backendWindow, measurement) {
  if (!Number.isSafeInteger(backendWindow) || backendWindow <= 0) return null;
  const guarded = backendWindow >= LOCAL_MIN_SENTRY_WINDOW;
  return {
    backend,
    transport: 'proxy',
    backendId: null,
    backendWindow,
    measurement,
    pickerAliasTemplate: 'claude-{backendId}[1m]',
    advertisedWindow: Math.min(backendWindow, PICKER_ALIAS_CLIENT_WINDOW),
    ...(guarded ? { compactHeadroom: localCompactHeadroom(backendWindow) } : {}),
    sentry: guarded ? 'synthetic-413' : 'none',
  };
}

function localServerPolicy(state) {
  const backendWindow = state?.contextWindow;
  return liveWindowPolicy(LOCAL_PROVIDER, backendWindow, `llama-server /props n_ctx ${backendWindow} on 127.0.0.1:${state?.port}, read live`);
}

// An LM Studio row's window is the context its model is loaded with. A model LM Studio has not
// loaded has none yet, so its row stays unmeasured until a refresh sees it loaded.
function lmStudioModelPolicy(state, backendId) {
  if (typeof backendId !== 'string' || !backendId.startsWith(LMSTUDIO_MODEL_PREFIX)) return null;
  const backendWindow = state?.models?.get(backendId.slice(LMSTUDIO_MODEL_PREFIX.length))?.contextWindow;
  return liveWindowPolicy(LMSTUDIO_PROVIDER, backendWindow, `LM Studio /api/v1/models loaded context_length ${backendWindow} at ${state?.baseUrl}, read live`);
}

// claude-code-proxy providers other than Codex publish no context window, and the table above
// admits only measured rows. Advertising Claude Code's own unknown-model window keeps the client
// compacting well before a smaller backend limit; a real overflow still comes back as a 413.
function proxyProviderPolicy(provider, backendId) {
  const measured = provider === LOCAL_PROVIDER ? localServerPolicy(localServerState())
    : provider === LMSTUDIO_PROVIDER ? lmStudioModelPolicy(lmStudioServerState(), backendId)
      : null;
  if (measured) return measured;
  return {
    backend: provider,
    transport: 'proxy',
    backendId: null,
    backendWindow: null,
    measurement: `unmeasured default for claude-code-proxy ${provider} rows absent from this table`,
    pickerAliasTemplate: 'claude-{backendId}[1m]',
    advertisedWindow: CODEX_UNKNOWN_MODEL_WINDOW,
    sentry: 'none',
  };
}

// transport says who serves a request: 'proxy' (claude-code-proxy, Codex included), 'grok' (this
// plugin's Grok backend), or 'anthropic' (byte-identical passthrough). A Grok row the table does
// not measure is one only the proxy's Grok provider serves, so its policy names 'proxy' itself.
function policyTransport(policy) {
  if (policy.transport) return policy.transport;
  return policy.backend === 'anthropic' || policy.backend === 'grok' ? policy.backend : 'proxy';
}

function resolveGatewayModelPolicy(id) {
  const backendId = gatewayBackendModelId(id);
  const policyId = backendId.startsWith('gpt-') ? backendId.replace(CODEX_SERVICE_TIER_SUFFIX, '') : backendId;
  const provider = proxyModelProvider(backendId);
  const policy = (policyId !== 'default' && Object.hasOwn(MODEL_WINDOW_POLICY, policyId) ? MODEL_WINDOW_POLICY[policyId] : null)
    || (backendId.startsWith('gpt-') ? MODEL_WINDOW_POLICY.default : null)
    || (provider ? proxyProviderPolicy(provider, backendId) : null)
    || (typeof id === 'string' && id.startsWith(PREFIX) && !id.startsWith(LEGACY_CODEX_PREFIX)
      ? MODEL_WINDOW_POLICY.anthropic
      : null);
  if (!policy) return null;
  const transport = policyTransport(policy);
  const pickerId = transport === 'proxy' ? advertisedProxyModelPart(backendId) : backendId;
  const pickerAlias = policy.backendId === backendId && policy.pickerAlias
    ? policy.pickerAlias.replace(backendId, pickerId)
    : policy.pickerAliasTemplate
      ? policy.pickerAliasTemplate.replace('{backendId}', pickerId)
      : `${PREFIX}${pickerId}[1m]`;
  return { ...policy, backendId, pickerAlias, transport };
}

function gatewayAdvertisedWindow(id) {
  const policy = resolveGatewayModelPolicy(id);
  if (!policy) return null;
  const cap = contextWindowCap(policy.backend);
  return cap && policy.advertisedWindow ? Math.min(policy.advertisedWindow, cap) : policy.advertisedWindow;
}

function gatewayClientModelId(id) {
  const policy = resolveGatewayModelPolicy(id);
  if (!policy) return id;
  return gatewayAdvertisedWindow(id) > CODEX_UNKNOWN_MODEL_WINDOW
    ? policy.pickerAlias
    : `${PREFIX}${policy.transport === 'proxy' ? advertisedProxyModelPart(policy.backendId) : policy.backendId}`;
}

function codexContextWindow(id) {
  return gatewayAdvertisedWindow(id) || MODEL_WINDOW_POLICY.default.advertisedWindow;
}

function codexClientModelId(id) {
  return gatewayClientModelId(id);
}

const STATIC_ENV_BLOCK = {
  CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
  CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
  ENABLE_TOOL_SEARCH: 'true',
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
};
const PIN_ALIASES = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
};
const KNOWN_GOOD_PINS = {
  opus: 'claude-opus-5-5[1m]',
  sonnet: 'claude-sonnet-5-5[1m]',
  fable: 'claude-fable-5-1[1m]',
};
// Defaults this plugin shipped earlier. A wired project still holding one was written by the
// gateway, not typed by the user, so a pin change must still be allowed to replace it.
const RETIRED_SHIPPED_PINS = {
  opus: ['claude-opus-5[1m]', 'claude-opus-4-8[1m]'],
  sonnet: ['claude-sonnet-5[1m]'],
  fable: [],
};
const PIN_OVERRIDE_PATH = path.join(STATE, 'pins.json');
const PIN_CACHE_PATH = path.join(STATE, 'detected-pins.json');
const PIN_CACHE_TTL_MS = Number(process.env.CODEX_GATEWAY_PIN_CACHE_TTL_MS) || 24 * 60 * 60 * 1000;
const PIN_PROBE_TIMEOUT_MS = Number(process.env.CODEX_GATEWAY_PIN_PROBE_TIMEOUT_MS) || 5000;
const CLAUDE_BIN = process.env.CODEX_GATEWAY_CLAUDE_BIN || 'claude';
const CLAUDE_BIN_IS_BATCH = WIN && /\.(?:cmd|bat)$/i.test(CLAUDE_BIN);
const LEGACY_ENV_BLOCK = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '950000' };
const GATEWAY_MODELS_CACHE = path.join(CLAUDE_CONFIG_DIR, 'cache', 'gateway-models.json');
const CLI_PATH = path.join(__dirname, '..', 'bin', 'model-gateway.js');
const STABLE_COMMAND_PATH = path.join(STATE, 'model-gateway.js');

// The stable launcher only exists once SessionStart's writeCommandLauncher has run (hooks/registry-writer.js).
// An in-session plugin upgrade can leave a process whose STABLE_COMMAND_PATH points at a file the still-loaded
// old hook never wrote (issue #77), so every message that names it falls back to the CLI's own real path.
function resolveStableCommandPath({ pathExists = fs.existsSync } = {}) {
  return pathExists(STABLE_COMMAND_PATH) ? STABLE_COMMAND_PATH : CLI_PATH;
}

function upstreamBlockedMessage(commandPath, blocked) {
  if (blocked?.expiresAt) return `Codex is rate-limited by OpenAI (429) until ${blocked.expiresAt}. The block lifts by itself then, or sooner when a Codex request succeeds; wait, or explicitly re-route this ticket.`;
  return `Codex is blocked by an OpenAI rejection. Run \`node "${commandPath}" setup\`; if it persists, wait for a claude-code-proxy update or explicitly re-route this ticket. Codex tickets remain blocked.`;
}

const CODEX_READINESS_MESSAGES = {
  'binary-missing': (commandPath = resolveStableCommandPath()) => `Codex dispatch refused: claude-code-proxy is missing. Run \`node "${commandPath}" setup\`, then retry. No Anthropic fallback was used.`,
  'auth-missing': (commandPath = resolveStableCommandPath()) => `Codex dispatch refused: ChatGPT sign-in is required. Run \`node "${commandPath}" login\`, finish browser OAuth, then run \`node "${commandPath}" setup\` and retry. Credentials live in \`~/.config/claude-code-proxy/\`.`,
  'proxy-down': () => `Codex dispatch refused: claude-code-proxy is not answering on /v1/models. The running shim supervisor retries recovery with bounded backoff; check ${path.join(LOGS, 'guardian.log')} if it does not recover. No Anthropic fallback was used.`,
  'shim-down': (commandPath = resolveStableCommandPath()) => `Codex dispatch refused: the model-gateway shim is down. Run \`node "${commandPath}" ensure\`, then retry. No Anthropic fallback was used.`,
  'serving-version-mismatch': (commandPath = resolveStableCommandPath()) => `Codex dispatch refused: model-gateway is serving a stale shim version. Run \`node "${commandPath}" ensure\`, then retry. No Anthropic fallback was used.`,
  'upstream-blocked': (commandPath = resolveStableCommandPath(), blocked = null) => upstreamBlockedMessage(commandPath, blocked),
  'upstream-unavailable': (commandPath, unavailable = null) => upstreamUnavailableMessage(unavailable),
};

// The hold names its own failure and its end, so a refusal that outlives it is visibly stale (issue #175).
function upstreamUnavailableMessage(unavailable) {
  if (!unavailable?.observedAt) return 'Codex had a terminal upstream failure in the last 30 seconds. Wait briefly, then retry; /v1/models only proves the local proxy is answering.';
  const until = unavailable.expiresAt || 'about 30 seconds later';
  return `Codex had a terminal upstream failure (HTTP ${unavailable.statusCode}) at ${unavailable.observedAt}. Dispatch holds until ${until}, or until a Codex request succeeds; /v1/models only proves the local proxy is answering.`;
}

function codexReadinessMessage(state, commandPath, upstreamBlocked = null) {
  return CODEX_READINESS_MESSAGES[state](commandPath, upstreamBlocked);
}

function gatewayDiscoveryModels(models) {
  if (!Array.isArray(models)) return [];
  return models.flatMap((model) => {
    if (!model || typeof model.id !== 'string' || !/(claude|anthropic)/i.test(model.id)) return [];
    const entry = { id: gatewayClientModelId(model.id) };
    if (typeof model.display_name === 'string') entry.display_name = model.display_name;
    return [entry];
  });
}

function readGatewayDiscoveryCache(cachePath = GATEWAY_MODELS_CACHE) {
  try { return JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch { return null; }
}

function sameGatewayDiscoveryModels(left, right) {
  if (!Array.isArray(left) || left.length !== right.length) return false;
  return left.every((model, index) => (
    model?.id === right[index].id && model?.display_name === right[index].display_name
  ));
}

function discoveryCacheIsCurrent(existing, models, force) {
  return !force && existing && sameGatewayDiscoveryModels(existing.models, models);
}

function syncGatewayDiscoveryCache({ models, baseUrl = DEFAULT_BASE_URL, cachePath = GATEWAY_MODELS_CACHE, now = Date.now, force = false } = {}) {
  if (baseUrl === COMPAT_BASE_URL) return { state: 'skipped', reason: 'rc-compatibility', cachePath, modelCount: 0 };
  if (baseUrl !== DEFAULT_BASE_URL) return { state: 'skipped', reason: 'gateway-not-wired', cachePath, modelCount: 0 };

  const gatewayModels = gatewayDiscoveryModels(models);
  const existing = readGatewayDiscoveryCache(cachePath);
  if (discoveryCacheIsCurrent(existing, gatewayModels, force)) {
    return { state: 'unchanged', cachePath, modelCount: gatewayModels.length };
  }

  const cache = { baseUrl, fetchedAt: now(), models: gatewayModels };
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  writeFileAtomically(cachePath, JSON.stringify(cache, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(cachePath, 0o600); } catch {}
  return { state: 'wrote', cachePath, modelCount: gatewayModels.length };
}

function parseVersionDirectory(version) {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function versionIsOlder(left, right) {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] < right[index];
  }
  return false;
}

function parseInstalledCliVersion(cliPath) {
  const pluginRoot = path.dirname(path.dirname(cliPath));
  return parseVersionDirectory(path.basename(pluginRoot));
}

function canReplaceInstalledCliPath(currentCliPath, candidateCliPath) {
  if (typeof currentCliPath !== 'string' || typeof candidateCliPath !== 'string'
    || !path.isAbsolute(currentCliPath) || !path.isAbsolute(candidateCliPath)) return false;
  const current = path.resolve(currentCliPath);
  const candidate = path.resolve(candidateCliPath);
  let realCurrent;
  let realCandidate;
  try {
    realCurrent = fs.realpathSync(current);
    realCandidate = fs.realpathSync(candidate);
  } catch { return false; }
  if (current === candidate) return realCurrent === realCandidate;
  const canonicalCli = (file) => path.basename(file) === 'model-gateway.js' && path.basename(path.dirname(file)) === 'bin';
  if (![current, candidate, realCurrent, realCandidate].every(canonicalCli)) return false;
  const cacheRoot = (file) => path.dirname(path.dirname(path.dirname(file)));
  // Version ordering is meaningful only within the same lexical AND resolved cache root.
  // Development checkouts can restart themselves, but cannot adopt unrelated installations.
  if (cacheRoot(current) !== cacheRoot(candidate) || cacheRoot(realCurrent) !== cacheRoot(realCandidate)) return false;
  const currentVersion = parseInstalledCliVersion(current);
  const candidateVersion = parseInstalledCliVersion(candidate);
  if (!currentVersion || !candidateVersion) return false;
  if (path.basename(path.dirname(path.dirname(candidate))) !== path.basename(path.dirname(path.dirname(realCandidate)))) return false;
  return !versionIsOlder(candidateVersion, currentVersion);
}

const PLUGIN_NAME = 'model-gateway';

// Claude Code keeps its plugin installs either under CLAUDE_CODE_PLUGIN_CACHE_DIR
// or, when that is unset, under <config dir>/plugins. Both layouts hold
// installed_plugins.json beside the same cache/<marketplace>/<plugin>/<version>
// tree, so a host that moved the cache is a different directory, not a
// different shape. Callers get every registry that exists rather than the first
// one: during a cache-dir migration both files are present and either may be
// the stale copy, and the entries themselves carry the install paths we need.
function pluginRegistryDirectories(env = process.env) {
  const directories = [];
  if (env.CLAUDE_CODE_PLUGIN_CACHE_DIR) directories.push(path.resolve(env.CLAUDE_CODE_PLUGIN_CACHE_DIR));
  const configDirectory = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const legacyDirectory = path.join(path.resolve(configDirectory), 'plugins');
  if (!directories.includes(legacyDirectory)) directories.push(legacyDirectory);
  return directories;
}

function installedPluginsRegistryPaths(env = process.env) {
  return pluginRegistryDirectories(env).map((directory) => path.join(directory, 'installed_plugins.json'));
}

// A full plugin id (name@marketplace) matches that one key; a bare plugin name
// matches the plugin installed from any marketplace, so a fork install counts.
function readInstalledPluginEntries(pluginId, {
  env = process.env,
  readFile = fs.readFileSync,
} = {}) {
  const matches = pluginId.includes('@') ? (key) => key === pluginId : (key) => key.startsWith(`${pluginId}@`);
  const entries = [];
  for (const file of installedPluginsRegistryPaths(env)) {
    let registry;
    try { registry = JSON.parse(readFile(file, 'utf8')); } catch { continue; }
    for (const [key, installs] of Object.entries(registry?.plugins || {})) {
      if (!matches(key) || !Array.isArray(installs)) continue;
      entries.push(...installs.filter(Boolean).map((install) => ({ ...install, registry: file })));
    }
  }
  return entries;
}

// Registry versions are the install directory names Claude Code recorded, so they are ordinary
// semantic versions; compare them numerically, newest first, and break a tie on the recorded
// update time. This is the stable launcher's ordering, so the launcher and the SessionStart hook
// always land on the same install.
function newestRegisteredInstallFirst(left, right) {
  const numbers = (value) => String(value == null ? '' : value).split(/[^0-9]+/).map(Number);
  const a = numbers(left.version);
  const b = numbers(right.version);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (b[index] || 0) - (a[index] || 0);
    if (difference !== 0) return difference;
  }
  return String(right.lastUpdated || '').localeCompare(String(left.lastUpdated || ''));
}

// The CLI of the install Claude Code recorded in installed_plugins.json: the copy whose supervisor
// owns the gateway port, which is not necessarily the copy a session loaded. A directory
// marketplace loads a development checkout while the recorded install keeps serving, and the two
// roots differ even when the code is identical. Returns null when no recorded install has a CLI on
// disk: a --plugin-dir checkout, a registry Claude Code has not written yet, or an install
// directory that was removed.
function resolveRegisteredCliPath({
  pluginId = PLUGIN_NAME,
  env = process.env,
  readEntries = readInstalledPluginEntries,
  pathExists = fs.existsSync,
} = {}) {
  const installed = readEntries(pluginId, { env })
    .filter((entry) => typeof entry?.installPath === 'string' && entry.installPath)
    .map((entry) => ({ ...entry, cliPath: path.join(entry.installPath, 'bin', 'model-gateway.js') }))
    .filter((entry) => pathExists(entry.cliPath))
    .sort(newestRegisteredInstallFirst);
  return installed.length ? installed[0].cliPath : null;
}

function resolveNewestInstalledCliPath({ cliPath = CLI_PATH, readDirectory = fs.readdirSync, pathExists = fs.existsSync } = {}) {
  const pluginRoot = path.dirname(path.dirname(cliPath));
  const pluginCacheRoot = path.dirname(pluginRoot);
  const candidates = [cliPath];
  try {
    for (const entry of readDirectory(pluginCacheRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const siblingCliPath = path.join(pluginCacheRoot, entry.name, 'bin', 'model-gateway.js');
      if (pathExists(siblingCliPath)) candidates.push(siblingCliPath);
    }
  } catch {}

  return candidates.reduce((newestCliPath, candidateCliPath) => (
    canReplaceInstalledCliPath(newestCliPath, candidateCliPath) ? candidateCliPath : newestCliPath
  ));
}

function readPluginVersion() {
  try {
    const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8'));
    return typeof version === 'string' ? version : null;
  } catch { return null; }
}

const PLUGIN_VERSION = readPluginVersion();

function mkdirs() {
  for (const directory of [STATE, LOGS, BIN_DIR]) fs.mkdirSync(directory, { recursive: true });
}

module.exports = {
  ANTHROPIC_UPSTREAM, AUTH_HEADERS, BIN_DIR, CLAUDE_BIN, CLAUDE_BIN_IS_BATCH, CODEX_CONTEXT_WINDOWS,
  CODEX_FAMILY_RE, CODEX_UNKNOWN_MODEL_WINDOW, CODEX_UPSTREAM_BLOCK_PATH, COMPAT_BASE_URL, COMPAT_HOST, COMPAT_PORT,
  DEFAULT_BASE_URL, MODEL_WINDOW_POLICY,
  DISPATCH_MODEL_ID, DISPATCH_ROUTE_CACHE_PATH, GATEWAY_MODELS_CACHE, GROK_ENDPOINT, GROK_PREFIX,
  HOSTS_BLOCK_END, HOSTS_BLOCK_LINE, HOSTS_BLOCK_START, KNOWN_GOOD_PINS, LEGACY_CODEX_PREFIX,
  LEGACY_ENV_BLOCK, LIST_DISPATCH_MODEL, LOGS, MIN_PROXY_VERSION, PIN_ALIASES, PIN_CACHE_PATH,
  PIN_CACHE_TTL_MS, PIN_OVERRIDE_PATH, PIN_PROBE_TIMEOUT_MS, PLUGIN_VERSION, PREFIX, PROXY_BIN,
  PROXY_PORT, PUBLIC_SHIM_PORT, REPO, REQUEST_ROUTE_LOG, REQUEST_ROUTE_LOG_PATH, LIFECYCLE_LOG_PATH,
  PROJECT_WIRING_REGISTRY_PATH, RETIRED_SHIPPED_PINS, ROUTE_TELEMETRY_ENABLED, ROUTE_TELEMETRY_TIMEOUT_MS, SHIM_FAILURE_PATH, SHIM_PORT, SOCKET_PATH, STATE,
  STATIC_ENV_BLOCK, STABLE_COMMAND_PATH, TRACE_HEADERS, WIRING_CONFIG_PATH, WIN, CLI_PATH, CLAUDE_CONFIG_DIR, mkdirs,
  CAP_COMPACTION_MARGIN, CODEX_COMPACT_HEADROOM, CONTEXT_WINDOW_BACKENDS, CONTEXT_WINDOW_MAX, CONTEXT_WINDOW_MIN,
  CONTEXT_WINDOW_PATH, DEFAULT_CONTEXT_WINDOWS, COMPACT_AT_BACKENDS, gatewayCompactTrigger, codexBillingNote, contextWindowCap,
  contextWindowCompactAt, effectiveSentryPolicy, LOCAL_MIN_SENTRY_WINDOW, lmStudioModelPolicy, localServerPolicy, parseCompactAtValue, sentryHeadroom,
  parseContextWindowValue, readContextWindowSettings, writeContextWindowSettings,
  canReplaceInstalledCliPath, codexClientModelId, codexContextWindow, codexContextWindowModelId,
  codexReadinessMessage,
  gatewayAdvertisedWindow, gatewayBackendModelId, gatewayClientModelId, gatewayDiscoveryModels,
  installedPluginsRegistryPaths, pluginRegistryDirectories, readInstalledPluginEntries,
  readGatewayDiscoveryCache, resolveGatewayModelPolicy, resolveNewestInstalledCliPath, resolveStableCommandPath,
  resolveRegisteredCliPath,
  sameGatewayDiscoveryModels, syncGatewayDiscoveryCache,
};
