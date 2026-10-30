import { checkPermission, type PermissionRecord } from '../permissions/permission-model';
import { loadPermissions } from '../permissions/permission-store';
import { siteForUrl } from '../permissions/site';
import type { ContentBlock } from '../protocol';

interface TabEntry {
  tabId: number;
  windowId: number | undefined;
  title?: string;
  url: string | undefined;
  unapproved?: true;
  active: boolean;
}

// A tab's title and path may carry private data or injected text from a site the user never
// approved, so for http(s) tabs without an allow only the origin is listed. This only reads the
// records: it neither prompts nor consumes or touches them.
function describeTab(
  tab: browser.tabs.Tab & { id: number },
  records: PermissionRecord[],
  now: number,
  approvedHost: string | undefined,
): TabEntry {
  const entry: TabEntry = { tabId: tab.id, windowId: tab.windowId, title: tab.title, url: tab.url, active: tab.active };
  const url = tab.url ?? '';
  const site = siteForUrl(url);
  if (!site.ok || site.host === approvedHost) return entry;
  if (checkPermission(records, url, { now }).outcome.kind === 'allowed') return entry;
  return { tabId: tab.id, windowId: tab.windowId, url: new URL(url).origin, unapproved: true, active: tab.active };
}

// approvedHost is the host the user allowed for the current call, which an allow-once answer does not store.
export async function tabsContextText(approvedHost?: string): Promise<string> {
  const [tabs, activeTabs, records] = await Promise.all([
    browser.tabs.query({ windowType: 'normal' }),
    browser.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' }),
    loadPermissions(),
  ]);
  const now = Date.now();
  const context = {
    tabs: tabs
      .filter((tab): tab is browser.tabs.Tab & { id: number } => tab.id !== undefined)
      .map((tab) => describeTab(tab, records, now, approvedHost)),
    activeTabId: activeTabs[0]?.id ?? null,
  };
  return JSON.stringify(context);
}

export async function tabsContext(): Promise<ContentBlock[]> {
  return [{ type: 'text', text: await tabsContextText() }];
}
