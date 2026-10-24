import { mkdirSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_DIR, socketPathIn, tempDir, textResult, waitFor } from './helpers';

const MCP_TIMEOUT_MS = 30_000;
const SIGNALS = ['exit', 'SIGINT', 'SIGTERM'] as const;

// A fake native host on the bridge socket that records requests and answers only when told to.
async function startFakeBridge(runtimeDir: string) {
  mkdirSync(join(runtimeDir, APP_DIR), { mode: 0o700 });
  const requests: Record<string, unknown>[] = [];
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    let partial = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      const lines = (partial + chunk).split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) requests.push(JSON.parse(line) as Record<string, unknown>);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPathIn(runtimeDir), resolve));
  return {
    requests,
    answer: (message: unknown) => sockets[0]?.write(`${JSON.stringify(message)}\n`),
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

// The 30 s timeout cannot be waited for in a child process, so this file runs the MCP server inside
// the test worker with fake stdio, a stubbed process.exit and fake setTimeout. Sockets stay real.
async function startInProcessMcp(runtimeDir: string) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const responses: Record<string, unknown>[] = [];
  let partial = '';
  stdout.setEncoding('utf8');
  stdout.on('data', (chunk: string) => {
    const lines = (partial + chunk).split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) responses.push(JSON.parse(line) as Record<string, unknown>);
  });
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as unknown as typeof process.stdin);
  vi.spyOn(process, 'stdout', 'get').mockReturnValue(stdout as unknown as typeof process.stdout);
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as typeof process.exit);
  const listenersBefore = new Map(SIGNALS.map((event) => [event, process.listeners(event)]));
  const removeServerListeners = (): void => {
    for (const event of SIGNALS) {
      for (const listener of process.listeners(event)) {
        if (!listenersBefore.get(event)?.includes(listener)) process.off(event, listener as () => void);
      }
    }
  };
  vi.stubEnv('XDG_RUNTIME_DIR', runtimeDir);

  const send = (message: unknown): void => {
    stdin.write(`${JSON.stringify(message)}\n`);
  };
  const response = (id: number) =>
    waitFor(() => {
      const found = responses.find((message) => message['id'] === id);
      if (!found) throw new Error(`no response ${id} yet`);
      return found;
    });
  try {
    vi.resetModules();
    const { runMcpServer } = await import('../mcp-server');
    await runMcpServer();
    send({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    });
    await response(0);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  } catch (error) {
    removeServerListeners();
    throw error;
  }

  return {
    responses,
    callTabsContext: (id: number) => {
      send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'tabs_context', arguments: {} } });
    },
    response,
    stop: async () => {
      try {
        stdin.end();
        await waitFor(() => expect(exit).toHaveBeenCalledWith(0));
      } finally {
        removeServerListeners();
      }
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe.runIf(process.platform === 'linux' || process.platform === 'darwin')('MCP server request timeout', () => {
  it('returns a timeout error after 30 s and ignores the late answer', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const runtimeDir = await tempDir();
    const bridge = await startFakeBridge(runtimeDir);
    const mcp = await startInProcessMcp(runtimeDir);
    try {
      mcp.callTabsContext(1);
      await waitFor(() => expect(bridge.requests).toHaveLength(1));
      expect(bridge.requests[0]).toEqual({ type: 'tool_request', id: '1', tool: 'tabs_context', args: {} });

      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(MCP_TIMEOUT_MS - 1);
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(await mcp.response(1)).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: 'tabs_context timed out after 30 s' }], isError: true },
      });

      bridge.answer(textResult('1', 'too late'));
      mcp.callTabsContext(2);
      await waitFor(() => expect(bridge.requests).toHaveLength(2));
      expect(bridge.requests[1]).toMatchObject({ id: '2' });
      bridge.answer(textResult('2', 'on time'));
      expect(await mcp.response(2)).toEqual({
        jsonrpc: '2.0',
        id: 2,
        result: { content: [{ type: 'text', text: 'on time' }] },
      });
      expect(mcp.responses.filter((message) => message['id'] === 1)).toHaveLength(1);
    } finally {
      await mcp.stop();
      await bridge.close();
    }
  });
});
