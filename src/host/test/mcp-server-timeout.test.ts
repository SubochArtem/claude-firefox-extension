import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUNTIME_DIR_VAR, sleep, startFakeHost, tempDir, textResult, waitFor } from './helpers';

const MCP_TIMEOUT_MS = 150_000;
const ELICITATION_TIMEOUT_MS = 120_000;
const HANDSHAKE_TIMEOUT_MS = 2_000;
const AUTH_FAILED = /^Authentication with the native host failed/;
const SIGNALS = ['exit', 'SIGINT', 'SIGTERM'] as const;

// The 150 s timeout cannot be waited for in a child process, so this file runs the MCP server inside
// the test worker with fake stdio, a stubbed process.exit and fake setTimeout. Sockets stay real.
async function startInProcessMcp(runtimeDir: string, capabilities: Record<string, unknown> = {}) {
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
  vi.stubEnv(RUNTIME_DIR_VAR, runtimeDir);

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
      params: { protocolVersion: '2025-06-18', capabilities, clientInfo: { name: 't', version: '0' } },
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

describe('MCP server request timeout', () => {
  it('returns a timeout error after 150 s and ignores the late answer', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const runtimeDir = await tempDir();
    const bridge = await startFakeHost(runtimeDir);
    const mcp = await startInProcessMcp(runtimeDir);
    try {
      mcp.callTabsContext(1);
      await waitFor(() => expect(bridge.requests).toHaveLength(1));
      expect(bridge.requests[0]).toEqual({ type: 'tool_request', id: '1', tool: 'tabs_context', args: {} });

      vi.advanceTimersByTime(MCP_TIMEOUT_MS - 1);
      await sleep(50);
      expect(mcp.responses.find((message) => message['id'] === 1)).toBeUndefined();
      vi.advanceTimersByTime(1);
      expect(await mcp.response(1)).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: 'tabs_context timed out after 150 s' }], isError: true },
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

describe('MCP server permission elicitation timeout', () => {
  it('answers deny once when the user does not answer the elicitation within 120 s', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const runtimeDir = await tempDir();
    const bridge = await startFakeHost(runtimeDir);
    const mcp = await startInProcessMcp(runtimeDir, { elicitation: {} });
    const permissionResponses = () => bridge.requests.filter((message) => message['type'] === 'permission_response');
    try {
      mcp.callTabsContext(1);
      await waitFor(() => expect(bridge.requests).toHaveLength(1));
      expect(bridge.requests[0]).toMatchObject({ id: '1', approvalViaClient: true });
      bridge.answer({
        type: 'permission_request',
        requestId: 'req-1',
        callId: '1',
        host: 'example.com',
        tool: 'tabs_context',
        action: 'navigate',
        canIncludeSubdomains: true,
      });
      await waitFor(() => expect(mcp.responses.find((message) => message['method'] === 'elicitation/create')).toBeDefined());

      vi.advanceTimersByTime(ELICITATION_TIMEOUT_MS - 1);
      await sleep(50);
      expect(permissionResponses()).toEqual([]);
      vi.advanceTimersByTime(1);
      await waitFor(() =>
        expect(permissionResponses()).toEqual([
          { type: 'permission_response', requestId: 'req-1', answer: 'deny', includeSubdomains: false },
        ]),
      );
    } finally {
      await mcp.stop();
      await bridge.close();
    }
  });
});

describe('MCP server handshake timeout', () => {
  it.each([
    ['never answers hello', 'silent', ['hello']],
    ['never sends ready', 'no-ready', ['hello', 'auth']],
  ] as const)('reports an authentication failure after 2 s when the host %s', async (_label, mode, expected) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const runtimeDir = await tempDir();
    const bridge = await startFakeHost(runtimeDir, mode);
    const mcp = await startInProcessMcp(runtimeDir);
    try {
      mcp.callTabsContext(1);
      await waitFor(() => expect(bridge.received.map((message) => message['type'])).toEqual(expected));
      vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS - 1);
      await sleep(50);
      expect(mcp.responses.find((message) => message['id'] === 1)).toBeUndefined();
      vi.advanceTimersByTime(1);
      const response = await mcp.response(1);
      expect(response).toMatchObject({ jsonrpc: '2.0', id: 1, result: { isError: true } });
      const content = (response['result'] as { content: { type: string; text: string }[] }).content;
      expect(content).toEqual([{ type: 'text', text: expect.stringMatching(AUTH_FAILED) }]);
      expect(bridge.requests).toEqual([]);
      expect(bridge.received.map((message) => message['type'])).toEqual(expected);
    } finally {
      await mcp.stop();
      await bridge.close();
    }
  });
});
