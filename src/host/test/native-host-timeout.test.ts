import { existsSync } from 'node:fs';
import { createServer, Server, type Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  bridgeInfoPathIn,
  bridgeTargetIn,
  connectClient,
  connectRaw,
  encodeNativeMessage,
  endpointExists,
  endpointIn,
  nativeLength,
  newEndpoint,
  randomHex,
  RUNTIME_DIR_VAR,
  sleep,
  tempDir,
  textResult,
  waitFor,
} from './helpers';

const HOST_TIMEOUT_MS = 155_000;
const HANDSHAKE_TIMEOUT_MS = 2_000;
const SIGNALS = ['exit', 'SIGINT', 'SIGTERM'] as const;

// The 155 s timeout cannot be waited for in a child process, so this file runs the host inside the
// test worker with fake stdio, a stubbed process.exit and fake setTimeout. Sockets stay real.
async function startInProcessHost(runtimeDir: string) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const frames: Record<string, unknown>[] = [];
  stdout.on('data', (chunk: Buffer) => {
    for (let offset = 0; offset < chunk.length; ) {
      const length = nativeLength(chunk, offset);
      frames.push(JSON.parse(chunk.subarray(offset + 4, offset + 4 + length).toString('utf8')) as Record<string, unknown>);
      offset += 4 + length;
    }
  });
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as unknown as typeof process.stdin);
  vi.spyOn(process, 'stdout', 'get').mockReturnValue(stdout as unknown as typeof process.stdout);
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as typeof process.exit);
  const listenersBefore = new Map(SIGNALS.map((event) => [event, process.listeners(event)]));
  const removeHostListeners = (): void => {
    for (const event of SIGNALS) {
      for (const listener of process.listeners(event)) {
        if (!listenersBefore.get(event)?.includes(listener)) process.off(event, listener as () => void);
      }
    }
  };
  vi.stubEnv(RUNTIME_DIR_VAR, runtimeDir);

  try {
    vi.resetModules();
    const { runNativeHost } = await import('../native-host');
    await runNativeHost();
  } catch (error) {
    removeHostListeners();
    throw error;
  }

  const stop = async (): Promise<void> => {
    try {
      stdin.end();
      await waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    } finally {
      removeHostListeners();
    }
  };
  return { stdin, frames, stop };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('native host request timeout', () => {
  it('answers with an error after 155 s without a response and ignores the late answer', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const runtimeDir = await tempDir();
    const host = await startInProcessHost(runtimeDir);
    const endpoint = endpointIn(runtimeDir);
    try {
      const client = await connectClient(bridgeTargetIn(runtimeDir));
      client.send({ type: 'tool_request', id: 'slow', tool: 'tabs_context', args: {} });
      const request = await waitFor(() => {
        const frame = host.frames.find((message) => message['type'] === 'tool_request');
        if (!frame) throw new Error('request not forwarded yet');
        return frame;
      });

      vi.advanceTimersByTime(HOST_TIMEOUT_MS - 1);
      await sleep(50);
      expect(client.lines).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(await client.nextLine()).toEqual({
        type: 'tool_response',
        id: 'slow',
        error: { content: [{ type: 'text', text: 'The Firefox extension did not answer tabs_context in time' }] },
      });

      host.stdin.write(encodeNativeMessage(textResult(request['id'], 'too late')));
      await waitFor(() =>
        expect(console.error).toHaveBeenCalledWith(`[native-host] response for unknown request ${String(request['id'])}`),
      );
      expect(client.lines).toHaveLength(1);
    } finally {
      await host.stop();
    }
    expect(await endpointExists(endpoint)).toBe(false);
    expect(existsSync(bridgeInfoPathIn(runtimeDir))).toBe(false);
  });

  it('clears the timeout when the extension answers in time', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const runtimeDir = await tempDir();
    const host = await startInProcessHost(runtimeDir);
    try {
      const client = await connectClient(bridgeTargetIn(runtimeDir));
      client.send({ type: 'tool_request', id: 'fast', tool: 'tabs_context', args: {} });
      const request = await waitFor(() => {
        const frame = host.frames.find((message) => message['type'] === 'tool_request');
        if (!frame) throw new Error('request not forwarded yet');
        return frame;
      });
      host.stdin.write(encodeNativeMessage(textResult(request['id'], 'in time')));
      expect(await client.nextLine()).toEqual(textResult('fast', 'in time'));
      vi.advanceTimersByTime(HOST_TIMEOUT_MS);
      await sleep(50);
      expect(client.lines).toHaveLength(1);
      expect(client.isClosed()).toBe(false);
    } finally {
      await host.stop();
    }
  });
});

describe('native host startup', () => {
  it('closes the server when stdin fails between the bind and recording the socket identity', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Faked so the 1 s grace timer cannot be what ends the host.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const listen = Server.prototype.listen;
    let endpoint: unknown;
    // The stream error is queued with process.nextTick right after the 'listening' event, so
    // shutdown runs before the await in runNativeHost resumes.
    vi.spyOn(Server.prototype, 'listen').mockImplementation(function (this: Server, ...args: unknown[]) {
      endpoint = args[0];
      const server = (listen as (...listenArgs: unknown[]) => Server).apply(this, args);
      process.stdin.destroy(new Error('boom'));
      return server;
    } as typeof Server.prototype.listen);
    const runtimeDir = await tempDir();
    const host = await startInProcessHost(runtimeDir);
    try {
      await waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));
      expect(typeof endpoint).toBe('string');
      expect(await endpointExists(endpoint as string)).toBe(false);
      expect(existsSync(bridgeInfoPathIn(runtimeDir))).toBe(false);
      expect(console.error).toHaveBeenCalledWith('[native-host] shutting down: stdin error: boom');
      expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining('listening on'));
    } finally {
      await host.stop();
    }
  });
});

