import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeTool } from '../tools';
import { type NavigationOutcome, waitForNavigation } from '../tools/navigate';
import type { NavigateTarget } from '../tools/navigation-input';
import { mockBrowser } from './browser-mock';

const TAB = 5;
const OTHER_TAB = 6;
const SUBFRAME = 19327352833;
const ABORTED = 'Error code 2152398850';
const UNKNOWN_HOST = 'Error code 2152398878';
const CONNECTION_REFUSED = 'Error code 2152398861';
const PREVIOUS = 'https://previous.example/';
const PREVIOUS_DOC = 'doc-previous';
const TARGET = 'https://example.com/';
const TARGET_DOC = 'doc-target';

let browserMock: ReturnType<typeof mockBrowser>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  browserMock = mockBrowser();
});

afterEach(() => {
  vi.useRealTimers();
});

// Runs pending promise callbacks without moving the fake clock.
const flush = () => vi.advanceTimersByTimeAsync(0);

function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  promise.then(
    (value) => {
      state.settled = true;
      state.value = value;
    },
    (error: unknown) => {
      state.settled = true;
      state.error = error;
    },
  );
  return state;
}

function beforeNavigate(url: string, { tabId = TAB, frameId = 0 } = {}) {
  browserMock.webNavigation.onBeforeNavigate.emit({ tabId, frameId, url });
}

function committed(url: string, documentId: string | undefined, { tabId = TAB, frameId = 0 } = {}) {
  browserMock.webNavigation.onCommitted.emit({ tabId, frameId, url, documentId });
}

function completed(url: string, documentId: string | undefined, { tabId = TAB, frameId = 0 } = {}) {
  browserMock.webNavigation.onCompleted.emit({ tabId, frameId, url, documentId });
}

function failed(url: string, error: string | undefined, { tabId = TAB, frameId = 0, documentId = PREVIOUS_DOC } = {}) {
  browserMock.webNavigation.onErrorOccurred.emit({ tabId, frameId, url, error, documentId });
}

// Firefox 159 adds the forward_back qualifier only when the update comes from a history traversal; the
// page's own pushState, replaceState and fragment changes carry none.
const TRAVERSAL = ['forward_back'];

function fragmentUpdated(url: string, { tabId = TAB, frameId = 0, transitionQualifiers = [] as string[] } = {}) {
  browserMock.webNavigation.onReferenceFragmentUpdated.emit({
    tabId,
    frameId,
    url,
    documentId: PREVIOUS_DOC,
    transitionType: 'link',
    transitionQualifiers,
  });
}

function historyStateUpdated(url: string, { tabId = TAB, frameId = 0, transitionQualifiers = [] as string[] } = {}) {
  browserMock.webNavigation.onHistoryStateUpdated.emit({
    tabId,
    frameId,
    url,
    documentId: PREVIOUS_DOC,
    transitionType: 'link',
    transitionQualifiers,
  });
}

function removed(tabId: number) {
  browserMock.tabs.onRemoved.emit(tabId, { windowId: 1, isWindowClosing: false });
}

// What Firefox 158 sends for a plain load: a second onBeforeNavigate after an NS_BINDING_ABORTED error
// that belongs to the previous document.
function normalLoad(url = TARGET, documentId = TARGET_DOC) {
  beforeNavigate(url);
  failed(url, ABORTED);
  beforeNavigate(url);
  committed(url, documentId);
  completed(url, documentId);
}

function expectCleanedUp() {
  expect(browserMock.listenerCount()).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
}

const toTarget: NavigateTarget = { kind: 'url', url: TARGET };

async function startWait(target: NavigateTarget = toTarget, start: () => Promise<unknown> = async () => {}) {
  const state = track(waitForNavigation(TAB, target, start));
  await flush();
  return state;
}

