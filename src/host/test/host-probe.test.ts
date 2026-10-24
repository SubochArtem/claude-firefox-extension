import { writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { BridgeInfo } from '../bridge-info';
import { HOST_PROBE_TIMEOUT_MS, isAuthenticatedHostAlive } from '../host-probe';
import {
  bridgeInfoPathIn,
  connectClient,
  randomHex,
  readBridgeJson,
  socketPathIn,
  startFakeHost,
  startHost,
  tempDir,
  textResult,
  waitFor,
  type FakeHostMode,
} from './helpers';

function infoFor(endpoint: string, secret = randomHex()): BridgeInfo {
  return { version: 1, endpoint, secret, pid: 999_999 };
}

interface RawListener {
  endpoint: string;
  lines: string[];
  closedConnections: () => number;
}

// A listener that knows nothing about the handshake and plays `onConnection` on every client. Every
// line the probe sends lands in `lines`.
async function rawListener(onConnection: (socket: Socket) => void): Promise<RawListener> {
  const endpoint = join(await tempDir(), 'raw.sock');
  const sockets: Socket[] = [];
  const lines: string[] = [];
  let closedConnections = 0;
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => {});
    socket.on('close', () => closedConnections++);
    let partial = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      const parts = (partial + chunk).split('\n');
      partial = parts.pop() ?? '';
      lines.push(...parts.filter((line) => line.trim() !== ''));
    });
    onConnection(socket);
  });
  await new Promise<void>((resolve) => server.listen(endpoint, resolve));
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return { endpoint, lines, closedConnections: () => closedConnections };
}

// The probe resolves once it has given up on the connection; what it sent is only complete once the
// listener has seen that connection close.
async function waitForClose(closedConnections: () => number): Promise<void> {
  await waitFor(() => expect(closedConnections()).toBe(1));
}

function types(lines: Record<string, unknown>[]): unknown[] {
  return lines.map((message) => message['type']);
}

async function probeTimed(info: BridgeInfo): Promise<{ alive: boolean; elapsed: number }> {
  const start = performance.now();
  const alive = await isAuthenticatedHostAlive(info);
  return { alive, elapsed: performance.now() - start };
}

