import { describe, expect, it } from 'vitest';
import { BIDI_PORT_ENV, BidiError, bidiPort, connectBidi, DEFAULT_BIDI_PORT } from '../bidi-client';
import { BIDI_ABORT_CLEANUP_TIMEOUT_MS, createSerialQueue, runBidiInput, type BidiInputTimeouts } from '../bidi-input';
import { closedPort, HANG, startFakeBidi, startPlainHttp, type FakeBidi } from './fake-bidi';
import { waitFor } from './helpers';

const MARKER = { name: '__claudeTabMarker_0123456789abcdef', value: 'a'.repeat(32) };
const URL_A = 'https://a.example/';
const ACTIONS = [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: 'a' }, { type: 'keyUp', value: 'a' }] }];
const FAST: BidiInputTimeouts = { connect: 2_000, command: 300, evaluate: 300, actions: 300 };

function request(url = URL_A) {
  return { marker: MARKER, url, actions: ACTIONS };
}

async function firefox(contexts: FakeBidi['contexts']): Promise<FakeBidi> {
  const fake = await startFakeBidi();
  fake.contexts.push(...contexts);
  return fake;
}

function evaluatedContexts(fake: FakeBidi): string[] {
  return fake.commands
    .filter((command) => command.method === 'script.evaluate')
    .map((command) => (command.params['target'] as { context: string }).context);
}

describe('bidiPort', () => {
  it('defaults to 9222 when the variable is unset or empty', () => {
    expect(bidiPort({})).toBe(DEFAULT_BIDI_PORT);
    expect(DEFAULT_BIDI_PORT).toBe(9222);
    expect(bidiPort({ [BIDI_PORT_ENV]: '' })).toBe(9222);
    expect(bidiPort({ [BIDI_PORT_ENV]: '  ' })).toBe(9222);
  });

  it.each([
    ['1', 1],
    ['9333', 9333],
    [' 65535 ', 65535],
  ])('accepts %j', (raw, port) => {
    expect(bidiPort({ [BIDI_PORT_ENV]: raw })).toBe(port);
  });

  it.each(['0', '65536', '-1', 'abc', '92.22', '1e3', '0x10', '123456'])('rejects %j with a clear error', (raw) => {
    expect(() => bidiPort({ [BIDI_PORT_ENV]: raw })).toThrow(BidiError);
    expect(() => bidiPort({ [BIDI_PORT_ENV]: raw })).toThrow(
      new RegExp(`${BIDI_PORT_ENV} must be a port number from 1 to 65535, received "${raw.trim()}".*environment Firefox is started from`),
    );
  });
});

describe('connectBidi', () => {
  it('explains how to start Firefox when nothing listens on the port', async () => {
    const port = await closedPort();
    const error = await connectBidi(port).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BidiError);
    expect((error as Error).message).toMatch(new RegExp(`Firefox is not listening for WebDriver BiDi on port ${port}`));
    expect((error as Error).message).toContain(`--remote-debugging-port=${port}`);
    expect((error as Error).message).toContain(BIDI_PORT_ENV);
  });

  it('reports another program on the port when the WebSocket handshake fails', async () => {
    const port = await startPlainHttp();
    await expect(connectBidi(port)).rejects.toThrow(/the port is open, but it did not accept a WebDriver BiDi WebSocket/);
  });

  it('matches responses by id, ignores events and reports error responses and timeouts', async () => {
    const fake = await firefox([]);
    fake.greeting.push({ type: 'event', method: 'log.entryAdded', params: {} }, { type: 'success', id: 99, result: {} });
    fake.reply('script.evaluate', () => ({ error: 'invalid argument', message: 'bad expression' }));
    fake.reply('input.performActions', () => HANG);
    const connection = await connectBidi(fake.port);
    try {
      await expect(connection.command('session.new', { capabilities: {} })).resolves.toEqual({
        sessionId: 'session-1',
        capabilities: {},
      });
      await expect(connection.command('script.evaluate', {})).rejects.toThrow(
        'Firefox WebDriver BiDi script.evaluate failed: invalid argument: bad expression',
      );
      await expect(connection.command('input.performActions', {}, 50)).rejects.toThrow(
        'Firefox did not answer WebDriver BiDi input.performActions within 0.05 s',
      );
      await expect(connection.command('session.end', {})).resolves.toEqual({});
    } finally {
      connection.close();
    }
    await expect(connection.command('session.end', {})).rejects.toThrow(/closed/);
  });
});

