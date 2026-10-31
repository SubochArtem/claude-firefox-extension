import type { ApprovalPrompt } from '../permissions/approval';
import { siteForUrl } from '../permissions/site';
import { landedSite, requireSiteAccess } from '../permissions/site-access';
import type { ContentBlock } from '../protocol';
import { type NavigateTarget, parseNavigateArgs } from './navigation-input';
import { tabsContextText } from './tabs-context';
import { ToolError } from './tool-error';

export const NAVIGATION_START_TIMEOUT_MS = 2_000;
// With a permission prompt before it, still below the host's tool request timeout (TOOL_REQUEST_TIMEOUT_MS
// in host/protocol.ts), so the agent gets this tool's own answer.
export const NAVIGATION_TIMEOUT_MS = 20_000;

// Firefox reports the cancelled load of the previous document with this error right after a new
// navigation starts, so it only counts once it belongs to the document committed for the new one.
const NS_BINDING_ABORTED = 'Error code 2152398850';

const NETWORK_ERRORS = new Map<number, [description: string, name: string]>([
  [2152398850, ['the load was aborted', 'NS_BINDING_ABORTED']],
  [2152398861, ['connection refused', 'NS_ERROR_CONNECTION_REFUSED']],
  [2152398862, ['connection timed out', 'NS_ERROR_NET_TIMEOUT']],
  [2152398864, ['the browser is offline', 'NS_ERROR_OFFLINE']],
  [2152398868, ['connection reset', 'NS_ERROR_NET_RESET']],
  [2152398878, ['server not found', 'NS_ERROR_UNKNOWN_HOST']],
  [2152398879, ['redirect loop', 'NS_ERROR_REDIRECT_LOOP']],
]);

const HISTORY_PREFIX: Record<NavigateTarget['kind'], string> = {
  url: 'Navigated to',
  back: 'Navigated back to',
  forward: 'Navigated forward to',
};

export type NavigationOutcome =
  | { status: 'loaded' | 'still-loading' | 'same-document' | 'download' | 'no-response'; url: string }
  | { status: 'error'; url: string; error: string | undefined }
  | { status: 'not-started' | 'closed' | 'superseded' };

// Firefox sends documentId, which @types/firefox-webext-browser does not declare.
interface FrameDetails {
  tabId: number;
  frameId: number;
  url: string;
  documentId?: string;
}

interface SameDocumentDetails extends FrameDetails {
  transitionQualifiers?: string[];
}

// Ends the wait of the navigate call currently in flight in each tab.
const inFlight = new Map<number, () => void>();

function isSameDocument(committed: FrameDetails, completed: FrameDetails): boolean {
  if (committed.documentId !== undefined && completed.documentId !== undefined) {
    return committed.documentId === completed.documentId;
  }
  return committed.url === completed.url;
}

