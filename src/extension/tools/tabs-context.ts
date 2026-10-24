import type { ContentBlock } from '../protocol';

export async function tabsContext(): Promise<ContentBlock[]> {
  const [tabs, activeTabs] = await Promise.all([
    browser.tabs.query({ windowType: 'normal' }),
    browser.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' }),
  ]);
  const context = {
    tabs: tabs
      .filter((tab) => tab.id !== undefined)
      .map((tab) => ({
        tabId: tab.id,
        windowId: tab.windowId,
        title: tab.title,
        url: tab.url,
        active: tab.active,
      })),
    activeTabId: activeTabs[0]?.id ?? null,
  };
  return [{ type: 'text', text: JSON.stringify(context) }];
}