describe('runBidiInput', () => {
  it('runs session.new, getTree, evaluate, performActions, releaseActions and session.end in order on one connection', async () => {
    const fake = await firefox([
      { context: 'ctx-b', url: 'https://b.example/' },
      { context: 'ctx-a', url: URL_A, marker: MARKER.value },
    ]);
    await runBidiInput(request(), fake.port, FAST);
    expect(fake.methods()).toEqual([
      'session.new',
      'browsingContext.getTree',
      'script.evaluate',
      'input.performActions',
      'input.releaseActions',
      'session.end',
    ]);
    expect(fake.commands.every((command) => command.connection === 1)).toBe(true);
    expect(fake.commands[0]?.params).toEqual({ capabilities: {} });
    expect(fake.commands[1]?.params).toEqual({ maxDepth: 0 });
    expect(fake.commands[2]?.params).toMatchObject({
      expression: `window["${MARKER.name}"] === "${MARKER.value}"`,
      target: { context: 'ctx-a' },
      awaitPromise: false,
    });
    expect(fake.commands[3]?.params).toEqual({ context: 'ctx-a', actions: ACTIONS });
    expect(fake.commands[4]?.params).toEqual({ context: 'ctx-a' });
    await waitFor(() => expect(fake.openConnections()).toBe(0));
  });

  it('still releases actions and ends the session when performActions fails', async () => {
    const fake = await firefox([{ context: 'ctx-a', url: URL_A, marker: MARKER.value }]);
    fake.reply('input.performActions', () => ({ error: 'invalid argument', message: 'bad action' }));
    await expect(runBidiInput(request(), fake.port, FAST)).rejects.toThrow(
      'Firefox WebDriver BiDi input.performActions failed: invalid argument: bad action',
    );
    expect(fake.methods().slice(-3)).toEqual(['input.performActions', 'input.releaseActions', 'session.end']);
    await waitFor(() => expect(fake.openConnections()).toBe(0));
  });

  it('ends the session when performActions times out', async () => {
    const fake = await firefox([{ context: 'ctx-a', url: URL_A, marker: MARKER.value }]);
    fake.reply('input.performActions', () => HANG);
    await expect(runBidiInput(request(), fake.port, FAST)).rejects.toThrow(
      'Firefox did not answer WebDriver BiDi input.performActions within 0.3 s',
    );
    expect(fake.methods().slice(-2)).toEqual(['input.releaseActions', 'session.end']);
  });

  it('ends a session whose session.new timed out, since Firefox may have created it', async () => {
    const fake = await firefox([]);
    fake.reply('session.new', () => HANG);
    await expect(runBidiInput(request(), fake.port, FAST)).rejects.toThrow(/did not answer WebDriver BiDi session.new/);
    expect(fake.methods()).toEqual(['session.new', 'session.end']);
  });

  it('explains a refused session.new as another active WebDriver session and sends no session.end', async () => {
    const fake = await firefox([]);
    fake.reply('session.new', () => ({ error: 'session not created', message: 'Maximum number of active sessions' }));
    const error = await runBidiInput(request(), fake.port, FAST).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BidiError);
    expect((error as Error).message).toMatch(
      /^Firefox refused a new WebDriver BiDi session \(session not created: Maximum number of active sessions\)\. .*another WebDriver BiDi or Marionette client is probably connected/,
    );
    expect(fake.methods()).toEqual(['session.new']);
    await waitFor(() => expect(fake.openConnections()).toBe(0));
  });

  it('fails with the start hint when Firefox is not listening', async () => {
    const port = await closedPort();
    await expect(runBidiInput(request(), port, FAST)).rejects.toThrow(`--remote-debugging-port=${port}`);
  });

  it('checks only the contexts showing the tab URL', async () => {
    const fake = await firefox([
      { context: 'ctx-other', url: 'https://other.example/', marker: MARKER.value },
      { context: 'ctx-a1', url: URL_A },
      { context: 'ctx-a2', url: URL_A, marker: MARKER.value },
    ]);
    await runBidiInput(request(), fake.port, FAST);
    expect(evaluatedContexts(fake).sort()).toEqual(['ctx-a1', 'ctx-a2']);
    expect(fake.commands.find((command) => command.method === 'input.performActions')?.params['context']).toBe('ctx-a2');
  });

  it('reports the tab as not found when the marker is only in a context with another URL', async () => {
    const fake = await firefox([
      { context: 'ctx-1', url: 'https://one.example/' },
      { context: 'ctx-2', url: 'https://two.example/', marker: MARKER.value },
    ]);
    await expect(runBidiInput(request('https://moved.example/'), fake.port, FAST)).rejects.toThrow(
      /^Could not find the tab in WebDriver BiDi: no top-level browsing context shows the tab's URL\. /,
    );
    expect(evaluatedContexts(fake)).toEqual([]);
    expect(fake.methods()).not.toContain('input.performActions');
    expect(fake.methods().at(-1)).toBe('session.end');
  });

  it('refuses when two contexts with the tab URL carry the marker, ignoring other URLs', async () => {
    const fake = await firefox([
      { context: 'ctx-other', url: 'https://other.example/', marker: MARKER.value },
      { context: 'ctx-a1', url: URL_A, marker: MARKER.value },
      { context: 'ctx-a2', url: URL_A, marker: MARKER.value },
    ]);
    await expect(runBidiInput(request(), fake.port, FAST)).rejects.toThrow(
      "Could not identify the tab in WebDriver BiDi: 2 browsing contexts carry the tab's marker",
    );
    expect(evaluatedContexts(fake).sort()).toEqual(['ctx-a1', 'ctx-a2']);
    expect(fake.methods()).not.toContain('input.performActions');
  });

  it('fails without input when no context carries the marker', async () => {
    const fake = await firefox([
      { context: 'ctx-a', url: URL_A, marker: 'b'.repeat(32) },
      { context: 'ctx-b', url: 'https://b.example/' },
    ]);
    await expect(runBidiInput(request(), fake.port, FAST)).rejects.toThrow(
      /^Could not find the tab in WebDriver BiDi: no browsing context carries the tab's marker\. /,
    );
    expect(fake.methods()).not.toContain('input.performActions');
    expect(fake.methods()).not.toContain('input.releaseActions');
    expect(fake.methods().at(-1)).toBe('session.end');
  });

  it('fails without input when several contexts carry the marker', async () => {
    const fake = await firefox([
      { context: 'ctx-1', url: URL_A, marker: MARKER.value },
      { context: 'ctx-2', url: URL_A, marker: MARKER.value },
    ]);
    await expect(runBidiInput(request(), fake.port, FAST)).rejects.toThrow(
      'Could not identify the tab in WebDriver BiDi: 2 browsing contexts carry the tab\'s marker',
    );
    expect(fake.methods()).not.toContain('input.performActions');
    expect(fake.methods().at(-1)).toBe('session.end');
  });

  it('treats a context that does not answer the marker check as no match', async () => {
    const fake = await firefox([
      { context: 'ctx-hung', url: URL_A, hangs: true },
      { context: 'ctx-a', url: URL_A, marker: MARKER.value },
    ]);
    await runBidiInput(request(), fake.port, FAST);
    expect(fake.commands.find((command) => command.method === 'input.performActions')?.params['context']).toBe('ctx-a');

    fake.contexts.splice(1, 1);
    await expect(runBidiInput(request(), fake.port, FAST)).rejects.toThrow('(1 of 1 checked contexts did not answer)');
  });
});

