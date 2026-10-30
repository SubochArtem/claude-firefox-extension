import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockBrowser } from './browser-mock';

const RECONNECT_ALARM = 'reconnect-native-host';
const PONG_TIMEOUT_MS = 5_000;

// Captured before fake timers are installed; a macrotask turn lets every pending promise chain settle.
const realSetTimeout = globalThis.setTimeout;
const flushPromises = () => new Promise((resolve) => realSetTimeout(resolve, 0));

let browserMock: ReturnType<typeof mockBrowser>;
let bridge: typeof import('../native-bridge');

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  // Date is faked too, so a stability check may use timestamps or a timer.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  browserMock = mockBrowser();
  // native-bridge keeps its connection state in module scope, so every test gets a fresh copy.
  vi.resetModules();
  bridge = await import('../native-bridge');
});

afterEach(() => {
  vi.useRealTimers();
});

function lastPort() {
  const port = browserMock.ports.at(-1);
  if (!port) throw new Error('no port was opened');
  return port;
}

function connectAndPong() {
  bridge.connect();
  const port = lastPort();
  port.emitMessage({ type: 'pong' });
  return port;
}

describe('connect', () => {
  it('opens the native port and sends ping', () => {
    bridge.connect();
    expect(browserMock.connectNative).toHaveBeenCalledExactlyOnceWith('claude_firefox_extension');
    expect(lastPort().postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'ping' });
  });

  it('exports the alarm name used by the background script', () => {
    expect(bridge.RECONNECT_ALARM).toBe(RECONNECT_ALARM);
  });

  it('does not open a second port while one is open', () => {
    bridge.connect();
    bridge.connect();
    lastPort().emitMessage({ type: 'pong' });
    bridge.connect();
    expect(browserMock.connectNative).toHaveBeenCalledTimes(1);
  });

  it('does not open a port while a retry is pending', () => {
    bridge.connect();
    lastPort().emitDisconnect('No such native application');
    bridge.connect();
    expect(browserMock.connectNative).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    expect(browserMock.connectNative).toHaveBeenCalledTimes(2);
  });
});

