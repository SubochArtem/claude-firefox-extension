import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalDecision, ApprovalPrompt, ApprovalRequest } from '../permissions/approval';
import type { ClientApprovals } from '../permissions/client-prompt';
import { deniedMessage } from '../permissions/site-access';
import type { ToolResponse } from '../protocol';
import type { executeTool as ExecuteTool } from '../tools';
import type * as Tracking from '../tools/network-tracking';
import { NETWORK_FLUSH_DELAY_MS, networkCaptureKey, networkPageChangedMessage } from '../tools/network-tracking';
import { restrictedPageMessage } from '../tools/tab-access';
import { mockBrowser } from './browser-mock';

const TAB = 5;
const PAGE = 'https://example.com/app';
const T0 = new Date(2026, 0, 1, 12, 0, 0, 0).getTime();

let browserMock: ReturnType<typeof mockBrowser>;
let tabs: Map<number, Partial<browser.tabs.Tab>>;
let decision: ApprovalDecision;
let approvalRequests: ApprovalRequest[];
let executeTool: typeof ExecuteTool;
let tracking: typeof Tracking;
let nextRequest: number;
let tabReads: number;
let afterTabRead: ((count: number) => void) | undefined;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(T0);
  browserMock = mockBrowser();
  browserMock.allowSites('example.com');
  tabs = new Map([[TAB, { id: TAB, windowId: 1, url: PAGE, active: true }]]);
  browserMock.tabs.get.mockImplementation(async (tabId) => {
    const tab = tabs.get(tabId);
    if (!tab) throw new Error(`Invalid tab ID: ${tabId}`);
    tabReads += 1;
    afterTabRead?.(tabReads);
    return { ...tab };
  });
  browserMock.query.mockImplementation(async (query) => [...tabs.values()].filter((tab) => !query.active || tab.active));
  browserMock.permissions.contains.mockResolvedValue(true);
  decision = { kind: 'answered', answer: 'allow_once', wildcard: false };
  approvalRequests = [];
  nextRequest = 1;
  tabReads = 0;
  afterTabRead = undefined;
  ({ executeTool } = await import('../tools'));
  tracking = await import('../tools/network-tracking');
});

afterEach(() => {
  vi.useRealTimers();
});

const prompt: ApprovalPrompt = {
  requestApproval: async (request) => {
    approvalRequests.push(request);
    return decision;
  },
};
const approvals: ClientApprovals = { promptFor: () => prompt, handleResponse: () => {}, close: () => {} };

function run(args: Record<string, unknown> = {}): Promise<ToolResponse> {
  return executeTool({ type: 'tool_request', id: '1:1', tool: 'read_network_requests', args, approvalViaClient: true }, approvals);
}

async function text(args: Record<string, unknown> = {}): Promise<string> {
  const response = await run(args);
  if (!('result' in response)) throw new Error(`expected a result, got ${JSON.stringify(response)}`);
  const [block] = response.result.content;
  return block?.type === 'text' ? block.text : '';
}

async function failure(args: Record<string, unknown> = {}): Promise<string> {
  const response = await run(args);
  if (!('error' in response)) throw new Error(`expected an error, got ${JSON.stringify(response)}`);
  const [block] = response.error.content;
  return block?.type === 'text' ? block.text : '';
}

function stored(tabId = TAB): unknown {
  return browserMock.storage.session.data.get(networkCaptureKey(tabId));
}

function moveTab(url: string, tabId = TAB): void {
  tabs.set(tabId, { ...tabs.get(tabId), id: tabId, windowId: 1, url });
}

function read(host = 'example.com', tabId = TAB, options: { clear?: boolean } = {}): Promise<Tracking.NetworkCaptureRead> {
  return tracking.readNetworkCapture(tabId, host, { limit: 100, clear: options.clear ?? false });
}

async function request(
  url: string,
  { tabId = TAB, type = 'script', method = 'GET', status = 200 as number | string | null, ms = 10 } = {},
): Promise<string> {
  const requestId = String(nextRequest++);
  const timeStamp = Date.now();
  await tracking.recordRequestStart({ requestId, tabId, url, method, type, timeStamp });
  if (typeof status === 'number') {
    await tracking.recordRequestCompleted({ requestId, tabId, statusCode: status, timeStamp: timeStamp + ms });
  } else if (typeof status === 'string') {
    await tracking.recordRequestError({ requestId, tabId, error: status, timeStamp: timeStamp + ms });
  }
  return requestId;
}