describe('runBidiInput abort', () => {
  it('stops waiting for performActions on abort and still releases actions and ends the session', async () => {
    const fake = await firefox([{ context: 'ctx-a', url: URL_A, marker: MARKER.value }]);
    fake.reply('input.performActions', () => HANG);
    const controller = new AbortController();
    const slow = { ...FAST, actions: 30_000, command: 30_000 };
    const run = runBidiInput(request(), fake.port, slow, controller.signal);
    await waitFor(() => expect(fake.methods()).toContain('input.performActions'));
    const started = Date.now();
    controller.abort();
    await expect(run).rejects.toThrow(/stopped/);
    expect(Date.now() - started).toBeLessThan(BIDI_ABORT_CLEANUP_TIMEOUT_MS * 2);
    expect(fake.methods().slice(-3)).toEqual(['input.performActions', 'input.releaseActions', 'session.end']);
    await waitFor(() => expect(fake.openConnections()).toBe(0));
  });

  it('uses short cleanup timeouts after an abort', async () => {
    const fake = await firefox([{ context: 'ctx-a', url: URL_A, marker: MARKER.value }]);
    fake.reply('input.performActions', () => HANG);
    fake.reply('input.releaseActions', () => HANG);
    const controller = new AbortController();
    const run = runBidiInput(request(), fake.port, { ...FAST, actions: 30_000, command: 30_000 }, controller.signal);
    await waitFor(() => expect(fake.methods()).toContain('input.performActions'));
    const started = Date.now();
    controller.abort();
    await expect(run).rejects.toThrow(/stopped/);
    expect(Date.now() - started).toBeLessThan(BIDI_ABORT_CLEANUP_TIMEOUT_MS + 1_000);
    expect(fake.methods().at(-1)).toBe('session.end');
  });

  it('does not connect when already aborted', async () => {
    const fake = await firefox([{ context: 'ctx-a', url: URL_A, marker: MARKER.value }]);
    const controller = new AbortController();
    controller.abort();
    await expect(runBidiInput(request(), fake.port, FAST, controller.signal)).rejects.toThrow(/stopped/);
    expect(fake.commands).toEqual([]);
  });
});

