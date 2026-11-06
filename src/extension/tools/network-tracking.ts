import { siteForUrl } from '../permissions/site';
import {
  addRequest,
  completeRequest,
  failRequest,
  isNetworkCapture,
  type NetworkCapture,
  newCapture,
  type RequestCompletion,
  type RequestFailure,
  type RequestStart,
  selectRequests,
} from './network-buffer';
import type { NetworkReadResult } from './network-output';
import { redactRequestUrl } from './network-output';
import { type PageAccess, requireSameSite } from './page-script';

export const NETWORK_CAPTURE_KEY_PREFIX = 'networkCapture:';
export const NETWORK_FLUSH_DELAY_MS = 500;
export const NETWORK_TOOL = 'read_network_requests';

export function networkPageChangedMessage(tool: string, tabId: number, host: string): string {
  return `Cannot read network requests of tab ${tabId}: the page navigated away from ${host} to another site, so nothing was read. Call ${tool} again to read the requests of the tab's current page; a page on another site needs its own permission.`;
}

export const NETWORK_ACCESS: PageAccess = {
  action: 'read_network_requests',
  label: { verb: 'read network requests', target: 'read network requests of' },
  pageChanged: networkPageChangedMessage,
};

type Captures = Map<number, NetworkCapture>;

interface TabEvent {
  tabId: number;
}

export type RequestStartDetails = RequestStart & TabEvent;
export type RequestCompletedDetails = RequestCompletion & TabEvent;
export type RequestErrorDetails = RequestFailure & TabEvent;

// The requests of tracked tabs, in storage.session under one key per tab so they survive the event page
// being suspended. Recorded requests change the cached captures in place and the changed tabs are written
// at most once per NETWORK_FLUSH_DELAY_MS, so a busy page does not write on every event; tracking, clearing
// and untracking write right away and take effect in the cache only once storage has them. A tab whose
// write fails (storage.session quota) keeps its requests in the cache and is written again later.
let cache: Promise<Captures> | undefined;
let queue: Promise<unknown> = Promise.resolve();
const dirty = new Set<number>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task);
  queue = result.catch(() => {});
  return result;
}

export function networkCaptureKey(tabId: number): string {
  return `${NETWORK_CAPTURE_KEY_PREFIX}${tabId}`;
}

async function load(): Promise<Captures> {
  const stored = await browser.storage.session.get(null);
  const map: Captures = new Map();
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(NETWORK_CAPTURE_KEY_PREFIX)) continue;
    const id = key.slice(NETWORK_CAPTURE_KEY_PREFIX.length);
    const tabId = Number(id);
    if (!/^\d+$/.test(id) || !Number.isSafeInteger(tabId) || !isNetworkCapture(value)) continue;
    const { host, since, dropped, entries } = value;
    map.set(tabId, { host, since, dropped, entries });
  }
  return map;
}

function captures(): Promise<Captures> {
  cache ??= load().catch((error: unknown) => {
    cache = undefined;
    throw error;
  });
  return cache;
}

function save(tabId: number, capture: NetworkCapture): Promise<void> {
  return browser.storage.session.set({ [networkCaptureKey(tabId)]: capture });
}

// The tab's whole capture is written, its recorded requests not yet flushed included.
async function replace(map: Captures, tabId: number, capture: NetworkCapture): Promise<void> {
  await save(tabId, capture);
  map.set(tabId, capture);
  dirty.delete(tabId);
}

function flush(): Promise<void> {
  return serialized(async () => {
    const map = await captures();
    const tabIds = [...dirty];
    dirty.clear();
    for (const tabId of tabIds) {
      const capture = map.get(tabId);
      if (!capture) continue;
      try {
        await save(tabId, capture);
      } catch {
        // Written with the tab's next recorded request or change.
        dirty.add(tabId);
      }
    }
  });
}

// Not restarted by later events, so a page that keeps sending requests is still written regularly.
function scheduleFlush(tabId: number): void {
  dirty.add(tabId);
  flushTimer ??= setTimeout(() => {
    flushTimer = undefined;
    void flush();
  }, NETWORK_FLUSH_DELAY_MS);
}

function hostOf(url: string): string {
  const site = siteForUrl(url);
  return site.ok ? site.host : '';
}

function record(tabId: number, change: (capture: NetworkCapture, map: Captures) => boolean): Promise<void> {
  return serialized(async () => {
    const map = await captures();
    const capture = map.get(tabId);
    if (capture && change(capture, map)) scheduleFlush(tabId);
  });
}

