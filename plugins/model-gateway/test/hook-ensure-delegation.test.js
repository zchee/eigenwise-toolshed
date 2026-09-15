'use strict';

// A directory marketplace loads this plugin straight from a git checkout, so SessionStart hooks get
// a CLAUDE_PLUGIN_ROOT that is not the install Claude Code recorded in installed_plugins.json — and
// it is the recorded install whose supervisor owns the gateway port. Running `ensure` from the
// checkout made it refuse its own healthy gateway ("owns :18764 from a different install root").
// hooks/ensure.js delegates the startup check to the recorded install instead, and falls back to
// the loaded copy only when the registry names none.
//
// Every CLI these tests delegate to is a fixture script that records its arguments and exits with a
// chosen status: nothing here starts a supervisor, binds a port, or touches the live gateway.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnGatewayProcessSync } = require('./support.js');

const root = path.resolve(__dirname, '..');
const hook = path.join(root, 'hooks', 'ensure.js');
const PLUGIN_ID = 'model-gateway@eigenwise-toolshed';

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-hook-ensure-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// A stand-in for bin/model-gateway.js that records how it was invoked and exits with a status the
// caller chooses, so a test can prove both which CLI ran and that its exit code was forwarded.
function writeFixtureCli(installPath) {
  const file = path.join(installPath, 'bin', 'model-gateway.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.env.MODEL_GATEWAY_TEST_RESULT, JSON.stringify([process.argv[1], ...process.argv.slice(2)]));",
    'process.exit(Number(process.env.MODEL_GATEWAY_TEST_EXIT || 0));',
  ].join('\n'));
  return file;
}

function writeRegistry(directory, installs) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'installed_plugins.json'), JSON.stringify({ plugins: { [PLUGIN_ID]: installs } }));
}

function runHook(home, overrides, args = ['ensure', '--quiet']) {
  return spawnGatewayProcessSync(process.execPath, [hook, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, ...overrides },
  });
}

function invocation(resultFile) {
  return JSON.parse(fs.readFileSync(resultFile, 'utf8'));
}

test('a checkout loaded from a directory marketplace runs the registered install instead of itself', (t) => {
  const home = temporaryDirectory(t);
  const checkout = path.join(home, 'checkout', 'plugins', 'model-gateway');
  const install = path.join(home, 'claude-agent-plugins', 'cache', 'eigenwise-toolshed', 'model-gateway', '0.51.2');
  const checkoutCli = writeFixtureCli(checkout);
  const installedCli = writeFixtureCli(install);
  const result = path.join(home, 'result.json');
  writeRegistry(path.join(home, 'claude-agent-plugins'), [
    { version: '0.51.2', scope: 'user', installPath: install, lastUpdated: '2026-09-15T17:28:17.624Z' },
  ]);

  const hookRun = runHook(home, {
    CLAUDE_PLUGIN_ROOT: checkout,
    CLAUDE_CODE_PLUGIN_CACHE_DIR: path.join(home, 'claude-agent-plugins'),
    MODEL_GATEWAY_TEST_RESULT: result,
    MODEL_GATEWAY_TEST_EXIT: '0',
  });

  assert.equal(hookRun.status, 0, hookRun.stderr);
  assert.deepEqual(invocation(result), [installedCli, 'ensure', '--quiet']);
  assert.notEqual(invocation(result)[0], checkoutCli);
});

// The first SessionStart hook writes ~/.claude/model-gateway/model-gateway.js, and the host may run
// both hook commands concurrently. Delegation must not wait on that file existing.
test('delegation does not depend on the generated stable launcher existing yet', (t) => {
  const home = temporaryDirectory(t);
  const checkout = path.join(home, 'checkout');
  const install = path.join(home, 'installs', '0.51.2');
  writeFixtureCli(checkout);
  const installedCli = writeFixtureCli(install);
  const result = path.join(home, 'result.json');
  writeRegistry(path.join(home, 'claude-agent-plugins'), [{ version: '0.51.2', installPath: install }]);

  assert.equal(fs.existsSync(path.join(home, '.claude', 'model-gateway', 'model-gateway.js')), false);
  const hookRun = runHook(home, {
    CLAUDE_PLUGIN_ROOT: checkout,
    CLAUDE_CODE_PLUGIN_CACHE_DIR: path.join(home, 'claude-agent-plugins'),
    MODEL_GATEWAY_TEST_RESULT: result,
    MODEL_GATEWAY_TEST_EXIT: '0',
  });

  assert.equal(hookRun.status, 0, hookRun.stderr);
  assert.deepEqual(invocation(result), [installedCli, 'ensure', '--quiet']);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'model-gateway', 'model-gateway.js')), false);
});

