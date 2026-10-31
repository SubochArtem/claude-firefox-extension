import { ToolError } from './tool-error';

export interface ActionLabel {
  verb: string;
  target: string;
}

export function permissionMessage(verb: string): string {
  return `Failed to ${verb}: the extension is not allowed to access websites. Open about:addons, choose Claude Firefox Extension, open its Permissions tab and enable "Access your data for all websites", then try again.`;
}

// Firefox's default extensions.webextensions.restrictedDomains: no extension may script or capture them.
const RESTRICTED_DOMAINS = new Set([
  'accounts-static.cdn.mozilla.net',
  'accounts.firefox.com',
  'addons.cdn.mozilla.net',
  'addons.mozilla.org',
  'api.accounts.firefox.com',
  'content.cdn.mozilla.net',
  'discovery.addons.mozilla.org',
  'install.mozilla.org',
  'oauth.accounts.firefox.com',
  'profile.accounts.firefox.com',
  'support.mozilla.org',
  'sync.services.mozilla.com',
]);

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return String(error);
}

export async function resolveTab(tabId: number | undefined, label: ActionLabel): Promise<browser.tabs.Tab & { id: number }> {
  if (tabId === undefined) {
    const [active] = await browser.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' });
    if (active?.id === undefined) {
      throw new ToolError(
        `Failed to ${label.verb}: there is no active tab in a normal browser window. Pass a tabId from tabs_context.`,
      );
    }
    return { ...active, id: active.id };
  }
  const tab = await browser.tabs.get(tabId).catch(() => undefined);
  if (!tab) {
    throw new ToolError(
      `Failed to ${label.verb}: tab ${tabId} does not exist (it may have been closed). Call tabs_context to see current tabs.`,
    );
  }
  return { ...tab, id: tabId };
}

export function restrictedPageMessage(label: ActionLabel, tabId: number, url: string): string {
  return `Cannot ${label.target} tab ${tabId} (${url}): Firefox does not let extensions access this page (about: and other browser pages, addons.mozilla.org and other Mozilla sites, other extensions' pages, reader view, the PDF viewer), or the page failed to load. Navigate the tab to a regular website first.`;
}

export function isRestrictedDomain(url: string): boolean {
  return URL.canParse(url) && RESTRICTED_DOMAINS.has(new URL(url).hostname);
}

// Firefox rejects executeScript with "Missing host permission for the tab[, or any frames]" and
// captureTab with "Missing activeTab permission".
export function isPermissionError(message: string): boolean {
  return /missing (host|activeTab) permission/i.test(message);
}
