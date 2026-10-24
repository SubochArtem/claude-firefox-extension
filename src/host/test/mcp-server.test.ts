import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it, onTestFinished } from 'vitest';
import { APP_DIR, hostEntry, startHost, tempDir, textResult, track, waitFor } from './helpers';

const NOT_CONNECTED =
  'Firefox is not running or the Claude Firefox extension is not connected. Open Firefox with the extension enabled and try again.';

// StdioClientTransport always merges `env` into the SDK's reduced default environment (HOME, LOGNAME,
// PATH, SHELL, TERM, USER), the same way Claude Code starts the server. Only XDG_RUNTIME_DIR is added,
// to keep every test away from the user's real bridge socket directory.
async function startMcp(runtimeDir: string): Promise<{ client: Client; stderr: () => string }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [hostEntry, '--mcp'],
    env: { XDG_RUNTIME_DIR: runtimeDir },
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

describe.skipIf(process.platform === 'win32')('MCP server process', () => {
  it('lists tabs_context with an empty input schema', async () => {
    const { client } = await startMcp(await tempDir());
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['tabs_context']);
    expect(tools[0]?.description).toMatch(/tab ids/);
    expect(tools[0]?.inputSchema).toMatchObject({ type: 'object', properties: {} });
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
    const { client } = await startMcp(runtimeDir);
    expect(await callTabsContext(client)).toEqual({ content: [{ type: 'text', text: 'first' }] });

    first.child.stdin.end();
    expect(await first.exited).toBe(0);
    expect(await callTabsContext(client)).toEqual({ content: [{ type: 'text', text: NOT_CONNECTED }], isError: true });

    const second = await startHost(runtimeDir);
    second.respondWith((request) => textResult(request['id'], 'second'));
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

  it.each([
    ['without a bridge connection', false],
    ['while connected to a host', true],
  ])('exits 0 on stdin EOF %s', async (_label, connected) => {
    const runtimeDir = await tempDir();
    const host = connected ? await startHost(runtimeDir) : undefined;
    host?.respondWith((request) => textResult(request['id'], 'ok'));
    const mcp = track(
      spawn(process.execPath, [hostEntry, '--mcp'], { env: { ...getDefaultEnvironment(), XDG_RUNTIME_DIR: runtimeDir } }),
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
