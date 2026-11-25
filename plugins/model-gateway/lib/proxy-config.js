'use strict';

// Where claude-code-proxy keeps its config.json, and that file's contents. The gateway reads it for
// the settings a provider takes from there rather than from a sign-in (an OpenCode API key, a
// Vertex AI project, the LM Studio server), so it describes the same proxy the gateway starts.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Mirrors claude-code-proxy's paths::resolve_config_dir, where it reads config.json.
function proxyConfigDirectory({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (env.CCP_CONFIG_DIR) return env.CCP_CONFIG_DIR;
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'claude-code-proxy');
  if (platform === 'darwin') return path.join(home, '.config', 'claude-code-proxy');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'claude-code-proxy');
}

// null when the file is missing or is not JSON, which the proxy treats as no config at all.
function readProxyConfig(configDirectory = proxyConfigDirectory()) {
  try { return JSON.parse(fs.readFileSync(path.join(configDirectory, 'config.json'), 'utf8')); } catch { return null; }
}

module.exports = { proxyConfigDirectory, readProxyConfig };
