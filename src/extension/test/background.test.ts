import { beforeEach, describe, expect, it, vi } from 'vitest';

const { connect, RECONNECT_ALARM } = vi.hoisted(() => ({ connect: vi.fn(), RECONNECT_ALARM: 'reconnect-native-host' }));

vi.mock('../native-bridge', () => ({ connect, RECONNECT_ALARM }));

function listenerList<Listener>() {
  const listeners: Listener[] = [];
  return { listeners, event: { addListener: (listener: Listener) => listeners.push(listener) } };
}

let onMessage: ReturnType<typeof listenerList<(message: unknown) => unknown>>;
let onAlarm: ReturnType<typeof listenerList<(alarm: { name: string }) => void>>;
let onStartup: ReturnType<typeof listenerList<() => void>>;
let onCommitted: { listeners: { listener: unknown; filter: unknown }[] };
let onTabRemoved: ReturnType<typeof listenerList<(tabId: number) => void>>;
let getRegisteredContentScripts: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  connect.mockReset();
  onMessage = listenerList();
  onAlarm = listenerList();
  onStartup = listenerList();
  onTabRemoved = listenerList();
  onCommitted = { listeners: [] };
  getRegisteredContentScripts = vi.fn(async () => []);
  vi.stubGlobal('browser', {
    runtime: {
      onInstalled: listenerList().event,
      onStartup: onStartup.event,
      onMessage: onMessage.event,
      getManifest: () => ({ version: '0' }),
    },
    alarms: { onAlarm: onAlarm.event },
    webNavigation: {
      onCommitted: { addListener: (listener: unknown, filter: unknown) => onCommitted.listeners.push({ listener, filter }) },
    },
    tabs: { onRemoved: onTabRemoved.event },
    storage: { session: { get: async () => ({}) } },
    scripting: { getRegisteredContentScripts },
  });
  vi.resetModules();
  await import('../background');
});

describe('background script', () => {
  it('connects once at load and registers the prompt and options message listeners', async () => {
    const { handlePromptMessage } = await import('../permissions/popup-prompt');
    const { handleOptionsMessage } = await import('../options/options-messages');
    expect(connect).toHaveBeenCalledTimes(1);
    expect(onMessage.listeners).toEqual([handlePromptMessage, handleOptionsMessage]);
    expect(onStartup.listeners).toEqual([connect]);
  });

  it('registers console tracking on http(s) commits and tab removal', async () => {
    const { handleConsoleCommit, handleConsoleTabRemoved } = await import('../tools/console-tracking');
    expect(onCommitted.listeners).toEqual([{ listener: handleConsoleCommit, filter: { url: [{ schemes: ['http', 'https'] }] } }]);
    expect(onTabRemoved.listeners).toEqual([handleConsoleTabRemoved]);
  });

  it('reconciles the console capture registration on every start', async () => {
    await vi.waitFor(() => expect(getRegisteredContentScripts).toHaveBeenCalledWith({ ids: ['console-capture'] }));
  });

  it('connects on the reconnect alarm without adding listeners', () => {
    const [alarmListener] = onAlarm.listeners;
    alarmListener?.({ name: RECONNECT_ALARM });
    alarmListener?.({ name: RECONNECT_ALARM });
    expect(connect).toHaveBeenCalledTimes(3);
    expect(onMessage.listeners).toHaveLength(2);
  });

  it('ignores other alarms', () => {
    const [alarmListener] = onAlarm.listeners;
    alarmListener?.({ name: 'something-else' });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(onMessage.listeners).toHaveLength(2);
  });
});
