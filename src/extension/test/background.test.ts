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

beforeEach(async () => {
  connect.mockReset();
  onMessage = listenerList();
  onAlarm = listenerList();
  onStartup = listenerList();
  vi.stubGlobal('browser', {
    runtime: {
      onInstalled: listenerList().event,
      onStartup: onStartup.event,
      onMessage: onMessage.event,
      getManifest: () => ({ version: '0' }),
    },
    alarms: { onAlarm: onAlarm.event },
  });
  vi.resetModules();
  await import('../background');
});

describe('background script', () => {
  it('connects once at load and registers exactly one message listener', async () => {
    const { handlePromptMessage } = await import('../permissions/popup-prompt');
    expect(connect).toHaveBeenCalledTimes(1);
    expect(onMessage.listeners).toEqual([handlePromptMessage]);
    expect(onStartup.listeners).toEqual([connect]);
  });

  it('connects on the reconnect alarm without adding listeners', () => {
    const [alarmListener] = onAlarm.listeners;
    alarmListener?.({ name: RECONNECT_ALARM });
    alarmListener?.({ name: RECONNECT_ALARM });
    expect(connect).toHaveBeenCalledTimes(3);
    expect(onMessage.listeners).toHaveLength(1);
  });

  it('ignores other alarms', () => {
    const [alarmListener] = onAlarm.listeners;
    alarmListener?.({ name: 'something-else' });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(onMessage.listeners).toHaveLength(1);
  });
});
