import { vi } from 'vitest';

export interface FakePort {
  port: browser.runtime.Port;
  postMessage: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  emitMessage: (message: unknown) => void;
  emitDisconnect: (errorMessage?: string) => void;
}

function createPort(name: string): FakePort {
  const messageListeners: ((message: unknown) => void)[] = [];
  const disconnectListeners: (() => void)[] = [];
  const postMessage = vi.fn();
  const disconnect = vi.fn();
  const port = {
    name,
    error: undefined as { message: string } | undefined,
    postMessage,
    disconnect,
    onMessage: { addListener: (listener: (message: unknown) => void) => messageListeners.push(listener) },
    onDisconnect: { addListener: (listener: () => void) => disconnectListeners.push(listener) },
  };
  return {
    port: port as unknown as browser.runtime.Port,
    postMessage,
    disconnect,
    emitMessage: (message) => {
      for (const listener of messageListeners) listener(message);
    },
    emitDisconnect: (errorMessage) => {
      if (errorMessage !== undefined) port.error = { message: errorMessage };
      for (const listener of disconnectListeners) listener();
    },
  };
}

export type TabsQuery = (query: browser.tabs._QueryQueryInfo) => Promise<Partial<browser.tabs.Tab>[]>;

// Installs a minimal `browser` global with only what the extension code under test touches.
export function mockBrowser() {
  const ports: FakePort[] = [];
  const connectNative = vi.fn((name: string) => {
    const fake = createPort(name);
    ports.push(fake);
    return fake.port;
  });
  const alarms = {
    create: vi.fn(async () => {}),
    clear: vi.fn(async () => true),
  };
  const query = vi.fn<TabsQuery>(async () => []);
  vi.stubGlobal('browser', { runtime: { connectNative }, alarms, tabs: { query } });
  return { ports, connectNative, alarms, query };
}
