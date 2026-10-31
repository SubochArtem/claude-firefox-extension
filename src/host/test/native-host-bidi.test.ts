import { describe, expect, it } from 'vitest';
import { BIDI_PORT_ENV } from '../bidi-client';
import { closedPort, HANG, startFakeBidi } from './fake-bidi';
import { childEnv, connectClient, hostEnv, startHost, tempDir, textResult, waitFor, type FakeExtension } from './helpers';

const MARKER = { name: '__claudeTabMarker_0123456789abcdef', value: 'c'.repeat(32) };
const URL_A = 'https://a.example/';
const ACTIONS = [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: 'x' }, { type: 'keyUp', value: 'x' }] }];

function inputRequest(requestId: string): Record<string, unknown> {
  return { type: 'bidi_input_request', requestId, marker: MARKER, url: URL_A, actions: ACTIONS };
}

function bidiResponses(host: FakeExtension): unknown[] {
  return host.received.filter((message) => (message as { type: string }).type === 'bidi_input_response');
}

async function hostWithPort(port: string): Promise<FakeExtension> {
  const runtimeDir = await tempDir();
  return startHost(runtimeDir, { env: childEnv({ [BIDI_PORT_ENV]: port }, hostEnv(runtimeDir)) });
}

describe('native host bidi input requests', () => {
  it('runs the actions in the marked context and answers the extension', async () => {
    const fake = await startFakeBidi();
    fake.contexts.push({ context: 'ctx-a', url: URL_A, marker: MARKER.value });
    const host = await hostWithPort(String(fake.port));
    host.send(inputRequest('b1'));
    await waitFor(() => expect(bidiResponses(host)).toEqual([{ type: 'bidi_input_response', requestId: 'b1', ok: true }]));
    expect(fake.commands.find((command) => command.method === 'input.performActions')?.params).toEqual({
      context: 'ctx-a',
      actions: ACTIONS,
    });
    expect(fake.methods().at(-1)).toBe('session.end');
  });

  it('serializes concurrent requests into one session at a time', async () => {
    const fake = await startFakeBidi();
    fake.contexts.push({ context: 'ctx-a', url: URL_A, marker: MARKER.value });
    const host = await hostWithPort(String(fake.port));
    host.send(inputRequest('b1'));
    host.send(inputRequest('b2'));
    host.send(inputRequest('b3'));
    await waitFor(() => expect(bidiResponses(host)).toHaveLength(3));
    expect(bidiResponses(host)).toEqual(
      ['b1', 'b2', 'b3'].map((requestId) => ({ type: 'bidi_input_response', requestId, ok: true })),
    );
    const sessions = fake.commands.filter((command) => command.method === 'session.new' || command.method === 'session.end');
    expect(sessions.map((command) => [command.method, command.connection])).toEqual([
      ['session.new', 1],
      ['session.end', 1],
      ['session.new', 2],
      ['session.end', 2],
      ['session.new', 3],
      ['session.end', 3],
    ]);
  });

  it('answers with the start hint when Firefox is not listening', async () => {
    const port = await closedPort();
    const host = await hostWithPort(String(port));
    host.send(inputRequest('b1'));
    await waitFor(() => expect(bidiResponses(host)).toHaveLength(1));
    expect(bidiResponses(host)[0]).toEqual({
      type: 'bidi_input_response',
      requestId: 'b1',
      ok: false,
      error: expect.stringContaining(`--remote-debugging-port=${port}`),
    });
  });

  it('answers with a clear error for an invalid port variable', async () => {
    const host = await hostWithPort('not-a-port');
    host.send(inputRequest('b1'));
    await waitFor(() => expect(bidiResponses(host)).toHaveLength(1));
    expect(bidiResponses(host)[0]).toEqual({
      type: 'bidi_input_response',
      requestId: 'b1',
      ok: false,
      error: expect.stringContaining(`${BIDI_PORT_ENV} must be a port number from 1 to 65535, received "not-a-port"`),
    });
  });

  it('answers a malformed request that names its id and drops one that does not', async () => {
    const fake = await startFakeBidi();
    const host = await hostWithPort(String(fake.port));
    host.send({ ...inputRequest('bad'), actions: 'click' });
    host.send({ ...inputRequest('x'), requestId: 5 });
    host.send({ type: 'ping' });
    await waitFor(() => expect(host.received).toContainEqual({ type: 'pong' }));
    await waitFor(() =>
      expect(bidiResponses(host)).toEqual([
        { type: 'bidi_input_response', requestId: 'bad', ok: false, error: 'The extension sent an invalid input request' },
      ]),
    );
    expect(fake.commands).toEqual([]);
  });

  it('does not route bidi responses or requests to MCP clients', async () => {
    const fake = await startFakeBidi();
    fake.contexts.push({ context: 'ctx-a', url: URL_A, marker: MARKER.value });
    const host = await hostWithPort(String(fake.port));
    host.respondWith((request) => textResult(request['id'], 'ok'));
    const client = await connectClient(host);
    host.send(inputRequest('b1'));
    client.send({ type: 'tool_request', id: '1', tool: 't', args: {} });
    expect(await client.nextLine()).toEqual(textResult('1', 'ok'));
    await waitFor(() => expect(bidiResponses(host)).toHaveLength(1));
    expect(client.lines).toHaveLength(1);
  });
  it('refuses requests beyond the queue limit at once', async () => {
    const fake = await startFakeBidi();
    fake.contexts.push({ context: 'ctx-a', url: URL_A, marker: MARKER.value });
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.reply('input.performActions', async (_params, connection) => {
      if (connection === 1) await held;
      return { result: {} };
    });
    const host = await hostWithPort(String(fake.port));
    const ids = Array.from({ length: 10 }, (_, i) => `b${i + 1}`);
    for (const id of ids) host.send(inputRequest(id));
    await waitFor(() => expect(bidiResponses(host)).toHaveLength(2));
    expect(bidiResponses(host)).toEqual(
      ['b9', 'b10'].map((requestId) => ({
        type: 'bidi_input_response',
        requestId,
        ok: false,
        error: expect.stringMatching(/^Too many input requests are waiting for WebDriver BiDi/),
      })),
    );
    release?.();
    await waitFor(() => expect(bidiResponses(host)).toHaveLength(10), 30_000);
    expect(bidiResponses(host).slice(2)).toEqual(
      ids.slice(0, 8).map((requestId) => ({ type: 'bidi_input_response', requestId, ok: true })),
    );
  }, 40_000);

  it('ends the BiDi session before exiting when the extension disconnects during performActions', async () => {
    const fake = await startFakeBidi();
    fake.contexts.push({ context: 'ctx-a', url: URL_A, marker: MARKER.value });
    fake.reply('input.performActions', () => HANG);
    const host = await hostWithPort(String(fake.port));
    host.send(inputRequest('b1'));
    host.send(inputRequest('b2'));
    await waitFor(() => expect(fake.methods()).toContain('input.performActions'));
    const started = Date.now();
    host.child.stdin.end();
    expect(await host.exited).toBe(0);
    expect(Date.now() - started).toBeLessThan(3_500);
    expect(fake.methods().slice(-3)).toEqual(['input.performActions', 'input.releaseActions', 'session.end']);
    expect(fake.commands.filter((command) => command.method === 'session.new')).toHaveLength(1);
  });
});
