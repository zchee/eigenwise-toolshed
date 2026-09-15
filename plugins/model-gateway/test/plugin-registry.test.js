'use strict';

// Claude Code moved its plugin installs out of <config dir>/plugins and into
// the directory it names in CLAUDE_CODE_PLUGIN_CACHE_DIR. Both layouts keep
// installed_plugins.json beside a cache/<marketplace>/<plugin>/<version> tree,
// and a migrated host leaves both files on disk with one of them stale, so
// every reader has to consult both: the registry readers that locate the
// newest installed CLI, and the ownership check that proves a process on the
// gateway port belongs to a sibling install of this same plugin. Before this,
// a host with the env var set had the gateway reading a stale registry and
// refusing to recover its own port ("owns :18764 from a different install
// root").

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// Isolate HOME before any lib require: runtime.js derives STATE/LOGS/PROXY_BIN
// from os.homedir() at load time, and os.homedir() honors $HOME on POSIX.
const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-plugin-registry-home-'));
process.env.HOME = fixtureHome;
process.env.USERPROFILE = fixtureHome;
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR;

const { installedPluginsRegistryPaths, pluginRegistryDirectories, readInstalledPluginEntries } = require('../lib/runtime.js');
const { isPluginCacheParent, pluginCacheIdentity } = require('../lib/process-supervision.js');

const PLUGIN_ID = 'model-gateway@eigenwise-toolshed';

function temporaryDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function withEnvironment(t, overrides) {
  const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function writeRegistry(directory, installs) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'installed_plugins.json'), JSON.stringify({ plugins: { [PLUGIN_ID]: installs } }));
}

test('the configured plugin cache dir is searched before the config-dir layout', () => {
  const directories = pluginRegistryDirectories({
    CLAUDE_CODE_PLUGIN_CACHE_DIR: '/data/claude-agent-plugins',
    CLAUDE_CONFIG_DIR: '/home/user/.claude',
  });

  assert.deepEqual(directories, [
    path.resolve('/data/claude-agent-plugins'),
    path.join(path.resolve('/home/user/.claude'), 'plugins'),
  ]);
  assert.deepEqual(installedPluginsRegistryPaths({
    CLAUDE_CODE_PLUGIN_CACHE_DIR: '/data/claude-agent-plugins',
    CLAUDE_CONFIG_DIR: '/home/user/.claude',
  }), [
    path.join(path.resolve('/data/claude-agent-plugins'), 'installed_plugins.json'),
    path.join(path.resolve('/home/user/.claude'), 'plugins', 'installed_plugins.json'),
  ]);
});

test('an unset plugin cache dir falls back to the config-dir layout alone', () => {
  assert.deepEqual(pluginRegistryDirectories({ CLAUDE_CONFIG_DIR: '/home/user/.claude' }), [
    path.join(path.resolve('/home/user/.claude'), 'plugins'),
  ]);
});

test('a plugin cache dir pointing at the config-dir layout is not searched twice', () => {
  const legacy = path.join(path.resolve('/home/user/.claude'), 'plugins');

  assert.deepEqual(pluginRegistryDirectories({
    CLAUDE_CODE_PLUGIN_CACHE_DIR: legacy,
    CLAUDE_CONFIG_DIR: '/home/user/.claude',
  }), [legacy]);
});

test('installs are read from both registries so a stale one cannot hide a newer install', (t) => {
  const cacheDirectory = temporaryDirectory(t, 'model-gateway-cache-dir-');
  const configDirectory = temporaryDirectory(t, 'model-gateway-config-dir-');
  writeRegistry(cacheDirectory, [{ version: '0.52.0', scope: 'user', installPath: '/installs/0.52.0' }]);
  writeRegistry(path.join(configDirectory, 'plugins'), [{ version: '0.40.0', scope: 'project', installPath: '/installs/0.40.0' }]);

  const entries = readInstalledPluginEntries(PLUGIN_ID, {
    env: { CLAUDE_CODE_PLUGIN_CACHE_DIR: cacheDirectory, CLAUDE_CONFIG_DIR: configDirectory },
  });

  assert.deepEqual(entries.map((entry) => [entry.version, entry.scope]), [['0.52.0', 'user'], ['0.40.0', 'project']]);
  assert.equal(entries[0].registry, path.join(cacheDirectory, 'installed_plugins.json'));
});

