import { createClaudeCodeRelay } from './chat/claude-code-relay';
import type { BoundTab } from './chat/system-prompt';
import { bidiChannels, connect, RECONNECT_ALARM, sendToNativeHost, setChatHostListener } from './native-bridge';
import { createClaudeCodeStatusHandler, handleOptionsMessage } from './options/options-messages';
import { handlePromptMessage } from './permissions/popup-prompt';
import { createSidebarMessageHandler, SIDEBAR_PAGE } from './sidebar/sidebar-messages';
import { registerConsoleTracking } from './tools/console-tracking';
import { registerNetworkTracking } from './tools/network-tracking';

browser.runtime.onInstalled.addListener((details) => {
  const { version } = browser.runtime.getManifest();
  console.log(`Claude Firefox Extension ${version} installed (reason: ${details.reason})`);
});

// An event page only runs at browser startup if it listens to runtime.onStartup. Every wake
// re-runs this script, so the top-level connect() below does the actual work and these listeners
// exist to wake the page; connect() ignores calls while a port or a retry is already pending.
browser.runtime.onStartup.addListener(connect);

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) connect();
});

browser.runtime.onMessage.addListener(handlePromptMessage);
browser.runtime.onMessage.addListener(handleOptionsMessage);
browser.runtime.onMessage.addListener(createSidebarMessageHandler(bidiChannels));

async function activeTabOf(windowId: number): Promise<BoundTab | undefined> {
  const [tab] = await browser.tabs.query({ active: true, windowId });
  if (tab?.id === undefined) return undefined;
  return { id: tab.id, url: tab.url ?? '', title: tab.title ?? '' };
}

// The open native port keeps this event page loaded; a sidebar port alone does not, so when the host
// is not connected the page may unload and the sidebar sees its port disconnect.
const claudeCodeRelay = createClaudeCodeRelay({
  sendToHost: sendToNativeHost,
  sidebarUrl: browser.runtime.getURL(SIDEBAR_PAGE),
  extensionId: browser.runtime.id,
  activeTab: activeTabOf,
  platform: async () => (await browser.runtime.getPlatformInfo()).os,
});
setChatHostListener(claudeCodeRelay);
browser.runtime.onConnect.addListener(claudeCodeRelay.connect);
browser.runtime.onMessage.addListener(createClaudeCodeStatusHandler(claudeCodeRelay.status));
registerConsoleTracking();
registerNetworkTracking();

connect();