export function recordRequestStart(details: RequestStartDetails): Promise<void> {
  if (details.tabId < 0) return Promise.resolve();
  return record(details.tabId, (capture, map) => {
    let target = capture;
    if (details.type === 'main_frame') {
      const host = hostOf(details.url);
      if (host !== capture.host) {
        target = newCapture(host, details.timeStamp);
        map.set(details.tabId, target);
      }
    }
    addRequest(target, { ...details, url: redactRequestUrl(details.url) });
    return true;
  });
}

export function recordRequestCompleted(details: RequestCompletedDetails): Promise<void> {
  if (details.tabId < 0) return Promise.resolve();
  return record(details.tabId, (capture) => completeRequest(capture, details));
}

export function recordRequestError(details: RequestErrorDetails): Promise<void> {
  if (details.tabId < 0) return Promise.resolve();
  return record(details.tabId, (capture) => failRequest(capture, details));
}

// Covers top-frame navigations to another site without a main_frame request, such as from the back-forward cache.
export function handleNetworkCommit(details: { tabId: number; frameId: number; url: string; timeStamp?: number }): Promise<void> {
  if (details.frameId !== 0) return Promise.resolve();
  return record(details.tabId, (capture, map) => {
    const host = hostOf(details.url);
    if (host === capture.host) return false;
    map.set(details.tabId, newCapture(host, details.timeStamp ?? Date.now()));
    return true;
  }).catch(() => {});
}

export function handleNetworkTabRemoved(tabId: number): Promise<void> {
  return serialized(async () => {
    const map = await captures();
    if (!map.has(tabId)) return;
    await browser.storage.session.remove(networkCaptureKey(tabId));
    map.delete(tabId);
    dirty.delete(tabId);
  }).catch(() => {});
}

// webRequest listeners return nothing: they are not blocking, and a returned promise must not be taken as a
// blocking response.
export function handleRequestStart(details: RequestStartDetails): void {
  recordRequestStart(details).catch(() => {});
}

export function handleRequestCompleted(details: RequestCompletedDetails): void {
  recordRequestCompleted(details).catch(() => {});
}

export function handleRequestError(details: RequestErrorDetails): void {
  recordRequestError(details).catch(() => {});
}

export interface NetworkCaptureRead {
  // The tab's URL when it was read.
  url: string;
  // Capture was started for the tab by this call.
  started: boolean;
  // False when clearing was asked but the emptied list could not be stored; the list is kept then.
  cleared: boolean;
  result: NetworkReadResult;
}

// Starts tracking the tab on its first read. host is the site the caller was allowed to read. The tab is
// checked again once earlier events are applied: if it has moved to another site since the permission
// check, its capture may already hold that site's requests, so nothing is read, created or replaced. A tab
// still on host whose capture belongs to another site (a main_frame request that loaded no page: a download,
// a 204, an error) gets a new empty capture for host; the other site's requests are dropped unread.
export function readNetworkCapture(
  tabId: number,
  host: string,
  options: { urlPattern?: string; limit: number; clear: boolean },
): Promise<NetworkCaptureRead> {
  return serialized(async () => {
    const map = await captures();
    const url = await requireSameSite(NETWORK_TOOL, tabId, host, NETWORK_ACCESS);
    const current = map.get(tabId);
    if (!current || current.host !== host) {
      const started = newCapture(host, Date.now());
      await replace(map, tabId, started);
      const { since, dropped } = started;
      return { url, started: true, cleared: options.clear, result: { ...selectRequests(started, options), dropped, since } };
    }
    const { since, dropped } = current;
    const result = { ...selectRequests(current, options), dropped, since };
    let cleared = false;
    if (options.clear) {
      cleared = await replace(map, tabId, newCapture(host, Date.now())).then(
        () => true,
        () => false,
      );
    }
    return { url, started: false, cleared, result };
  });
}

// Registered at the top level of the background script, so a request or a commit in any tab wakes the
// event page; only tracked tabs are recorded.
export function registerNetworkTracking(): void {
  const filter = { urls: ['<all_urls>'] };
  browser.webRequest.onBeforeRequest.addListener(handleRequestStart, filter);
  browser.webRequest.onCompleted.addListener(handleRequestCompleted, filter);
  browser.webRequest.onErrorOccurred.addListener(handleRequestError, filter);
  browser.webNavigation.onCommitted.addListener(handleNetworkCommit, { url: [{ schemes: ['http', 'https'] }] });
  browser.tabs.onRemoved.addListener(handleNetworkTabRemoved);
}