function requestLines(reply: string): string[] {
  return reply.split('\n').filter((line) => /^[A-Z]+ /.test(line));
}

describe('read_network_requests', () => {
  it('starts capture on the first call and tells the agent to reload', async () => {
    expect(await text()).toBe(
      `Network capture started for tab ${TAB} (${PAGE}) with this call; requests made before it were not recorded. Reload the page or repeat the action you want to observe, then call read_network_requests again.`,
    );
    expect(stored()).toEqual({ host: 'example.com', since: T0, dropped: 0, entries: [] });
  });

  it('lists requests of the tracked tab recorded after the first call', async () => {
    await text();
    await request('https://example.com/app.js', { ms: 123 });
    await request('https://api.example/x', { method: 'POST', type: 'xmlhttprequest', status: 'NS_ERROR_UNKNOWN_HOST', ms: 4 });
    await request('https://example.com/a.png', { type: 'image', status: null });
    expect(await text()).toBe(
      [
        `Network requests of tab ${TAB} (${PAGE}) captured since 12:00:00.000: showing 3 of 3.`,
        'GET 200 script https://example.com/app.js [123 ms]',
        'POST ERROR NS_ERROR_UNKNOWN_HOST xmlhttprequest https://api.example/x [4 ms]',
        'GET PENDING image https://example.com/a.png',
      ].join('\n'),
    );
  });

  it('says nothing was captured when a tracked tab made no requests', async () => {
    await text();
    expect(await text()).toMatch(/^No network requests captured in tab 5 /);
  });

  it('ignores requests of untracked tabs and requests without a tab', async () => {
    await text();
    await request('https://example.com/other', { tabId: 9 });
    await request('https://example.com/worker', { tabId: -1 });
    expect(await text()).toMatch(/^No network requests captured/);
    await vi.advanceTimersByTimeAsync(NETWORK_FLUSH_DELAY_MS);
    expect(stored()).toEqual(expect.objectContaining({ entries: [] }));
    expect(stored(9)).toBeUndefined();
  });

  it('does not record anything before the first call', async () => {
    await request('https://example.com/early.js');
    await text();
    expect(await text()).toMatch(/^No network requests captured/);
  });

  it('stores urls without credentials, query or fragment and matches the pattern against them', async () => {
    await text();
    await request('https://user:pw@example.com/api/items?token=secret#top');
    await vi.advanceTimersByTimeAsync(NETWORK_FLUSH_DELAY_MS);
    expect(JSON.stringify(stored())).not.toContain('secret');
    expect(JSON.stringify(stored())).not.toContain('pw@');
    expect(await text({ urlPattern: 'SECRET' })).toMatch(/none of 1 match/);
    expect(requestLines(await text({ urlPattern: '/API/' }))).toEqual(['GET 200 script https://example.com/api/items?[REDACTED]#[REDACTED] [10 ms]']);
  });

  it('applies the limit to the most recent requests and clears after reading', async () => {
    await text();
    await request('https://example.com/1');
    await request('https://example.com/2');
    await request('https://example.com/3');
    expect(requestLines(await text({ limit: 2, clear: true }))).toEqual([
      'GET 200 script https://example.com/2 [10 ms]',
      'GET 200 script https://example.com/3 [10 ms]',
    ]);
    expect(stored()).toEqual(expect.objectContaining({ entries: [] }));
    expect(await text()).toMatch(/^No network requests captured/);
  });

  it('reads the given tab', async () => {
    tabs.set(7, { id: 7, windowId: 1, url: 'https://example.com/other', active: false });
    await text({ tabId: 7 });
    expect(stored(7)).toEqual(expect.objectContaining({ host: 'example.com' }));
    expect(stored()).toBeUndefined();
  });

  it('asks for the read_network_requests permission and stops when denied', async () => {
    browserMock.allowSites();
    decision = { kind: 'answered', answer: 'deny', wildcard: false };
    expect(await failure()).toBe(deniedMessage('example.com'));
    expect(approvalRequests).toEqual([
      expect.objectContaining({ host: 'example.com', tool: 'read_network_requests', action: 'read_network_requests' }),
    ]);
    expect(stored()).toBeUndefined();
    await request('https://example.com/app.js');
    await vi.advanceTimersByTimeAsync(NETWORK_FLUSH_DELAY_MS);
    expect(stored()).toBeUndefined();
  });

  it('refuses restricted pages without asking', async () => {
    tabs.set(TAB, { id: TAB, windowId: 1, url: 'https://addons.mozilla.org/en-US/firefox/', active: true });
    expect(await failure()).toBe(
      restrictedPageMessage({ verb: 'read network requests', target: 'read network requests of' }, TAB, 'https://addons.mozilla.org/en-US/firefox/'),
    );
    expect(approvalRequests).toEqual([]);
    expect(stored()).toBeUndefined();
  });

  it('starts a new list for the page when the stored list belongs to another site, without reading it', async () => {
    const other = {
      host: 'other.example',
      since: T0 - 1_000,
      dropped: 0,
      entries: [{ requestId: '1', url: 'https://other.example/secret', method: 'GET', type: 'script', start: T0 - 500 }],
    };
    browserMock.storage.session.data.set(networkCaptureKey(TAB), other);
    const reply = await text();
    expect(reply).toMatch(/^Network capture started for tab 5 /);
    expect(reply).not.toContain('other.example');
    expect(stored()).toEqual({ host: 'example.com', since: T0, dropped: 0, entries: [] });
    expect(await text()).toMatch(/^No network requests captured/);
  });

  it('starts a new list after a main_frame request to another site that loaded no page', async () => {
    await text();
    await request('https://example.com/a.js');
    await request('https://other.example/file.zip', { type: 'main_frame' });
    await request('https://other.example/secret.js');
    const reply = await text();
    expect(reply).toMatch(/^Network capture started for tab 5 /);
    expect(reply).not.toContain('other.example');
    expect(stored()).toEqual({ host: 'example.com', since: T0, dropped: 0, entries: [] });
    await request('https://example.com/b.js');
    expect(requestLines(await text())).toEqual(['GET 200 script https://example.com/b.js [10 ms]']);
  });

  it('does not leak or relabel the list when the tab moves to another site after the permission check', async () => {
    await text();
    await request('https://example.com/a.js');
    tabReads = 0;
    afterTabRead = (count) => {
      if (count !== 1) return;
      afterTabRead = undefined;
      moveTab('https://other.example/');
      void tracking.handleNetworkCommit({ tabId: TAB, frameId: 0, url: 'https://other.example/', timeStamp: Date.now() });
      void tracking.recordRequestStart({ requestId: 'b1', tabId: TAB, url: 'https://other.example/secret.js', method: 'GET', type: 'script', timeStamp: Date.now() });
    };
    expect(await failure()).toBe(networkPageChangedMessage('read_network_requests', TAB, 'example.com'));
    await vi.advanceTimersByTimeAsync(NETWORK_FLUSH_DELAY_MS);
    expect(stored()).toEqual(
      expect.objectContaining({ host: 'other.example', entries: [expect.objectContaining({ url: 'https://other.example/secret.js' })] }),
    );
    moveTab(PAGE);
    await request(PAGE, { type: 'main_frame' });
    const reply = await text();
    expect(reply).not.toContain('other.example');
    expect(requestLines(reply)).toEqual([`GET 200 main_frame ${PAGE} [10 ms]`]);
  });

  it('does not start tracking for a site the tab has left after the permission check', async () => {
    tabReads = 0;
    afterTabRead = (count) => {
      if (count !== 1) return;
      afterTabRead = undefined;
      moveTab('https://other.example/');
      void tracking.handleNetworkCommit({ tabId: TAB, frameId: 0, url: 'https://other.example/', timeStamp: Date.now() });
    };
    expect(await failure()).toBe(networkPageChangedMessage('read_network_requests', TAB, 'example.com'));
    await request('https://other.example/secret.js');
    await vi.advanceTimersByTimeAsync(NETWORK_FLUSH_DELAY_MS);
    expect(stored()).toBeUndefined();
    expect(browserMock.storage.session.set).not.toHaveBeenCalled();
  });

  it('rejects invalid arguments', async () => {
    expect(await failure({ limit: 0 })).toBe('Invalid read_network_requests arguments: limit must be a positive integer, received 0');
    expect(stored()).toBeUndefined();
  });
});

