'use strict';

// claude-code-proxy's local provider (src/providers/local.rs on the proxy's dev branch) serves one
// model, local/gguf, by forwarding Anthropic Messages requests to a llama.cpp llama-server on
// 127.0.0.1:$CCP_LLAMA_PORT. The proxy reads that variable from its own environment, which is the
// gateway's (process-supervision.js starts it with a copy of this process's env), so the gateway's
// environment names the same server. The proxy has no `local` CLI group, so no `auth status` exists
// to ask; llama-server itself is asked instead.

const { localServerState, setLocalServerState } = require('./proxy-models.js');

const LOCAL_PROVIDER = 'local';
const LLAMA_PORT_ENV = 'CCP_LLAMA_PORT';

// The proxy lists local/gguf whenever the variable is present, then parses it as Rust's
// NonZeroU16 (an optional `+`, digits, no whitespace) and fails every request when that fails.
function llamaServerPort(env = process.env) {
  const raw = env[LLAMA_PORT_ENV];
  if (typeof raw !== 'string') return { port: null, configured: false };
  const port = /^\+?\d+$/.test(raw) ? Number(raw) : NaN;
  return port >= 1 && port <= 65535 ? { port, configured: true } : { port: null, configured: true, invalid: raw };
}

// GET /props answers with default_generation_settings.n_ctx, the context of one slot, which is the
// most a single request can use. llama-server's router mode (several models behind one port)
// reports 0 there, and that is not a window.
function contextWindowFromProps(props) {
  const nCtx = props?.default_generation_settings?.n_ctx;
  return Number.isSafeInteger(nCtx) && nCtx > 0 ? nCtx : null;
}

// { port, configured, reachable, contextWindow, error? }. Never throws: a missing or silent server
// is a readiness state, not a failure of the caller.
async function probeLlamaServer({ env = process.env, fetchUrl, timeout = 1500 } = {}) {
  const { port, configured, invalid } = llamaServerPort(env);
  if (!configured) return { port: null, configured: false, reachable: false, contextWindow: null };
  if (port === null) return { port: null, configured: true, reachable: false, contextWindow: null, error: `${LLAMA_PORT_ENV}=${invalid} is not a port` };
  try {
    const response = await fetchUrl(`http://127.0.0.1:${port}/props`, { timeout });
    if (response.status !== 200) {
      return { port, configured: true, reachable: false, contextWindow: null, error: `GET /props answered HTTP ${response.status}` };
    }
    let props = null;
    try { props = JSON.parse(response.body.toString()); } catch { /* not llama-server */ }
    return { port, configured: true, reachable: true, contextWindow: contextWindowFromProps(props) };
  } catch (error) {
    return { port, configured: true, reachable: false, contextWindow: null, error: error?.code || error?.message || String(error) };
  }
}

// Probes the server when the listing has the local row and records the answer for policy
// resolution. A server that stops answering on the same port keeps its last measured window, the
// way a failed listing refresh keeps the last listing: dropping it would change the row's picker
// id (with or without [1m]) for the length of an outage. A server that answers decides afresh.
async function refreshLocalServerState(routes, { env = process.env, fetchUrl } = {}) {
  if (!Array.isArray(routes) || !routes.some(({ provider }) => provider === LOCAL_PROVIDER)) {
    setLocalServerState(null);
    return null;
  }
  const previous = localServerState();
  const state = await probeLlamaServer({ env, fetchUrl });
  if (!state.reachable && state.port !== null && previous?.port === state.port && previous.contextWindow) {
    state.contextWindow = previous.contextWindow;
  }
  setLocalServerState(state);
  return state;
}

module.exports = {
  LLAMA_PORT_ENV,
  LOCAL_PROVIDER,
  contextWindowFromProps,
  llamaServerPort,
  probeLlamaServer,
  refreshLocalServerState,
};
