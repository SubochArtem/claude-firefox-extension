import { CONSOLE_SCRIPT } from '../page/console-capture-api';

export const CONSOLE_TABS_KEY = 'consoleTrackedTabs';
export const CONSOLE_SCRIPT_ID = 'console-capture';

// Hosts that fit a match pattern; others (IPv6, a trailing dot) get only the injection on commit.
const PATTERN_HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;

interface TrackedTab {
  tabId: number;
  host: string;
}

// Tabs whose console is captured with the host of their page, in storage.session so the list survives the
// event page being suspended. Cached while the page is awake, so a commit does not wait for storage before injecting.
let cache: Promise<Map<number, string>> | undefined;
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task);
  queue = result.catch(() => {});
  return result;
}

function isTrackedTab(value: unknown): value is TrackedTab {
  if (typeof value !== 'object' || value === null) return false;
  const { tabId, host } = value as Record<string, unknown>;
  return Number.isSafeInteger(tabId) && typeof host === 'string';
}

async function load(): Promise<Map<number, string>> {
  const stored = (await browser.storage.session.get(CONSOLE_TABS_KEY))[CONSOLE_TABS_KEY];
  const tabs = Array.isArray(stored) ? stored.filter(isTrackedTab) : [];
  return new Map(tabs.map(({ tabId, host }) => [tabId, host]));
}

function trackedTabs(): Promise<Map<number, string>> {
  cache ??= load().catch((error: unknown) => {
    cache = undefined;
    throw error;
  });
  return cache;
}

async function save(tabs: Map<number, string>): Promise<void> {
  const list: TrackedTab[] = [...tabs].map(([tabId, host]) => ({ tabId, host }));
  await browser.storage.session.set({ [CONSOLE_TABS_KEY]: list });
}

function patternHost(url: string): string {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return '';
    return PATTERN_HOST.test(hostname) ? hostname : '';
  } catch {
    return '';
  }
}

export function consoleMatchPatterns(tabs: Map<number, string>): string[] {
  const hosts = new Set([...tabs.values()].filter((host) => host !== ''));
  return [...hosts].sort().map((host) => `*://${host}/*`);
}

// One registration covers the hosts of all tracked tabs, so the capture runs at document_start on every load
// there. Recomputed from the tracked list, which makes a failed or interrupted update heal on the next change.
async function syncRegistration(tabs: Map<number, string>): Promise<void> {
  const matches = consoleMatchPatterns(tabs);
  const [registered] = await browser.scripting.getRegisteredContentScripts({ ids: [CONSOLE_SCRIPT_ID] });
  if (matches.length === 0) {
    if (registered) await browser.scripting.unregisterContentScripts({ ids: [CONSOLE_SCRIPT_ID] });
    return;
  }
  if (!registered) {
    await browser.scripting.registerContentScripts([
      {
        id: CONSOLE_SCRIPT_ID,
        js: [CONSOLE_SCRIPT],
        matches,
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: false,
        persistAcrossSessions: false,
      },
    ]);
    return;
  }
  const current = registered.matches ?? [];
  if (current.length !== matches.length || current.some((pattern, index) => pattern !== matches[index])) {
    await browser.scripting.updateContentScripts([{ id: CONSOLE_SCRIPT_ID, matches }]);
  }
}

// The cache takes the new list only once storage has it, so a failed write leaves both unchanged.
// A registration failure leaves only the injection on commit, so it does not fail the caller.
async function saveAndSync(next: Map<number, string>): Promise<void> {
  await save(next);
  cache = Promise.resolve(next);
  await syncRegistration(next).catch(() => {});
}

// Resolves true when this call started tracking the tab.
export function trackConsole(tabId: number, url: string): Promise<boolean> {
  return serialized(async () => {
    const tabs = await trackedTabs();
    const started = !tabs.has(tabId);
    const host = patternHost(url);
    if (!started && tabs.get(tabId) === host) return false;
    await saveAndSync(new Map(tabs).set(tabId, host));
    return started;
  });
}

export function untrackConsole(tabId: number): Promise<void> {
  return serialized(async () => {
    const tabs = await trackedTabs();
    if (!tabs.has(tabId)) return;
    const next = new Map(tabs);
    next.delete(tabId);
    await saveAndSync(next);
  });
}

function moveConsoleTab(tabId: number, url: string): Promise<void> {
  return serialized(async () => {
    const tabs = await trackedTabs();
    const host = patternHost(url);
    if (!tabs.has(tabId) || tabs.get(tabId) === host) return;
    await saveAndSync(new Map(tabs).set(tabId, host));
  });
}

export async function isConsoleTracked(tabId: number): Promise<boolean> {
  return (await trackedTabs()).has(tabId);
}

export function syncConsoleRegistration(): Promise<void> {
  return serialized(async () => syncRegistration(await trackedTabs()));
}

// The registered script covers loads on hosts already registered. A commit on a host that is not (the first
// load after the tab moved to another host, or a host no match pattern can name) gets the capture injected
// here, later than document_start, so messages logged before it are missed; the bundle installs only once.
async function reinject(tabId: number): Promise<void> {
  await browser.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: [CONSOLE_SCRIPT], injectImmediately: true });
}

export async function handleConsoleCommit(details: { tabId: number; frameId: number; url: string }): Promise<void> {
  if (details.frameId !== 0 || !(await isConsoleTracked(details.tabId).catch(() => false))) return;
  await Promise.all([reinject(details.tabId).catch(() => {}), moveConsoleTab(details.tabId, details.url).catch(() => {})]);
}

export function handleConsoleTabRemoved(tabId: number): Promise<void> {
  return untrackConsole(tabId).catch(() => {});
}

// Registered at the top level of the background script, so a commit in a tracked tab wakes the event page.
// Every start of the background script reconciles the registration with the tracked list.
export function registerConsoleTracking(): void {
  browser.webNavigation.onCommitted.addListener(handleConsoleCommit, { url: [{ schemes: ['http', 'https'] }] });
  browser.tabs.onRemoved.addListener(handleConsoleTabRemoved);
  syncConsoleRegistration().catch(() => {});
}