// Events of the previous page keep arriving while it is torn down, so only main-frame events after
// an onBeforeNavigate that followed the call count, and onCompleted must belong to the document
// committed after it. An onCompleted for the requested url without a commit is a download; a download
// behind a redirect completes with another url and ends in no-response. A newer wait in the same tab
// ends this one as superseded, because the events of both navigations cannot be told apart.
// Firefox starts a load over with a second onBeforeNavigate and reports the superseded load with one
// NS_BINDING_ABORTED. These events race the commit: the restart and its abort can follow onCommitted,
// and the abort then carries the documentId of the committed document. So every restart excuses one
// abort, and a document committed for the url its navigation started with survives the restart.
export function waitForNavigation(
  tabId: number,
  target: NavigateTarget,
  start: () => Promise<unknown>,
): Promise<NavigationOutcome> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let startedUrl: string | undefined;
    let committed: FrameDetails | undefined;
    const startedCommits: FrameDetails[] = [];
    let restarts = 0;
    let aborts = 0;
    let startTimer: ReturnType<typeof setTimeout> | undefined;

    // A tab created with about:blank reports that load only after tabs.create has resolved, so its
    // events can reach a wait for an http(s) url that started right after; no such url ends on about:blank.
    const isMainFrame = (details: FrameDetails) =>
      details.tabId === tabId &&
      details.frameId === 0 &&
      !(target.kind === 'url' && details.url === 'about:blank');

    const onBeforeNavigate = (details: FrameDetails) => {
      if (!isMainFrame(details)) return;
      if (startedUrl !== undefined) restarts++;
      startedUrl = details.url;
      committed = undefined;
    };
    const onCommitted = (details: FrameDetails) => {
      if (!isMainFrame(details) || startedUrl === undefined) return;
      committed = details;
      if (details.url === startedUrl) startedCommits.push(details);
    };
    const onCompleted = (details: FrameDetails) => {
      if (!isMainFrame(details) || startedUrl === undefined) return;
      if (
        (committed && isSameDocument(committed, details)) ||
        startedCommits.some((commit) => isSameDocument(commit, details))
      ) {
        finish({ status: 'loaded', url: details.url });
      } else if (!committed && details.url === startedUrl) {
        finish({ status: 'download', url: details.url });
      }
    };
    const onErrorOccurred = (details: FrameDetails & { error?: string }) => {
      if (!isMainFrame(details) || startedUrl === undefined) return;
      if (details.error === NS_BINDING_ABORTED) {
        // Deliberate trade-off to tolerate Firefox's varying event order: after a restart a genuine
        // abort arriving before the stale one is swallowed, and the wait ends in still-loading or
        // no-response at the timeout instead of an error.
        aborts++;
        if (aborts <= restarts || !(committed && isSameDocument(committed, details))) return;
      }
      finish({ status: 'error', url: details.url, error: details.error });
    };
    const onSameDocument = (details: SameDocumentDetails) => {
      if (!isMainFrame(details)) return;
      // Firefox marks a history traversal with forward_back; the page's own pushState, replaceState or
      // fragment change carries no qualifier and must not pass for a history step that never happened.
      const matches =
        target.kind === 'url'
          ? details.url === target.url
          : startedUrl === undefined && (details.transitionQualifiers ?? []).includes('forward_back');
      if (matches) finish({ status: 'same-document', url: details.url });
    };
    const onRemoved = (removedTabId: number) => {
      if (removedTabId === tabId) finish({ status: 'closed' });
    };

    const supersede = () => finish({ status: 'superseded' });
    inFlight.get(tabId)?.();
    inFlight.set(tabId, supersede);

    const { webNavigation, tabs } = browser;
    webNavigation.onBeforeNavigate.addListener(onBeforeNavigate);
    webNavigation.onCommitted.addListener(onCommitted);
    webNavigation.onCompleted.addListener(onCompleted);
    webNavigation.onErrorOccurred.addListener(onErrorOccurred);
    webNavigation.onReferenceFragmentUpdated.addListener(onSameDocument);
    webNavigation.onHistoryStateUpdated.addListener(onSameDocument);
    tabs.onRemoved.addListener(onRemoved);

    const overallTimer = setTimeout(() => {
      const lastCommit = committed ?? startedCommits[startedCommits.length - 1];
      if (lastCommit) finish({ status: 'still-loading', url: lastCommit.url });
      else if (startedUrl !== undefined) finish({ status: 'no-response', url: startedUrl });
      else finish({ status: 'not-started' });
    }, NAVIGATION_TIMEOUT_MS);

    function cleanup() {
      settled = true;
      if (inFlight.get(tabId) === supersede) inFlight.delete(tabId);
      clearTimeout(overallTimer);
      clearTimeout(startTimer);
      webNavigation.onBeforeNavigate.removeListener(onBeforeNavigate);
      webNavigation.onCommitted.removeListener(onCommitted);
      webNavigation.onCompleted.removeListener(onCompleted);
      webNavigation.onErrorOccurred.removeListener(onErrorOccurred);
      webNavigation.onReferenceFragmentUpdated.removeListener(onSameDocument);
      webNavigation.onHistoryStateUpdated.removeListener(onSameDocument);
      tabs.onRemoved.removeListener(onRemoved);
    }

    function finish(outcome: NavigationOutcome) {
      if (settled) return;
      cleanup();
      resolve(outcome);
    }

    // tabs.goBack and tabs.goForward resolve even when there is no history entry, so a navigation
    // that never starts is detected by silence after the call.
    let started: Promise<unknown>;
    try {
      started = start();
    } catch (error) {
      cleanup();
      reject(error);
      return;
    }
    started.then(
      () => {
        if (settled) return;
        startTimer = setTimeout(() => {
          if (startedUrl === undefined) finish({ status: 'not-started' });
        }, NAVIGATION_START_TIMEOUT_MS);
      },
      (error: unknown) => {
        if (settled) return;
        cleanup();
        reject(error);
      },
    );
  });
}

function startNavigation(tabId: number, target: NavigateTarget): Promise<unknown> {
  if (target.kind === 'back') return browser.tabs.goBack(tabId);
  if (target.kind === 'forward') return browser.tabs.goForward(tabId);
  return browser.tabs.update(tabId, { url: target.url });
}

function describeNavigationError(error: string | undefined): string {
  if (error === undefined) return 'unknown error';
  const code = /^Error code (\d+)$/.exec(error)?.[1];
  const known = code === undefined ? undefined : NETWORK_ERRORS.get(Number(code));
  if (!known) return error;
  const [description, name] = known;
  return `${description} (${name}, ${error})`;
}

// Carries the reason apart from the navigate wording, so tabs_create can report the same failure
// in its own words.
export class NavigationError extends ToolError {
  constructor(
    readonly detail: string,
    readonly url?: string,
    readonly tabClosed = false,
  ) {
    super(url === undefined ? `Failed to navigate: ${detail}` : `Failed to navigate to ${url}: ${detail}`);
  }
}

export function unapprovedText(tabId: number, host: string | undefined): string {
  if (host === undefined) {
    return `Tab ${tabId} landed on a page outside site permissions (not http or https). Its title and content are withheld.`;
  }
  return `Tab ${tabId} landed on an unapproved host: ${host}. Its title and content are withheld; the next action on this tab will ask the user for permission.`;
}

