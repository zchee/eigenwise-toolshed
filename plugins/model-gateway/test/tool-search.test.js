'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');
const { spawnGatewayProcess } = require('./support.js');

const CLI = path.join(__dirname, '..', 'bin', 'model-gateway.js');
const ARTIFACT_PATTERN = String.raw`^(?!__.*__$)[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}"\\./[\]]{1,200}$`;
const ARTIFACT_OUTPUT = String.raw`^(?!__.*__$)[^"\\./[\]]{1,200}$`;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function request(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: body == null ? 'GET' : 'POST',
      path: pathname,
      headers: body == null ? {} : {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function waitForHealthz(port) {
  const deadline = Date.now() + 5000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await request(port, '/healthz');
      if (response.status === 200) return;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError || new Error('shim did not become healthy');
}

function tool(name, deferLoading, inputSchema = { type: 'object', properties: {} }) {
  const definition = {
    name,
    description: `${name} fixture`,
    input_schema: inputSchema,
  };
  if (deferLoading !== undefined) definition.defer_loading = deferLoading;
  return definition;
}

function assertForwardedArtifactPattern(payload, toolName = 'Artifact') {
  assert.equal(payload.tools.find((entry) => entry.name === toolName)
    .input_schema.properties.filename.pattern, ARTIFACT_OUTPUT, 'identity adapter leaves the rejected Artifact pattern');
}

test('Codex tool search resolves references while Anthropic passthrough stays byte-identical', async (t) => {
  const shimPort = await freePort();
  const proxyPort = await freePort();
  const forwardedToCodex = [];
  const proxy = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }));
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      forwardedToCodex.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', model: 'gpt-5.6-sol', content: [] }));
    });
  });
  await new Promise((resolve) => proxy.listen(proxyPort, '127.0.0.1', resolve));
  t.after(() => proxy.close());

  let forwardedToAnthropic;
  const anthropic = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      forwardedToAnthropic = Buffer.concat(chunks).toString();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', model: 'claude-opus-4-8[1m]', content: [] }));
    });
  });
  const anthropicPort = await new Promise((resolve) => {
    anthropic.listen(0, '127.0.0.1', () => resolve(anthropic.address().port));
  });
  t.after(() => anthropic.close());

  const child = spawnGatewayProcess(t, process.execPath, [CLI, 'serve-shim'], {
    env: {
      ...process.env,
      CODEX_GATEWAY_PORT: String(shimPort),
      CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
      CODEX_GATEWAY_ANTHROPIC_UPSTREAM: `http://127.0.0.1:${anthropicPort}`,
      CODEX_GATEWAY_REQUEST_LOG: '0',
      CODEX_GATEWAY_SENTRY: '0',
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  await waitForHealthz(shimPort);

  const models = JSON.parse((await request(shimPort, '/v1/models')).body).data;
  assert.ok(models.some(({ id }) => id === 'claude-gpt-5.6-sol[1m]'));

  const artifactSchema = {
    type: 'object',
    properties: { filename: { type: 'string', pattern: ARTIFACT_PATTERN } },
  };
  const tools = [
    tool('ToolSearch'),
    tool('Bash', false),
    tool('Artifact', false, artifactSchema),
    tool('mcp__sidequest_board__list', true, artifactSchema),
    tool('mcp__sidequest_board__comments', true),
    tool('ExitPlanMode', false),
  ];
  assert.throws(() => assertForwardedArtifactPattern({ tools }), /identity adapter leaves the rejected Artifact pattern/);
  const initial = JSON.stringify({
    model: 'claude-gpt-5.6-sol',
    max_tokens: 32,
    messages: [{ role: 'user', content: 'Find the board list tool' }],
    tools,
  });
  assert.equal((await request(shimPort, '/v1/messages', initial)).status, 200);
  assert.deepEqual(forwardedToCodex[0].tools.map(({ name }) => name), ['ToolSearch', 'Bash', 'Artifact']);
  assertForwardedArtifactPattern(forwardedToCodex[0]);
  assert.equal(forwardedToCodex[0].tools.some((entry) => 'defer_loading' in entry), false);

  const followUpBody = {
    model: 'claude-gpt-5.6-sol',
    max_tokens: 32,
    messages: [
      { role: 'user', content: 'Find the board list tool' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'search-1', name: 'ToolSearch', input: { query: 'list board tickets' } }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'search-1',
          content: [
            { type: 'text', text: 'Found one tool' },
            { type: 'tool_reference', tool_name: 'mcp__sidequest_board__list' },
          ],
        }],
      },
    ],
    tools,
  };
  const followUp = JSON.stringify(followUpBody);
  assert.equal((await request(shimPort, '/v1/messages', followUp)).status, 200);
  assert.deepEqual(forwardedToCodex[1].tools.map(({ name }) => name), [
    'ToolSearch',
    'Bash',
    'Artifact',
    'mcp__sidequest_board__list',
  ]);
  assert.equal(forwardedToCodex[1].tools.some((entry) => 'defer_loading' in entry), false);
  assert.equal(forwardedToCodex[1].tools.find((entry) => entry.name === 'mcp__sidequest_board__list')
    .input_schema.properties.filename.pattern, ARTIFACT_OUTPUT);
  assert.equal(forwardedToCodex[1].tools.some((entry) => entry.name === 'ExitPlanMode'), false);
  assert.deepEqual(forwardedToCodex[1].messages[2].content[0].content, [
    { type: 'text', text: 'Found one tool' },
    { type: 'text', text: 'Tool reference: mcp__sidequest_board__list' },
  ]);
  assert.equal(JSON.stringify(forwardedToCodex[1]).includes('tool_reference'), false);

  const rejected = await request(shimPort, '/v1/messages', JSON.stringify({
    model: 'claude-gpt-5.6-sol',
    max_tokens: 32,
    messages: [{ role: 'user', content: 'Use the unsafe fixture' }],
    tools: [tool('unsafe_fixture', false, { not: { pattern: String.raw`[^\p{Cc}a]` } })],
  }));
  assert.equal(rejected.status, 400);
  const rejectedBody = JSON.parse(rejected.body);
  assert.equal(rejectedBody.error.type, 'invalid_request_error');
  assert.match(rejectedBody.error.message, /unsafe_fixture/);
  assert.match(rejectedBody.error.message, /\/tools\/0\/input_schema\/not/);
  assert.match(rejectedBody.error.message, /forbidden-schema-applicator/);
  assert.equal(rejectedBody.error.message.includes('[^'), false);
  assert.equal(forwardedToCodex.length, 2);

  const escapedNegativeContext = await request(shimPort, '/v1/messages', JSON.stringify({
    model: 'claude-gpt-5.6-sol',
    max_tokens: 32,
    messages: [{ role: 'user', content: 'Use the escaped negative fixture' }],
    tools: [tool('escaped_negative_fixture', false, {
      type: 'string',
      pattern: String.raw`^(?!\)[^\p{Cc}X]).*$`,
    })],
  }));
  assert.equal(escapedNegativeContext.status, 400);
  const escapedNegativeBody = JSON.parse(escapedNegativeContext.body);
  assert.match(escapedNegativeBody.error.message, /escaped_negative_fixture/);
  assert.match(escapedNegativeBody.error.message, /negative-regex-context/);
  assert.equal(escapedNegativeBody.error.message.includes('[^'), false);
  assert.equal(forwardedToCodex.length, 2);

  const anthropicRaw = JSON.stringify({ ...followUpBody, model: 'claude-opus-4-8[1m]' }, null, 2);
  assert.equal((await request(shimPort, '/v1/messages', anthropicRaw)).status, 200);
  assert.equal(forwardedToAnthropic, anthropicRaw);
  assert.equal(forwardedToCodex.length, 2);
});

