import { READ_PAGE_ENTRY, READ_PAGE_SCRIPT, type ReadPageOptions, type ReadPageResult } from '../page/read-page-api';
import type { ApprovalPrompt } from '../permissions/approval';
import { siteForUrl } from '../permissions/site';
import { requireSiteAccess } from '../permissions/site-access';
import type { ContentBlock } from '../protocol';
import {
  type ActionLabel,
  errorMessage,
  isPermissionError,
  isRestrictedDomain,
  permissionMessage,
  resolveTab,
  restrictedPageMessage,
} from './tab-access';
import { parseReadPageArgs } from './read-page-input';
import { ToolError } from './tool-error';

export const READ_PAGE_TIMEOUT_MS = 30_000;

const LABEL: ActionLabel = { verb: 'read the page', target: 'read' };

type EntryReply = ReadPageResult | { ok: false; missing: true };

export function pageChangedMessage(tabId: number, host: string): string {
  return `Cannot read tab ${tabId}: the page navigated away from ${host} to another site, so nothing was read. Call read_page again to read the tab's current page; a page on another site needs its own permission.`;
}

export function stillLoadingMessage(tabId: number): string {
  return `Failed to read tab ${tabId}: the page did not answer within ${READ_PAGE_TIMEOUT_MS / 1000} s; it may still be loading. Wait a moment and call read_page again.`;
}

// Serialized into the page, so it must not use anything from this module's scope.
function callEntry(name: string, options: ReadPageOptions): EntryReply {
  const entry = (globalThis as unknown as Record<string, unknown>)[name];
  if (typeof entry !== 'function') return { ok: false, missing: true };
  return (entry as (options: ReadPageOptions) => ReadPageResult)(options);
}

async function requireSameSite(tabId: number, host: string): Promise<void> {
  const tab = await browser.tabs.get(tabId).catch(() => undefined);
  if (!tab) throw new ToolError(`Cannot read tab ${tabId}: the tab was closed`);
  const site = siteForUrl(tab.url ?? '');
  if (!site.ok || site.host !== host) throw new ToolError(pageChangedMessage(tabId, host));
}

async function injectionFailure(tabId: number, url: string, error: unknown): Promise<ToolError> {
  const message = errorMessage(error);
  if (!isPermissionError(message)) return new ToolError(`Failed to read tab ${tabId}: ${message}`);
  if (!(await browser.permissions.contains({ origins: ['<all_urls>'] }))) {
    return new ToolError(permissionMessage(LABEL.verb));
  }
  return new ToolError(restrictedPageMessage(LABEL, tabId, url));
}

async function execute<Args extends unknown[], Result>(
  tabId: number,
  url: string,
  injection: browser.scripting.ScriptInjection<Args, Result>,
): Promise<Result | undefined> {
  let results: browser.scripting.InjectionResult<Result>[];
  try {
    results = await browser.scripting.executeScript(injection);
  } catch (error) {
    throw await injectionFailure(tabId, url, error);
  }
  const [main] = results;
  if (main === undefined) throw new ToolError(restrictedPageMessage(LABEL, tabId, url));
  if (main.error !== undefined) throw new ToolError(`Failed to read tab ${tabId}: ${errorMessage(main.error)}`);
  return main.result;
}

function isReply(value: unknown): value is EntryReply {
  if (typeof value !== 'object' || value === null) return false;
  const reply = value as Record<string, unknown>;
  if (reply.ok === false) return reply.missing === true || typeof reply.error === 'string';
  const viewport = reply.viewport as Record<string, unknown> | undefined;
  return (
    reply.ok === true &&
    typeof reply.tree === 'string' &&
    typeof viewport?.width === 'number' &&
    typeof viewport.height === 'number'
  );
}

async function readInPage(tabId: number, url: string, options: ReadPageOptions): Promise<ReadPageResult> {
  const call = async (): Promise<EntryReply> => {
    const reply = await execute(tabId, url, { target: { tabId }, func: callEntry, args: [READ_PAGE_ENTRY, options] });
    if (!isReply(reply)) throw new ToolError(`Failed to read tab ${tabId}: the page returned no usable result`);
    return reply;
  };
  let reply = await call();
  if ('missing' in reply) {
    await execute(tabId, url, { target: { tabId }, files: [READ_PAGE_SCRIPT] });
    reply = await call();
  }
  if ('missing' in reply) throw new ToolError(`Failed to read tab ${tabId}: the page script did not load`);
  return reply;
}

function withTimeout<T>(promise: Promise<T>, tabId: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ToolError(stillLoadingMessage(tabId))), READ_PAGE_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function emptyTreeText(options: ReadPageOptions): string {
  return options.filter === 'interactive'
    ? 'No visible interactive elements found on the page. Try filter "all".'
    : 'No visible elements found on the page; it may be empty or still loading.';
}

export async function readPage(args: Record<string, unknown>, prompt: ApprovalPrompt): Promise<ContentBlock[]> {
  const parsed = parseReadPageArgs(args);
  if (!parsed.ok) throw new ToolError(`Invalid read_page arguments: ${parsed.error}`);
  const { tabId: requestedTabId, ...options } = parsed.value;
  const tab = await resolveTab(requestedTabId, LABEL);
  const url = tab.url ?? '';
  // Checked before the site permission, so the user is not asked about a page that cannot be read.
  if (isRestrictedDomain(url)) throw new ToolError(restrictedPageMessage(LABEL, tab.id, url));
  if (!(await browser.permissions.contains({ origins: ['<all_urls>'] }))) {
    throw new ToolError(permissionMessage(LABEL.verb));
  }
  const host = await requireSiteAccess(
    { url, tool: 'read_page', action: 'read_page_content', subject: `Cannot read tab ${tab.id} (${url})` },
    prompt,
  );

  // The tab may navigate while the permission prompt is open or while the script runs; the tree of a
  // page on another site is never returned.
  await requireSameSite(tab.id, host);
  const result = await withTimeout(readInPage(tab.id, url, options), tab.id);
  await requireSameSite(tab.id, host);
  if (!result.ok) throw new ToolError(result.error);

  const tree = result.tree === '' ? emptyTreeText(options) : result.tree;
  return [{ type: 'text', text: `${tree}\n\nViewport: ${result.viewport.width}x${result.viewport.height}` }];
}