export interface NavigationTexts {
  headline: (url: string) => string;
  download: (url: string, stayUrl: string | undefined) => string;
  unapproved: (host: string | undefined) => string;
}

async function currentTab(tabId: number): Promise<browser.tabs.Tab> {
  try {
    return await browser.tabs.get(tabId);
  } catch {
    throw new NavigationError(`tab ${tabId} was closed`, undefined, true);
  }
}

// A redirect may end on a site the user never approved, so its title and url are withheld.
async function report(
  tabId: number,
  texts: NavigationTexts,
  approvedHost: string | undefined,
  headline: string,
  note?: string,
): Promise<ContentBlock[]> {
  const tab = await currentTab(tabId);
  const landed = await landedSite(tab.url, approvedHost);
  if (!landed.allowed) return [{ type: 'text', text: texts.unapproved(landed.host) }];
  const lines = [headline];
  if (tab.title) lines.push(`Title: ${tab.title}`);
  if (note) lines.push(note);
  return [{ type: 'text', text: `${lines.join('\n')}\n\nTabs context: ${await tabsContextText(approvedHost)}` }];
}

// A download reached through history, and the page a tab stays on after it, may be on a host the user never
// approved; only the origin is shown then.
async function shownUrl(url: string | undefined, approvedHost: string | undefined): Promise<string | undefined> {
  if (url === undefined || !siteForUrl(url).ok) return url;
  const landed = await landedSite(url, approvedHost);
  return landed.allowed ? url : `${new URL(url).origin} (unapproved host)`;
}

// Starts the navigation in an existing tab and turns its outcome into the tool result; every expected
// failure is thrown as a NavigationError. approvedHost is the host the user allowed for this call.
export async function navigateTab(
  tabId: number,
  target: NavigateTarget,
  initialTab: browser.tabs.Tab,
  texts: NavigationTexts,
  approvedHost?: string,
): Promise<ContentBlock[]> {
  let outcome: NavigationOutcome;
  try {
    outcome = await waitForNavigation(tabId, target, () => startNavigation(tabId, target));
  } catch (error) {
    throw new NavigationError(error instanceof Error ? error.message : String(error));
  }

  switch (outcome.status) {
    case 'loaded':
    case 'same-document':
      return report(tabId, texts, approvedHost, texts.headline(outcome.url));
    case 'still-loading':
      return report(
        tabId,
        texts,
        approvedHost,
        texts.headline(outcome.url),
        `The page was still loading after ${NAVIGATION_TIMEOUT_MS / 1000} s; its content may be incomplete.`,
      );
    case 'download': {
      const tab = await browser.tabs.get(tabId).catch(() => initialTab);
      const downloadUrl = (await shownUrl(outcome.url, approvedHost)) ?? outcome.url;
      return [{ type: 'text', text: texts.download(downloadUrl, await shownUrl(tab.url, approvedHost)) }];
    }
    case 'error':
      throw new NavigationError(describeNavigationError(outcome.error), outcome.url);
    case 'no-response':
      throw new NavigationError(`${outcome.url} did not respond within ${NAVIGATION_TIMEOUT_MS / 1000} s`);
    case 'closed':
      throw new NavigationError(`tab ${tabId} was closed`, undefined, true);
    case 'superseded':
      throw new NavigationError(
        `superseded by another navigate call in tab ${tabId} before this navigation finished`,
      );
    case 'not-started': {
      const tab = await currentTab(tabId);
      if (target.kind === 'url') {
        // Firefox starts nothing when the tab already shows exactly this url, fragment included.
        if (tab.url === target.url) return report(tabId, texts, approvedHost, `Tab ${tabId} is already on ${target.url}`);
        throw new NavigationError(
          `the navigation to ${target.url} did not start within ${NAVIGATION_START_TIMEOUT_MS / 1000} s`,
        );
      }
      const entry = target.kind === 'back' ? 'previous' : 'next';
      throw new NavigationError(`tab ${tabId} has no ${entry} page in its history; it stays on ${tab.url}`);
    }
  }
}

export async function navigate(args: Record<string, unknown>, prompt: ApprovalPrompt): Promise<ContentBlock[]> {
  const parsed = parseNavigateArgs(args);
  if (!parsed.ok) throw new ToolError(`Failed to navigate: ${parsed.error}`);
  const { tabId, target } = parsed.value;
  const initialTab = await browser.tabs.get(tabId).catch(() => undefined);
  if (!initialTab) throw new ToolError(`Failed to navigate: tab ${tabId} does not exist`);

  const approvedHost =
    target.kind === 'url'
      ? await requireSiteAccess(
          {
            url: target.url,
            tool: 'navigate',
            action: 'navigate',
            subject: `Failed to navigate to ${target.url}`,
          },
          prompt,
        )
      : undefined;

  const prefix = HISTORY_PREFIX[target.kind];
  return navigateTab(
    tabId,
    target,
    initialTab,
    {
      headline: (url) => `${prefix} ${url}`,
      download: (url, stayUrl) => `${url} started a download instead of opening a page; tab ${tabId} stays on ${stayUrl}`,
      unapproved: (host) => unapprovedText(tabId, host),
    },
    approvedHost,
  );
}
