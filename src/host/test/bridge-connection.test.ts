import type { Socket } from 'node:net';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { BridgeConnection } from '../mcp-server';
import { RUNTIME_DIR_VAR, startFakeHost, tempDir, textResult, waitFor, type FakeHost } from './helpers';

const NOT_CONNECTED =
  'Firefox is not running or the Claude Firefox extension is not connected. Open Firefox with the extension enabled and try again.';
const NOT_CONNECTED_RESULT = { content: [{ type: 'text', text: NOT_CONNECTED }], isError: true };
const ANSWER = { content: [{ type: 'text', text: 'answer' }] };

// Records every client socket the MCP side opens, so a test can destroy one at a precise moment.
// A socket is destroyed synchronously, but its 'close' event only follows on a later turn of the
// event loop; calls made in between see a destroyed socket that no close listener has cleared yet.
const net = vi.hoisted(() => ({
  sockets: [] as Socket[],
  onCreate: undefined as ((socket: Socket) => void) | undefined,
}));

vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>();
  return {
    ...actual,
    createConnection: ((...args: Parameters<typeof actual.createConnection>) => {
      const socket = actual.createConnection(...args);
      net.sockets.push(socket);
      net.onCreate?.(socket);
      return socket;
    }) as typeof actual.createConnection,
  };
});

async function connectedBridge(): Promise<{ bridge: BridgeConnection; host: FakeHost }> {
  net.sockets = [];
  net.onCreate = undefined;
  const runtimeDir = await tempDir();
  vi.stubEnv(RUNTIME_DIR_VAR, runtimeDir);
  const host = await startFakeHost(runtimeDir);
  host.respondWith((request) => textResult(request['id'], 'answer'));
  const bridge = new BridgeConnection();
  onTestFinished(() => bridge.close());
  return { bridge, host };
}

// Holds back the socket's 'close' event until the returned function is called, so it can be
// delivered after the bridge has already reconnected.
function holdCloseEvent(socket: Socket): () => void {
  const emit = socket.emit.bind(socket);
  let held: unknown[] | undefined;
  socket.emit = ((event: string | symbol, ...args: unknown[]) => {
    if (event !== 'close') return emit(event, ...args);
    held = args;
    return true;
  }) as typeof socket.emit;
  return () => {
    socket.emit = emit as typeof socket.emit;
    if (held) emit('close', ...held);
  };
}

// The close event of the dead socket arrives after the bridge has reconnected; it must neither drop
// the new connection nor fail a call that is pending on it.
async function expectNewConnectionSurvives(bridge: BridgeConnection, host: FakeHost, releaseClose: () => void): Promise<void> {
  host.respondWith(() => undefined);
  const before = host.requests.length;
  const pendingCall = bridge.call('tabs_context', {});
  const request = await waitFor(() => {
    const found = host.requests[before];
    if (!found) throw new Error('the pending request has not reached the host');
    return found;
  });
  releaseClose();
  host.answer(textResult(request['id'], 'answer'));
  expect(await pendingCall).toEqual(ANSWER);
  host.respondWith((next) => textResult(next['id'], 'answer'));
  expect(await bridge.call('tabs_context', {})).toEqual(ANSWER);
  expect(net.sockets).toHaveLength(2);
}

describe('BridgeConnection', () => {
  it('reconnects instead of staying stuck when the socket is destroyed between ready and being cached', async () => {
    const { bridge, host } = await connectedBridge();
    let releaseClose: () => void = () => {};
    // Registered before the bridge's own reader, so the socket is already destroyed when the
    // handshake sees ready in the same chunk and resolves.
    net.onCreate = (socket) => {
      net.onCreate = undefined;
      releaseClose = holdCloseEvent(socket);
      socket.on('data', (chunk: Buffer) => {
        if (chunk.toString('utf8').includes('"type":"ready"')) socket.destroy();
      });
    };
    expect([NOT_CONNECTED_RESULT, ANSWER]).toContainEqual(await bridge.call('tabs_context', {}));
    expect(await bridge.call('tabs_context', {})).toEqual(ANSWER);
    expect(net.sockets).toHaveLength(2);
    await expectNewConnectionSurvives(bridge, host, releaseClose);
  });

  it('reconnects when the cached socket was destroyed before its close event arrived', async () => {
    const { bridge, host } = await connectedBridge();
    expect(await bridge.call('tabs_context', {})).toEqual(ANSWER);
    expect(net.sockets).toHaveLength(1);
    const dead = net.sockets[0] as Socket;
    const releaseClose = holdCloseEvent(dead);
    dead.destroy();
    expect([NOT_CONNECTED_RESULT, ANSWER]).toContainEqual(await bridge.call('tabs_context', {}));
    expect(await bridge.call('tabs_context', {})).toEqual(ANSWER);
    expect(net.sockets).toHaveLength(2);
    await expectNewConnectionSurvives(bridge, host, releaseClose);
  });
});
