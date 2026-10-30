import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeTool } from '../tools';
import { PROMPT_ANSWER_MESSAGE } from '../permissions/approval';
import { handlePromptMessage } from '../permissions/popup-prompt';
import { PERMISSION_STORAGE_KEY } from '../permissions/permission-store';
import { blockedMessage, deniedMessage } from '../permissions/site-access';
import { containerUnavailableMessage } from '../permissions/agent-container';
import { SETTINGS_STORAGE_KEY } from '../settings';
import { EXTENSION_ID, mockBrowser } from './browser-mock';

const WINDOW = 1;
const POPUP_WINDOW = 2;
const TAB = 5;
const OTHER_TAB = 6;
const NEW_TAB = 9;
const TARGET = 'https://example.com/';
const TARGET_DOC = 'doc-target';
const ABORTED = 'Error code 2152398850';
const UNKNOWN_HOST = 'Error code 2152398878';
const PROMPT_WINDOW = 50;
const SECOND_WINDOW = 3;
const CONTAINER = 'firefox-container-1';

let browserMock: ReturnType<typeof mockBrowser>;
let openTabs: Map<number, Partial<browser.tabs.Tab>>;

// Keeps a small model of the open tabs behind tabs.get, tabs.query, tabs.create and tabs.remove.
function useTabModel() {
  openTabs = new Map([
    [TAB, { id: TAB, windowId: WINDOW, title: 'Previous', url: 'https://previous.example/', active: true }],
    [OTHER_TAB, { id: OTHER_TAB, windowId: WINDOW, title: 'Other', url: 'https://other.example/', active: false }],
  ]);
  browserMock.tabs.get.mockImplementation(async (tabId) => {
    const tab = openTabs.get(tabId);
    if (!tab) throw new Error(`Invalid tab ID: ${tabId}`);
    return tab;
  });
  browserMock.query.mockImplementation(async (query) => {
    const all = [...openTabs.values()].filter((tab) => tab.windowId === WINDOW);
    return query.active ? all.filter((tab) => tab.active) : all;
  });
  browserMock.tabs.create.mockImplementation(async (properties) => {
    const tab = { id: NEW_TAB, windowId: properties.windowId, url: properties.url, title: '', active: false };
    openTabs.set(NEW_TAB, tab);
    return tab;
  });
  browserMock.windows.getLastFocused.mockResolvedValue({ id: WINDOW, type: 'normal' });
  browserMock.windows.getAll.mockResolvedValue([{ id: WINDOW, type: 'normal', focused: true }]);
  browserMock.windows.get.mockImplementation(async (windowId) => {
    if (windowId === WINDOW) return { id: WINDOW, type: 'normal' };
    if (windowId === POPUP_WINDOW) return { id: POPUP_WINDOW, type: 'popup' };
    throw new Error(`Invalid window ID: ${windowId}`);
  });
}

function closeTab(tabId: number) {
  openTabs.delete(tabId);
  browserMock.tabs.onRemoved.emit(tabId, { windowId: WINDOW, isWindowClosing: false });
}

function tabsContext() {
  const tabs = [...openTabs.values()].map((tab) => ({
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title,
    url: tab.url,
    active: tab.active,
  }));
  const activeTabId = [...openTabs.values()].find((tab) => tab.active)?.id ?? null;
  return JSON.stringify({ tabs, activeTabId });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  browserMock = mockBrowser();
  browserMock.allowSites('example.com', 'other.example', 'previous.example', 'slow.example', 'hang.example', 'nonexistent.invalid', 'popup.example', '127.0.0.1');
  useTabModel();
});

afterEach(() => {
  expect(browserMock.listenerCount()).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

const flush = () => vi.advanceTimersByTimeAsync(0);

function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T } = { settled: false };
  void promise.then((value) => {
    state.settled = true;
    state.value = value;
  });
  return state;
}

function request(tool: string, args: Record<string, unknown>) {
  return { type: 'tool_request' as const, id: '1:7', tool, args };
}