describe('native host handshake timeout', () => {
  it('closes a connection that sends nothing after exactly 2 s without writing to it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const runtimeDir = await tempDir();
    const host = await startInProcessHost(runtimeDir);
    try {
      const timersBefore = vi.getTimerCount();
      const client = await connectRaw(endpointIn(runtimeDir));
      // Only a sync point: the host has accepted the connection and started its handshake timer.
      await waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(timersBefore));
      vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS - 1);
      await sleep(50);
      expect(client.isClosed()).toBe(false);
      vi.advanceTimersByTime(1);
      await client.closed;
      expect(client.lines).toEqual([]);
    } finally {
      await host.stop();
    }
  });

  it('counts the 2 s from the connection, not from the hello', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const runtimeDir = await tempDir();
    const host = await startInProcessHost(runtimeDir);
    try {
      const timersBefore = vi.getTimerCount();
      const client = await connectRaw(endpointIn(runtimeDir));
      // Only a sync point: the host has accepted the connection and started its handshake timer.
      await waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(timersBefore));
      vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS / 2);
      client.send({ type: 'hello', nonce: randomHex() });
      expect(await client.nextLine()).toMatchObject({ type: 'hello' });
      vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS / 2);
      await client.closed;
      expect(client.lines).toHaveLength(1);
    } finally {
      await host.stop();
    }
  });

  it('clears the handshake timer once the client is authenticated', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const runtimeDir = await tempDir();
    const host = await startInProcessHost(runtimeDir);
    try {
      const client = await connectClient(bridgeTargetIn(runtimeDir));
      vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS * 5);
      await sleep(50);
      expect(client.isClosed()).toBe(false);
      client.send({ type: 'tool_request', id: 'late', tool: 'tabs_context', args: {} });
      const request = await waitFor(() => {
        const frame = host.frames.find((message) => message['type'] === 'tool_request');
        if (!frame) throw new Error('request not forwarded yet');
        return frame;
      });
      host.stdin.write(encodeNativeMessage(textResult(request['id'], 'still open')));
      expect(await client.nextLine()).toEqual(textResult('late', 'still open'));
    } finally {
      await host.stop();
    }
  });
});

describe('native host handshake slots', () => {
  const OVERSIZED = Buffer.from('a'.repeat(5 * 1024));
  // Each case makes the host close all 8 idle connections synchronously.
  it.each<[string, (hostSockets: Socket[]) => void]>([
    ['the handshake timeout', () => vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS)],
    ['invalid JSON', (hostSockets) => hostSockets.forEach((socket) => socket.emit('data', Buffer.from('not json\n')))],
    ['the pre-ready line cap', (hostSockets) => hostSockets.forEach((socket) => socket.emit('data', OVERSIZED))],
  ])('frees the slots of connections it closes on %s before their close events run', async (_label, closeIdle) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const listen = Server.prototype.listen;
    let hostServer: Server | undefined;
    vi.spyOn(Server.prototype, 'listen').mockImplementation(function (this: Server, ...args: unknown[]) {
      hostServer = this;
      return (listen as (...listenArgs: unknown[]) => Server).apply(this, args);
    } as typeof Server.prototype.listen);
    const runtimeDir = await tempDir();
    const host = await startInProcessHost(runtimeDir);
    vi.mocked(Server.prototype.listen).mockRestore();
    if (!hostServer) throw new Error('the host server was not captured');
    const hostSockets: Socket[] = [];
    hostServer.on('connection', (socket: Socket) => hostSockets.push(socket));
    // A connection accepted by a separate server, handed to the host's server below at a moment no
    // real accept can be timed to: after the host has destroyed the idle sockets, before their
    // asynchronous 'close' events have run.
    const spareServer = createServer();
    onTestFinished(() => {
      spareServer.close();
    });
    const spareEndpoint = newEndpoint(runtimeDir, 'spare');
    await new Promise<void>((resolve) => spareServer.listen(spareEndpoint, resolve));
    const accepted = new Promise<Socket>((resolve) => spareServer.once('connection', resolve));
    try {
      const idle = await Promise.all(Array.from({ length: 8 }, () => connectRaw(endpointIn(runtimeDir))));
      await waitFor(() => expect(hostSockets).toHaveLength(8));
      const spare = await connectRaw(spareEndpoint);
      const spareOnHost = await accepted;

      closeIdle(hostSockets.slice());
      expect(hostSockets.every((socket) => socket.destroyed)).toBe(true);
      hostServer.emit('connection', spareOnHost);

      await Promise.all(idle.map((client) => client.closed));
      spare.send({ type: 'hello', nonce: randomHex() });
      await sleep(50);
      expect(spare.isClosed()).toBe(false);
      expect(await spare.nextLine()).toMatchObject({ type: 'hello' });
    } finally {
      await host.stop();
    }
  });
});
