'use strict';

// claude-code-proxy lists every model it serves on /v1/models and names the provider that serves
// it in display_name as "<id> (<provider>)" (server.rs handler_models). That listing is the source
// of truth for the gateway's proxy routes, so a model the proxy adds becomes a picker row without a
// gateway release.
const CODEX_FAMILY_RE = /^gpt-/;
const PROXY_DISPLAY_NAME_RE = /^(.+) \(([a-z0-9][a-z0-9-]*)\)$/;
// The proxy also lists Claude Code's own model names (haiku, sonnet, opus, fable, claude-*) and
// maps them onto one configured provider, so a client pointed straight at the proxy keeps working.
// Behind the gateway those names are real Claude models served by api.anthropic.com; routing them
// to the proxy would silently replace Claude with another vendor's model.
const ANTHROPIC_STYLE_ALIAS_RE = /^(?:claude-|anthropic-)|^(?:haiku|sonnet|opus|fable)$/;
const PROVIDER_LABELS = Object.freeze({
  codex: 'Codex',
  cursor: 'Cursor',
  grok: 'Grok',
  kimi: 'Kimi',
  muse: 'Muse',
  opencode: 'OpenCode',
  vertex: 'Vertex AI',
});

function providerLabel(provider) {
  if (typeof provider !== 'string' || !provider) return 'Proxy';
  return PROVIDER_LABELS[provider] || provider[0].toUpperCase() + provider.slice(1);
}

function proxyModelProviderFromRow(row) {
  const match = typeof row.display_name === 'string' ? row.display_name.match(PROXY_DISPLAY_NAME_RE) : null;
  if (match && match[1] === row.id) return match[2];
  return CODEX_FAMILY_RE.test(row.id) ? 'codex' : null;
}

// [{ id, provider }] in listing order, without Anthropic-style aliases, unattributed rows, or
// repeats. Rows from a proxy old enough to omit the "(provider)" suffix still count as Codex when
// they carry a Codex model id, which is all such a proxy served.
function parseProxyModelListing(rows) {
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  const routes = [];
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || !row.id || ANTHROPIC_STYLE_ALIAS_RE.test(row.id) || seen.has(row.id)) continue;
    const provider = proxyModelProviderFromRow(row);
    if (!provider) continue;
    seen.add(row.id);
    routes.push({ id: row.id, provider });
  }
  return routes;
}

// ~/.claude/model-gateway/models.json predates provider-tagged listings: a list of bare Codex ids.
// Without a live listing nothing else proves which provider owns an id, so only the Codex family
// is accepted; anything else would be advertised and then handed to api.anthropic.com.
function modelsFileRoutes(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id) => typeof id === 'string' && CODEX_FAMILY_RE.test(id)))]
    .map((id) => ({ id, provider: 'codex' }));
}

// Last known listing, keyed by backend id. The worker replaces it on every catalog refresh and the
// CLI loads it from the proxy before it builds a catalog, so resolving an id never needs I/O.
const proxyRoutes = new Map();

function setProxyModelRoutes(routes) {
  proxyRoutes.clear();
  for (const route of Array.isArray(routes) ? routes : []) {
    if (route && typeof route.id === 'string' && typeof route.provider === 'string') proxyRoutes.set(route.id, route.provider);
  }
}

function proxyModelRoutes() {
  return [...proxyRoutes].map(([id, provider]) => ({ id, provider }));
}

// claude-code-proxy's vertex provider lists each Gemini model twice, under its bare id and as
// vertex/<id>, and sends both to the same upstream model. Only the bare row is advertised; the
// vertex/ spelling stays in the route table, so it still routes when a user types it.
const VERTEX_ID_PREFIX = 'vertex/';

function advertisedProxyRoutes(routes) {
  const vertexIds = new Set(routes.filter(({ provider }) => provider === 'vertex').map(({ id }) => id));
  return routes.filter(({ id, provider }) => !(provider === 'vertex' && id.startsWith(VERTEX_ID_PREFIX) && vertexIds.has(id.slice(VERTEX_ID_PREFIX.length))));
}

// Codex ids stay routable with no listing at all, as they were before listings were read.
function proxyModelProvider(backendId) {
  if (typeof backendId !== 'string' || !backendId) return null;
  if (CODEX_FAMILY_RE.test(backendId)) return 'codex';
  return proxyRoutes.get(backendId) || null;
}

function proxyModelDisplayName(id, provider) {
  return `${id} (${providerLabel(provider)})`;
}

module.exports = {
  ANTHROPIC_STYLE_ALIAS_RE,
  CODEX_FAMILY_RE,
  advertisedProxyRoutes,
  modelsFileRoutes,
  parseProxyModelListing,
  providerLabel,
  proxyModelDisplayName,
  proxyModelProvider,
  proxyModelRoutes,
  setProxyModelRoutes,
};
