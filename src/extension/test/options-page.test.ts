// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_SETTINGS_STORAGE_KEY } from '../chat-settings';
import { mockBrowser } from './browser-mock';

const BODY = `
  <input type="radio" name="agentTabs" value="container" /><input type="radio" name="agentTabs" value="default" />
  <p id="empty"></p><table id="permissions"><tbody id="permission-rows"></tbody></table>
  <input type="radio" name="chatBackend" value="api" /><input type="radio" name="chatBackend" value="claude-code" />
  <select id="chat-model"></select>
  <p id="claude-code-status"></p>
  <input id="api-key" /><button id="api-key-save"></button><button id="api-key-clear"></button>
  <p id="api-key-status"></p><p id="api-access-status"></p><button id="api-access-grant"></button>
  <p id="status"></p>
`;

let browserMock: ReturnType<typeof mockBrowser>;
const storageListeners: ((changes: Record<string, unknown>) => void)[] = [];

function backendInput(value: string): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(`input[name="chatBackend"][value="${value}"]`);
  if (!input) throw new Error(`no backend input ${value}`);
  return input;
}

async function loadPage(): Promise<void> {
  vi.resetModules();
  await import('../options/options');
}

beforeEach(() => {
  browserMock = mockBrowser();
  storageListeners.length = 0;
  const event = () => ({ addListener: vi.fn() });
  Object.assign(browserMock.runtime, { sendMessage: vi.fn(async () => ({ hostConnected: false })) });
  Object.assign(browserMock.permissions, { onAdded: event(), onRemoved: event(), request: vi.fn(async () => false) });
  Object.assign(browserMock.storage.local, {
    onChanged: { addListener: (listener: (changes: Record<string, unknown>) => void) => storageListeners.push(listener) },
  });
  document.body.innerHTML = BODY;
});

describe('options page chat backend', () => {
  it('checks the API backend by default', async () => {
    await loadPage();
    await vi.waitFor(() => expect(backendInput('api').checked).toBe(true));
    expect(backendInput('claude-code').checked).toBe(false);
  });

  it('loads a saved Claude Code backend', async () => {
    browserMock.storage.local.data.set(CHAT_SETTINGS_STORAGE_KEY, { apiKey: '', model: 'claude-haiku-5-5', backend: 'claude-code' });
    await loadPage();
    await vi.waitFor(() => expect(backendInput('claude-code').checked).toBe(true));
    expect(backendInput('api').checked).toBe(false);
  });

  it('saves the chosen backend and keeps the key and the model', async () => {
    browserMock.storage.local.data.set(CHAT_SETTINGS_STORAGE_KEY, { apiKey: 'sk-ant-key', model: 'claude-opus-5-5', backend: 'api' });
    await loadPage();
    await vi.waitFor(() => expect(backendInput('api').checked).toBe(true));
    const input = backendInput('claude-code');
    input.checked = true;
    input.dispatchEvent(new Event('change'));
    await vi.waitFor(() =>
      expect(browserMock.storage.local.data.get(CHAT_SETTINGS_STORAGE_KEY)).toEqual({ apiKey: 'sk-ant-key', model: 'claude-opus-5-5', backend: 'claude-code' }),
    );
    const api = backendInput('api');
    api.checked = true;
    api.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(browserMock.storage.local.data.get(CHAT_SETTINGS_STORAGE_KEY)).toMatchObject({ backend: 'api' }));
  });

  it('follows a backend changed elsewhere', async () => {
    await loadPage();
    await vi.waitFor(() => expect(backendInput('api').checked).toBe(true));
    browserMock.storage.local.data.set(CHAT_SETTINGS_STORAGE_KEY, { apiKey: '', model: 'claude-opus-5-5', backend: 'claude-code' });
    for (const listener of storageListeners) listener({ [CHAT_SETTINGS_STORAGE_KEY]: {} });
    await vi.waitFor(() => expect(backendInput('claude-code').checked).toBe(true));
  });
});