describe('network tracking', () => {
  it('batches writes of recorded requests', async () => {
    await read();
    browserMock.storage.session.set.mockClear();
    for (let index = 0; index < 20; index += 1) await request(`https://example.com/${index}`);
    expect(browserMock.storage.session.set).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(NETWORK_FLUSH_DELAY_MS - 1);
    expect(browserMock.storage.session.set).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(browserMock.storage.session.set).toHaveBeenCalledTimes(1);
    expect((stored() as { entries: unknown[] }).entries).toHaveLength(20);
  });

  it('writes only the tabs that recorded requests, each under its own key', async () => {
    moveTab('https://example.com/other', 8);
    await read();
    await read('example.com', 8);
    browserMock.storage.session.set.mockClear();
    await request('https://example.com/8.js', { tabId: 8 });
    await vi.advanceTimersByTimeAsync(NETWORK_FLUSH_DELAY_MS);
    expect(browserMock.storage.session.set.mock.calls).toEqual([[{ [networkCaptureKey(8)]: expect.objectContaining({ host: 'example.com' }) }]]);
    expect((stored(8) as { entries: unknown[] }).entries).toHaveLength(1);
    expect((stored() as { entries: unknown[] }).entries).toEqual([]);
  });

  it('flushes a busy page while requests keep coming', async () => {
    await read();
    browserMock.storage.session.set.mockClear();
    for (let index = 0; index < 10; index += 1) {
      await request(`https://example.com/${index}`);
      await vi.advanceTimersByTimeAsync(NETWORK_FLUSH_DELAY_MS / 4);
    }
    expect(browserMock.storage.session.set.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps recorded requests when the background script restarts', async () => {
    await read();
    await request('https://example.com/kept.js');
    await vi.advanceTimersByTimeAsync(NETWORK_FLUSH_DELAY_MS);
    vi.resetModules();
    tracking = await import('../tools/network-tracking');
    const { started, result } = await read();
    expect(started).toBe(false);
    expect(result.entries.map((entry) => entry.url)).toEqual(['https://example.com/kept.js']);
  });

  it('completes a request that started before the background script restarted', async () => {
    await read();
    await tracking.recordRequestStart({ requestId: 'r1', tabId: TAB, url: 'https://example.com/slow', method: 'GET', type: 'fetch', timeStamp: T0 });
    await vi.advanceTimersByTimeAsync(NETWORK_FLUSH_DELAY_MS);
    vi.resetModules();
    tracking = await import('../tools/network-tracking');
    await tracking.recordRequestCompleted({ requestId: 'r1', tabId: TAB, statusCode: 201, timeStamp: T0 + 2_000 });
    const { result } = await read();
    expect(result.entries).toEqual([expect.objectContaining({ requestId: 'r1', status: 201, end: T0 + 2_000 })]);
  });

  it('starts over when the top frame requests a page on another site and keeps the list on the same site', async () => {
    await read();
    await request('https://example.com/1.js');
    await request('https://www.example.com/next', { type: 'main_frame' });
    await request('https://cdn.example/lib.js');
    let capture = await read();
    expect(capture.result.entries.map((entry) => entry.url)).toEqual([
      'https://example.com/1.js',
      'https://www.example.com/next',
      'https://cdn.example/lib.js',
    ]);
    vi.setSystemTime(T0 + 5_000);
    await request('https://other.example/', { type: 'main_frame' });
    await request('https://other.example/app.js');
    moveTab('https://other.example/');
    capture = await read('other.example');
    expect(capture.started).toBe(false);
    expect(capture.result.since).toBe(T0 + 5_000);
    expect(capture.result.entries.map((entry) => entry.url)).toEqual(['https://other.example/', 'https://other.example/app.js']);
  });

  it('keeps the list when a subframe loads a page on another site', async () => {
    await read();
    await request('https://ads.example/frame', { type: 'sub_frame' });
    const { result } = await read();
    expect(result.entries).toHaveLength(1);
  });

  it('starts over when the top frame commits on another site', async () => {
    await read();
    await request('https://example.com/1.js');
    await tracking.handleNetworkCommit({ tabId: TAB, frameId: 3, url: 'https://other.example/' });
    await tracking.handleNetworkCommit({ tabId: TAB, frameId: 0, url: 'https://www.example.com/again' });
    let capture = await read();
    expect(capture.result.entries).toHaveLength(1);
    await tracking.handleNetworkCommit({ tabId: TAB, frameId: 0, url: 'https://other.example/' });
    moveTab('https://other.example/');
    capture = await read('other.example');
    expect(capture.result.entries).toEqual([]);
    expect(capture.started).toBe(false);
  });

  it('refuses a read for a host the tab is no longer on and keeps its list', async () => {
    await read();
    await request('https://example.com/1.js');
    moveTab('https://other.example/');
    await expect(read()).rejects.toThrow(networkPageChangedMessage('read_network_requests', TAB, 'example.com'));
    moveTab(PAGE);
    expect((await read()).result.entries).toHaveLength(1);
  });

  it('ignores commits in untracked tabs', async () => {
    await tracking.handleNetworkCommit({ tabId: 9, frameId: 0, url: 'https://other.example/' });
    await vi.advanceTimersByTimeAsync(NETWORK_FLUSH_DELAY_MS);
    expect(stored(9)).toBeUndefined();
    expect(browserMock.storage.session.set).not.toHaveBeenCalled();
  });

  it('untracks a closed tab and drops its requests', async () => {
    moveTab('https://example.com/other', 8);
    await read();
    await read('example.com', 8);
    await request('https://example.com/1.js');
    await tracking.handleNetworkTabRemoved(TAB);
    expect(stored()).toBeUndefined();
    expect(stored(8)).toEqual(expect.objectContaining({ host: 'example.com' }));
    await request('https://example.com/2.js');
    await vi.advanceTimersByTimeAsync(NETWORK_FLUSH_DELAY_MS);
    expect(stored()).toBeUndefined();
    const { started, result } = await read();
    expect(started).toBe(true);
    expect(result.entries).toEqual([]);
  });

  it('does not start tracking when storing the new list fails', async () => {
    browserMock.storage.session.set.mockRejectedValueOnce(new Error('quota exceeded'));
    await expect(read()).rejects.toThrow('quota exceeded');
    await request('https://example.com/1.js');
    await vi.advanceTimersByTimeAsync(NETWORK_FLUSH_DELAY_MS);
    expect(stored()).toBeUndefined();
    expect((await read()).started).toBe(true);
  });

  it('keeps the tab tracked when removing its list fails', async () => {
    await read();
    browserMock.storage.session.remove.mockRejectedValueOnce(new Error('storage failure'));
    await expect(tracking.handleNetworkTabRemoved(TAB)).resolves.toBeUndefined();
    expect((await read()).started).toBe(false);
  });

  it('reads from memory and writes again later when a flush fails', async () => {
    await read();
    browserMock.storage.session.set.mockRejectedValueOnce(new Error('quota exceeded'));
    await request('https://example.com/1.js');
    await vi.advanceTimersByTimeAsync(NETWORK_FLUSH_DELAY_MS);
    expect((stored() as { entries: unknown[] }).entries).toEqual([]);
    expect((await read()).result.entries).toHaveLength(1);
    await request('https://example.com/2.js');
    await vi.advanceTimersByTimeAsync(NETWORK_FLUSH_DELAY_MS);
    expect((stored() as { entries: unknown[] }).entries).toHaveLength(2);
  });

  it('returns the requests and keeps the list when storing the cleared list fails', async () => {
    await read();
    await request('https://example.com/1.js');
    browserMock.storage.session.set.mockRejectedValueOnce(new Error('quota exceeded'));
    const reply = await text({ clear: true });
    expect(requestLines(reply)).toEqual(['GET 200 script https://example.com/1.js [10 ms]']);
    expect(reply).not.toContain('The list was cleared.');
    expect(reply).toContain('The list could not be cleared');
    expect((await read()).result.entries).toHaveLength(1);
  });

  it('ignores malformed stored data and other keys', async () => {
    const valid = { host: 'c.example', since: 0, dropped: 0, entries: [] };
    const data = browserMock.storage.session.data;
    data.set('networkCapture:x5', valid);
    data.set('networkCapture:6.5', valid);
    data.set('networkCapture:2', valid);
    data.set('networkCapture:3', { host: 'd.example', since: 0, dropped: 0, entries: [{ url: 1 }] });
    data.set(networkCaptureKey(TAB), null);
    data.set('consoleTabs', [{ tabId: 4, host: 'example.com' }]);
    moveTab('https://c.example/', 2);
    moveTab('https://d.example/', 3);
    moveTab('https://example.com/', 4);
    expect((await read('c.example', 2)).started).toBe(false);
    expect((await read('d.example', 3)).started).toBe(true);
    expect((await read('example.com', 4)).started).toBe(true);
    expect((await read()).started).toBe(true);
  });
});