test('the config-dir registry is used when no plugin cache dir is configured', (t) => {
  const home = temporaryDirectory(t);
  const configDirectory = path.join(home, 'relocated-claude');
  const checkout = path.join(home, 'checkout');
  const install = path.join(home, 'installs', '0.51.2');
  writeFixtureCli(checkout);
  const installedCli = writeFixtureCli(install);
  const result = path.join(home, 'result.json');
  writeRegistry(path.join(configDirectory, 'plugins'), [{ version: '0.51.2', installPath: install }]);

  const hookRun = runHook(home, {
    CLAUDE_PLUGIN_ROOT: checkout,
    CLAUDE_CONFIG_DIR: configDirectory,
    MODEL_GATEWAY_TEST_RESULT: result,
    MODEL_GATEWAY_TEST_EXIT: '7',
  });

  assert.equal(hookRun.status, 7, hookRun.stderr);
  assert.deepEqual(invocation(result), [installedCli, 'ensure', '--quiet']);
});

// A host migrated between the two registry layouts keeps both files, and either may be the stale
// one, so the newest recorded install wins wherever it is listed.
test('the newest recorded install wins across a migrated host\'s two registries', (t) => {
  const home = temporaryDirectory(t);
  const configDirectory = path.join(home, '.claude');
  const cacheDirectory = path.join(home, 'claude-agent-plugins');
  const checkout = path.join(home, 'checkout');
  const stale = path.join(home, 'installs', '0.40.0');
  const current = path.join(home, 'installs', '0.52.0');
  writeFixtureCli(checkout);
  writeFixtureCli(stale);
  const currentCli = writeFixtureCli(current);
  const result = path.join(home, 'result.json');
  writeRegistry(path.join(configDirectory, 'plugins'), [{ version: '0.40.0', installPath: stale }]);
  writeRegistry(cacheDirectory, [{ version: '0.52.0', installPath: current }]);

  const hookRun = runHook(home, {
    CLAUDE_PLUGIN_ROOT: checkout,
    CLAUDE_CODE_PLUGIN_CACHE_DIR: cacheDirectory,
    CLAUDE_CONFIG_DIR: configDirectory,
    MODEL_GATEWAY_TEST_RESULT: result,
    MODEL_GATEWAY_TEST_EXIT: '0',
  });

  assert.equal(hookRun.status, 0, hookRun.stderr);
  assert.deepEqual(invocation(result), [currentCli, 'ensure', '--quiet']);
});

test('a recorded install whose CLI is gone does not hide one that is still on disk', (t) => {
  const home = temporaryDirectory(t);
  const cacheDirectory = path.join(home, 'claude-agent-plugins');
  const checkout = path.join(home, 'checkout');
  const removed = path.join(home, 'installs', '0.52.0');
  const present = path.join(home, 'installs', '0.51.2');
  writeFixtureCli(checkout);
  const presentCli = writeFixtureCli(present);
  const result = path.join(home, 'result.json');
  writeRegistry(cacheDirectory, [
    { version: '0.52.0', installPath: removed },
    { version: '0.51.2', installPath: present },
  ]);

  const hookRun = runHook(home, {
    CLAUDE_PLUGIN_ROOT: checkout,
    CLAUDE_CODE_PLUGIN_CACHE_DIR: cacheDirectory,
    MODEL_GATEWAY_TEST_RESULT: result,
    MODEL_GATEWAY_TEST_EXIT: '0',
  });

  assert.equal(hookRun.status, 0, hookRun.stderr);
  assert.deepEqual(invocation(result), [presentCli, 'ensure', '--quiet']);
});

