import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APP_DIR,
  connectClient,
  nativeHeader,
  startHost,
  tempDir,
  textResult,
  waitFor,
} from './helpers';

describe.skipIf(process.platform === 'win32')('native host process', () => {
  it('creates a private socket directory and a 0600 socket', async () => {
    const runtimeDir = await tempDir();
    const host = await startHost(runtimeDir);
    expect(lstatSync(join(runtimeDir, APP_DIR)).mode & 0o777).toBe(0o700);
    const socket = lstatSync(host.socketPath);
    expect(socket.isSocket()).toBe(true);
    expect(socket.mode & 0o777).toBe(0o600);
  });

  it('answers ping with pong', async () => {
    const host = await startHost(await tempDir());
    host.send({ type: 'ping' });
    await waitFor(() => expect(host.received).toEqual([{ type: 'pong' }]));
  });

  it('forwards requests with per-client ids and routes responses back to the right client', async () => {
    const host = await startHost(await tempDir());
    const [a, b] = await Promise.all([connectClient(host.socketPath), connectClient(host.socketPath)]);
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
    const client = await connectClient(host.socketPath);
    for (const id of ['x', 'y', 'z']) client.send({ type: 'tool_request', id, tool: 't', args: {} });
    const lines = await Promise.all([client.nextLine(), client.nextLine(), client.nextLine()]);
    expect(lines.map((line) => line['id'])).toEqual(['x', 'y', 'z']);
    for (const line of lines) {
      expect(line).toEqual(textResult(line['id'], expect.stringMatching(new RegExp(`^answer \\d+:${String(line['id'])}$`))));
    }
  });

  it('rejects a duplicate request id while the first is pending', async () => {
    const host = await startHost(await tempDir());
    const client = await connectClient(host.socketPath);
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
    const client = await connectClient(host.socketPath);
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
    const client = await connectClient(host.socketPath);
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
    const gone = await connectClient(host.socketPath);
    gone.send({ type: 'tool_request', id: '1', tool: 't', args: {} });
    const request = await host.nextRequest();
    gone.socket.destroy();
    await gone.closed;

    // A full round trip on a newer connection makes sure the host has handled the older close.
    const other = await connectClient(host.socketPath);
    host.respondWith((next) => textResult(next['id'], 'still serving'));
    other.send({ type: 'tool_request', id: '1', tool: 't', args: {} });
    expect(await other.nextLine()).toEqual(textResult('1', 'still serving'));

    host.send(textResult(request['id'], 'late'));
    await host.waitForStderr(new RegExp(`response for unknown request ${String(request['id'])}`));
    expect(gone.lines).toEqual([]);
  });

  it('exits 0 and removes its socket when stdin closes, failing pending requests', async () => {
    const host = await startHost(await tempDir());
    const client = await connectClient(host.socketPath);
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
    expect(existsSync(host.socketPath)).toBe(false);
    expect(host.stderr()).toMatch(/shutting down: stdin closed/);
  });

  it('exits 0 and removes its socket on SIGTERM', async () => {
    const host = await startHost(await tempDir());
    host.child.kill('SIGTERM');
    expect(await host.exited).toBe(0);
    expect(existsSync(host.socketPath)).toBe(false);
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
  });

  it('shuts down when the extension declares a frame larger than 64 MB', async () => {
    const host = await startHost(await tempDir());
    host.sendRaw(nativeHeader(64 * 1024 * 1024 + 1));
    expect(await host.exited).toBe(0);
    expect(existsSync(host.socketPath)).toBe(false);
    expect(host.stderr()).toMatch(/shutting down: stdin error: native message too large/);
  });

  it('exits 1 when another host is already listening and leaves its socket alone', async () => {
    const runtimeDir = await tempDir();
    const first = await startHost(runtimeDir);
    const before = lstatSync(first.socketPath).ino;
    const second = await startHost(runtimeDir, { waitUntilListening: false });
    expect(await second.exited).toBe(1);
    expect(second.stderr()).toMatch(/another native host is already listening/);
    expect(lstatSync(first.socketPath).ino).toBe(before);

    first.respondWith((request) => textResult(request['id'], 'first'));
    const client = await connectClient(first.socketPath);
    client.send({ type: 'tool_request', id: '1', tool: 't', args: {} });
    expect(await client.nextLine()).toEqual(textResult('1', 'first'));
  });

  it('takes over a stale socket left by a killed host', async () => {
    const runtimeDir = await tempDir();
    const crashed = await startHost(runtimeDir);
    crashed.child.kill('SIGKILL');
    await crashed.exited;
    expect(existsSync(crashed.socketPath)).toBe(true);

    const host = await startHost(runtimeDir);
    host.respondWith((request) => textResult(request['id'], 'new host'));
    const client = await connectClient(host.socketPath);
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

    stop(oldHost);
    expect(await oldHost.exited).toBe(0);
    expect(lstatSync(newHost.socketPath).ino).toBe(newInode);

    newHost.respondWith((request) => textResult(request['id'], 'newer'));
    const client = await connectClient(newHost.socketPath);
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
  });
});
