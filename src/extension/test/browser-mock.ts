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

export interface FakeEvent<Args extends unknown[]> {
  addListener: (listener: (...args: Args) => void) => void;
  removeListener: (listener: (...args: Args) => void) => void;
  hasListener: (listener: (...args: Args) => void) => boolean;
  emit: (...args: Args) => void;
  listenerCount: () => number;
}

function createEvent<Args extends unknown[]>(): FakeEvent<Args> {
  const listeners: ((...args: Args) => void)[] = [];
  return {
    addListener: (listener) => {
      listeners.push(listener);
    },
    removeListener: (listener) => {
      const index = listeners.indexOf(listener);
      if (index !== -1) listeners.splice(index, 1);
    },
    hasListener: (listener) => listeners.includes(listener),
    emit: (...args) => {
      for (const listener of [...listeners]) {
        if (listeners.includes(listener)) listener(...args);
      }
    },
    listenerCount: () => listeners.length,
  };
}

export interface NavigationDetails {
  tabId: number;
  frameId: number;
  url: string;
  documentId?: string;
  error?: string;
  timeStamp?: number;
  transitionType?: string;
  transitionQualifiers?: string[];
}

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
  const tabs = {
    query,
    get: vi.fn<(tabId: number) => Promise<Partial<browser.tabs.Tab>>>(async (tabId) => {
      throw new Error(`Invalid tab ID: ${tabId}`);
    }),
    update: vi.fn<(tabId: number, properties: browser.tabs._UpdateUpdateProperties) => Promise<Partial<browser.tabs.Tab>>>(
      async (tabId) => ({ id: tabId }),
    ),
    goBack: vi.fn<(tabId: number) => Promise<void>>(async () => {}),
    goForward: vi.fn<(tabId: number) => Promise<void>>(async () => {}),
    create: vi.fn<(properties: browser.tabs._CreateCreateProperties) => Promise<Partial<browser.tabs.Tab>>>(
      async () => ({ id: 1 }),
    ),
    remove: vi.fn<(tabIds: number | number[]) => Promise<void>>(async () => {}),
    onRemoved: createEvent<[tabId: number, removeInfo: browser.tabs._OnRemovedRemoveInfo]>(),
  };
  const webNavigation = {
    onBeforeNavigate: createEvent<[details: NavigationDetails]>(),
    onCommitted: createEvent<[details: NavigationDetails]>(),
    onCompleted: createEvent<[details: NavigationDetails]>(),
    onErrorOccurred: createEvent<[details: NavigationDetails]>(),
    onReferenceFragmentUpdated: createEvent<[details: NavigationDetails]>(),
    onHistoryStateUpdated: createEvent<[details: NavigationDetails]>(),
  };
  const windows = {
    get: vi.fn<(windowId: number) => Promise<Partial<browser.windows.Window>>>(async (windowId) => {
      throw new Error(`Invalid window ID: ${windowId}`);
    }),
    getLastFocused: vi.fn<() => Promise<Partial<browser.windows.Window>>>(async () => {
      throw new Error('No window');
    }),
  };
  const events = [tabs.onRemoved, ...Object.values(webNavigation)];
  const listenerCount = () => events.reduce((sum, event) => sum + event.listenerCount(), 0);
  vi.stubGlobal('browser', { runtime: { connectNative }, alarms, tabs, webNavigation, windows });
  return { ports, connectNative, alarms, query, tabs, webNavigation, windows, listenerCount };
}
