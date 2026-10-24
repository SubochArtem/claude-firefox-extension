import { existsSync } from 'node:fs';
import { Server } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectClient, encodeNativeMessage, nativeLength, socketPathIn, tempDir, textResult, waitFor } from './helpers';

const HOST_TIMEOUT_MS = 35_000;
const SIGNALS = ['exit', 'SIGINT', 'SIGTERM'] as const;

// The 35 s timeout cannot be waited for in a child process, so this file runs the host inside the
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
  vi.stubEnv('XDG_RUNTIME_DIR', runtimeDir);

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

describe.runIf(process.platform === 'linux' || process.platform === 'darwin')('native host request timeout', () => {
  it('answers with an error after 35 s without a response and ignores the late answer', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const runtimeDir = await tempDir();
    const host = await startInProcessHost(runtimeDir);
    try {
      const client = await connectClient(socketPathIn(runtimeDir));
      client.send({ type: 'tool_request', id: 'slow', tool: 'tabs_context', args: {} });
      const request = await waitFor(() => {
        const frame = host.frames.find((message) => message['type'] === 'tool_request');
        if (!frame) throw new Error('request not forwarded yet');
        return frame;
      });

      vi.advanceTimersByTime(HOST_TIMEOUT_MS - 1);
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(1);
      expect(await client.nextLine()).toEqual({
        type: 'tool_response',
        id: 'slow',
        error: { content: [{ type: 'text', text: 'The Firefox extension did not answer tabs_context in time' }] },
      });
      expect(vi.getTimerCount()).toBe(0);

      host.stdin.write(encodeNativeMessage(textResult(request['id'], 'too late')));
      await waitFor(() =>
        expect(console.error).toHaveBeenCalledWith(`[native-host] response for unknown request ${String(request['id'])}`),
      );
      expect(client.lines).toHaveLength(1);
    } finally {
      await host.stop();
    }
    expect(existsSync(socketPathIn(runtimeDir))).toBe(false);
  });

  it('clears the timeout when the extension answers in time', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const runtimeDir = await tempDir();
    const host = await startInProcessHost(runtimeDir);
    try {
      const client = await connectClient(socketPathIn(runtimeDir));
      client.send({ type: 'tool_request', id: 'fast', tool: 'tabs_context', args: {} });
      const request = await waitFor(() => {
        const frame = host.frames.find((message) => message['type'] === 'tool_request');
        if (!frame) throw new Error('request not forwarded yet');
        return frame;
      });
      expect(vi.getTimerCount()).toBe(1);
      host.stdin.write(encodeNativeMessage(textResult(request['id'], 'in time')));
      expect(await client.nextLine()).toEqual(textResult('fast', 'in time'));
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(HOST_TIMEOUT_MS);
      expect(client.lines).toHaveLength(1);
    } finally {
      await host.stop();
    }
  });
});

describe.runIf(process.platform === 'linux' || process.platform === 'darwin')('native host startup', () => {
  it('closes the server when stdin fails between the bind and recording the socket identity', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Faked so the 1 s grace timer cannot be what ends the host.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const listen = Server.prototype.listen;
    // The stream error is queued with process.nextTick right after the 'listening' event, so
    // shutdown runs before the await in runNativeHost resumes.
    vi.spyOn(Server.prototype, 'listen').mockImplementation(function (this: Server, ...args: unknown[]) {
      const server = (listen as (...listenArgs: unknown[]) => Server).apply(this, args);
      process.stdin.destroy(new Error('boom'));
      return server;
    } as typeof Server.prototype.listen);
    const runtimeDir = await tempDir();
    const host = await startInProcessHost(runtimeDir);
    try {
      await waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));
      expect(existsSync(socketPathIn(runtimeDir))).toBe(false);
      expect(console.error).toHaveBeenCalledWith('[native-host] shutting down: stdin error: boom');
      expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining('listening on'));
    } finally {
      await host.stop();
    }
  });
});