test('a missing or unparsable registry is skipped without hiding the other one', (t) => {
  const cacheDirectory = temporaryDirectory(t, 'model-gateway-cache-dir-');
  const configDirectory = temporaryDirectory(t, 'model-gateway-config-dir-');
  fs.mkdirSync(cacheDirectory, { recursive: true });
  fs.writeFileSync(path.join(cacheDirectory, 'installed_plugins.json'), '{ not json');
  writeRegistry(path.join(configDirectory, 'plugins'), [{ version: '0.40.0', scope: 'user', installPath: '/installs/0.40.0' }]);

  const entries = readInstalledPluginEntries(PLUGIN_ID, {
    env: { CLAUDE_CODE_PLUGIN_CACHE_DIR: cacheDirectory, CLAUDE_CONFIG_DIR: configDirectory },
  });

  assert.deepEqual(entries.map((entry) => entry.version), ['0.40.0']);
  assert.deepEqual(readInstalledPluginEntries(PLUGIN_ID, {
    env: { CLAUDE_CONFIG_DIR: path.join(configDirectory, 'absent') },
  }), []);
});

test('an install under the configured plugin cache dir is recognized as this plugin', (t) => {
  const cacheDirectory = temporaryDirectory(t, 'model-gateway-cache-dir-');
  withEnvironment(t, { CLAUDE_CODE_PLUGIN_CACHE_DIR: cacheDirectory, CLAUDE_CONFIG_DIR: undefined });
  const pluginRoot = path.join(cacheDirectory, 'cache', 'eigenwise-toolshed', 'model-gateway');
  const installRoot = path.join(pluginRoot, '0.51.2');
  fs.mkdirSync(installRoot, { recursive: true });

  const identity = pluginCacheIdentity(installRoot);

  assert.ok(identity, 'an install in the configured plugin cache dir must have a cache identity');
  assert.equal(identity, pluginCacheIdentity(path.join(pluginRoot, '0.52.0')));
  assert.equal(isPluginCacheParent(cacheDirectory), true);
});

test('the config-dir plugins layout keeps its cache identity', (t) => {
  const configDirectory = temporaryDirectory(t, 'model-gateway-config-dir-');
  withEnvironment(t, { CLAUDE_CODE_PLUGIN_CACHE_DIR: undefined, CLAUDE_CONFIG_DIR: configDirectory });
  const installRoot = path.join(configDirectory, 'plugins', 'cache', 'eigenwise-toolshed', 'model-gateway', '0.51.2');
  fs.mkdirSync(installRoot, { recursive: true });

  assert.ok(pluginCacheIdentity(installRoot));
});

test('a cache-shaped path outside any known plugin cache dir has no cache identity', (t) => {
  const cacheDirectory = temporaryDirectory(t, 'model-gateway-cache-dir-');
  const unrelated = temporaryDirectory(t, 'model-gateway-unrelated-');
  withEnvironment(t, { CLAUDE_CODE_PLUGIN_CACHE_DIR: cacheDirectory, CLAUDE_CONFIG_DIR: undefined });
  const installRoot = path.join(unrelated, 'cache', 'eigenwise-toolshed', 'model-gateway', '0.51.2');
  fs.mkdirSync(installRoot, { recursive: true });

  assert.equal(pluginCacheIdentity(installRoot), null);
  assert.equal(isPluginCacheParent(unrelated), false);
});

test.after(() => fs.rmSync(fixtureHome, { recursive: true, force: true }));