describe.skipIf(process.platform === 'win32')('isAuthenticatedHostAlive', () => {
  it('gives up after at most one second', () => {
    expect(HOST_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(HOST_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(1_000);
  });

  it('is true for a running native host probed with its own bridge.json, which stays usable', async () => {
    const host = await startHost(await tempDir());
    const info = readBridgeJson(host.bridgeInfoPath) as BridgeInfo;
    expect(await isAuthenticatedHostAlive(info)).toBe(true);
    expect(host.child.exitCode).toBeNull();

    host.respondWith((request) => textResult(request['id'], 'after probe'));
    const client = await connectClient(info.endpoint, info.secret);
    client.send({ type: 'tool_request', id: '1', tool: 't', args: {} });
    expect(await client.nextLine()).toEqual(textResult('1', 'after probe'));
  });

  it('runs the full client handshake and sends nothing after ready', async () => {
    const runtimeDir = await tempDir();
    const host = await startFakeHost(runtimeDir);
    const info = readBridgeJson(bridgeInfoPathIn(runtimeDir)) as BridgeInfo;
    expect(await isAuthenticatedHostAlive(info)).toBe(true);
    await waitForClose(host.closedConnections);
    expect(types(host.received)).toEqual(['hello', 'auth']);
    expect(host.requests).toEqual([]);
  });

  it('is false and sends no auth when the listener proves a different secret', async () => {
    const runtimeDir = await tempDir();
    const host = await startFakeHost(runtimeDir);
    expect(await isAuthenticatedHostAlive(infoFor(socketPathIn(runtimeDir)))).toBe(false);
    await waitForClose(host.closedConnections);
    expect(types(host.received)).toEqual(['hello']);
  });

  it.each<[string, FakeHostMode]>([
    ['proves a different secret', 'wrong-secret'],
    ['replays a host proof made for another client nonce', 'replay-proof'],
    ['sends a short proof', 'short-proof'],
    ['sends a non-hex proof', 'non-hex-proof'],
    ['sends ready without proving the secret', 'ready-without-hello'],
    ['closes the connection after hello', 'close-after-hello'],
  ])('is false and sends no auth when the listener %s', async (_label, mode) => {
    const runtimeDir = await tempDir();
    const host = await startFakeHost(runtimeDir, mode);
    const endpoint = socketPathIn(runtimeDir);
    expect(await isAuthenticatedHostAlive(infoFor(endpoint, host.secret))).toBe(false);
    await waitForClose(host.closedConnections);
    expect(types(host.received)).toEqual(['hello']);
  });

  // The host proof is genuine here, so sending the auth is correct; only the missing ready fails it.
  it('is false when the listener sends a tool response instead of ready', async () => {
    const runtimeDir = await tempDir();
    const host = await startFakeHost(runtimeDir, 'response-instead-of-ready');
    const endpoint = socketPathIn(runtimeDir);
    expect(await isAuthenticatedHostAlive(infoFor(endpoint, host.secret))).toBe(false);
    await waitForClose(host.closedConnections);
    expect(types(host.received)).toEqual(['hello', 'auth']);
    expect(host.requests).toEqual([]);
  });

  it('is false when nothing exists at the endpoint', async () => {
    expect(await isAuthenticatedHostAlive(infoFor(join(await tempDir(), 'missing.sock')))).toBe(false);
  });

  it('is false for a stale socket left by a killed host', async () => {
    const host = await startHost(await tempDir());
    const info = readBridgeJson(host.bridgeInfoPath) as BridgeInfo;
    host.child.kill('SIGKILL');
    await host.exited;
    expect(await isAuthenticatedHostAlive(info)).toBe(false);
  });

  it('is false when the endpoint is a regular file', async () => {
    const endpoint = join(await tempDir(), 'file.sock');
    writeFileSync(endpoint, '');
    expect(await isAuthenticatedHostAlive(infoFor(endpoint))).toBe(false);
  });

  it.each<[string, FakeHostMode]>([
    ['never answers hello', 'silent'],
    ['accepts the auth but never sends ready', 'no-ready'],
  ])('is false within the timeout when the listener %s', async (_label, mode) => {
    const runtimeDir = await tempDir();
    const host = await startFakeHost(runtimeDir, mode);
    const endpoint = socketPathIn(runtimeDir);
    const { alive, elapsed } = await probeTimed(infoFor(endpoint, host.secret));
    expect(alive).toBe(false);
    expect(elapsed).toBeLessThan(HOST_PROBE_TIMEOUT_MS + 500);
  });

  it.each([
    ['a line that is not JSON', 'not json at all\n'],
    ['a hello without a nonce or proof', '{"type":"hello"}\n'],
    ['a JSON array', '[1,2,3]\n'],
    ['binary noise', '\u0000ÿ\u0001\n'],
  ])('is false and sends no auth when the listener answers with %s', async (_label, garbage) => {
    const listener = await rawListener((socket) => socket.write(garbage));
    const { alive, elapsed } = await probeTimed(infoFor(listener.endpoint));
    expect(alive).toBe(false);
    expect(elapsed).toBeLessThan(HOST_PROBE_TIMEOUT_MS + 500);
    await waitForClose(listener.closedConnections);
    expect(types(listener.lines.map((line) => JSON.parse(line) as Record<string, unknown>))).not.toContain('auth');
  });

  it('is false within the timeout when the listener streams data without a newline', async () => {
    const listener = await rawListener((socket) => {
      const timer = setInterval(() => socket.write('x'.repeat(1024)), 5);
      socket.on('close', () => clearInterval(timer));
    });
    const { alive, elapsed } = await probeTimed(infoFor(listener.endpoint));
    expect(alive).toBe(false);
    expect(elapsed).toBeLessThan(HOST_PROBE_TIMEOUT_MS + 500);
    await waitForClose(listener.closedConnections);
    expect(types(listener.lines.map((line) => JSON.parse(line) as Record<string, unknown>))).not.toContain('auth');
  });
});
