import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  APP_DIR,
  bridgeInfoPathIn,
  childEnv,
  hostEntry,
  INJECTED_TEXT,
  newEndpoint,
  randomHex,
  readBridgeJson,
  sleep,
  startFakeHost,
  startHost,
  tempDir,
  textResult,
  track,
  waitFor,
  type FakeHostMode,
} from './helpers';

const NOT_CONNECTED =
  'Firefox is not running or the Claude Firefox extension is not connected. Open Firefox with the extension enabled and try again.';
const AUTH_FAILED = /^Authentication with the native host failed/;

// The SDK's reduced default environment (HOME, LOGNAME, PATH, SHELL, TERM, USER; on Windows APPDATA,
// LOCALAPPDATA, USERPROFILE and a few more), the way Claude Code starts the server, pointed at
// runtimeDir to keep every test away from the user's real bridge: XDG_RUNTIME_DIR is added, or
// LOCALAPPDATA replaced on Windows.
function serverEnv(runtimeDir: string): Record<string, string> {
  return process.platform === 'win32'
    ? childEnv({ LOCALAPPDATA: runtimeDir }, getDefaultEnvironment())
    : { ...getDefaultEnvironment(), XDG_RUNTIME_DIR: runtimeDir };
}

// StdioClientTransport always merges `env` into the SDK's default environment; `env` replaces
// serverEnv(runtimeDir).
async function startMcp(
  runtimeDir: string,
  env: Record<string, string> = serverEnv(runtimeDir),
): Promise<{ client: Client; stderr: () => string }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [hostEntry, '--mcp'],
    env,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const client = new Client({ name: 'mcp-server-test', version: '0.0.0' });
  onTestFinished(() => client.close());
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

function callTabsContext(client: Client) {
  return client.callTool({ name: 'tabs_context', arguments: {} });
}

function errorText(result: Awaited<ReturnType<typeof callTabsContext>>): string {
  expect(result.isError).toBe(true);
  return (result.content as { text: string }[])[0]?.text ?? '';
}

