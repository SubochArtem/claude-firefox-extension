import type { PermissionAction } from '../permissions/actions';
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

// A page bundle that installs a function under `entry` on the global of the extension's isolated world.
export interface PageScript<Options, Result> {
  entry: string;
  file: string;
  options: Options;
  isResult: (value: unknown) => value is Result;
}

// What a page tool does on the site: the permission it needs and the wording of its errors.
export interface PageAccess {
  action: PermissionAction;
  label: ActionLabel;
  pageChanged: (tool: string, tabId: number, host: string) => string;
}

type Missing = { ok: false; missing: true };

export function pageChangedMessage(tool: string, tabId: number, host: string): string {
  return `Cannot read tab ${tabId}: the page navigated away from ${host} to another site, so nothing was read. Call ${tool} again to read the tab's current page; a page on another site needs its own permission.`;
}

export const READ_ACCESS: PageAccess = {
  action: 'read_page_content',
  label: { verb: 'read the page', target: 'read' },
  pageChanged: pageChangedMessage,
};

export function stillLoadingMessage(tool: string, tabId: number, target = 'read'): string {
  return `Failed to ${target} tab ${tabId}: the page did not answer within ${PAGE_SCRIPT_TIMEOUT_MS / 1000} s; it may still be loading. Wait a moment and call ${tool} again.`;
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

async function requireSameSite(tool: string, tabId: number, host: string, access: PageAccess): Promise<void> {
  const tab = await browser.tabs.get(tabId).catch(() => undefined);
  if (!tab) throw new ToolError(`Cannot ${access.label.target} tab ${tabId}: the tab was closed`);
  const site = siteForUrl(tab.url ?? '');
  if (!site.ok || site.host !== host) throw new ToolError(access.pageChanged(tool, tabId, host));
}

async function injectionFailure(tabId: number, url: string, error: unknown, label: ActionLabel): Promise<ToolError> {
  const message = errorMessage(error);
  if (!isPermissionError(message)) return new ToolError(`Failed to ${label.target} tab ${tabId}: ${message}`);
  if (!(await browser.permissions.contains({ origins: ['<all_urls>'] }))) {
    return new ToolError(permissionMessage(label.verb));
  }
  return new ToolError(restrictedPageMessage(label, tabId, url));
}

async function execute<Args extends unknown[], Result>(
  tabId: number,
  url: string,
  label: ActionLabel,
  injection: browser.scripting.ScriptInjection<Args, Result>,
): Promise<Result | undefined> {
  let results: browser.scripting.InjectionResult<Result>[];
  try {
    results = await browser.scripting.executeScript(injection);
  } catch (error) {
    throw await injectionFailure(tabId, url, error, label);
  }
  const [main] = results;
  if (main === undefined) throw new ToolError(restrictedPageMessage(label, tabId, url));
  if (main.error !== undefined) {
    throw new ToolError(`Failed to ${label.target} tab ${tabId}: ${errorMessage(main.error)}`);
  }
  return main.result;
}

async function runInPage<Options, Result>(
  tabId: number,
  url: string,
  script: PageScript<Options, Result>,
  label: ActionLabel,
): Promise<Result> {
  const call = async (): Promise<Result | Missing> => {
    const reply = await execute(tabId, url, label, {
      target: { tabId },
      func: callEntry,
      args: [script.entry, script.options],
    });
    if (isMissing(reply) || script.isResult(reply)) return reply;
    throw new ToolError(`Failed to ${label.target} tab ${tabId}: the page returned no usable result`);
  };
  let reply = await call();
  if (isMissing(reply)) {
    await execute(tabId, url, label, { target: { tabId }, files: [script.file] });
    reply = await call();
  }
  if (isMissing(reply)) throw new ToolError(`Failed to ${label.target} tab ${tabId}: the page script did not load`);
  return reply;
}

function withTimeout<T>(promise: Promise<T>, tool: string, tabId: number, target: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ToolError(stillLoadingMessage(tool, tabId, target))), PAGE_SCRIPT_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Runs a page bundle's entry point in a tab after the site gate for the access's action.
export async function readTabPage<Options, Result>(
  tool: string,
  requestedTabId: number | undefined,
  prompt: ApprovalPrompt,
  script: PageScript<Options, Result>,
  access: PageAccess = READ_ACCESS,
): Promise<Result> {
  const { label } = access;
  const tab = await resolveTab(requestedTabId, label);
  const url = tab.url ?? '';
  // Checked before the site permission, so the user is not asked about a page that cannot be reached.
  if (isRestrictedDomain(url)) throw new ToolError(restrictedPageMessage(label, tab.id, url));
  if (!(await browser.permissions.contains({ origins: ['<all_urls>'] }))) {
    throw new ToolError(permissionMessage(label.verb));
  }
  const host = await requireSiteAccess(
    { url, tool, action: access.action, subject: `Cannot ${label.target} tab ${tab.id} (${url})` },
    prompt,
  );

  // The tab may navigate while the permission prompt is open or while the script runs; content of a
  // page on another site is never returned.
  await requireSameSite(tool, tab.id, host, access);
  const result = await withTimeout(runInPage(tab.id, url, script, label), tool, tab.id, label.target);
  await requireSameSite(tool, tab.id, host, access);
  return result;
}
