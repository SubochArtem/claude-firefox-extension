import { formatRemoteValue } from '../../host/remote-value-format';
import { evaluateInMainWorld, type MainWorldEvalResult } from '../page/main-world-eval';
import type { ApprovalPrompt } from '../permissions/approval';
import { siteForUrl } from '../permissions/site';
import { landedSite } from '../permissions/site-access';
import type { ContentBlock } from '../protocol';
import { type BidiEvaluateChannel, type EvaluateOutcome, evaluateInTab } from './bidi-evaluate';
import { type BidiInputChannel, BidiUnavailableError } from './bidi-input';
import { parseJavascriptArgs } from './javascript-input';
import { injectionFailure, type OpenTab, openTabPage, type PageAccess, requireSameSite } from './page-script';
import { errorMessage, restrictedPageMessage } from './tab-access';
import { ToolError } from './tool-error';

const TOOL = 'javascript_tool';
export const FALLBACK_TIMEOUT_MS = 30_000;
export const CODE_PREVIEW_CHARS = 300;
const MAX_PAGE_NAME_CHARS = 60;

export function javascriptPageChangedMessage(_tool: string, tabId: number, host: string): string {
  return `Cannot run JavaScript in tab ${tabId}: the page navigated away from ${host} to another site, so the script was not run. Check the tab's current page before trying again; a page on another site needs its own permission.`;
}

const ACCESS: PageAccess = {
  action: 'execute_javascript',
  label: { verb: 'run JavaScript', target: 'run JavaScript in' },
  pageChanged: javascriptPageChangedMessage,
};

export function codePreview(code: string): string {
  const trimmed = code.trim();
  return trimmed.length > CODE_PREVIEW_CHARS ? `${trimmed.slice(0, CODE_PREVIEW_CHARS)}… (${trimmed.length} characters)` : trimmed;
}

function nonSitePage(url: string | undefined): string {
  if (url === undefined || url === '') return 'a page whose address is not available';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'a page with an invalid address';
  }
  const name = parsed.protocol === 'about:' ? `${parsed.protocol}${parsed.pathname}` : `a ${parsed.protocol.slice(0, -1)} page`;
  return `${name.slice(0, MAX_PAGE_NAME_CHARS)}, which site permissions do not cover (only http and https pages)`;
}

// The reason names the landed page: an http(s) host without permission, or a page no site permission can cover.
export function withheldText(tabId: number, url: string | undefined): string {
  const site = siteForUrl(url ?? '');
  const where = site.ok ? `${site.host}, which has no site permission` : nonSitePage(url);
  return `The script ran, but tab ${tabId} is now on ${where}, so its result is withheld. Check the tab with tabs_context; the next action on the new page will ask the user for permission.`;
}

export function closedText(tabId: number): string {
  return `The script ran, but tab ${tabId} was closed afterwards, so its result is withheld.`;
}

export function fallbackTimeoutMessage(tabId: number): string {
  return `The script in tab ${tabId} did not finish within ${FALLBACK_TIMEOUT_MS / 1000} s. A page script cannot be stopped, so it may still be running in the page.`;
}

export function blockedMessage(tabId: number, cause: string): string {
  return `Cannot run JavaScript in tab ${tabId}: WebDriver BiDi is unavailable and the page's Content Security Policy blocks eval, which the fallback needs. Start Firefox with --remote-debugging-port so the script runs through WebDriver BiDi, which the page's policy does not block. Cause: ${cause}`;
}

export function evalFallbackWarning(cause: string): string {
  return `Warning: WebDriver BiDi is unavailable, so the script ran with eval in the page's main world, which the page's Content Security Policy may block. For WebDriver BiDi, start Firefox with --remote-debugging-port. Cause: ${cause}`;
}

function isResult(value: unknown): value is MainWorldEvalResult {
  if (typeof value !== 'object' || value === null) return false;
  const reply = value as Record<string, unknown>;
  if (reply.kind === 'value') return 'value' in reply;
  return (reply.kind === 'exception' || reply.kind === 'blocked') && typeof reply.text === 'string';
}

// executeScript has no way to stop a page script, so the timeout only stops waiting for it.
async function evaluateInMainWorldOf(tab: OpenTab, code: string): Promise<EvaluateOutcome> {
  const { tabId } = tab;
  const url = await requireSameSite(TOOL, tabId, tab.host, ACCESS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ToolError(fallbackTimeoutMessage(tabId))), FALLBACK_TIMEOUT_MS);
  });
  const injection = browser.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: evaluateInMainWorld, args: [code] });
  let results: browser.scripting.InjectionResult<unknown>[];
  try {
    results = await Promise.race([injection, timeout]);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw await injectionFailure(tabId, url, error, ACCESS.label);
  } finally {
    clearTimeout(timer);
  }
  const [main] = results;
  if (main === undefined) throw new ToolError(restrictedPageMessage(ACCESS.label, tabId, url));
  if (main.error !== undefined) throw new ToolError(`Failed to run JavaScript in tab ${tabId}: ${errorMessage(main.error)}`);
  const result = main.result;
  if (!isResult(result)) throw new ToolError(`Failed to run JavaScript in tab ${tabId}: the page returned no usable result`);
  switch (result.kind) {
    case 'blocked':
      throw new ToolError(blockedMessage(tabId, result.text));
    case 'exception':
      return { exception: result.text };
    case 'value':
      return { value: formatRemoteValue(result.value) };
  }
}

// The script runs through WebDriver BiDi script.evaluate; eval in the page's MAIN world is used only when
// the native host reports BiDi itself unavailable, like the synthetic input fallback.
async function evaluate(
  tab: OpenTab,
  code: string,
  channel: BidiEvaluateChannel | undefined,
): Promise<{ outcome: EvaluateOutcome; warning?: string }> {
  const url = await requireSameSite(TOOL, tab.tabId, tab.host, ACCESS);
  try {
    return { outcome: await evaluateInTab(channel, tab.tabId, url, code) };
  } catch (error) {
    if (!(error instanceof BidiUnavailableError)) throw error;
    return { outcome: await evaluateInMainWorldOf(tab, code), warning: evalFallbackWarning(error.message) };
  }
}

// The script may navigate the tab, so nothing it returned is shown unless the tab is still on an allowed site.
async function withheldNote(tab: OpenTab): Promise<string | undefined> {
  const current = await browser.tabs.get(tab.tabId).catch(() => undefined);
  if (!current) return closedText(tab.tabId);
  const landed = await landedSite(current.url, tab.host);
  return landed.allowed ? undefined : withheldText(tab.tabId, current.url);
}

export async function javascriptTool(
  args: Record<string, unknown>,
  prompt: ApprovalPrompt,
  _input?: BidiInputChannel,
  channel?: BidiEvaluateChannel,
): Promise<ContentBlock[]> {
  const parsed = parseJavascriptArgs(args);
  if (!parsed.ok) throw new ToolError(`Invalid javascript_tool arguments: ${parsed.error}`);
  const { text: code, tabId } = parsed.value;
  const tab = await openTabPage(TOOL, tabId, prompt, ACCESS, codePreview(code));
  const { outcome, warning } = await evaluate(tab, code, channel);
  const note = await withheldNote(tab);
  if (note !== undefined) return [{ type: 'text', text: warning === undefined ? note : `${note}\n${warning}` }];
  if ('exception' in outcome) {
    throw new ToolError(`JavaScript error: ${outcome.exception}${warning === undefined ? '' : `\n\n${warning}`}`);
  }
  return [{ type: 'text', text: warning === undefined ? outcome.value : `${outcome.value}\n\n${warning}` }];
}
