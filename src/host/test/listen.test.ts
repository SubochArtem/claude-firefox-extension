import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { listenWithRetry } from '../listen';
import { newEndpoint, tempDir } from './helpers';

function closeOnFinish(server: Server): Server {
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        if (server.listening) server.close(() => resolve());
        else resolve();
      }),
  );
  return server;
}

async function occupy(path: string): Promise<Server> {
  const server = closeOnFinish(createServer());
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return server;
}

// listenWithRetry is the seam for EADDRINUSE on a freshly generated endpoint (a random Windows pipe
// name that happens to be taken). Unix socket paths stand in for pipe names on Linux and macOS.
describe('listenWithRetry', () => {
  it('binds the first endpoint when it is free', async () => {
    const dir = await tempDir();
    const free = newEndpoint(dir, 'free');
    const server = closeOnFinish(createServer());
    const nextEndpoint = vi.fn(() => free);
    await expect(listenWithRetry(server, nextEndpoint)).resolves.toBe(free);
    expect(nextEndpoint).toHaveBeenCalledTimes(1);
    expect(server.listening).toBe(true);
    expect(server.address()).toBe(free);
  });

  it('asks for a new endpoint after EADDRINUSE and resolves with the one it bound', async () => {
    const dir = await tempDir();
    const taken = newEndpoint(dir, 'taken');
    const free = newEndpoint(dir, 'free');
    const occupant = await occupy(taken);
    const server = closeOnFinish(createServer());
    const errorListeners = server.listenerCount('error');
    const nextEndpoint = vi.fn<() => string>().mockReturnValueOnce(taken).mockReturnValueOnce(taken).mockReturnValueOnce(free);

    await expect(listenWithRetry(server, nextEndpoint)).resolves.toBe(free);
    expect(nextEndpoint).toHaveBeenCalledTimes(3);
    expect(server.address()).toBe(free);
    expect(server.listenerCount('error')).toBe(errorListeners);
    expect(occupant.listening).toBe(true);
    expect(occupant.address()).toBe(taken);
  });

  it('rejects with EADDRINUSE after three collisions by default', async () => {
    const dir = await tempDir();
    const taken = newEndpoint(dir, 'taken');
    await occupy(taken);
    const server = closeOnFinish(createServer());
    const nextEndpoint = vi.fn(() => taken);
    await expect(listenWithRetry(server, nextEndpoint)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(nextEndpoint).toHaveBeenCalledTimes(3);
    expect(server.listening).toBe(false);
  });

  it('honours a custom number of attempts', async () => {
    const dir = await tempDir();
    const taken = newEndpoint(dir, 'taken');
    const free = newEndpoint(dir, 'free');
    await occupy(taken);

    const once = vi.fn<() => string>().mockReturnValueOnce(taken).mockReturnValueOnce(free);
    await expect(listenWithRetry(closeOnFinish(createServer()), once, 1)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(once).toHaveBeenCalledTimes(1);

    const five = vi.fn<() => string>();
    for (let i = 0; i < 4; i++) five.mockReturnValueOnce(taken);
    five.mockReturnValueOnce(free);
    await expect(listenWithRetry(closeOnFinish(createServer()), five, 5)).resolves.toBe(free);
    expect(five).toHaveBeenCalledTimes(5);
  });
});

// A pipe name has no parent directory that could be missing.
describe.skipIf(process.platform === 'win32')('listenWithRetry on Unix sockets', () => {
  it('rejects at once without retrying on an error other than EADDRINUSE', async () => {
    const dir = await tempDir();
    const server = closeOnFinish(createServer());
    const nextEndpoint = vi.fn(() => join(dir, 'missing', 'bridge.sock'));
    const error = (await listenWithRetry(server, nextEndpoint).then(
      () => undefined,
      (reason: unknown) => reason,
    )) as NodeJS.ErrnoException | undefined;
    // Node reports a missing parent directory of a Unix socket as EACCES; ENOENT is accepted too.
    expect(['EACCES', 'ENOENT']).toContain(error?.code);
    expect(nextEndpoint).toHaveBeenCalledTimes(1);
    expect(server.listening).toBe(false);
  });
});