describe('waitForNavigation', () => {
  it('registers every listener before starting the navigation', async () => {
    let countAtStart = -1;
    await startWait(toTarget, async () => {
      countAtStart = browserMock.listenerCount();
    });
    expect(countAtStart).toBe(7);
  });

  it('resolves loaded on a normal load, ignoring the aborted load of the previous document', async () => {
    const state = await startWait();
    normalLoad();
    await flush();
    expect(state.value).toEqual<NavigationOutcome>({ status: 'loaded', url: TARGET });
    expectCleanedUp();
  });

  it('reports the final url after a server redirect', async () => {
    const state = await startWait({ kind: 'url', url: 'http://example.com/redirect' });
    beforeNavigate('http://example.com/redirect');
    beforeNavigate(TARGET);
    failed('http://example.com/redirect', ABORTED);
    committed(TARGET, TARGET_DOC);
    completed(TARGET, TARGET_DOC);
    await flush();
    expect(state.value).toEqual({ status: 'loaded', url: TARGET });
    expectCleanedUp();
  });

  it('handles events fired while the navigation call is still pending', async () => {
    const state = await startWait(toTarget, async () => normalLoad());
    expect(state.value).toEqual({ status: 'loaded', url: TARGET });
    expectCleanedUp();
  });

  it('matches onCompleted to the committed document by documentId', async () => {
    const state = await startWait();
    beforeNavigate(TARGET);
    committed(TARGET, TARGET_DOC);
    completed(TARGET, PREVIOUS_DOC);
    await flush();
    expect(state.settled).toBe(false);
    completed(TARGET, TARGET_DOC);
    await flush();
    expect(state.value).toEqual({ status: 'loaded', url: TARGET });
  });

  it('matches onCompleted to the committed document by url when Firefox sends no documentId', async () => {
    const state = await startWait();
    beforeNavigate(TARGET);
    committed(TARGET, undefined);
    completed(PREVIOUS, undefined);
    await flush();
    expect(state.settled).toBe(false);
    completed(TARGET, undefined);
    await flush();
    expect(state.value).toEqual({ status: 'loaded', url: TARGET });
  });

  describe('while the tab is still loading the previous page', () => {
    it('ignores a commit and a completion of the previous page that arrive before the new navigation starts', async () => {
      const state = await startWait();
      committed(PREVIOUS, PREVIOUS_DOC);
      completed(PREVIOUS, PREVIOUS_DOC);
      failed(PREVIOUS, CONNECTION_REFUSED);
      await flush();
      expect(state.settled).toBe(false);
      normalLoad();
      await flush();
      expect(state.value).toEqual({ status: 'loaded', url: TARGET });
    });

    it('ignores a stale completion of the previous page after the new navigation started', async () => {
      const state = await startWait();
      failed(PREVIOUS, ABORTED);
      beforeNavigate(TARGET);
      completed(PREVIOUS, PREVIOUS_DOC);
      await flush();
      expect(state.settled).toBe(false);
      committed(TARGET, TARGET_DOC);
      completed(PREVIOUS, PREVIOUS_DOC);
      await flush();
      expect(state.settled).toBe(false);
      completed(TARGET, TARGET_DOC);
      await flush();
      expect(state.value).toEqual({ status: 'loaded', url: TARGET });
    });

    it('drops a commit when Firefox starts the navigation over', async () => {
      const state = await startWait();
      beforeNavigate(TARGET);
      committed(PREVIOUS, PREVIOUS_DOC);
      beforeNavigate(TARGET);
      completed(PREVIOUS, PREVIOUS_DOC);
      await flush();
      expect(state.settled).toBe(false);
      committed(TARGET, TARGET_DOC);
      completed(TARGET, TARGET_DOC);
      await flush();
      expect(state.value).toEqual({ status: 'loaded', url: TARGET });
    });
  });

  it('ignores subframes and other tabs', async () => {
    const state = await startWait();
    beforeNavigate(TARGET);
    committed(TARGET, TARGET_DOC);
    beforeNavigate('https://example.com/frame', { frameId: SUBFRAME });
    committed('https://example.com/frame', 'doc-frame', { frameId: SUBFRAME });
    failed('https://example.com/frame', UNKNOWN_HOST, { frameId: SUBFRAME });
    completed('https://example.com/frame', 'doc-frame', { frameId: SUBFRAME });
    beforeNavigate(TARGET, { tabId: OTHER_TAB });
    failed(TARGET, UNKNOWN_HOST, { tabId: OTHER_TAB });
    completed(TARGET, TARGET_DOC, { tabId: OTHER_TAB });
    fragmentUpdated(`${TARGET}#x`, { tabId: OTHER_TAB });
    removed(OTHER_TAB);
    await flush();
    expect(state.settled).toBe(false);
    completed(TARGET, TARGET_DOC);
    await flush();
    expect(state.value).toEqual({ status: 'loaded', url: TARGET });
  });

  describe('errors', () => {
    it.each([
      ['an unknown host', 'https://nonexistent.invalid/', UNKNOWN_HOST],
      ['a refused connection', 'http://127.0.0.1:9/', CONNECTION_REFUSED],
    ])('reports %s with the url and the raw error', async (_label, url, error) => {
      const state = await startWait({ kind: 'url', url });
      beforeNavigate(url);
      failed(url, ABORTED);
      beforeNavigate(url);
      failed(url, error, { documentId: 'doc-error' });
      committed(url, 'doc-error-page');
      await flush();
      expect(state.value).toEqual({ status: 'error', url, error });
      expectCleanedUp();
    });

    it('passes on a missing error description', async () => {
      const state = await startWait();
      beforeNavigate(TARGET);
      failed(TARGET, undefined);
      await flush();
      expect(state.value).toEqual({ status: 'error', url: TARGET, error: undefined });
    });

    it('ignores NS_BINDING_ABORTED of another document even after the navigation committed', async () => {
      const state = await startWait();
      beforeNavigate(TARGET);
      failed(TARGET, ABORTED);
      committed(TARGET, TARGET_DOC);
      failed(TARGET, ABORTED, { documentId: PREVIOUS_DOC });
      await flush();
      expect(state.settled).toBe(false);
      completed(TARGET, TARGET_DOC);
      await flush();
      expect(state.value).toEqual({ status: 'loaded', url: TARGET });
    });

    it('reports NS_BINDING_ABORTED of the committed document as an error without waiting for the timeout', async () => {
      const state = await startWait();
      beforeNavigate(TARGET);
      committed(TARGET, TARGET_DOC);
      failed(TARGET, ABORTED, { documentId: TARGET_DOC });
      await flush();
      expect(state.value).toEqual({ status: 'error', url: TARGET, error: ABORTED });
      expectCleanedUp();
    });
  });

  describe('downloads', () => {
    it('reports a download: the target completes without a commit', async () => {
      const download = 'https://example.com/file.zip';
      const state = await startWait({ kind: 'url', url: download });
      beforeNavigate(download);
      completed(download, PREVIOUS_DOC);
      await flush();
      expect(state.value).toEqual({ status: 'download', url: download });
      expectCleanedUp();
    });

    it('does not take a stale completion of the previous page for a download', async () => {
      const state = await startWait();
      beforeNavigate(TARGET);
      completed(PREVIOUS, PREVIOUS_DOC);
      await flush();
      expect(state.settled).toBe(false);
    });

    // Known limitation: the completion of a download behind a redirect carries the final url, which
    // does not match the started one, so it ends in no-response.
    it('ends a download behind a redirect without a second onBeforeNavigate in no-response', async () => {
      const redirect = 'https://example.com/get';
      const state = await startWait({ kind: 'url', url: redirect });
      beforeNavigate(redirect);
      completed('https://cdn.example.com/file.zip', PREVIOUS_DOC);
      await flush();
      expect(state.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(state.value).toEqual({ status: 'no-response', url: redirect });
      expectCleanedUp();
    });

    it('does not report a download before the navigation started', async () => {
      const state = await startWait();
      completed(TARGET, PREVIOUS_DOC);
      await flush();
      expect(state.settled).toBe(false);
    });
  });

  describe('same-document navigation', () => {
    it('resolves same-document on a fragment update to the target url', async () => {
      const state = await startWait({ kind: 'url', url: `${TARGET}#section` });
      fragmentUpdated(`${TARGET}#other`);
      await flush();
      expect(state.settled).toBe(false);
      fragmentUpdated(`${TARGET}#section`);
      await flush();
      expect(state.value).toEqual({ status: 'same-document', url: `${TARGET}#section` });
      expectCleanedUp();
    });

    it('accepts a main-frame fragment or history state update of a history traversal for back and forward', async () => {
      const back = await startWait({ kind: 'back' });
      historyStateUpdated('https://example.com/app/list', { transitionQualifiers: TRAVERSAL });
      await flush();
      expect(back.value).toEqual({ status: 'same-document', url: 'https://example.com/app/list' });

      const forward = await startWait({ kind: 'forward' });
      fragmentUpdated(`${TARGET}#next`, { transitionQualifiers: TRAVERSAL });
      await flush();
      expect(forward.value).toEqual({ status: 'same-document', url: `${TARGET}#next` });
      expectCleanedUp();
    });

    it('accepts a traversal update that arrives before the back call resolved', async () => {
      let resolveStart = () => {};
      const state = await startWait({ kind: 'back' }, () => new Promise<void>((resolve) => (resolveStart = resolve)));
      fragmentUpdated(TARGET, { transitionQualifiers: TRAVERSAL });
      await flush();
      expect(state.value).toEqual({ status: 'same-document', url: TARGET });
      resolveStart();
      await flush();
      expectCleanedUp();
    });

    it.each<['back' | 'forward']>([['back'], ['forward']])(
      "ignores the page's own pushState, replaceState and fragment changes while going %s",
      async (kind) => {
        const state = await startWait({ kind });
        historyStateUpdated('https://example.com/app/list');
        historyStateUpdated('https://example.com/app/list?r=1', { transitionQualifiers: ['client_redirect'] });
        fragmentUpdated(`${TARGET}#next`);
        await flush();
        expect(state.settled).toBe(false);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(state.value).toEqual({ status: 'not-started' });
        expectCleanedUp();
      },
    );

    it('ignores a replaceState that lands after a back call on a tab without history', async () => {
      const state = await startWait({ kind: 'back' });
      await vi.advanceTimersByTimeAsync(400);
      historyStateUpdated(`${PREVIOUS}?r=1`);
      await vi.advanceTimersByTimeAsync(1_599);
      expect(state.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(state.value).toEqual({ status: 'not-started' });
      expectCleanedUp();
    });

    it('ignores history updates of the old page once a back navigation has started', async () => {
      const state = await startWait({ kind: 'back' });
      beforeNavigate(TARGET);
      historyStateUpdated('https://previous.example/#x', { transitionQualifiers: TRAVERSAL });
      await flush();
      expect(state.settled).toBe(false);
    });
  });

  describe('history', () => {
    it('resolves loaded on a back navigation restored from the cache', async () => {
      const state = await startWait({ kind: 'back' });
      beforeNavigate(TARGET);
      committed(TARGET, TARGET_DOC);
      completed(TARGET, TARGET_DOC);
      await flush();
      expect(state.value).toEqual({ status: 'loaded', url: TARGET });
    });
  });

  describe('timeouts', () => {
    it('resolves not-started 2 s after the navigation call resolved when nothing happens', async () => {
      const state = await startWait({ kind: 'forward' });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(state.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(state.value).toEqual({ status: 'not-started' });
      expectCleanedUp();
    });

    it('measures the 2 s from when the navigation call resolved', async () => {
      let resolveStart = () => {};
      const state = await startWait(toTarget, () => new Promise<void>((resolve) => (resolveStart = resolve)));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(state.settled).toBe(false);
      resolveStart();
      await vi.advanceTimersByTimeAsync(1_999);
      expect(state.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(state.value).toEqual({ status: 'not-started' });
      expectCleanedUp();
    });

    it('does not count stale events of the previous page as a start', async () => {
      const state = await startWait();
      failed(PREVIOUS, ABORTED);
      committed(PREVIOUS, PREVIOUS_DOC);
      completed(PREVIOUS, PREVIOUS_DOC);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(state.value).toEqual({ status: 'not-started' });
    });

    it('resolves still-loading 20 s after the call when the page committed but never completed', async () => {
      const state = await startWait();
      beforeNavigate(TARGET);
      committed(TARGET, TARGET_DOC);
      await vi.advanceTimersByTimeAsync(19_999);
      expect(state.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(state.value).toEqual({ status: 'still-loading', url: TARGET });
      expectCleanedUp();
    });

    it('resolves no-response 20 s after the call when the navigation started but never committed', async () => {
      const state = await startWait();
      beforeNavigate(TARGET);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(state.value).toEqual({ status: 'no-response', url: TARGET });
      expectCleanedUp();
    });

    it('resolves not-started at 20 s when the navigation call itself never resolves', async () => {
      const state = await startWait(toTarget, () => new Promise<void>(() => {}));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(state.value).toEqual({ status: 'not-started' });
      expectCleanedUp();
    });
  });

  it('resolves closed when the tab is removed during the wait', async () => {
    const state = await startWait();
    beforeNavigate(TARGET);
    removed(TAB);
    await flush();
    expect(state.value).toEqual({ status: 'closed' });
    expectCleanedUp();
  });

  it('rejects with the error of the navigation call and cleans up', async () => {
    const state = await startWait(toTarget, async () => {
      throw new Error('Illegal URL');
    });
    expect(state.error).toEqual(new Error('Illegal URL'));
    expectCleanedUp();
  });

  it('rejects and cleans up when the navigation call throws synchronously', async () => {
    const state = await startWait(toTarget, () => {
      throw new Error('Illegal URL');
    });
    expect(state.error).toEqual(new Error('Illegal URL'));
    expectCleanedUp();
    const next = await startWait();
    normalLoad();
    await flush();
    expect(next.value).toEqual({ status: 'loaded', url: TARGET });
    expectCleanedUp();
  });

  describe('a newer wait in the same tab', () => {
    it('ends the wait in flight as superseded and keeps following its own navigation', async () => {
      const first = await startWait({ kind: 'url', url: 'https://slow.example/' });
      beforeNavigate('https://slow.example/');
      committed('https://slow.example/', PREVIOUS_DOC);
      const second = await startWait();
      expect(first.value).toEqual<NavigationOutcome>({ status: 'superseded' });
      expect(second.settled).toBe(false);
      normalLoad();
      await flush();
      expect(second.value).toEqual({ status: 'loaded', url: TARGET });
      expectCleanedUp();
    });

    it('supersedes the wait in flight before the newer navigation starts', async () => {
      const first = await startWait({ kind: 'url', url: 'https://slow.example/' });
      beforeNavigate('https://slow.example/');
      let listenersAtStart = -1;
      const second = await startWait(toTarget, async () => {
        listenersAtStart = browserMock.listenerCount();
        normalLoad();
      });
      expect(listenersAtStart).toBe(7);
      expect(first.value).toEqual({ status: 'superseded' });
      expect(second.value).toEqual({ status: 'loaded', url: TARGET });
      expectCleanedUp();
    });

    it('does not touch a wait in another tab', async () => {
      const other = track(waitForNavigation(OTHER_TAB, toTarget, async () => {}));
      await flush();
      const state = await startWait();
      normalLoad();
      await flush();
      expect(state.value).toEqual({ status: 'loaded', url: TARGET });
      expect(other.settled).toBe(false);
      beforeNavigate(TARGET, { tabId: OTHER_TAB });
      committed(TARGET, TARGET_DOC, { tabId: OTHER_TAB });
      completed(TARGET, TARGET_DOC, { tabId: OTHER_TAB });
      await flush();
      expect(other.value).toEqual({ status: 'loaded', url: TARGET });
      expectCleanedUp();
    });

    it('does not supersede a wait that already settled', async () => {
      const first = await startWait();
      normalLoad();
      await flush();
      const second = await startWait({ kind: 'url', url: 'https://other.example/' });
      expect(first.value).toEqual({ status: 'loaded', url: TARGET });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(second.value).toEqual({ status: 'not-started' });
      expectCleanedUp();
    });
  });

  it('ignores events after it has settled', async () => {
    const state = await startWait();
    beforeNavigate(TARGET);
    removed(TAB);
    await flush();
    committed(TARGET, TARGET_DOC);
    completed(TARGET, TARGET_DOC);
    failed(TARGET, UNKNOWN_HOST);
    await flush();
    expect(state.value).toEqual({ status: 'closed' });
    expectCleanedUp();
  });
});

describe('navigate tool', () => {
  const TABS_CONTEXT = '{"tabs":[{"tabId":5,"windowId":1,"title":"Example Domain","url":"https://example.com/","active":true}],"activeTabId":5}';

  function request(args: Record<string, unknown>) {
    return { type: 'tool_request' as const, id: '1:7', tool: 'navigate', args };
  }

  function setTab(tab: Partial<browser.tabs.Tab> | undefined) {
    browserMock.tabs.get.mockImplementation(async (tabId) => {
      if (tabId !== TAB || !tab) throw new Error(`Invalid tab ID: ${tabId}`);
      return { id: TAB, windowId: 1, active: true, ...tab };
    });
  }

  function setTabsContext() {
    browserMock.query.mockImplementation(async (query) =>
      query.active
        ? [{ id: TAB, windowId: 1, active: true }]
        : [{ id: TAB, windowId: 1, title: 'Example Domain', url: TARGET, active: true }],
    );
  }

  function success(text: string) {
    return { type: 'tool_response', id: '1:7', result: { content: [{ type: 'text', text }] } };
  }

  function failure(text: string) {
    return { type: 'tool_response', id: '1:7', error: { content: [{ type: 'text', text }] } };
  }

  async function run(args: Record<string, unknown>, events: () => void = () => {}) {
    const state = track(executeTool(request(args)));
    await flush();
    events();
    await flush();
    return state;
  }

  beforeEach(() => {
    setTab({ url: PREVIOUS, title: 'Previous' });
    setTabsContext();
  });

  afterEach(() => {
    expectCleanedUp();
  });

  it('navigates to a normalized url and reports the final url, the title and the tabs context', async () => {
    const state = await run({ tabId: TAB, url: 'example.com' }, () => {
      setTab({ url: TARGET, title: 'Example Domain' });
      normalLoad();
    });
    expect(browserMock.tabs.update).toHaveBeenCalledWith(TAB, { url: TARGET });
    expect(state.value).toEqual(success(`Navigated to ${TARGET}\nTitle: Example Domain\n\nTabs context: ${TABS_CONTEXT}`));
  });

  it('reports the url after a redirect', async () => {
    const state = await run({ tabId: TAB, url: 'http://example.com' }, () => {
      setTab({ url: 'https://www.example.com/', title: 'Example' });
      beforeNavigate('http://example.com/');
      beforeNavigate('https://www.example.com/');
      committed('https://www.example.com/', TARGET_DOC);
      completed('https://www.example.com/', TARGET_DOC);
    });
    expect(browserMock.tabs.update).toHaveBeenCalledWith(TAB, { url: 'http://example.com/' });
    expect(state.value).toEqual(success(`Navigated to https://www.example.com/\nTitle: Example\n\nTabs context: ${TABS_CONTEXT}`));
  });

  it('omits the title line when the page has no title', async () => {
    const state = await run({ tabId: TAB, url: TARGET }, () => {
      setTab({ url: TARGET, title: '' });
      normalLoad();
    });
    expect(state.value).toEqual(success(`Navigated to ${TARGET}\n\nTabs context: ${TABS_CONTEXT}`));
  });

  it('reports success after a same-document navigation', async () => {
    const state = await run({ tabId: TAB, url: `${TARGET}#part` }, () => {
      setTab({ url: `${TARGET}#part`, title: 'Example Domain' });
      fragmentUpdated(`${TARGET}#part`);
    });
    expect(state.value).toEqual(success(`Navigated to ${TARGET}#part\nTitle: Example Domain\n\nTabs context: ${TABS_CONTEXT}`));
  });

  it('says the tab is already on the url when Firefox starts nothing because nothing would change', async () => {
    setTab({ url: `${TARGET}#part`, title: 'Example Domain' });
    const state = await run({ tabId: TAB, url: `${TARGET}#part` });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(state.value).toEqual(
      success(`Tab 5 is already on ${TARGET}#part\nTitle: Example Domain\n\nTabs context: ${TABS_CONTEXT}`),
    );
  });

  it('reports a navigation to another url that does not start as an error', async () => {
    const state = await run({ tabId: TAB, url: TARGET });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(state.value).toEqual(failure(`Failed to navigate: the navigation to ${TARGET} did not start within 2 s`));
  });

  it('reports success with a still-loading note when the page committed but did not finish in 20 s', async () => {
    const state = await run({ tabId: TAB, url: 'https://slow.example/' }, () => {
      setTab({ url: 'https://slow.example/', title: 'Slow' });
      beforeNavigate('https://slow.example/');
      committed('https://slow.example/', TARGET_DOC);
    });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.value).toEqual(
      success(
        `Navigated to https://slow.example/\nTitle: Slow\nThe page was still loading after 20 s; its content may be incomplete.\n\nTabs context: ${TABS_CONTEXT}`,
      ),
    );
  });

  it('reports a server that does not respond in 20 s as an error', async () => {
    const state = await run({ tabId: TAB, url: 'https://hang.example/' }, () => {
      beforeNavigate('https://hang.example/');
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(state.value).toEqual(failure('Failed to navigate: https://hang.example/ did not respond within 20 s'));
  });

  it('reports a download instead of a navigation, with the page the tab stays on', async () => {
    const download = 'https://example.com/file.zip';
    const state = await run({ tabId: TAB, url: download }, () => {
      beforeNavigate(download);
      completed(download, PREVIOUS_DOC);
    });
    expect(state.value).toEqual(
      success(`${download} started a download instead of opening a page; tab 5 stays on ${PREVIOUS}`),
    );
  });

  it.each<[string, string | undefined, string]>([
    ['an unknown host', UNKNOWN_HOST, 'server not found (NS_ERROR_UNKNOWN_HOST, Error code 2152398878)'],
    ['a refused connection', CONNECTION_REFUSED, 'connection refused (NS_ERROR_CONNECTION_REFUSED, Error code 2152398861)'],
    ['a timeout', 'Error code 2152398862', 'connection timed out (NS_ERROR_NET_TIMEOUT, Error code 2152398862)'],
    ['an unmapped code', 'Error code 2153390067', 'Error code 2153390067'],
    ['a missing description', undefined, 'unknown error'],
  ])('reports %s with a readable message', async (_label, error, message) => {
    const url = 'https://nonexistent.invalid/';
    const state = await run({ tabId: TAB, url: 'nonexistent.invalid' }, () => {
      beforeNavigate(url);
      failed(url, ABORTED);
      beforeNavigate(url);
      failed(url, error);
    });
    expect(state.value).toEqual(failure(`Failed to navigate to ${url}: ${message}`));
  });

  it('reports an aborted load of the committed page with a readable message', async () => {
    const state = await run({ tabId: TAB, url: TARGET }, () => {
      beforeNavigate(TARGET);
      committed(TARGET, TARGET_DOC);
      failed(TARGET, ABORTED, { documentId: TARGET_DOC });
    });
    expect(state.value).toEqual(
      failure(`Failed to navigate to ${TARGET}: the load was aborted (NS_BINDING_ABORTED, Error code 2152398850)`),
    );
  });

  it('reports a tab closed during the wait', async () => {
    const state = await run({ tabId: TAB, url: TARGET }, () => {
      beforeNavigate(TARGET);
      setTab(undefined);
      removed(TAB);
    });
    expect(state.value).toEqual(failure('Failed to navigate: tab 5 was closed'));
  });

  it('reports a tab that disappears between the end of the wait and reading its final state', async () => {
    const state = await run({ tabId: TAB, url: TARGET }, () => {
      setTab(undefined);
      normalLoad();
    });
    expect(state.value).toEqual(failure('Failed to navigate: tab 5 was closed'));
  });

  it('fails the earlier call when another navigate call in the same tab supersedes it', async () => {
    const first = await run({ tabId: TAB, url: 'https://slow.example/' }, () => {
      beforeNavigate('https://slow.example/');
      committed('https://slow.example/', PREVIOUS_DOC);
    });
    const second = await run({ tabId: TAB, url: TARGET }, () => {
      setTab({ url: TARGET, title: 'Example Domain' });
      failed('https://slow.example/', ABORTED, { documentId: PREVIOUS_DOC });
      normalLoad();
    });
    expect(first.value).toEqual(
      failure('Failed to navigate: superseded by another navigate call in tab 5 before this navigation finished'),
    );
    expect(second.value).toEqual(success(`Navigated to ${TARGET}\nTitle: Example Domain\n\nTabs context: ${TABS_CONTEXT}`));
  });

  it('maps a rejected tabs.update to a navigation error', async () => {
    browserMock.tabs.update.mockRejectedValue(new Error(`Illegal URL: ${TARGET}`));
    const state = await run({ tabId: TAB, url: TARGET });
    expect(state.value).toEqual(failure(`Failed to navigate: Illegal URL: ${TARGET}`));
  });

  it('rejects a nonexistent tab without navigating', async () => {
    const state = await run({ tabId: 99, url: TARGET });
    expect(state.value).toEqual(failure('Failed to navigate: tab 99 does not exist'));
    expect(browserMock.tabs.update).not.toHaveBeenCalled();
  });

  it('answers an unexpected failure that is not a navigation error with "Tool execution failed:"', async () => {
    browserMock.query.mockRejectedValue(new Error('tabs API unavailable'));
    const state = await run({ tabId: TAB, url: TARGET }, () => {
      setTab({ url: TARGET, title: 'Example Domain' });
      normalLoad();
    });
    expect(state.value).toEqual(failure('Tool execution failed: tabs API unavailable'));
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['a missing url', { tabId: TAB }, 'Missing required parameter url (string)'],
    ['a missing tabId', { url: TARGET }, 'Missing required parameter tabId (integer)'],
    ['a fractional tabId', { tabId: 1.5, url: TARGET }, 'tabId must be an integer, received 1.5'],
    [
      'a javascript: url',
      { tabId: TAB, url: 'javascript:alert(1)' },
      'Unsupported URL scheme "javascript:"; only http and https URLs are allowed',
    ],
  ])('rejects %s with the parser message and touches no tab', async (_label, args, message) => {
    const state = await run(args);
    expect(state.value).toEqual(failure(`Failed to navigate: ${message}`));
    expect(browserMock.tabs.get).not.toHaveBeenCalled();
    expect(browserMock.tabs.update).not.toHaveBeenCalled();
  });

  describe('history', () => {
    it.each<[string, 'goBack' | 'goForward', string]>([
      ['back', 'goBack', 'Navigated back to'],
      ['forward', 'goForward', 'Navigated forward to'],
    ])('goes %s and reports the page it landed on', async (keyword, method, prefix) => {
      const state = await run({ tabId: TAB, url: keyword }, () => {
        setTab({ url: TARGET, title: 'Example Domain' });
        beforeNavigate(TARGET);
        committed(TARGET, TARGET_DOC);
        completed(TARGET, TARGET_DOC);
      });
      expect(browserMock.tabs[method]).toHaveBeenCalledWith(TAB);
      expect(browserMock.tabs.update).not.toHaveBeenCalled();
      expect(state.value).toEqual(success(`${prefix} ${TARGET}\nTitle: Example Domain\n\nTabs context: ${TABS_CONTEXT}`));
    });

    it('goes back within the same document', async () => {
      const state = await run({ tabId: TAB, url: 'BACK' }, () => {
        setTab({ url: `${TARGET}#top`, title: 'Example Domain' });
        fragmentUpdated(`${TARGET}#top`, { transitionQualifiers: TRAVERSAL });
      });
      expect(state.value).toEqual(
        success(`Navigated back to ${TARGET}#top\nTitle: Example Domain\n\nTabs context: ${TABS_CONTEXT}`),
      );
    });

    it.each<[string, string]>([
      ['back', 'tab 5 has no previous page in its history; it stays on https://previous.example/'],
      ['forward', 'tab 5 has no next page in its history; it stays on https://previous.example/'],
    ])('reports going %s without history when nothing starts within 2 s', async (keyword, message) => {
      const state = await run({ tabId: TAB, url: keyword });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(state.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(state.value).toEqual(failure(`Failed to navigate: ${message}`));
    });

    it("does not take the page's own replaceState for a step back", async () => {
      const state = await run({ tabId: TAB, url: 'back' });
      await vi.advanceTimersByTimeAsync(400);
      historyStateUpdated(`${PREVIOUS}?r=1`);
      await vi.advanceTimersByTimeAsync(1_600);
      expect(state.value).toEqual(
        failure('Failed to navigate: tab 5 has no previous page in its history; it stays on https://previous.example/'),
      );
    });

    it('maps a rejected tabs.goBack to a navigation error', async () => {
      browserMock.tabs.goBack.mockRejectedValue(new Error('NS_ERROR_UNEXPECTED'));
      const state = await run({ tabId: TAB, url: 'back' });
      expect(state.value).toEqual(failure('Failed to navigate: NS_ERROR_UNEXPECTED'));
    });
  });
});
