import type { ContentBlock } from '../protocol';
import { NavigationError, navigateTab } from './navigate';
import { parseTabsCloseArgs, parseTabsCreateArgs } from './navigation-input';
import { tabsContextText } from './tabs-context';
import { ToolError } from './tool-error';

// Below the host's 30 s tool request timeout. A beforeunload prompt keeps the tab open until the user
// answers it, which may take longer than this.
export const TAB_CLOSE_TIMEOUT_MS = 5_000;

async function withTabsContext(text: string): Promise<ContentBlock[]> {
  return [{ type: 'text', text: `${text}\n\nTabs context: ${await tabsContextText()}` }];
}

async function lastFocusedNormalWindowId(): Promise<number> {
  // Firefox ignores the windowTypes filter of windows.getLastFocused, so the type is checked here.
  const window = await browser.windows.getLastFocused().catch(() => undefined);
  if (window?.type !== 'normal' || window.id === undefined) {
    throw new ToolError('Failed to create a tab: there is no normal browser window to open it in');
  }
  return window.id;
}

export async function tabsCreate(args: Record<string, unknown>): Promise<ContentBlock[]> {
  const parsed = parseTabsCreateArgs(args);
  if (!parsed.ok) throw new ToolError(`Failed to create a tab: ${parsed.error}`);
  const { url } = parsed.value;
  const windowId = await lastFocusedNormalWindowId();
  // Without a url Firefox would open the new tab page; about:blank keeps the tab empty.
  const tab = await browser.tabs.create({ windowId, url: 'about:blank', active: false });
  const tabId = tab.id;
  if (tabId === undefined) throw new Error('the new tab has no id');
  if (url === undefined) return withTabsContext(`Created tab ${tabId}`);

  try {
    return await navigateTab(tabId, { kind: 'url', url }, tab, {
      headline: (finalUrl) => `Created tab ${tabId} and navigated to ${finalUrl}`,
      download: (finalUrl, stayUrl) =>
        `Created tab ${tabId}, but ${finalUrl} started a download instead of opening a page; tab ${tabId} stays on ${stayUrl}`,
    });
  } catch (error) {
    if (!(error instanceof NavigationError)) throw error;
    const failed = error.url === undefined ? 'the load failed' : `the load of ${error.url} failed`;
    const stays = error.tabClosed ? '' : `; tab ${tabId} stays open`;
    throw new ToolError(`Tab ${tabId} was created, but ${failed}: ${error.detail}${stays}`);
  }
}

// Resolves true once the tab is gone, false if it is still open after the timeout. The listener is
// registered before tabs.remove so a fast removal is not missed.
function removeTab(tabId: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onRemoved = (removedTabId: number) => {
      if (removedTabId === tabId) finish(true);
    };
    function cleanup() {
      settled = true;
      clearTimeout(timer);
      browser.tabs.onRemoved.removeListener(onRemoved);
    }
    function finish(closed: boolean) {
      if (settled) return;
      cleanup();
      resolve(closed);
    }
    browser.tabs.onRemoved.addListener(onRemoved);
    browser.tabs.remove(tabId).then(
      async () => {
        if (settled) return;
        // Firefox may resolve tabs.remove before onRemoved fires; a tab that is gone counts as removed.
        const stillOpen = await browser.tabs.get(tabId).then(
          () => true,
          () => false,
        );
        if (settled) return;
        if (!stillOpen) finish(true);
        else timer = setTimeout(() => finish(false), TAB_CLOSE_TIMEOUT_MS);
      },
      (error: unknown) => {
        if (settled) return;
        cleanup();
        reject(error);
      },
    );
  });
}

export async function tabsClose(args: Record<string, unknown>): Promise<ContentBlock[]> {
  const parsed = parseTabsCloseArgs(args);
  if (!parsed.ok) throw new ToolError(`Failed to close the tab: ${parsed.error}`);
  const { tabId } = parsed.value;
  const tab = await browser.tabs.get(tabId).catch(() => undefined);
  if (!tab) {
    throw new ToolError(
      `Tab ${tabId} does not exist (it may have already been closed). Call tabs_context to see current tabs.`,
    );
  }
  const window = tab.windowId === undefined ? undefined : await browser.windows.get(tab.windowId).catch(() => undefined);
  if (window?.type !== 'normal') {
    throw new ToolError(`Failed to close tab ${tabId}: it is not in a normal browser window`);
  }
  const normalTabs = await browser.tabs.query({ windowType: 'normal' });
  if (normalTabs.length <= 1) {
    throw new ToolError(
      `Refusing to close tab ${tabId}: it is the last tab of the last browser window, and closing it would close the window and may quit Firefox. Create another tab first with tabs_create.`,
    );
  }

  let closed: boolean;
  try {
    closed = await removeTab(tabId);
  } catch (error) {
    throw new ToolError(`Failed to close tab ${tabId}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!closed) {
    throw new ToolError(
      `Tab ${tabId} was not closed within ${TAB_CLOSE_TIMEOUT_MS / 1000} s; the page may be asking to confirm leaving it. The tab stays open.`,
    );
  }
  return withTabsContext(`Closed tab ${tabId}`);
}
