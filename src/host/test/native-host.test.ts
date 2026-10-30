import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  APP_DIR,
  childEnv,
  connectClient,
  endpointExists,
  connectRaw,
  nativeHeader,
  proof,
  randomHex,
  readBridgeJson,
  sleep,
  startHost,
  tempDir,
  textResult,
  waitFor,
  within,
  type BridgeClient,
  type FakeExtension,
} from './helpers';

const HEX64 = /^[0-9a-f]{64}$/;

// Sends the client hello and returns the host hello, checking nothing.
async function hello(client: BridgeClient): Promise<{ clientNonce: string; serverNonce: string; hostProof: unknown }> {
  const clientNonce = randomHex();
  client.send({ type: 'hello', nonce: clientNonce });
  const line = await client.nextLine();
  return { clientNonce, serverNonce: String(line['nonce']), hostProof: line['proof'] };
}

// 'exit' can fire before the last stdout bytes have been read from the pipe.
async function stdoutEnded(host: FakeExtension): Promise<void> {
  await waitFor(() => {
    if (!host.child.stdout.readableEnded) throw new Error('the native host stdout is still open');
  });
}

describe('native host process', () => {
  it('uses a new secret at every start', async () => {
    const runtimeDir = await tempDir();
    const first = await startHost(runtimeDir);
    const firstSecret = readBridgeJson(first.bridgeInfoPath).secret;
    first.child.stdin.end();
    expect(await first.exited).toBe(0);
    const second = await startHost(runtimeDir);
    expect(readBridgeJson(second.bridgeInfoPath).secret).not.toBe(firstSecret);
  });

  it('answers ping with pong', async () => {
    const host = await startHost(await tempDir());
    host.send({ type: 'ping' });
    await waitFor(() => expect(host.received).toEqual([{ type: 'pong' }]));
  });

  it('forwards requests with per-client ids and routes responses back to the right client', async () => {
    const host = await startHost(await tempDir());
    const [a, b] = await Promise.all([connectClient(host), connectClient(host)]);
    a.send({ type: 'tool_request', id: '1', tool: 'tabs_context', args: { from: 'a' } });
    const first = await host.nextRequest();
    b.send({ type: 'tool_request', id: '1', tool: 'tabs_context', args: { from: 'b' } });
    const second = await host.nextRequest();

    expect(first).toMatchObject({ type: 'tool_request', tool: 'tabs_context', args: { from: 'a' } });
    expect(second).toMatchObject({ type: 'tool_request', tool: 'tabs_context', args: { from: 'b' } });
    expect(first['id']).toMatch(/^\d+:1$/);
    expect(second['id']).toMatch(/^\d+:1$/);
    expect(first['id']).not.toBe(second['id']);

    // Answer in reverse order to prove responses are matched by id, not by arrival.
    host.send(textResult(second['id'], 'for b'));
    host.send({ type: 'tool_response', id: first['id'], error: { content: [{ type: 'text', text: 'for a' }] } });
    expect(await b.nextLine()).toEqual(textResult('1', 'for b'));
    expect(await a.nextLine()).toEqual({
      type: 'tool_response',
      id: '1',
      error: { content: [{ type: 'text', text: 'for a' }] },
    });
  });

  it('serves several requests from one client concurrently', async () => {
    const host = await startHost(await tempDir());
    host.respondWith((request) => textResult(request['id'], `answer ${String(request['id'])}`));
    const client = await connectClient(host);
    for (const id of ['x', 'y', 'z']) client.send({ type: 'tool_request', id, tool: 't', args: {} });
    const lines = await Promise.all([client.nextLine(), client.nextLine(), client.nextLine()]);
    expect(lines.map((line) => line['id'])).toEqual(['x', 'y', 'z']);
    for (const line of lines) {
      expect(line).toEqual(textResult(line['id'], expect.stringMatching(new RegExp(`^answer \\d+:${String(line['id'])}$`))));
    }
  });

  it('rejects a duplicate request id while the first is pending', async () => {
    const host = await startHost(await tempDir());
    const client = await connectClient(host);
    client.send({ type: 'tool_request', id: 'dup', tool: 't', args: {} });
    const forwarded = await host.nextRequest();
    client.send({ type: 'tool_request', id: 'dup', tool: 't', args: {} });
    expect(await client.nextLine()).toEqual({
      type: 'tool_response',
      id: 'dup',
      error: { content: [{ type: 'text', text: 'Duplicate request id dup' }] },
    });
    host.send(textResult(forwarded['id'], 'done'));
    expect(await client.nextLine()).toEqual(textResult('dup', 'done'));
    expect(host.received.filter((message) => (message as { type: string }).type === 'tool_request')).toHaveLength(1);
  });

  it('ignores garbage from clients and keeps their connection usable', async () => {
    const host = await startHost(await tempDir());
    host.respondWith((request) => textResult(request['id'], 'ok'));
    const client = await connectClient(host);
    client.socket.write('{not json\n');
    client.send({ type: 'something_else' });
    client.send({ type: 'tool_request', id: 5, tool: 't', args: {} });
    client.send({ type: 'tool_request', id: 'good', tool: 't', args: {} });
    expect(await client.nextLine()).toEqual(textResult('good', 'ok'));
    expect(client.lines).toHaveLength(1);
    expect(host.stderr()).toMatch(/dropped invalid JSON line/);
    expect(host.stderr().match(/client \d+ sent an invalid message/g)).toHaveLength(2);
  });

  it('ignores garbage and unknown responses from the extension and keeps running', async () => {
    const host = await startHost(await tempDir());
    const garbage = Buffer.from('{oops', 'utf8');
    host.sendRaw(Buffer.concat([nativeHeader(garbage.length), garbage]));
    host.send({ type: 'pong' });
    host.send(textResult('9:9', 'nobody asked'));
    await host.waitForStderr(/response for unknown request 9:9/);
    expect(host.stderr()).toMatch(/dropped invalid native message/);
    expect(host.stderr()).toMatch(/extension sent an invalid message/);
    host.send({ type: 'ping' });
    await waitFor(() => expect(host.received).toEqual([{ type: 'pong' }]));
  });

  it('refuses to forward a request larger than the 1 MB native message limit', async () => {
    const host = await startHost(await tempDir());
    const client = await connectClient(host);
    client.send({ type: 'tool_request', id: 'big', tool: 'tabs_context', args: { blob: 'a'.repeat(1024 * 1024) } });
    expect(await client.nextLine()).toEqual({
      type: 'tool_response',
      id: 'big',
      error: { content: [{ type: 'text', text: 'Could not forward tabs_context to the Firefox extension' }] },
    });
    expect(host.received).toEqual([]);
  });

  it('drops pending requests of a client that disconnects', async () => {
    const host = await startHost(await tempDir());
    const gone = await connectClient(host);
    gone.send({ type: 'tool_request', id: '1', tool: 't', args: {} });
    const request = await host.nextRequest();
    gone.socket.destroy();
    await gone.closed;

    // A full round trip on a newer connection makes sure the host has handled the older close.
    const other = await connectClient(host);
    host.respondWith((next) => textResult(next['id'], 'still serving'));
    other.send({ type: 'tool_request', id: '1', tool: 't', args: {} });
    expect(await other.nextLine()).toEqual(textResult('1', 'still serving'));

    host.send(textResult(request['id'], 'late'));
    await host.waitForStderr(new RegExp(`response for unknown request ${String(request['id'])}`));
    expect(gone.lines).toEqual([]);
  });

  it('exits 0 and removes its endpoint when stdin closes, failing pending requests', async () => {
    const host = await startHost(await tempDir());
    const { endpoint } = host;
    const client = await connectClient(host);
    client.send({ type: 'tool_request', id: 'p', tool: 't', args: {} });
    await host.nextRequest();
    host.child.stdin.end();
    expect(await client.nextLine()).toEqual({
      type: 'tool_response',
      id: 'p',
      error: { content: [{ type: 'text', text: 'The Firefox extension disconnected' }] },
    });
    await client.closed;
    expect(await host.exited).toBe(0);
    expect(await endpointExists(endpoint)).toBe(false);
    expect(existsSync(host.bridgeInfoPath)).toBe(false);
    expect(host.stderr()).toMatch(/shutting down: stdin closed/);
  });

  it('shuts down when the extension declares a frame larger than 64 MB', async () => {
    const host = await startHost(await tempDir());
    const { endpoint } = host;
    host.sendRaw(nativeHeader(64 * 1024 * 1024 + 1));
    expect(await host.exited).toBe(0);
    expect(await endpointExists(endpoint)).toBe(false);
    expect(existsSync(host.bridgeInfoPath)).toBe(false);
    expect(host.stderr()).toMatch(/shutting down: stdin error: native message too large/);
  });

  it('answers a ping sent at spawn exactly once, after it has written bridge.json', async () => {
    const host = await startHost(await tempDir(), { waitUntilListening: false });
    const bridgeInfoAtFirstByte: boolean[] = [];
    host.child.stdout.once('data', () => bridgeInfoAtFirstByte.push(existsSync(host.bridgeInfoPath)));
    host.send({ type: 'ping' });
    await waitFor(() => expect(host.received).toEqual([{ type: 'pong' }]));
    expect(bridgeInfoAtFirstByte).toEqual([true]);
    await host.waitForStderr(/listening on/);
    await sleep(100);
    expect(host.received).toEqual([{ type: 'pong' }]);
  });

  it('handles every message sent at spawn in order once it has written bridge.json', async () => {
    const host = await startHost(await tempDir(), { waitUntilListening: false });
    const bridgeInfoAtData: boolean[] = [];
    host.child.stdout.on('data', () => bridgeInfoAtData.push(existsSync(host.bridgeInfoPath)));
    host.send({ type: 'ping' });
    host.send(textResult('9:9', 'nobody asked'));
    host.send({ type: 'ping' });
    await waitFor(() => expect(host.received).toEqual([{ type: 'pong' }, { type: 'pong' }]));
    expect(bridgeInfoAtData.length).toBeGreaterThan(0);
    expect(bridgeInfoAtData.every(Boolean)).toBe(true);
    await host.waitForStderr(/listening on/);
    await sleep(100);
    expect(host.received).toEqual([{ type: 'pong' }, { type: 'pong' }]);
    expect(host.child.exitCode).toBeNull();
    expect(host.stderr()).toMatch(/response for unknown request 9:9/);
  });

  it('writes nothing to stdout when stdin closes right after a ping sent at spawn', async () => {
    const host = await startHost(await tempDir(), { waitUntilListening: false });
    host.send({ type: 'ping' });
    host.child.stdin.end();
    expect(await host.exited).toBe(0);
    await stdoutEnded(host);
    expect(host.stdoutBytes()).toBe(0);
    expect(existsSync(host.bridgeInfoPath)).toBe(false);
  });

  it('removes its own leftover bridge.json temp files on exit and keeps those of other processes', async () => {
    const runtimeDir = await tempDir();
    const host = await startHost(runtimeDir);
    const own = join(runtimeDir, APP_DIR, `bridge.json.${host.child.pid}.${randomHex(8)}.tmp`);
    const other = join(runtimeDir, APP_DIR, `bridge.json.${process.pid}.${randomHex(8)}.tmp`);
    writeFileSync(own, '{}');
    writeFileSync(other, '{}');
    host.child.stdin.end();
    expect(await host.exited).toBe(0);
    expect(existsSync(own)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });
});

// Socket files, their permissions and the directory checks only exist on Linux and macOS; Windows
// cannot deliver SIGTERM to a handler (kill() terminates the process), and its second-host check has
// its own tests below.
describe.skipIf(process.platform === 'win32')('native host process on Unix sockets', () => {
  it('creates a private socket directory and a 0600 socket', async () => {
    const runtimeDir = await tempDir();
    const host = await startHost(runtimeDir);
    expect(lstatSync(join(runtimeDir, APP_DIR)).mode & 0o777).toBe(0o700);
    const socket = lstatSync(host.socketPath);
    expect(socket.isSocket()).toBe(true);
    expect(socket.mode & 0o777).toBe(0o600);
  });

  it('writes a 0600 bridge.json with its endpoint, pid and a fresh secret before reporting listening', async () => {
    const runtimeDir = await tempDir();
    const host = await startHost(runtimeDir);
    expect(lstatSync(host.bridgeInfoPath).mode & 0o777).toBe(0o600);
    expect(readBridgeJson(host.bridgeInfoPath)).toEqual({
      version: 1,
      endpoint: host.socketPath,
      secret: expect.stringMatching(HEX64),
      pid: host.child.pid,
    });
  });

  it('exits 0 and removes its socket and bridge.json on SIGTERM', async () => {
    const host = await startHost(await tempDir());
    host.child.kill('SIGTERM');
    expect(await host.exited).toBe(0);
    expect(existsSync(host.socketPath)).toBe(false);
    expect(existsSync(host.bridgeInfoPath)).toBe(false);
  });

  it('exits 0 and removes its socket on SIGTERM sent the moment it reports listening', async () => {
    const host = await startHost(await tempDir(), { waitUntilListening: false });
    let signalled = false;
    host.child.stderr.on('data', () => {
      if (signalled || !/listening on/.test(host.stderr())) return;
      signalled = true;
      host.child.kill('SIGTERM');
    });
    expect(await host.exited).toBe(0);
    expect(host.child.signalCode).toBeNull();
    expect(host.stderr()).toMatch(/shutting down: SIGTERM/);
    expect(existsSync(host.socketPath)).toBe(false);
    expect(existsSync(host.bridgeInfoPath)).toBe(false);
  });

  it('exits 1 when another host is already listening and leaves its socket alone', async () => {
    const runtimeDir = await tempDir();
    const first = await startHost(runtimeDir);
    const before = lstatSync(first.socketPath).ino;
    const info = readBridgeJson(first.bridgeInfoPath);
    const second = await startHost(runtimeDir, { waitUntilListening: false });
    expect(await second.exited).toBe(1);
    expect(second.stderr()).toMatch(/another native host is already listening/);
    expect(lstatSync(first.socketPath).ino).toBe(before);
    expect(readBridgeJson(first.bridgeInfoPath)).toEqual(info);

    first.respondWith((request) => textResult(request['id'], 'first'));
    const client = await connectClient(first);
    client.send({ type: 'tool_request', id: '1', tool: 't', args: {} });
    expect(await client.nextLine()).toEqual(textResult('1', 'first'));
  });

  // A pong from a host that is about to exit makes the extension believe it connected, so the second
  // host must decide to step aside before it handles anything the extension sent.
  it('writes nothing to stdout when it exits because another host is listening, even for a ping sent at spawn', async () => {
    const runtimeDir = await tempDir();
    const first = await startHost(runtimeDir);
    const info = readBridgeJson(first.bridgeInfoPath);
    const second = await startHost(runtimeDir, { waitUntilListening: false });
    second.send({ type: 'ping' });
    expect(await second.exited).toBe(1);
    await stdoutEnded(second);
    expect(second.stdoutBytes()).toBe(0);
    expect(readBridgeJson(first.bridgeInfoPath)).toEqual(info);

    first.send({ type: 'ping' });
    await waitFor(() => expect(first.received).toEqual([{ type: 'pong' }]));
    first.respondWith((request) => textResult(request['id'], 'first'));
    const client = await connectClient(first);
    client.send({ type: 'tool_request', id: '1', tool: 't', args: {} });
    expect(await client.nextLine()).toEqual(textResult('1', 'first'));
  });

  it('takes over a stale socket left by a killed host', async () => {
    const runtimeDir = await tempDir();
    const crashed = await startHost(runtimeDir);
    crashed.child.kill('SIGKILL');
    await crashed.exited;
    expect(existsSync(crashed.socketPath)).toBe(true);
    expect(readBridgeJson(crashed.bridgeInfoPath).pid).toBe(crashed.child.pid);

    const host = await startHost(runtimeDir);
    expect(readBridgeJson(host.bridgeInfoPath).pid).toBe(host.child.pid);
    host.respondWith((request) => textResult(request['id'], 'new host'));
    const client = await connectClient(host);
    client.send({ type: 'tool_request', id: '1', tool: 't', args: {} });
    expect(await client.nextLine()).toEqual(textResult('1', 'new host'));
  });

  it.each([
    ['stdin closes', (host: Awaited<ReturnType<typeof startHost>>) => host.child.stdin.end()],
    ['SIGTERM arrives', (host: Awaited<ReturnType<typeof startHost>>) => host.child.kill('SIGTERM')],
  ])('an old host does not remove a newer host socket when %s', async (_label, stop) => {
    const runtimeDir = await tempDir();
    const oldHost = await startHost(runtimeDir);
    // Simulates another host having replaced the socket file at the same path.
    renameSync(oldHost.socketPath, `${oldHost.socketPath}.old`);
    const newHost = await startHost(runtimeDir);
    const newInode = lstatSync(newHost.socketPath).ino;
    const newInfo = readBridgeJson(newHost.bridgeInfoPath);
    expect(newInfo.pid).toBe(newHost.child.pid);

    stop(oldHost);
    expect(await oldHost.exited).toBe(0);
    expect(lstatSync(newHost.socketPath).ino).toBe(newInode);
    expect(readBridgeJson(newHost.bridgeInfoPath)).toEqual(newInfo);

    newHost.respondWith((request) => textResult(request['id'], 'newer'));
    const client = await connectClient(newHost);
    client.send({ type: 'tool_request', id: '1', tool: 't', args: {} });
    expect(await client.nextLine()).toEqual(textResult('1', 'newer'));
  });

  it('exits 1 without listening when the socket directory is not private', async () => {
    const runtimeDir = await tempDir();
    mkdirSync(join(runtimeDir, APP_DIR));
    chmodSync(join(runtimeDir, APP_DIR), 0o755);
    const host = await startHost(runtimeDir, { waitUntilListening: false });
    expect(await host.exited).toBe(1);
    expect(host.stderr()).toMatch(/Refusing to use bridge socket directory .*: its mode is 755/);
    expect(existsSync(host.socketPath)).toBe(false);
    expect(existsSync(host.bridgeInfoPath)).toBe(false);
  });
});

describe('native host handshake', () => {
  it('proves the secret, then authenticates the client and sends ready', async () => {
    const host = await startHost(await tempDir());
    const { secret } = readBridgeJson(host.bridgeInfoPath);
    const client = await connectRaw(host.endpoint);
    const { clientNonce, serverNonce, hostProof } = await hello(client);
    expect(client.lines[0]).toEqual({ type: 'hello', nonce: expect.stringMatching(HEX64), proof: expect.stringMatching(HEX64) });
    expect(serverNonce).not.toBe(clientNonce);
    expect(hostProof).toBe(proof(secret, 'host', clientNonce, serverNonce));
    client.send({ type: 'auth', proof: proof(secret, 'client', clientNonce, serverNonce) });
    expect(await client.nextLine()).toEqual({ type: 'ready' });
    expect(JSON.stringify(client.lines)).not.toContain(secret);

    host.respondWith((request) => textResult(request['id'], 'authenticated'));
    client.send({ type: 'tool_request', id: '1', tool: 't', args: {} });
    expect(await client.nextLine()).toEqual(textResult('1', 'authenticated'));
  });

  it('uses a different server nonce on every connection', async () => {
    const host = await startHost(await tempDir());
    const a = await hello(await connectRaw(host.endpoint));
    const b = await hello(await connectRaw(host.endpoint));
    expect(a.serverNonce).toMatch(HEX64);
    expect(a.serverNonce).not.toBe(b.serverNonce);
  });

  it('closes the connection on a wrong client proof without sending ready', async () => {
    const host = await startHost(await tempDir());
    const client = await connectRaw(host.endpoint);
    const { clientNonce, serverNonce } = await hello(client);
    client.send({ type: 'auth', proof: proof(randomHex(), 'client', clientNonce, serverNonce) });
    await client.closed;
    expect(client.lines).toHaveLength(1);
    expect(host.received).toEqual([]);
  });

  it('closes the connection when the client replays the host proof as its own', async () => {
    const host = await startHost(await tempDir());
    const client = await connectRaw(host.endpoint);
    const { hostProof } = await hello(client);
    client.send({ type: 'auth', proof: hostProof });
    await client.closed;
    expect(client.lines).toHaveLength(1);
  });

  it.each([
    ['a tool request', { type: 'tool_request', id: '1', tool: 't', args: {} }],
    ['auth', { type: 'auth', proof: 'ab'.repeat(32) }],
    ['a hello with a short nonce', { type: 'hello', nonce: 'ab' }],
    ['a hello without a nonce', { type: 'hello' }],
    ['an unknown message', { type: 'something_else' }],
  ])('closes the connection without writing anything when the first message is %s', async (_label, message) => {
    const host = await startHost(await tempDir());
    const client = await connectRaw(host.endpoint);
    client.send(message);
    await client.closed;
    expect(client.lines).toEqual([]);
    expect(host.received).toEqual([]);
  });

  it('closes the connection on a tool request between hello and auth', async () => {
    const host = await startHost(await tempDir());
    const client = await connectRaw(host.endpoint);
    await hello(client);
    client.send({ type: 'tool_request', id: '1', tool: 't', args: {} });
    await client.closed;
    expect(client.lines).toHaveLength(1);
    expect(host.received).toEqual([]);
  });

  it('closes the connection on a second hello', async () => {
    const host = await startHost(await tempDir());
    const client = await connectRaw(host.endpoint);
    await hello(client);
    client.send({ type: 'hello', nonce: randomHex() });
    await client.closed;
    expect(client.lines).toHaveLength(1);
  });

  it('does not forward a tool request sent in the same write as a wrong auth', async () => {
    const host = await startHost(await tempDir());
    const client = await connectRaw(host.endpoint);
    await hello(client);
    client.socket.write(
      `${JSON.stringify({ type: 'auth', proof: 'ab'.repeat(32) })}\n${JSON.stringify({ type: 'tool_request', id: '1', tool: 't', args: {} })}\n`,
    );
    await client.closed;
    // Give a forwarded request time to show up before asserting that none did.
    await sleep(100);
    expect(host.received).toEqual([]);
  });

  it('keeps at most 8 unauthenticated connections, closes idle ones after 2 s without writing, then accepts again', async () => {
    const host = await startHost(await tempDir());
    const started = Date.now();
    const idle = await Promise.all(Array.from({ length: 8 }, () => connectRaw(host.endpoint)));
    const extra = await connectRaw(host.endpoint);
    await extra.closed;
    expect(extra.lines).toEqual([]);
    expect(idle.every((client) => !client.isClosed())).toBe(true);

    await Promise.all(idle.map((client) => client.closed));
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
    for (const client of idle) expect(client.lines).toEqual([]);

    host.respondWith((request) => textResult(request['id'], 'slots freed'));
    const client = await connectClient(host);
    client.send({ type: 'tool_request', id: '1', tool: 't', args: {} });
    expect(await client.nextLine()).toEqual(textResult('1', 'slots freed'));
  });

  // Handshake messages are tiny; the 4 KiB cap keeps unauthenticated peers from making the host buffer
  // up to the 64 MB limit that applies after ready.
  it.each([
    ['in one write', [5 * 1024]],
    ['over several writes', [1024, 1024, 1024, 1024, 1024]],
  ])('closes a connection that sends more than 4 KiB without a newline before hello %s', async (_label, writes) => {
    const host = await startHost(await tempDir());
    const client = await connectRaw(host.endpoint);
    for (const bytes of writes) {
      if (client.isClosed()) break;
      client.socket.write('a'.repeat(bytes));
      await sleep(10);
    }
    // Well before the 2 s handshake timeout, which would close the connection anyway.
    await waitFor(() => expect(client.isClosed()).toBe(true), 1_000);
    expect(client.lines).toEqual([]);
    expect(host.received).toEqual([]);

    host.respondWith((request) => textResult(request['id'], 'still accepting'));
    const other = await connectClient(host);
    other.send({ type: 'tool_request', id: '1', tool: 't', args: {} });
    expect(await other.nextLine()).toEqual(textResult('1', 'still accepting'));
  });

  it('closes a connection that sends more than 4 KiB without a newline between hello and auth', async () => {
    const host = await startHost(await tempDir());
    const client = await connectRaw(host.endpoint);
    await hello(client);
    client.socket.write('a'.repeat(5 * 1024));
    await waitFor(() => expect(client.isClosed()).toBe(true), 1_000);
    expect(client.lines).toHaveLength(1);
    expect(host.received).toEqual([]);
  });

  it('accepts a hello line of exactly 4 KiB that arrives in two writes', async () => {
    const host = await startHost(await tempDir());
    const client = await connectRaw(host.endpoint);
    const message = JSON.stringify({ type: 'hello', nonce: randomHex() });
    client.socket.write(`${' '.repeat(4 * 1024 - message.length)}${message}`);
    await sleep(50);
    expect(client.isClosed()).toBe(false);
    client.socket.write('\n');
    expect(await client.nextLine()).toMatchObject({ type: 'hello', nonce: expect.stringMatching(HEX64) });
  });

  it('does not count authenticated connections against the limit', async () => {
    const host = await startHost(await tempDir());
    // One at a time: nine handshakes in flight together would exceed the limit themselves.
    const authenticated: BridgeClient[] = [];
    for (let i = 0; i < 9; i++) authenticated.push(await connectClient(host));
    const idle = await Promise.all(Array.from({ length: 7 }, () => connectRaw(host.endpoint)));
    const last = await connectClient(host);
    host.respondWith((request) => textResult(request['id'], 'ok'));
    last.send({ type: 'tool_request', id: '1', tool: 't', args: {} });
    expect(await last.nextLine()).toEqual(textResult('1', 'ok'));
    expect([...authenticated, ...idle].every((client) => !client.isClosed())).toBe(true);
  });

  it('frees exactly one slot per closed connection whatever closed it, so at most 8 stay unauthenticated afterwards', async () => {
    const host = await startHost(await tempDir());
    const raw = (step: string) => within(connectRaw(host.endpoint), 1_000, step);
    // Over the cap: eight closed by the handshake timeout, one destroyed on connect without a slot.
    const timedOut = await within(Promise.all(Array.from({ length: 8 }, () => connectRaw(host.endpoint))), 1_000, 'connect the 8 timed-out clients');
    const refused = await raw('connect the refused client');
    await within(refused.closed, 1_000, 'host closes the refused client');
    await within(Promise.all(timedOut.map((client) => client.closed)), 3_000, 'handshake timeout closes the 8 clients');

    const wrongProof = await raw('connect the wrong-proof client');
    const { clientNonce, serverNonce } = await hello(wrongProof);
    wrongProof.send({ type: 'auth', proof: proof(randomHex(), 'client', clientNonce, serverNonce) });
    const garbage = await raw('connect the garbage client');
    garbage.socket.write('not json\n');
    const oversized = await raw('connect the oversized client');
    oversized.socket.write('a'.repeat(5 * 1024));
    const authenticated = await within(connectClient(host), 1_000, 'authenticate a client');
    // destroy, not end: Windows named pipes have no real half-close, so the host may never see an
    // 'end'. Real MCP clients close by destroying the socket or exiting.
    authenticated.socket.destroy();
    const closing = { wrongProof, garbage, oversized, authenticated };
    await within(
      Promise.all(Object.values(closing).map((client) => client.closed)),
      1_000,
      'close the rejected and the authenticated clients',
    ).catch((error: unknown) => {
      const open = Object.entries(closing).filter(([, client]) => !client.isClosed()).map(([name]) => name);
      throw new Error(`${(error as Error).message}; still open: ${open.join(', ')}`);
    });
    // The host frees a slot in its close handler, which runs after the client already sees the
    // close. A full handshake needs later event loop turns on the host, so once it completes every
    // earlier close has been handled. Authenticated connections hold no slot.
    await within(connectClient(host), 1_000, 'authenticate after the closes');

    const silent = await within(Promise.all(Array.from({ length: 12 }, () => connectRaw(host.endpoint))), 1_000, 'connect the 12 silent clients');
    // A connect completes once the kernel queues it (Unix socket) or a pipe instance takes it
    // (Windows), before the host accepts it. The host accepts in that order and the cap is full after
    // the silent ones, so once the probe is refused every silent connection has been accepted or
    // refused.
    const probe = await raw('connect the probe');
    await waitFor(() => expect(probe.isClosed()).toBe(true), 1_000);
    await waitFor(() => expect(silent.filter((client) => client.isClosed())).toHaveLength(4), 1_000);
    expect(silent.filter((client) => !client.isClosed())).toHaveLength(8);
    for (const client of [...silent, probe]) expect(client.lines).toEqual([]);
  }, 10_000);
});

// Named pipes and %LOCALAPPDATA% only exist on Windows; these run in CI on windows-latest.
describe.runIf(process.platform === 'win32')('native host on Windows', () => {
  const PIPE = /^\\\\\.\\pipe\\claude-firefox-extension-[0-9a-f]{32}$/;

  async function windowsTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'cfe-'));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    return dir;
  }

  function startWindowsHost(localAppData: string) {
    return startHost(localAppData, { env: childEnv({ LOCALAPPDATA: localAppData }) });
  }

  it('listens on a random pipe named in bridge.json under LOCALAPPDATA and serves authenticated clients', async () => {
    const localAppData = await windowsTempDir();
    const host = await startWindowsHost(localAppData);
    const info = readBridgeJson(join(localAppData, APP_DIR, 'bridge.json'));
    expect(info).toEqual({ version: 1, endpoint: expect.stringMatching(PIPE), secret: expect.stringMatching(HEX64), pid: host.child.pid });

    host.respondWith((request) => textResult(request['id'], 'pipe'));
    const client = await connectClient(info.endpoint, info.secret);
    client.send({ type: 'tool_request', id: '1', tool: 't', args: {} });
    expect(await client.nextLine()).toEqual(textResult('1', 'pipe'));
  });

  it('falls back to <homedir>\\AppData\\Local when LOCALAPPDATA is unset', async () => {
    const home = await windowsTempDir();
    const host = await startHost(home, { env: childEnv({ USERPROFILE: home, LOCALAPPDATA: undefined }) });
    const info = readBridgeJson(join(home, 'AppData', 'Local', APP_DIR, 'bridge.json'));
    expect(info.pid).toBe(host.child.pid);
  });

  it('picks a new pipe name at every start and removes bridge.json on exit', async () => {
    const localAppData = await windowsTempDir();
    const infoPath = join(localAppData, APP_DIR, 'bridge.json');
    const first = await startWindowsHost(localAppData);
    const firstEndpoint = readBridgeJson(infoPath).endpoint;
    first.child.stdin.end();
    expect(await first.exited).toBe(0);
    expect(existsSync(infoPath)).toBe(false);

    await startWindowsHost(localAppData);
    expect(readBridgeJson(infoPath).endpoint).not.toBe(firstEndpoint);
  });

  it('exits 1 and leaves bridge.json alone when an authenticated host is already running', async () => {
    const localAppData = await windowsTempDir();
    const infoPath = join(localAppData, APP_DIR, 'bridge.json');
    const first = await startWindowsHost(localAppData);
    const info = readBridgeJson(infoPath);

    const second = await startHost(localAppData, { waitUntilListening: false, env: childEnv({ LOCALAPPDATA: localAppData }) });
    expect(await second.exited).toBe(1);
    expect(second.stderr().trim()).not.toBe('');
    expect(readBridgeJson(infoPath)).toEqual(info);

    first.respondWith((request) => textResult(request['id'], 'first'));
    const client = await connectClient(info.endpoint, info.secret);
    client.send({ type: 'tool_request', id: '1', tool: 't', args: {} });
    expect(await client.nextLine()).toEqual(textResult('1', 'first'));
  });

  it('writes nothing to stdout when it exits because an authenticated host is running, even for a ping sent at spawn', async () => {
    const localAppData = await windowsTempDir();
    const infoPath = join(localAppData, APP_DIR, 'bridge.json');
    const first = await startWindowsHost(localAppData);
    const info = readBridgeJson(infoPath);

    const second = await startHost(localAppData, { waitUntilListening: false, env: childEnv({ LOCALAPPDATA: localAppData }) });
    second.send({ type: 'ping' });
    expect(await second.exited).toBe(1);
    await stdoutEnded(second);
    expect(second.stdoutBytes()).toBe(0);
    expect(readBridgeJson(infoPath)).toEqual(info);

    first.send({ type: 'ping' });
    await waitFor(() => expect(first.received).toEqual([{ type: 'pong' }]));
  });

  it('handles every message sent at spawn in order once it has written bridge.json', async () => {
    const localAppData = await windowsTempDir();
    const infoPath = join(localAppData, APP_DIR, 'bridge.json');
    const host = await startHost(localAppData, { waitUntilListening: false, env: childEnv({ LOCALAPPDATA: localAppData }) });
    const bridgeInfoAtData: boolean[] = [];
    host.child.stdout.on('data', () => bridgeInfoAtData.push(existsSync(infoPath)));
    host.send({ type: 'ping' });
    host.send(textResult('9:9', 'nobody asked'));
    host.send({ type: 'ping' });
    await waitFor(() => expect(host.received).toEqual([{ type: 'pong' }, { type: 'pong' }]));
    expect(bridgeInfoAtData.length).toBeGreaterThan(0);
    expect(bridgeInfoAtData.every(Boolean)).toBe(true);
    await host.waitForStderr(/listening on/);
    await sleep(100);
    expect(host.received).toEqual([{ type: 'pong' }, { type: 'pong' }]);
    expect(host.child.exitCode).toBeNull();
  });

  it('writes nothing to stdout when stdin closes right after a ping sent at spawn', async () => {
    const localAppData = await windowsTempDir();
    const host = await startHost(localAppData, { waitUntilListening: false, env: childEnv({ LOCALAPPDATA: localAppData }) });
    host.send({ type: 'ping' });
    host.child.stdin.end();
    expect(await host.exited).toBe(0);
    await stdoutEnded(host);
    expect(host.stdoutBytes()).toBe(0);
    expect(existsSync(join(localAppData, APP_DIR, 'bridge.json'))).toBe(false);
  });

  it('replaces a bridge.json whose endpoint has no authenticated host', async () => {
    const localAppData = await windowsTempDir();
    const infoPath = join(localAppData, APP_DIR, 'bridge.json');
    mkdirSync(join(localAppData, APP_DIR), { recursive: true });
    const stale = { version: 1, endpoint: `\\\\.\\pipe\\${APP_DIR}-${randomHex(16)}`, secret: randomHex(), pid: 999_999 };
    writeFileSync(infoPath, JSON.stringify(stale));
    const host = await startWindowsHost(localAppData);
    const info = readBridgeJson(infoPath);
    expect(info.pid).toBe(host.child.pid);
    expect(info.endpoint).not.toBe(stale.endpoint);
  });

  it('rejects a client with the wrong secret on the pipe', async () => {
    const localAppData = await windowsTempDir();
    await startWindowsHost(localAppData);
    const info = readBridgeJson(join(localAppData, APP_DIR, 'bridge.json'));
    const client = await connectRaw(info.endpoint);
    const { clientNonce, serverNonce } = await hello(client);
    client.send({ type: 'auth', proof: proof(randomHex(), 'client', clientNonce, serverNonce) });
    await client.closed;
    expect(client.lines).toHaveLength(1);
  });
});