describe('createSerialQueue', () => {
  it('runs BiDi input requests one session at a time', async () => {
    const fake = await firefox([{ context: 'ctx-a', url: URL_A, marker: MARKER.value }]);
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.reply('input.performActions', async (_params, connection) => {
      if (connection === 1) await held;
      return { result: {} };
    });
    const queue = createSerialQueue();
    const slow = { ...FAST, actions: 5_000 };
    const first = queue.run(() => runBidiInput(request(), fake.port, slow));
    const second = queue.run(() => runBidiInput(request(), fake.port, slow));
    await waitFor(() => expect(fake.methods()).toContain('input.performActions'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.commands.filter((command) => command.method === 'session.new')).toHaveLength(1);
    release?.();
    await Promise.all([first, second]);
    const sessions = fake.commands.filter((command) => command.method === 'session.new' || command.method === 'session.end');
    expect(sessions.map((command) => [command.method, command.connection])).toEqual([
      ['session.new', 1],
      ['session.end', 1],
      ['session.new', 2],
      ['session.end', 2],
    ]);
  });

  it('keeps running after a failed task', async () => {
    const queue = createSerialQueue();
    await expect(queue.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(queue.run(() => Promise.resolve(7))).resolves.toBe(7);
  });
  it('refuses a task beyond the queue limit, counting the running one', async () => {
    const queue = createSerialQueue({ maxLength: 2, maxWaitMs: 60_000 });
    let release: (() => void) | undefined;
    const first = queue.run(
      () =>
        new Promise<number>((resolve) => {
          release = () => resolve(1);
        }),
    );
    const second = queue.run(() => Promise.resolve(2));
    await expect(queue.run(() => Promise.resolve(3))).rejects.toThrow(
      /^Too many input requests are waiting for WebDriver BiDi/,
    );
    await waitFor(() => expect(release).toBeDefined());
    release?.();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    await expect(queue.run(() => Promise.resolve(4))).resolves.toBe(4);
  });

  it('skips a task that waited longer than the limit', async () => {
    const queue = createSerialQueue({ maxLength: 8, maxWaitMs: 50 });
    let ran = false;
    const first = queue.run(() => new Promise((resolve) => setTimeout(resolve, 120)));
    const second = queue.run(() => {
      ran = true;
      return Promise.resolve();
    });
    await first;
    await expect(second).rejects.toThrow(/^The input request waited too long for WebDriver BiDi/);
    expect(ran).toBe(false);
  });
});