// A --plugin-dir development checkout is listed in no registry. It has to keep working exactly as
// it did before delegation existed: the loaded copy runs itself.
test('a checkout the registry does not list runs its own CLI', (t) => {
  const home = temporaryDirectory(t);
  const checkout = path.join(home, 'checkout');
  const checkoutCli = writeFixtureCli(checkout);
  const result = path.join(home, 'result.json');
  writeRegistry(path.join(home, 'claude-agent-plugins'), []);

  const hookRun = runHook(home, {
    CLAUDE_PLUGIN_ROOT: checkout,
    CLAUDE_CODE_PLUGIN_CACHE_DIR: path.join(home, 'claude-agent-plugins'),
    MODEL_GATEWAY_TEST_RESULT: result,
    MODEL_GATEWAY_TEST_EXIT: '3',
  }, ['ensure']);

  assert.equal(hookRun.status, 3, hookRun.stderr);
  assert.deepEqual(invocation(result), [checkoutCli, 'ensure']);
});

test('a missing registry file leaves the loaded copy running itself', (t) => {
  const home = temporaryDirectory(t);
  const checkout = path.join(home, 'checkout');
  const checkoutCli = writeFixtureCli(checkout);
  const result = path.join(home, 'result.json');

  const hookRun = runHook(home, {
    CLAUDE_PLUGIN_ROOT: checkout,
    CLAUDE_CONFIG_DIR: path.join(home, 'absent-claude'),
    MODEL_GATEWAY_TEST_RESULT: result,
    MODEL_GATEWAY_TEST_EXIT: '0',
  });

  assert.equal(hookRun.status, 0, hookRun.stderr);
  assert.deepEqual(invocation(result), [checkoutCli, 'ensure', '--quiet']);
});

test('no CLI anywhere names the registries it searched, and keeps the hook contract on exit codes', (t) => {
  const home = temporaryDirectory(t);
  const configDirectory = path.join(home, 'relocated-claude');
  const cacheDirectory = path.join(home, 'claude-agent-plugins');
  const checkout = path.join(home, 'checkout');
  fs.mkdirSync(checkout, { recursive: true });
  const environment = {
    CLAUDE_PLUGIN_ROOT: checkout,
    CLAUDE_CODE_PLUGIN_CACHE_DIR: cacheDirectory,
    CLAUDE_CONFIG_DIR: configDirectory,
  };

  const quiet = runHook(home, environment);
  const loud = runHook(home, environment, ['ensure']);

  // The hook path exits 0 on a refusal so Claude Code shows this line instead of a "hook failed"
  // badge, the same contract `ensure --quiet` keeps in lib/commands.js.
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(loud.status, 1);
  for (const run of [quiet, loud]) {
    assert.match(run.stderr, /no Model Gateway CLI to run/);
    assert.match(run.stderr, new RegExp(path.join(cacheDirectory, 'installed_plugins.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(run.stderr, new RegExp(path.join(configDirectory, 'plugins', 'installed_plugins.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(run.stderr, new RegExp(path.join(checkout, 'bin', 'model-gateway.js').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('the exit status of the delegated CLI is the hook\'s exit status', (t) => {
  const home = temporaryDirectory(t);
  const checkout = path.join(home, 'checkout');
  const install = path.join(home, 'installs', '0.51.2');
  writeFixtureCli(checkout);
  writeFixtureCli(install);
  const result = path.join(home, 'result.json');
  writeRegistry(path.join(home, 'claude-agent-plugins'), [{ version: '0.51.2', installPath: install }]);

  const hookRun = runHook(home, {
    CLAUDE_PLUGIN_ROOT: checkout,
    CLAUDE_CODE_PLUGIN_CACHE_DIR: path.join(home, 'claude-agent-plugins'),
    MODEL_GATEWAY_TEST_RESULT: result,
    MODEL_GATEWAY_TEST_EXIT: '19',
  }, ['ensure']);

  assert.equal(hookRun.status, 19, hookRun.stderr);
});