describe('MCP server process', () => {
  it('lists tabs_context first, with an empty input schema', async () => {
    const { client } = await startMcp(await tempDir());
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['tabs_context', 'navigate', 'tabs_create', 'tabs_close', 'computer']);
    expect(tools[0]?.description).toMatch(/tab ids/);
    expect(tools[0]?.inputSchema).toMatchObject({ type: 'object', properties: {} });
  });

  it('lists navigate with a required integer tabId and string url', async () => {
    const { client } = await startMcp(await tempDir());
    const { tools } = await client.listTools();
    const navigate = tools.find((tool) => tool.name === 'navigate');
    expect(navigate?.inputSchema).toMatchObject({
      type: 'object',
      properties: { tabId: { type: 'integer' }, url: { type: 'string' } },
      required: expect.arrayContaining(['tabId', 'url']),
    });
    expect(Object.keys(navigate?.inputSchema.properties ?? {}).sort()).toEqual(['tabId', 'url']);
    const description = navigate?.description ?? '';
    expect(description).toMatch(/https:\/\//);
    expect(description).toMatch(/\bback\b/);
    expect(description).toMatch(/\bforward\b/);
    expect(description).toMatch(/tabs_context/);
  });

  it('lists tabs_create with an optional string url', async () => {
    const { client } = await startMcp(await tempDir());
    const { tools } = await client.listTools();
    const tabsCreate = tools.find((tool) => tool.name === 'tabs_create');
    expect(tabsCreate?.inputSchema).toMatchObject({ type: 'object', properties: { url: { type: 'string' } } });
    expect(tabsCreate?.inputSchema.required ?? []).not.toContain('url');
    expect(Object.keys(tabsCreate?.inputSchema.properties ?? {})).toEqual(['url']);
    expect(tabsCreate?.description).toMatch(/background tab/);
  });

  it('lists tabs_close with a required integer tabId', async () => {
    const { client } = await startMcp(await tempDir());
    const { tools } = await client.listTools();
    const tabsClose = tools.find((tool) => tool.name === 'tabs_close');
    expect(tabsClose?.inputSchema).toMatchObject({
      type: 'object',
      properties: { tabId: { type: 'integer', exclusiveMinimum: 0 } },
      required: ['tabId'],
    });
    expect(Object.keys(tabsClose?.inputSchema.properties ?? {})).toEqual(['tabId']);
    expect(tabsClose?.description).toMatch(/last tab/);
  });

  it.each<[string, Record<string, unknown>]>([
    ['tabs_create', { url: 'example.com' }],
    ['tabs_create', {}],
    ['tabs_close', { tabId: 6 }],
  ])('forwards a %s call with its arguments to the extension and back', async (tool, args) => {
    const runtimeDir = await tempDir();
    const host = await startHost(runtimeDir);
    host.respondWith((request) => textResult(request['id'], 'done'));
    const { client } = await startMcp(runtimeDir);
    expect(await client.callTool({ name: tool, arguments: args })).toEqual({ content: [{ type: 'text', text: 'done' }] });
    expect(host.received).toEqual([{ type: 'tool_request', id: expect.stringMatching(/^\d+:1$/), tool, args }]);
  });

  it('forwards a navigate call with its arguments to the extension and back', async () => {
    const runtimeDir = await tempDir();
    const host = await startHost(runtimeDir);
    host.respondWith((request) => textResult(request['id'], 'Navigated to https://example.com/'));
    const { client } = await startMcp(runtimeDir);
    expect(await client.callTool({ name: 'navigate', arguments: { tabId: 5, url: 'example.com' } })).toEqual({
      content: [{ type: 'text', text: 'Navigated to https://example.com/' }],
    });
    expect(host.received).toEqual([
      {
        type: 'tool_request',
        id: expect.stringMatching(/^\d+:1$/),
        tool: 'navigate',
        args: { tabId: 5, url: 'example.com' },
      },
    ]);
  });

  it('lists computer with the screenshot action and optional tabId and scale', async () => {
    const { client } = await startMcp(await tempDir());
    const { tools } = await client.listTools();
    const computer = tools.find((tool) => tool.name === 'computer');
    expect(computer?.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['screenshot'] },
        tabId: { type: 'integer' },
        scale: { type: 'number', minimum: 0.1, maximum: 1 },
      },
      required: ['action'],
    });
    expect(computer?.description).toMatch(/screenshot/);
  });

  it('returns a screenshot from the extension as MCP text and image content', async () => {
    const runtimeDir = await tempDir();
    const host = await startHost(runtimeDir);
    // About the largest image the extension sends: 1,398,100 base64 characters.
    const data = Buffer.alloc(1_048_575, 7).toString('base64');
    const content = [
      { type: 'text', text: 'Captured screenshot (1280x720, jpeg)' },
      { type: 'image', data, mimeType: 'image/jpeg' },
    ];
    host.respondWith((request) => ({ type: 'tool_response', id: request['id'], result: { content } }));
    const { client } = await startMcp(runtimeDir);
    expect(await client.callTool({ name: 'computer', arguments: { action: 'screenshot', tabId: 5 } })).toEqual({ content });
    expect(host.received).toEqual([
      {
        type: 'tool_request',
        id: expect.stringMatching(/^\d+:1$/),
        tool: 'computer',
        args: { action: 'screenshot', tabId: 5 },
      },
    ]);
  });

  it('reports the server name and version from package.json', async () => {
    const { client } = await startMcp(await tempDir());
    expect(client.getServerVersion()).toEqual({ name: 'claude-firefox-extension', version: '0.1.0' });
  });

  it('returns the not-connected error when the socket directory does not exist', async () => {
    const { client } = await startMcp(await tempDir());
    expect(await callTabsContext(client)).toEqual({ content: [{ type: 'text', text: NOT_CONNECTED }], isError: true });
  });

  it('returns the not-connected error when no host is listening', async () => {
    const runtimeDir = await tempDir();
    mkdirSync(join(runtimeDir, APP_DIR), { mode: 0o700 });
    const { client } = await startMcp(runtimeDir);
    expect(await callTabsContext(client)).toEqual({ content: [{ type: 'text', text: NOT_CONNECTED }], isError: true });
  });

  it('forwards a call through the native host to the extension and back with the SDK reduced environment', async () => {
    const runtimeDir = await tempDir();
    const host = await startHost(runtimeDir);
    host.respondWith((request) => textResult(request['id'], JSON.stringify({ tabs: [], activeTabId: null })));
    const { client } = await startMcp(runtimeDir);
    expect(await callTabsContext(client)).toEqual({
      content: [{ type: 'text', text: '{"tabs":[],"activeTabId":null}' }],
    });
    expect(host.received).toEqual([
      { type: 'tool_request', id: expect.stringMatching(/^\d+:1$/), tool: 'tabs_context', args: {} },
    ]);
  });

  it('turns an extension error into an isError result', async () => {
    const runtimeDir = await tempDir();
    const host = await startHost(runtimeDir);
    host.respondWith((request) => ({
      type: 'tool_response',
      id: request['id'],
      error: { content: [{ type: 'text', text: 'Unknown tool: tabs_context' }] },
    }));
    const { client } = await startMcp(runtimeDir);
    expect(await callTabsContext(client)).toEqual({
      content: [{ type: 'text', text: 'Unknown tool: tabs_context' }],
      isError: true,
    });
  });

  it('keeps calls from several MCP servers apart', async () => {
    const runtimeDir = await tempDir();
    const host = await startHost(runtimeDir);
    host.respondWith((request) => textResult(request['id'], `answer for ${String(request['id'])}`));
    const servers = await Promise.all([startMcp(runtimeDir), startMcp(runtimeDir), startMcp(runtimeDir)]);
    const results = await Promise.all(servers.map(({ client }) => callTabsContext(client)));
    const texts = results.map((result) => (result.content as { text: string }[])[0]?.text);
    for (const text of texts) expect(text).toMatch(/^answer for \d+:1$/);
    expect(new Set(texts).size).toBe(3);
  });

  it('reports a lost host and reconnects to a new one', async () => {
    const runtimeDir = await tempDir();
    const first = await startHost(runtimeDir);
    first.respondWith((request) => textResult(request['id'], 'first'));
    const firstSecret = readBridgeJson(bridgeInfoPathIn(runtimeDir)).secret;
    const { client } = await startMcp(runtimeDir);
    expect(await callTabsContext(client)).toEqual({ content: [{ type: 'text', text: 'first' }] });

    first.child.stdin.end();
    expect(await first.exited).toBe(0);
    expect(await callTabsContext(client)).toEqual({ content: [{ type: 'text', text: NOT_CONNECTED }], isError: true });

    const second = await startHost(runtimeDir);
    second.respondWith((request) => textResult(request['id'], 'second'));
    expect(readBridgeJson(bridgeInfoPathIn(runtimeDir)).secret).not.toBe(firstSecret);
    expect(await callTabsContext(client)).toEqual({ content: [{ type: 'text', text: 'second' }] });
  });

  it('fails a pending call when the host goes away', async () => {
    const runtimeDir = await tempDir();
    const host = await startHost(runtimeDir);
    const { client } = await startMcp(runtimeDir);
    const call = callTabsContext(client);
    await host.nextRequest();
    host.child.stdin.end();
    expect(await call).toEqual({
      content: [{ type: 'text', text: 'The Firefox extension disconnected' }],
      isError: true,
    });
  });

  it('returns the not-connected error when bridge.json points at an endpoint nobody listens on', async () => {
    const runtimeDir = await tempDir();
    mkdirSync(join(runtimeDir, APP_DIR), { mode: 0o700 });
    writeFileSync(
      bridgeInfoPathIn(runtimeDir),
      JSON.stringify({ version: 1, endpoint: newEndpoint(join(runtimeDir, APP_DIR), 'bridge'), secret: randomHex(), pid: 999_999 }),
      { mode: 0o600 },
    );
    const { client } = await startMcp(runtimeDir);
    expect(await callTabsContext(client)).toEqual({ content: [{ type: 'text', text: NOT_CONNECTED }], isError: true });
  });

  it.each([
    ['is not JSON', '{oops'],
    ['has an unsupported version', JSON.stringify({ version: 2, endpoint: '/x', secret: 'ab'.repeat(32), pid: 1 })],
  ])('returns a clear tool error when bridge.json %s', async (_label, content) => {
    const runtimeDir = await tempDir();
    mkdirSync(join(runtimeDir, APP_DIR), { mode: 0o700 });
    writeFileSync(bridgeInfoPathIn(runtimeDir), content, { mode: 0o600 });
    const { client } = await startMcp(runtimeDir);
    const text = errorText(await callTabsContext(client));
    expect(text.startsWith(`Could not reach the native host: Invalid bridge info file ${bridgeInfoPathIn(runtimeDir)}`), text).toBe(true);
  });

  it('keeps the content of an invalid bridge.json out of the tool error and the log', async () => {
    const runtimeDir = await tempDir();
    mkdirSync(join(runtimeDir, APP_DIR), { mode: 0o700 });
    const secret = randomHex();
    writeFileSync(bridgeInfoPathIn(runtimeDir), `{"version":1,"endpoint":"/x","secret":"${secret}`, { mode: 0o600 });
    const { client, stderr } = await startMcp(runtimeDir);
    expect(await callTabsContext(client)).toEqual({
      content: [{ type: 'text', text: `Could not reach the native host: Invalid bridge info file ${bridgeInfoPathIn(runtimeDir)}: not valid JSON` }],
      isError: true,
    });
    expect(stderr()).not.toContain(secret.slice(0, 8));
  });

  it('reconnects to a new host after one closed the connection right after ready', async () => {
    const runtimeDir = await tempDir();
    const flaky = await startFakeHost(runtimeDir, 'close-after-ready');
    const { client } = await startMcp(runtimeDir);
    errorText(await callTabsContext(client));
    await flaky.close();

    const host = await startFakeHost(runtimeDir);
    host.respondWith((request) => textResult(request['id'], 'after reconnect'));
    expect(await callTabsContext(client)).toEqual({ content: [{ type: 'text', text: 'after reconnect' }] });
  });

  it('authenticates with the secret from bridge.json before sending the tool request', async () => {
    const runtimeDir = await tempDir();
    const host = await startFakeHost(runtimeDir);
    const { client } = await startMcp(runtimeDir);
    const call = callTabsContext(client);
    const request = await waitFor(() => {
      const found = host.requests[0];
      if (!found) throw new Error('no tool request yet');
      return found;
    });
    host.answer(textResult(request['id'], 'authenticated'));
    expect(await call).toEqual({ content: [{ type: 'text', text: 'authenticated' }] });
    expect(host.received.map((message) => message['type'])).toEqual(['hello', 'auth', 'tool_request']);
    expect(host.received[0]).toEqual({ type: 'hello', nonce: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(JSON.stringify(host.received)).not.toContain(host.secret);
    await host.close();
  });

  it.each<[string, FakeHostMode]>([
    ['proves a different secret', 'wrong-secret'],
    ['replays a host proof made for another client nonce', 'replay-proof'],
    ['sends a short proof', 'short-proof'],
    ['sends a non-hex proof', 'non-hex-proof'],
    ['sends ready without proving the secret', 'ready-without-hello'],
  ])('reports an authentication failure and sends neither auth nor a tool request when the host %s', async (_label, mode) => {
    const runtimeDir = await tempDir();
    const host = await startFakeHost(runtimeDir, mode);
    const { client } = await startMcp(runtimeDir);
    expect(errorText(await callTabsContext(client))).toMatch(AUTH_FAILED);
    // A message written right before the failure would still be in flight.
    await sleep(100);
    expect(host.received.map((message) => message['type'])).toEqual(['hello']);
    expect(host.requests).toEqual([]);
    await host.close();
  });

  it('returns an error and sends no tool request when the host closes the connection after hello', async () => {
    const runtimeDir = await tempDir();
    const host = await startFakeHost(runtimeDir, 'close-after-hello');
    const { client } = await startMcp(runtimeDir);
    errorText(await callTabsContext(client));
    await sleep(100);
    expect(host.received.map((message) => message['type'])).toEqual(['hello']);
    expect(host.requests).toEqual([]);
    await host.close();
  });

  it.each<[string, FakeHostMode]>([
    ['right after its hello', 'response-after-hello'],
    ['instead of ready', 'response-instead-of-ready'],
  ])('reports an authentication failure when the host sends a tool response %s', async (_label, mode) => {
    const runtimeDir = await tempDir();
    const host = await startFakeHost(runtimeDir, mode);
    // Makes an implementation that ignores the early response fail fast instead of timing out.
    host.respondWith((request) => textResult(request['id'], 'answered after ready'));
    const { client } = await startMcp(runtimeDir);
    const text = errorText(await callTabsContext(client));
    expect(text).toMatch(AUTH_FAILED);
    expect(text).not.toContain(INJECTED_TEXT);
    await sleep(100);
    expect(host.requests).toEqual([]);
    expect(host.received.map((message) => message['type'])).not.toContain('tool_request');
    await host.close();
  });

  it('runs a single handshake for two concurrent first calls and sends both requests after auth', async () => {
    const runtimeDir = await tempDir();
    const host = await startFakeHost(runtimeDir);
    host.respondWith((request) => textResult(request['id'], `answer ${String(request['id'])}`));
    const { client } = await startMcp(runtimeDir);
    const results = await Promise.all([callTabsContext(client), callTabsContext(client)]);
    const texts = results.map((result) => {
      expect(result.isError).toBeFalsy();
      return (result.content as { text: string }[])[0]?.text;
    });
    expect(new Set(texts)).toEqual(new Set(['answer 1', 'answer 2']));
    expect(host.connections()).toBe(1);
    expect(host.received.map((message) => message['type'])).toEqual(['hello', 'auth', 'tool_request', 'tool_request']);
    await host.close();
  });

  it('re-reads bridge.json on the next call after an authentication failure', async () => {
    const runtimeDir = await tempDir();
    const impostor = await startFakeHost(runtimeDir, 'wrong-secret');
    const { client } = await startMcp(runtimeDir);
    expect(errorText(await callTabsContext(client))).toMatch(AUTH_FAILED);
    await impostor.close();

    const host = await startHost(runtimeDir);
    host.respondWith((request) => textResult(request['id'], 'real host'));
    expect(await callTabsContext(client)).toEqual({ content: [{ type: 'text', text: 'real host' }] });
  });

  it('re-reads bridge.json when a host restarts with a new secret on the same socket path', async () => {
    const runtimeDir = await tempDir();
    const first = await startFakeHost(runtimeDir);
    first.respondWith((request) => textResult(request['id'], 'first'));
    const { client } = await startMcp(runtimeDir);
    expect(await callTabsContext(client)).toEqual({ content: [{ type: 'text', text: 'first' }] });
    await first.close();

    const second = await startFakeHost(runtimeDir);
    expect(second.secret).not.toBe(first.secret);
    second.respondWith((request) => textResult(request['id'], 'second'));
    // A call that races the MCP server noticing the dropped connection may still report not-connected.
    await waitFor(async () => expect(await callTabsContext(client)).toEqual({ content: [{ type: 'text', text: 'second' }] }));
    await second.close();
  });

  it.each([
    ['without a bridge connection', false],
    ['while connected to a host', true],
  ])('exits 0 on stdin EOF %s', async (_label, connected) => {
    const runtimeDir = await tempDir();
    const host = connected ? await startHost(runtimeDir) : undefined;
    host?.respondWith((request) => textResult(request['id'], 'ok'));
    const mcp = track(
      spawn(process.execPath, [hostEntry, '--mcp'], { env: serverEnv(runtimeDir) }),
    );
    let stdout = '';
    mcp.child.stdout.setEncoding('utf8');
    mcp.child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    const send = (message: unknown): void => {
      mcp.child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tabs_context', arguments: {} } });
    await mcp.waitForStderr(/ready/);
    await waitFor(() => expect(stdout).toMatch(/"id":2/));
    expect(stdout).toContain(connected ? '"text":"ok"' : 'Firefox is not running');

    mcp.child.stdin.end();
    expect(await mcp.exited).toBe(0);
    expect(mcp.stderr()).toMatch(/exiting: stdin closed/);
  });
});

// The socket directory checks only exist on Linux and macOS.
describe.skipIf(process.platform === 'win32')('MCP server process on Unix sockets', () => {
  it('returns a tool error when the socket directory is not private', async () => {
    const runtimeDir = await tempDir();
    const dir = join(runtimeDir, APP_DIR);
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    const { client } = await startMcp(runtimeDir);
    const result = await callTabsContext(client);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: 'text',
        text: `Could not reach the native host: Refusing to use bridge socket directory ${dir}: its mode is 755, group and other must have no access`,
      },
    ]);
  });
});

describe.runIf(process.platform === 'win32')('MCP server on Windows', () => {
  async function windowsTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'cfe-'));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    return dir;
  }

  // The SDK merges `env` over its default environment, so the override is applied to that same base.
  function mcpEnv(localAppData: string): Record<string, string> {
    return childEnv({ LOCALAPPDATA: localAppData }, getDefaultEnvironment());
  }

  it('finds the host through bridge.json under LOCALAPPDATA and forwards a call over the pipe', async () => {
    const localAppData = await windowsTempDir();
    const host = await startHost(localAppData, { env: childEnv({ LOCALAPPDATA: localAppData }) });
    host.respondWith((request) => textResult(request['id'], 'windows'));
    const { client } = await startMcp(localAppData, mcpEnv(localAppData));
    expect(await callTabsContext(client)).toEqual({ content: [{ type: 'text', text: 'windows' }] });
  });

  it('returns the not-connected error when there is no bridge.json', async () => {
    const localAppData = await windowsTempDir();
    const { client } = await startMcp(localAppData, mcpEnv(localAppData));
    expect(await callTabsContext(client)).toEqual({ content: [{ type: 'text', text: NOT_CONNECTED }], isError: true });
  });
});