describe('pong handling', () => {
  it('clears the reconnect alarm and the pong timeout', () => {
    const port = connectAndPong();
    expect(browserMock.alarms.clear).toHaveBeenCalledExactlyOnceWith(RECONNECT_ALARM);
    vi.advanceTimersByTime(PONG_TIMEOUT_MS + 1);
    expect(port.disconnect).not.toHaveBeenCalled();
    expect(browserMock.connectNative).toHaveBeenCalledTimes(1);
  });

  it('disconnects and schedules a reconnect when no pong arrives within 5 s', () => {
    bridge.connect();
    const port = lastPort();
    vi.advanceTimersByTime(PONG_TIMEOUT_MS - 1);
    expect(port.disconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(port.disconnect).toHaveBeenCalledOnce();
    expect(browserMock.alarms.create).toHaveBeenCalledExactlyOnceWith(RECONNECT_ALARM, { periodInMinutes: 0.5 });

    vi.advanceTimersByTime(999);
    expect(browserMock.connectNative).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(browserMock.connectNative).toHaveBeenCalledTimes(2);
    expect(lastPort().postMessage).toHaveBeenCalledWith({ type: 'ping' });
  });

  it('ignores a disconnect event after the pong timeout already handled the loss', () => {
    bridge.connect();
    const port = lastPort();
    vi.advanceTimersByTime(PONG_TIMEOUT_MS);
    port.emitDisconnect();
    expect(browserMock.alarms.create).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe('reconnect backoff', () => {
  // Advances to just before the expected delay, checks nothing reconnected, then crosses it.
  function expectReconnectAfter(delay: number): void {
    const opened = browserMock.connectNative.mock.calls.length;
    vi.advanceTimersByTime(delay - 1);
    expect(browserMock.connectNative).toHaveBeenCalledTimes(opened);
    vi.advanceTimersByTime(1);
    expect(browserMock.connectNative).toHaveBeenCalledTimes(opened + 1);
  }

  it('doubles the delay from 1 s up to a 30 s cap', () => {
    bridge.connect();
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      lastPort().emitDisconnect('Native host has exited.');
      expectReconnectAfter(delay);
    }
    expect(browserMock.alarms.create.mock.calls).toEqual(
      Array.from({ length: 7 }, () => [RECONNECT_ALARM, { periodInMinutes: 0.5 }]),
    );
  });

  it('uses a 10 s stability period', () => {
    expect(bridge.STABLE_CONNECTION_MS).toBe(10_000);
  });

  // A second Firefox gets a pong from a host that then exits because another host is running; a
  // reset on that pong would retry every second forever.
  it('keeps doubling up to the cap when every connection answers pong and drops 100 ms later', () => {
    bridge.connect();
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      lastPort().emitMessage({ type: 'pong' });
      vi.advanceTimersByTime(100);
      lastPort().emitDisconnect('Native host has exited.');
      expectReconnectAfter(delay);
    }
    expect(console.log).toHaveBeenCalledWith('Connected to native host');
  });

  it('does not reset the delay on a pong alone', () => {
    bridge.connect();
    lastPort().emitDisconnect();
    expectReconnectAfter(1_000);
    lastPort().emitDisconnect();
    expectReconnectAfter(2_000);
    lastPort().emitMessage({ type: 'pong' });
    lastPort().emitDisconnect();
    expectReconnectAfter(4_000);
  });

  it('does not reset the delay after a connection that stayed up just under the stability period', () => {
    bridge.connect();
    lastPort().emitDisconnect();
    expectReconnectAfter(1_000);
    lastPort().emitDisconnect();
    expectReconnectAfter(2_000);
    lastPort().emitMessage({ type: 'pong' });
    vi.advanceTimersByTime(bridge.STABLE_CONNECTION_MS - 1);
    lastPort().emitDisconnect();
    expectReconnectAfter(4_000);
  });

  it('resets the delay to 1 s after a connection stayed up for the stability period, then doubles again', () => {
    bridge.connect();
    lastPort().emitDisconnect();
    expectReconnectAfter(1_000);
    lastPort().emitDisconnect();
    expectReconnectAfter(2_000);
    lastPort().emitDisconnect();
    expectReconnectAfter(4_000);
    lastPort().emitMessage({ type: 'pong' });
    vi.advanceTimersByTime(bridge.STABLE_CONNECTION_MS);
    expect(browserMock.connectNative).toHaveBeenCalledTimes(4);
    lastPort().emitDisconnect();
    expectReconnectAfter(1_000);
    lastPort().emitDisconnect();
    expectReconnectAfter(2_000);
  });

  it('does not count a connection without a pong as stable before its pong timeout', () => {
    bridge.connect();
    lastPort().emitDisconnect();
    expectReconnectAfter(1_000);
    lastPort().emitDisconnect();
    expectReconnectAfter(2_000);
    vi.advanceTimersByTime(PONG_TIMEOUT_MS - 1);
    lastPort().emitDisconnect();
    expectReconnectAfter(4_000);
  });

  it('backs off again when a connection drops quickly after a stable one', () => {
    bridge.connect();
    lastPort().emitMessage({ type: 'pong' });
    vi.advanceTimersByTime(bridge.STABLE_CONNECTION_MS);
    lastPort().emitDisconnect();
    expectReconnectAfter(1_000);
    lastPort().emitMessage({ type: 'pong' });
    vi.advanceTimersByTime(100);
    lastPort().emitDisconnect();
    expectReconnectAfter(2_000);
  });

  it('neither restarts nor shortens the stability period on a duplicate pong', () => {
    bridge.connect();
    lastPort().emitDisconnect();
    expectReconnectAfter(1_000);
    lastPort().emitDisconnect();
    expectReconnectAfter(2_000);
    lastPort().emitMessage({ type: 'pong' });
    vi.advanceTimersByTime(bridge.STABLE_CONNECTION_MS / 2);
    lastPort().emitMessage({ type: 'pong' });
    vi.advanceTimersByTime(bridge.STABLE_CONNECTION_MS / 2 - 1);
    lastPort().emitDisconnect();
    expectReconnectAfter(4_000);

    lastPort().emitMessage({ type: 'pong' });
    vi.advanceTimersByTime(bridge.STABLE_CONNECTION_MS / 2);
    lastPort().emitMessage({ type: 'pong' });
    vi.advanceTimersByTime(bridge.STABLE_CONNECTION_MS / 2);
    lastPort().emitDisconnect();
    expectReconnectAfter(1_000);
  });

  it('logs the connection and clears the reconnect alarm on every pong, stable or not', () => {
    bridge.connect();
    lastPort().emitMessage({ type: 'pong' });
    lastPort().emitDisconnect();
    expectReconnectAfter(1_000);
    lastPort().emitMessage({ type: 'pong' });
    expect(browserMock.alarms.clear.mock.calls).toEqual([[RECONNECT_ALARM], [RECONNECT_ALARM]]);
    expect(vi.mocked(console.log).mock.calls.filter(([text]) => text === 'Connected to native host')).toHaveLength(2);
  });
});

describe('tool requests', () => {
  it('runs the tool and posts the response on the same port', async () => {
    browserMock.query.mockResolvedValue([]);
    const port = connectAndPong();
    port.emitMessage({ type: 'tool_request', id: '3:1', tool: 'tabs_context', args: {} });
    await flushPromises();
    expect(port.postMessage).toHaveBeenLastCalledWith({
      type: 'tool_response',
      id: '3:1',
      result: { content: [{ type: 'text', text: '{"tabs":[],"activeTabId":null}' }] },
    });
  });

  it('posts an error response for an unknown tool', async () => {
    const port = connectAndPong();
    port.emitMessage({ type: 'tool_request', id: '3:2', tool: 'missing', args: {} });
    await flushPromises();
    expect(port.postMessage).toHaveBeenLastCalledWith({
      type: 'tool_response',
      id: '3:2',
      error: { content: [{ type: 'text', text: 'Unknown tool: missing' }] },
    });
  });

  it('drops the response when the port was lost while the tool ran', async () => {
    let finish: (tabs: Partial<browser.tabs.Tab>[]) => void = () => {};
    browserMock.query.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const port = connectAndPong();
    port.emitMessage({ type: 'tool_request', id: '3:3', tool: 'tabs_context', args: {} });
    port.emitDisconnect();
    finish([]);
    await flushPromises();
    expect(port.postMessage).toHaveBeenCalledTimes(1);
  });

  it('ignores malformed messages', async () => {
    bridge.connect();
    const port = lastPort();
    for (const message of [null, 'pong', [{ type: 'pong' }], { type: 'ping' }, { type: 'tool_request', id: 1 }]) {
      port.emitMessage(message);
    }
    await flushPromises();
    expect(port.postMessage).toHaveBeenCalledTimes(1);
    expect(browserMock.alarms.clear).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(5);
    vi.advanceTimersByTime(PONG_TIMEOUT_MS);
    expect(port.disconnect).toHaveBeenCalledOnce();
  });
});

describe('stale ports', () => {
  it('ignores messages and disconnects from a port that was replaced', async () => {
    bridge.connect();
    const stale = lastPort();
    stale.emitDisconnect();
    vi.advanceTimersByTime(1_000);
    const current = lastPort();
    expect(current).not.toBe(stale);

    stale.emitMessage({ type: 'pong' });
    stale.emitMessage({ type: 'tool_request', id: '1:1', tool: 'missing', args: {} });
    stale.emitDisconnect();
    await flushPromises();
    expect(browserMock.alarms.clear).not.toHaveBeenCalled();
    expect(stale.postMessage).toHaveBeenCalledTimes(1);
    expect(browserMock.alarms.create).toHaveBeenCalledTimes(1);

    // The current port is still waiting for its own pong and handles it normally.
    current.emitMessage({ type: 'pong' });
    expect(browserMock.alarms.clear).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(60_000);
    expect(browserMock.connectNative).toHaveBeenCalledTimes(2);
  });

  it('ignores a pong from the port the pong timeout gave up on', () => {
    bridge.connect();
    const stale = lastPort();
    vi.advanceTimersByTime(PONG_TIMEOUT_MS);
    stale.emitMessage({ type: 'pong' });
    expect(browserMock.alarms.clear).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(browserMock.connectNative).toHaveBeenCalledTimes(2);
  });
});