async function startCodexFixture(t) {
  const shimPort = await freePort();
  const proxyPort = await freePort();
  const forwarded = [];
  const proxy = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }));
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      forwarded.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', model: 'gpt-5.6-sol', content: [] }));
    });
  });
  await new Promise((resolve) => proxy.listen(proxyPort, '127.0.0.1', resolve));
  t.after(() => proxy.close());
  const child = spawnGatewayProcess(t, process.execPath, [CLI, 'serve-shim'], {
    env: {
      ...process.env,
      CODEX_GATEWAY_PORT: String(shimPort),
      CODEX_GATEWAY_PROXY_PORT: String(proxyPort),
      CODEX_GATEWAY_REQUEST_LOG: '0',
      CODEX_GATEWAY_SENTRY: '0',
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  await waitForHealthz(shimPort);
  return { shimPort, forwarded };
}

function toolAdditionDefinition(name) {
  return { type: 'tool_addition', tool: { type: 'tool_definition', definition: tool(name) } };
}

function toolAdditionReference(name) {
  return { type: 'tool_addition', tool: { type: 'tool_reference', name } };
}

test('proxy routes turn tool_addition blocks into tools entries and drop the blocks', async (t) => {
  const { shimPort, forwarded } = await startCodexFixture(t);

  const systemTurn = {
    role: 'system',
    content: [
      { type: 'text', text: 'SessionStart hook additional context' },
      toolAdditionDefinition('mcp__docs__batch'),
      toolAdditionDefinition('Bash'),
      toolAdditionReference('advisor'),
      toolAdditionReference('mcp__sidequest_board__list'),
    ],
  };
  const additionsOnlyTurn = {
    role: 'system',
    content: [toolAdditionDefinition('mcp__docs__batch'), toolAdditionReference('mcp__sidequest_board__list')],
  };
  const tools = [
    tool('ToolSearch'),
    tool('Bash', false),
    { type: 'advisor_20260301', name: 'advisor', model: 'claude-fable-5-1', defer_loading: true },
    tool('mcp__sidequest_board__list', true),
    tool('mcp__sidequest_board__comments', true),
  ];
  const body = JSON.stringify({
    model: 'claude-gpt-5.6-sol',
    max_tokens: 32,
    messages: [
      { role: 'user', content: 'hi' },
      systemTurn,
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      additionsOnlyTurn,
      { role: 'user', content: 'list the board' },
    ],
    tools,
  });
  const response = await request(shimPort, '/v1/messages', body);
  assert.equal(response.status, 200, response.body);
  const payload = forwarded[0];
  assert.equal(JSON.stringify(payload).includes('tool_addition'), false, 'no tool_addition block reaches the backend');
  assert.deepEqual(payload.messages.map(({ role }) => role), ['user', 'system', 'assistant', 'user'],
    'a system turn that held only tool additions is dropped, the one with text stays');
  assert.deepEqual(payload.messages[1].content, [{ type: 'text', text: 'SessionStart hook additional context' }]);
  assert.deepEqual(payload.tools.map(({ name }) => name), [
    'ToolSearch',
    'Bash',
    'mcp__sidequest_board__list',
    'mcp__docs__batch',
  ], 'definitions are appended once by name, a referenced client tool is loaded, the advisor server tool and unreferenced deferred tools stay out');
  assert.equal(payload.tools.some((entry) => 'defer_loading' in entry), false);

  const noTools = await request(shimPort, '/v1/messages', JSON.stringify({
    model: 'claude-gpt-5.6-sol',
    max_tokens: 32,
    messages: [{ role: 'user', content: 'hi' }, { role: 'system', content: [toolAdditionDefinition('mcp__docs__batch')] }],
  }));
  assert.equal(noTools.status, 200, noTools.body);
  assert.deepEqual(forwarded[1].messages.map(({ role }) => role), ['user']);
  assert.deepEqual(forwarded[1].tools.map(({ name }) => name), ['mcp__docs__batch'], 'a definition creates the tools list when the request had none');
});
