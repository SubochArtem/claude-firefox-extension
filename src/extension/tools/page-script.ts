import type { ApprovalPrompt } from '../permissions/approval';
import { siteForUrl } from '../permissions/site';
import { requireSiteAccess } from '../permissions/site-access';
import {
  type ActionLabel,
  errorMessage,
  isPermissionError,
  isRestrictedDomain,
  permissionMessage,
  resolveTab,
  restrictedPageMessage,
} from './tab-access';
import { ToolError } from './tool-error';

export const PAGE_SCRIPT_TIMEOUT_MS = 30_000;

const LABEL: ActionLabel = { verb: 'read the page', target: 'read' };

// A page bundle that installs a function under `entry` on the global of the extension's isolated world.
export interface PageScript<Options, Result> {
  entry: string;
  file: string;
  options: Options;
  isResult: (value: unknown) => value is Result;
}

type Missing = { ok: false; missing: true };

export function pageChangedMessage(tool: string, tabId: number, host: string): string {
  return `Cannot read tab ${tabId}: the page navigated away from ${host} to another site, so nothing was read. Call ${tool} again to read the tab's current page; a page on another site needs its own permission.`;
}

export function stillLoadingMessage(tool: string, tabId: number): string {
  return `Failed to read tab ${tabId}: the page did not answer within ${PAGE_SCRIPT_TIMEOUT_MS / 1000} s; it may still be loading. Wait a moment and call ${tool} again.`;
}

// Serialized into the page, so it must not use anything from this module's scope.
function callEntry(name: string, options: unknown): unknown {
  const entry = (globalThis as unknown as Record<string, unknown>)[name];
  if (typeof entry !== 'function') return { ok: false, missing: true };
  return (entry as (options: unknown) => unknown)(options);
}

function isMissing(value: unknown): value is Missing {
  return typeof value === 'object' && value !== null && (value as Record<string, unknown>).missing === true;
}

async function requireSameSite(tool: string, tabId: number, host: string): Promise<void> {
  const tab = await browser.tabs.get(tabId).catch(() => undefined);
  if (!tab) throw new ToolError(`Cannot read tab ${tabId}: the tab was closed`);
  const site = siteForUrl(tab.url ?? '');
  if (!site.ok || site.host !== host) throw new ToolError(pageChangedMessage(tool, tabId, host));
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

async function runInPage<Options, Result>(tabId: number, url: string, script: PageScript<Options, Result>): Promise<Result> {
  const call = async (): Promise<Result | Missing> => {
    const reply = await execute(tabId, url, { target: { tabId }, func: callEntry, args: [script.entry, script.options] });
    if (isMissing(reply) || script.isResult(reply)) return reply;
    throw new ToolError(`Failed to read tab ${tabId}: the page returned no usable result`);
  };
  let reply = await call();
  if (isMissing(reply)) {
    await execute(tabId, url, { target: { tabId }, files: [script.file] });
    reply = await call();
  }
  if (isMissing(reply)) throw new ToolError(`Failed to read tab ${tabId}: the page script did not load`);
  return reply;
}

function withTimeout<T>(promise: Promise<T>, tool: string, tabId: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ToolError(stillLoadingMessage(tool, tabId))), PAGE_SCRIPT_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Runs a page bundle's entry point in a tab after the read_page_content site gate.
export async function readTabPage<Options, Result>(
  tool: string,
  requestedTabId: number | undefined,
  prompt: ApprovalPrompt,
  script: PageScript<Options, Result>,
): Promise<Result> {
  const tab = await resolveTab(requestedTabId, LABEL);
  const url = tab.url ?? '';
  // Checked before the site permission, so the user is not asked about a page that cannot be read.
  if (isRestrictedDomain(url)) throw new ToolError(restrictedPageMessage(LABEL, tab.id, url));
  if (!(await browser.permissions.contains({ origins: ['<all_urls>'] }))) {
    throw new ToolError(permissionMessage(LABEL.verb));
  }
  const host = await requireSiteAccess(
    { url, tool, action: 'read_page_content', subject: `Cannot read tab ${tab.id} (${url})` },
    prompt,
  );

  // The tab may navigate while the permission prompt is open or while the script runs; content of a
  // page on another site is never returned.
  await requireSameSite(tool, tab.id, host);
  const result = await withTimeout(runInPage(tab.id, url, script), tool, tab.id);
  await requireSameSite(tool, tab.id, host);
  return result;
}
