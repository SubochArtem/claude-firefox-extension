import type { ContentBlock } from '../protocol';
import { type NavigateTarget, parseNavigateArgs } from './navigation-input';
import { tabsContextText } from './tabs-context';
import { ToolError } from './tool-error';

export const NAVIGATION_START_TIMEOUT_MS = 2_000;
// Below the host's 30 s tool request timeout, so the agent gets this tool's own answer.
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
export function waitForNavigation(
  tabId: number,
  target: NavigateTarget,
  start: () => Promise<unknown>,
): Promise<NavigationOutcome> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let startedUrl: string | undefined;
    let committed: FrameDetails | undefined;
    let startTimer: ReturnType<typeof setTimeout> | undefined;

    const isMainFrame = (details: FrameDetails) => details.tabId === tabId && details.frameId === 0;

    const onBeforeNavigate = (details: FrameDetails) => {
      if (!isMainFrame(details)) return;
      startedUrl = details.url;
      committed = undefined;
    };
    const onCommitted = (details: FrameDetails) => {
      if (isMainFrame(details) && startedUrl !== undefined) committed = details;
    };
    const onCompleted = (details: FrameDetails) => {
      if (!isMainFrame(details) || startedUrl === undefined) return;
      if (committed) {
        if (isSameDocument(committed, details)) finish({ status: 'loaded', url: details.url });
      } else if (details.url === startedUrl) {
        finish({ status: 'download', url: details.url });
      }
    };
    const onErrorOccurred = (details: FrameDetails & { error?: string }) => {
      if (!isMainFrame(details) || startedUrl === undefined) return;
      if (details.error === NS_BINDING_ABORTED && !(committed && isSameDocument(committed, details))) return;
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
      if (committed) finish({ status: 'still-loading', url: committed.url });
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

async function currentTab(tabId: number): Promise<browser.tabs.Tab> {
  try {
    return await browser.tabs.get(tabId);
  } catch {
    throw new ToolError(`Failed to navigate: tab ${tabId} was closed`);
  }
}

async function report(tabId: number, headline: string, note?: string): Promise<ContentBlock[]> {
  const tab = await currentTab(tabId);
  const lines = [headline];
  if (tab.title) lines.push(`Title: ${tab.title}`);
  if (note) lines.push(note);
  return [{ type: 'text', text: `${lines.join('\n')}\n\nTabs context: ${await tabsContextText()}` }];
}

export async function navigate(args: Record<string, unknown>): Promise<ContentBlock[]> {
  const parsed = parseNavigateArgs(args);
  if (!parsed.ok) throw new ToolError(`Failed to navigate: ${parsed.error}`);
  const { tabId, target } = parsed.value;
  const initialTab = await browser.tabs.get(tabId).catch(() => undefined);
  if (!initialTab) throw new ToolError(`Failed to navigate: tab ${tabId} does not exist`);

  let outcome: NavigationOutcome;
  try {
    outcome = await waitForNavigation(tabId, target, () => startNavigation(tabId, target));
  } catch (error) {
    throw new ToolError(`Failed to navigate: ${error instanceof Error ? error.message : String(error)}`);
  }

  const prefix = HISTORY_PREFIX[target.kind];
  switch (outcome.status) {
    case 'loaded':
    case 'same-document':
      return report(tabId, `${prefix} ${outcome.url}`);
    case 'still-loading':
      return report(
        tabId,
        `${prefix} ${outcome.url}`,
        `The page was still loading after ${NAVIGATION_TIMEOUT_MS / 1000} s; its content may be incomplete.`,
      );
    case 'download': {
      const tab = await browser.tabs.get(tabId).catch(() => initialTab);
      const text = `${outcome.url} started a download instead of opening a page; tab ${tabId} stays on ${tab.url}`;
      return [{ type: 'text', text }];
    }
    case 'error':
      throw new ToolError(`Failed to navigate to ${outcome.url}: ${describeNavigationError(outcome.error)}`);
    case 'no-response':
      throw new ToolError(`Failed to navigate: ${outcome.url} did not respond within ${NAVIGATION_TIMEOUT_MS / 1000} s`);
    case 'closed':
      throw new ToolError(`Failed to navigate: tab ${tabId} was closed`);
    case 'superseded':
      throw new ToolError(
        `Failed to navigate: superseded by another navigate call in tab ${tabId} before this navigation finished`,
      );
    case 'not-started': {
      const tab = await currentTab(tabId);
      if (target.kind === 'url') {
        // Firefox starts nothing when the tab already shows exactly this url, fragment included.
        if (tab.url === target.url) return report(tabId, `Tab ${tabId} is already on ${target.url}`);
        throw new ToolError(
          `Failed to navigate: the navigation to ${target.url} did not start within ${NAVIGATION_START_TIMEOUT_MS / 1000} s`,
        );
      }
      const entry = target.kind === 'back' ? 'previous' : 'next';
      throw new ToolError(`Failed to navigate: tab ${tabId} has no ${entry} page in its history; it stays on ${tab.url}`);
    }
  }
}