async function run(tool: string, args: Record<string, unknown>, events: () => void = () => {}) {
  const state = track(executeTool(request(tool, args)));
  await flush();
  events();
  await flush();
  return state;
}

function success(text: string) {
  return { type: 'tool_response', id: '1:7', result: { content: [{ type: 'text', text }] } };
}

function failure(text: string) {
  return { type: 'tool_response', id: '1:7', error: { content: [{ type: 'text', text }] } };
}

function denySite(host: string) {
  browserMock.storage.local.data.set(PERMISSION_STORAGE_KEY, [
    { id: 'deny', host, wildcard: false, decision: 'deny', duration: 'always', createdAt: 0 },
  ]);
}

function emitLoad(tabId: number, url: string) {
  const { webNavigation } = browserMock;
  webNavigation.onBeforeNavigate.emit({ tabId, frameId: 0, url });
  webNavigation.onCommitted.emit({ tabId, frameId: 0, url, documentId: TARGET_DOC });
  webNavigation.onCompleted.emit({ tabId, frameId: 0, url, documentId: TARGET_DOC });
}

describe('tabs_create', () => {
  it('opens a blank background tab in the last focused normal window without waiting', async () => {
    const state = await run('tabs_create', {});
    expect(browserMock.tabs.create).toHaveBeenCalledWith({ windowId: WINDOW, url: 'about:blank', active: false, cookieStoreId: CONTAINER });
    expect(browserMock.tabs.update).not.toHaveBeenCalled();
    expect(state.value).toEqual(success(`Created tab ${NEW_TAB}\n\nTabs context: ${tabsContext()}`));
  });

  it('loads a normalized url in the new tab and reports the final url, the title and the tabs context', async () => {
    const state = await run('tabs_create', { url: 'example.com' }, () => {
      openTabs.set(NEW_TAB, { ...openTabs.get(NEW_TAB), url: TARGET, title: 'Example Domain' });
      emitLoad(NEW_TAB, TARGET);
    });
    expect(browserMock.tabs.create).toHaveBeenCalledWith({ windowId: WINDOW, url: 'about:blank', active: false, cookieStoreId: CONTAINER });
    expect(browserMock.tabs.update).toHaveBeenCalledWith(NEW_TAB, { url: TARGET });
    expect(state.value).toEqual(
      success(`Created tab ${NEW_TAB} and navigated to ${TARGET}\nTitle: Example Domain\n\nTabs context: ${tabsContext()}`),
    );
  });

  it('is not misled by the about:blank load of the new tab that Firefox reports after tabs.create', async () => {
    const state = await run('tabs_create', { url: TARGET }, () => {
      emitLoad(NEW_TAB, 'about:blank');
      openTabs.set(NEW_TAB, { ...openTabs.get(NEW_TAB), url: TARGET, title: 'Example Domain' });
      emitLoad(NEW_TAB, TARGET);
    });
    expect(state.value).toEqual(
      success(`Created tab ${NEW_TAB} and navigated to ${TARGET}\nTitle: Example Domain\n\nTabs context: ${tabsContext()}`),
    );
  });

  it('keeps the tab open and says so when the load fails with a network error', async () => {
    const url = 'https://nonexistent.invalid/';
    const state = await run('tabs_create', { url }, () => {
      const { webNavigation } = browserMock;
      webNavigation.onBeforeNavigate.emit({ tabId: NEW_TAB, frameId: 0, url });
      webNavigation.onErrorOccurred.emit({ tabId: NEW_TAB, frameId: 0, url, error: ABORTED, documentId: 'blank' });
      webNavigation.onBeforeNavigate.emit({ tabId: NEW_TAB, frameId: 0, url });
      webNavigation.onErrorOccurred.emit({ tabId: NEW_TAB, frameId: 0, url, error: UNKNOWN_HOST, documentId: 'blank' });
    });
    expect(state.value).toEqual(
      failure(
        `Tab ${NEW_TAB} was created, but the load of ${url} failed: server not found (NS_ERROR_UNKNOWN_HOST, ${UNKNOWN_HOST}); tab ${NEW_TAB} stays open`,
      ),
    );
    expect(browserMock.tabs.remove).not.toHaveBeenCalled();
    expect(openTabs.has(NEW_TAB)).toBe(true);
  });

  it('reports a server that does not respond like navigate does', async () => {
    const url = 'https://hang.example/';
    const state = await run('tabs_create', { url }, () => {
      browserMock.webNavigation.onBeforeNavigate.emit({ tabId: NEW_TAB, frameId: 0, url });
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(state.value).toEqual(
      failure(`Tab ${NEW_TAB} was created, but the load failed: ${url} did not respond within 20 s; tab ${NEW_TAB} stays open`),
    );
  });

  it('reports the page, not a download, when Firefox repeats onBeforeNavigate after the commit', async () => {
    const state = await run('tabs_create', { url: TARGET }, () => {
      const { webNavigation } = browserMock;
      webNavigation.onBeforeNavigate.emit({ tabId: NEW_TAB, frameId: 0, url: 'about:blank' });
      webNavigation.onCommitted.emit({ tabId: NEW_TAB, frameId: 0, url: 'about:blank', documentId: 'blank' });
      webNavigation.onBeforeNavigate.emit({ tabId: NEW_TAB, frameId: 0, url: TARGET });
      webNavigation.onCommitted.emit({ tabId: NEW_TAB, frameId: 0, url: TARGET, documentId: TARGET_DOC });
      webNavigation.onCompleted.emit({ tabId: NEW_TAB, frameId: 0, url: 'about:blank', documentId: TARGET_DOC });
      webNavigation.onBeforeNavigate.emit({ tabId: NEW_TAB, frameId: 0, url: TARGET });
      webNavigation.onErrorOccurred.emit({ tabId: NEW_TAB, frameId: 0, url: TARGET, error: ABORTED, documentId: TARGET_DOC });
      openTabs.set(NEW_TAB, { ...openTabs.get(NEW_TAB), url: TARGET, title: 'Example Domain' });
      webNavigation.onCompleted.emit({ tabId: NEW_TAB, frameId: 0, url: TARGET, documentId: TARGET_DOC });
    });
    expect(state.value).toEqual(
      success(`Created tab ${NEW_TAB} and navigated to ${TARGET}\nTitle: Example Domain\n\nTabs context: ${tabsContext()}`),
    );
  });

  it('reports a download instead of a page', async () => {
    const download = 'https://example.com/file.zip';
    const state = await run('tabs_create', { url: download }, () => {
      browserMock.webNavigation.onBeforeNavigate.emit({ tabId: NEW_TAB, frameId: 0, url: download });
      browserMock.webNavigation.onCompleted.emit({ tabId: NEW_TAB, frameId: 0, url: download, documentId: 'blank' });
    });
    expect(state.value).toEqual(
      success(
        `Created tab ${NEW_TAB}, but ${download} started a download instead of opening a page; tab ${NEW_TAB} stays on about:blank`,
      ),
    );
  });

  it('does not claim the tab stays open when it was closed during the load', async () => {
    const state = await run('tabs_create', { url: TARGET }, () => {
      browserMock.webNavigation.onBeforeNavigate.emit({ tabId: NEW_TAB, frameId: 0, url: TARGET });
      closeTab(NEW_TAB);
    });
    expect(state.value).toEqual(failure(`Tab ${NEW_TAB} was created, but the load failed: tab ${NEW_TAB} was closed`));
  });

  it.each<[string, Partial<browser.windows.Window>[], number]>([
    ['the focused normal window', [{ id: WINDOW, type: 'normal', focused: false }, { id: SECOND_WINDOW, type: 'normal', focused: true }], SECOND_WINDOW],
    ['the last listed normal window', [{ id: SECOND_WINDOW, type: 'normal', focused: false }, { id: WINDOW, type: 'normal', focused: false }], WINDOW],
  ])('opens the tab in %s when a popup window is focused', async (_label, windows, expected) => {
    browserMock.windows.getLastFocused.mockResolvedValue({ id: POPUP_WINDOW, type: 'popup' });
    browserMock.windows.getAll.mockResolvedValue(windows);
    await run('tabs_create', {});
    expect(browserMock.windows.getAll).toHaveBeenCalledWith({ windowTypes: ['normal'] });
    expect(browserMock.tabs.create).toHaveBeenCalledWith({ windowId: expected, url: 'about:blank', active: false, cookieStoreId: CONTAINER });
  });

  it.each<[string, () => void]>([
    ['the last focused window is a popup and there is no normal window', () => {
      browserMock.windows.getLastFocused.mockResolvedValue({ id: POPUP_WINDOW, type: 'popup' });
      browserMock.windows.getAll.mockResolvedValue([]);
    }],
    ['there is no window', () => {
      browserMock.windows.getLastFocused.mockRejectedValue(new Error('No window'));
      browserMock.windows.getAll.mockResolvedValue([]);
    }],
  ])('fails without creating a tab when %s', async (_label, setup) => {
    setup();
    const state = await run('tabs_create', { url: TARGET });
    expect(state.value).toEqual(failure('Failed to create a tab: there is no normal browser window to open it in'));
    expect(browserMock.tabs.create).not.toHaveBeenCalled();
  });

  it.each<[string, Partial<browser.windows.Window>, Partial<browser.windows.Window>[], number]>([
    [
      'the focused private window',
      { id: WINDOW, type: 'normal', incognito: true },
      [{ id: WINDOW, type: 'normal', incognito: true, focused: true }, { id: SECOND_WINDOW, type: 'normal', incognito: false, focused: false }],
      SECOND_WINDOW,
    ],
    [
      'a focused private window listed last',
      { id: POPUP_WINDOW, type: 'popup' },
      [{ id: SECOND_WINDOW, type: 'normal', focused: false }, { id: WINDOW, type: 'normal', incognito: true, focused: true }],
      SECOND_WINDOW,
    ],
  ])('skips %s for a container tab', async (_label, lastFocused, windows, expected) => {
    browserMock.windows.getLastFocused.mockResolvedValue(lastFocused);
    browserMock.windows.getAll.mockResolvedValue(windows);
    await run('tabs_create', {});
    expect(browserMock.tabs.create).toHaveBeenCalledWith({ windowId: expected, url: 'about:blank', active: false, cookieStoreId: CONTAINER });
  });

  it('fails without creating a tab when only private windows are open and a container is used', async () => {
    browserMock.windows.getLastFocused.mockResolvedValue({ id: WINDOW, type: 'normal', incognito: true });
    browserMock.windows.getAll.mockResolvedValue([{ id: WINDOW, type: 'normal', incognito: true, focused: true }]);
    const state = await run('tabs_create', {});
    expect(state.value).toEqual(
      failure(
        'Failed to create a tab: container tabs cannot open in private windows, and no regular browser window is open. The user can open a regular window or switch agent tabs to the normal profile in the extension options.',
      ),
    );
    expect(browserMock.tabs.create).not.toHaveBeenCalled();
  });

  it('opens the tab in the focused private window when the normal profile is used', async () => {
    browserMock.storage.local.data.set(SETTINGS_STORAGE_KEY, { agentTabs: 'default' });
    browserMock.windows.getLastFocused.mockResolvedValue({ id: WINDOW, type: 'normal', incognito: true });
    await run('tabs_create', {});
    expect(browserMock.tabs.create).toHaveBeenCalledWith({ windowId: WINDOW, url: 'about:blank', active: false });
  });

  it('opens the tab in the normal profile when the setting says so', async () => {
    browserMock.storage.local.data.set(SETTINGS_STORAGE_KEY, { agentTabs: 'default' });
    const state = await run('tabs_create', {});
    expect(browserMock.tabs.create).toHaveBeenCalledWith({ windowId: WINDOW, url: 'about:blank', active: false });
    expect(browserMock.contextualIdentities.query).not.toHaveBeenCalled();
    expect(browserMock.contextualIdentities.create).not.toHaveBeenCalled();
    expect(state.value).toEqual(success(`Created tab ${NEW_TAB}\n\nTabs context: ${tabsContext()}`));
  });

  it('opens the tab in the container when the stored setting is invalid', async () => {
    browserMock.storage.local.data.set(SETTINGS_STORAGE_KEY, { agentTabs: 'private' });
    await run('tabs_create', {});
    expect(browserMock.tabs.create).toHaveBeenCalledWith({ windowId: WINDOW, url: 'about:blank', active: false, cookieStoreId: CONTAINER });
  });

  it('reuses one container for parallel calls', async () => {
    const first = track(executeTool(request('tabs_create', {})));
    const second = track(executeTool(request('tabs_create', {})));
    await flush();
    expect(first.settled && second.settled).toBe(true);
    expect(browserMock.contextualIdentities.create).toHaveBeenCalledTimes(1);
    expect(browserMock.tabs.create.mock.calls.map(([properties]) => properties.cookieStoreId)).toEqual([CONTAINER, CONTAINER]);
  });

  it('fails without asking for permission or creating a tab when containers are disabled', async () => {
    const detail = 'Contextual identities are currently disabled';
    browserMock.contextualIdentities.query.mockRejectedValue(new Error(detail));
    const state = await run('tabs_create', { url: 'https://new.example/' });
    expect(state.value).toEqual(failure(containerUnavailableMessage(detail)));
    expect(browserMock.windows.create).not.toHaveBeenCalled();
    expect(browserMock.tabs.create).not.toHaveBeenCalled();
  });

  it('fails without creating a tab when the contextualIdentities API is missing', async () => {
    vi.stubGlobal('browser', { ...browser, contextualIdentities: undefined });
    const state = await run('tabs_create', {});
    expect(state.value).toEqual(failure(containerUnavailableMessage('the contextualIdentities API is not available')));
    expect(browserMock.tabs.create).not.toHaveBeenCalled();
  });

  it('rejects an invalid url with the parser message and creates no tab', async () => {
    const state = await run('tabs_create', { url: 'javascript:alert(1)' });
    expect(state.value).toEqual(
      failure('Failed to create a tab: Unsupported URL scheme "javascript:"; only http and https URLs are allowed'),
    );
    expect(browserMock.tabs.create).not.toHaveBeenCalled();
  });
});

describe('tabs_close', () => {
  it('closes the tab and reports the remaining tabs', async () => {
    browserMock.tabs.remove.mockImplementation(async () => closeTab(OTHER_TAB));
    const state = await run('tabs_close', { tabId: OTHER_TAB });
    expect(browserMock.tabs.remove).toHaveBeenCalledWith(OTHER_TAB);
    expect(state.value).toEqual(success(`Closed tab ${OTHER_TAB}\n\nTabs context: ${tabsContext()}`));
    expect(openTabs.has(OTHER_TAB)).toBe(false);
  });

  it('accepts a removal that tabs.remove resolves before onRemoved arrives', async () => {
    browserMock.tabs.remove.mockImplementation(async () => {
      openTabs.delete(OTHER_TAB);
    });
    const state = await run('tabs_close', { tabId: OTHER_TAB });
    expect(state.value).toEqual(success(`Closed tab ${OTHER_TAB}\n\nTabs context: ${tabsContext()}`));
  });

  it('waits for a removal that completes later', async () => {
    const state = await run('tabs_close', { tabId: OTHER_TAB });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(state.settled).toBe(false);
    closeTab(OTHER_TAB);
    await flush();
    expect(state.value).toEqual(success(`Closed tab ${OTHER_TAB}\n\nTabs context: ${tabsContext()}`));
  });

  it('does not claim success when the tab is still open after 5 s', async () => {
    const state = await run('tabs_close', { tabId: OTHER_TAB });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.value).toEqual(
      failure(
        `Tab ${OTHER_TAB} was not closed within 5 s; the page may be asking to confirm leaving it. The tab stays open.`,
      ),
    );
  });

  it('reports a rejected tabs.remove', async () => {
    browserMock.tabs.remove.mockRejectedValue(new Error('boom'));
    const state = await run('tabs_close', { tabId: OTHER_TAB });
    expect(state.value).toEqual(failure(`Failed to close tab ${OTHER_TAB}: boom`));
  });

  it('reports a tab that does not exist', async () => {
    const state = await run('tabs_close', { tabId: 99 });
    expect(state.value).toEqual(
      failure('Tab 99 does not exist (it may have already been closed). Call tabs_context to see current tabs.'),
    );
    expect(browserMock.tabs.remove).not.toHaveBeenCalled();
  });

  it('refuses to close the last tab of the last normal window', async () => {
    openTabs.delete(OTHER_TAB);
    const state = await run('tabs_close', { tabId: TAB });
    expect(state.value).toEqual(
      failure(
        `Refusing to close tab ${TAB}: it is the last tab of the last browser window, and closing it would close the window and may quit Firefox. Create another tab first with tabs_create.`,
      ),
    );
    expect(browserMock.tabs.remove).not.toHaveBeenCalled();
  });

  it.each<[string, number]>([
    ['a popup window', POPUP_WINDOW],
    ['a window it cannot read', 77],
  ])('refuses a tab in %s', async (_label, windowId) => {
    openTabs.set(20, { id: 20, windowId, url: 'https://popup.example/', active: true });
    const state = await run('tabs_close', { tabId: 20 });
    expect(state.value).toEqual(failure('Failed to close tab 20: it is not in a normal browser window'));
    expect(browserMock.tabs.remove).not.toHaveBeenCalled();
  });

  it('rejects an invalid tabId with the parser message', async () => {
    const state = await run('tabs_close', { tabId: 0 });
    expect(state.value).toEqual(failure('Failed to close the tab: tabId must be a positive safe integer, received 0'));
    expect(browserMock.tabs.get).not.toHaveBeenCalled();
  });

  it('ends a navigate call in flight on the closed tab with its "was closed" error', async () => {
    const navigation = track(executeTool({ ...request('navigate', { tabId: OTHER_TAB, url: TARGET }), id: '1:8' }));
    await flush();
    browserMock.webNavigation.onBeforeNavigate.emit({ tabId: OTHER_TAB, frameId: 0, url: TARGET });
    browserMock.tabs.remove.mockImplementation(async () => closeTab(OTHER_TAB));
    const state = await run('tabs_close', { tabId: OTHER_TAB });
    expect(state.value).toEqual(success(`Closed tab ${OTHER_TAB}\n\nTabs context: ${tabsContext()}`));
    expect(navigation.value).toEqual({
      type: 'tool_response',
      id: '1:8',
      error: { content: [{ type: 'text', text: `Failed to navigate: tab ${OTHER_TAB} was closed` }] },
    });
  });
});

describe('site permissions', () => {
  beforeEach(() => {
    browserMock.windows.create.mockResolvedValue({ id: PROMPT_WINDOW });
  });

  it('tabs_create refuses an always denied site without creating a tab', async () => {
    denySite('example.com');
    const state = await run('tabs_create', { url: TARGET });
    expect(state.value).toEqual(failure(blockedMessage('example.com')));
    expect(browserMock.tabs.create).not.toHaveBeenCalled();
    expect(browserMock.windows.create).not.toHaveBeenCalled();
  });

  it('tabs_create asks for a site without a decision and creates no tab when the prompt is closed', async () => {
    const state = await run('tabs_create', { url: 'https://new.example/' });
    expect(browserMock.windows.create).toHaveBeenCalledTimes(1);
    expect(state.settled).toBe(false);
    browserMock.windows.onRemoved.emit(PROMPT_WINDOW);
    await flush();
    expect(state.value).toEqual(failure(deniedMessage('new.example')));
    expect(browserMock.tabs.create).not.toHaveBeenCalled();
  });

  it('tabs_create resolves the window after approval, while its prompt popup is focused', async () => {
    const url = 'https://new.example/';
    const state = await run('tabs_create', { url });
    expect(browserMock.windows.create).toHaveBeenCalledTimes(1);
    expect(browserMock.windows.getLastFocused).not.toHaveBeenCalled();
    browserMock.windows.getLastFocused.mockResolvedValue({ id: PROMPT_WINDOW, type: 'popup' });
    browserMock.windows.getAll.mockResolvedValue([{ id: WINDOW, type: 'normal', focused: false }]);
    const promptUrl = String(browserMock.windows.create.mock.calls.at(-1)?.[0].url);
    const id = new URL(promptUrl).searchParams.get('id');
    await handlePromptMessage({ type: PROMPT_ANSWER_MESSAGE, id, answer: 'allow_once' }, { id: EXTENSION_ID, url: promptUrl });
    await flush();
    expect(browserMock.tabs.create).toHaveBeenCalledWith({ windowId: WINDOW, url: 'about:blank', active: false, cookieStoreId: CONTAINER });
    openTabs.set(NEW_TAB, { ...openTabs.get(NEW_TAB), url, title: 'New' });
    emitLoad(NEW_TAB, url);
    await flush();
    expect(state.value).toEqual(success(expect.stringMatching(/^Created tab 9 and navigated to https:\/\/new\.example\/\nTitle: New/)));
  });

  it('tabs_create withholds the page a redirect lands on when its host is not approved', async () => {
    const landing = 'https://evil.example/';
    const state = await run('tabs_create', { url: TARGET }, () => {
      openTabs.set(NEW_TAB, { ...openTabs.get(NEW_TAB), url: landing, title: 'Evil' });
      emitLoad(NEW_TAB, landing);
    });
    expect(state.value).toEqual(
      success(
        `Created tab ${NEW_TAB}. Tab ${NEW_TAB} landed on an unapproved host: evil.example. Its title and content are withheld; the next action on this tab will ask the user for permission.`,
      ),
    );
    expect(browserMock.windows.create).not.toHaveBeenCalled();
  });

  it.each(['about:blank', 'about:newtab', undefined])('tabs_close closes a tab on %j without a permission check', async (url) => {
    browserMock.storage.local.data.clear();
    openTabs.set(OTHER_TAB, { ...openTabs.get(OTHER_TAB), url });
    browserMock.tabs.remove.mockImplementation(async () => closeTab(OTHER_TAB));
    const state = await run('tabs_close', { tabId: OTHER_TAB });
    // No stored decision covers previous.example any more, so its tab is listed by origin only.
    const context = JSON.stringify({
      tabs: [{ tabId: TAB, windowId: WINDOW, url: 'https://previous.example', unapproved: true, active: true }],
      activeTabId: TAB,
    });
    expect(state.value).toEqual(success(`Closed tab ${OTHER_TAB}\n\nTabs context: ${context}`));
    expect(browserMock.windows.create).not.toHaveBeenCalled();
  });

  it('tabs_close refuses a tab on an always denied site', async () => {
    denySite('other.example');
    const state = await run('tabs_close', { tabId: OTHER_TAB });
    expect(state.value).toEqual(failure(blockedMessage('other.example')));
    expect(browserMock.tabs.remove).not.toHaveBeenCalled();
  });

  it('tabs_close asks for a site without a decision and keeps the tab when denied', async () => {
    browserMock.storage.local.data.clear();
    const state = await run('tabs_close', { tabId: OTHER_TAB });
    expect(browserMock.windows.create).toHaveBeenCalledTimes(1);
    browserMock.windows.onRemoved.emit(PROMPT_WINDOW);
    await flush();
    expect(state.value).toEqual(failure(deniedMessage('other.example')));
    expect(browserMock.tabs.remove).not.toHaveBeenCalled();
  });

  it('tabs_close does not ask about the last tab, which it refuses anyway', async () => {
    browserMock.storage.local.data.clear();
    openTabs.delete(TAB);
    const state = await run('tabs_close', { tabId: OTHER_TAB });
    expect(state.value).toEqual(failure(expect.stringMatching(/^Refusing to close tab 6: it is the last tab/)));
    expect(browserMock.windows.create).not.toHaveBeenCalled();
  });
});
