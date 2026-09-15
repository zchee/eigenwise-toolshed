#!/usr/bin/env node
'use strict';

// SessionStart runs with CLAUDE_PLUGIN_ROOT pointing at whichever copy of this plugin the session
// loaded. A directory marketplace loads a development checkout, while the supervisor already
// listening on the gateway port was started from the install Claude Code recorded in
// installed_plugins.json. `ensure` refuses to touch a port owned by a different install root — the
// check that stops an unrelated install from killing a running gateway — so a hook hardwired to
// ${CLAUDE_PLUGIN_ROOT} reports a perfectly healthy gateway as a foreign install. Run the recorded
// install's CLI instead, and fall back to the loaded copy only when no recorded install has a CLI
// on disk (a --plugin-dir checkout, or a registry Claude Code has not written yet).
//
// Resolution reads the registry directly rather than invoking the stable launcher at
// ~/.claude/model-gateway/model-gateway.js: the host may run SessionStart hook commands
// concurrently, so the launcher that hooks/registry-writer.js generates is not guaranteed to exist
// when this one runs. Reading the registry needs no ordering and no generated file.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { installedPluginsRegistryPaths, resolveRegisteredCliPath } = require('../lib/runtime.js');

function loadedCliPath() {
  const root = process.env.CLAUDE_PLUGIN_ROOT
    ? path.resolve(process.env.CLAUDE_PLUGIN_ROOT)
    : path.join(__dirname, '..');
  return path.join(root, 'bin', 'model-gateway.js');
}

function missingInstallMessage(localCliPath) {
  const registries = installedPluginsRegistryPaths().map((file) => `"${file}"`).join(' and ');
  return `model-gateway: no Model Gateway CLI to run. Claude Code's plugin registry (${registries}) lists no install with bin/model-gateway.js, and this session's plugin root has none at "${localCliPath}". Reinstall the model-gateway plugin.`;
}

function run(argv = process.argv.slice(2)) {
  // `ensure --quiet` exits 0 even on a refusal so Claude Code shows the gateway's own line instead
  // of replacing it with a bare "hook failed" badge (SQ-1901). A delegation failure reads the same.
  const quiet = argv.includes('--quiet');
  const localCliPath = loadedCliPath();
  let cliPath = null;
  try { cliPath = resolveRegisteredCliPath(); } catch { cliPath = null; }
  if (!cliPath && fs.existsSync(localCliPath)) cliPath = localCliPath;
  if (!cliPath) {
    console.error(missingInstallMessage(localCliPath));
    return quiet ? 0 : 1;
  }
  const result = spawnSync(process.execPath, [cliPath, ...argv], { stdio: 'inherit', windowsHide: true });
  if (result.error) {
    console.error(`model-gateway: could not run "${cliPath}": ${result.error.message}`);
    return quiet ? 0 : 1;
  }
  return result.status == null ? (quiet ? 0 : 1) : result.status;
}

if (require.main === module) process.exit(run());

module.exports = { loadedCliPath, missingInstallMessage, run };
