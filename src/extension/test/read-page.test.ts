import { beforeEach, describe, expect, it, vi } from 'vitest';
import { READ_PAGE_ENTRY, READ_PAGE_SCRIPT, type ReadPageEntry, type ReadPageResult } from '../page/read-page-api';
import type { ApprovalPrompt } from '../permissions/approval';
import { executeTool } from '../tools';
import { permissionMessage } from '../tools/tab-access';
import { pageChangedMessage, READ_PAGE_TIMEOUT_MS, readPage, stillLoadingMessage } from '../tools/read-page';
import { mockBrowser } from './browser-mock';

const TAB = 5;
const OTHER_TAB = 6;
const PAGE = 'https://example.com/';
const TREE = 'button "Save" [ref_1]';

let browserMock: ReturnType<typeof mockBrowser>;
let tabs: Map<number, Partial<browser.tabs.Tab>>;
let entry: ReturnType<typeof vi.fn<ReadPageEntry>>;
let pageResult: ReadPageResult;

type Injection = browser.scripting.ScriptInjection<unknown[], unknown>;

// Runs func injections for real against the global, so a file injection installs the entry point there.
function runInjection(injection: Injection): browser.scripting.InjectionResult<unknown>[] {
  if (injection.files) {
    vi.stubGlobal(READ_PAGE_ENTRY, entry);
    return [{ frameId: 0, result: undefined }];
  }
  const func = injection.func as (...args: unknown[]) => unknown;
  return [{ frameId: 0, result: func(...(injection.args ?? [])) }];
}

function injections(): Injection[] {
  return browserMock.scripting.executeScript.mock.calls.map(([injection]) => injection);
}

beforeEach(() => {
  browserMock = mockBrowser();
  browserMock.allowSites('example.com', 'other.example');
  tabs = new Map([
    [TAB, { id: TAB, windowId: 1, url: PAGE, active: true }],
    [OTHER_TAB, { id: OTHER_TAB, windowId: 1, url: 'https://other.example/', active: false }],
  ]);
  browserMock.tabs.get.mockImplementation(async (tabId) => {
    const tab = tabs.get(tabId);
    if (!tab) throw new Error(`Invalid tab ID: ${tabId}`);
    return { ...tab };
  });
  browserMock.query.mockImplementation(async (query) => [...tabs.values()].filter((tab) => !query.active || tab.active));
  browserMock.permissions.contains.mockResolvedValue(true);
  pageResult = { ok: true, tree: TREE, viewport: { width: 1280, height: 720 } };
  entry = vi.fn<ReadPageEntry>(() => pageResult);
  browserMock.scripting.executeScript.mockImplementation(async (injection) => runInjection(injection));
});

async function run(args: Record<string, unknown> = {}) {
  return executeTool({ type: 'tool_request', id: '1:1', tool: 'read_page', args });
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

describe('read_page: output', () => {
  it('returns the tree, a blank line and the viewport size', async () => {
    expect(await text({ tabId: TAB })).toBe(`${TREE}\n\nViewport: 1280x720`);
  });

  it('reads the active tab by default', async () => {
    await text();
    expect(browserMock.query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true, windowType: 'normal' });
    expect(injections()[0]?.target).toEqual({ tabId: TAB });
  });

  it('passes the parsed options with defaults to the page', async () => {
    await text({ tabId: OTHER_TAB, filter: 'interactive', ref_id: 'ref_3', max_chars: 100 });
    expect(entry).toHaveBeenCalledWith({ filter: 'interactive', depth: 15, maxChars: 100, refId: 'ref_3' });
    expect(injections()[0]?.target).toEqual({ tabId: OTHER_TAB });
  });

  it('explains an empty tree', async () => {
    pageResult = { ok: true, tree: '', viewport: { width: 800, height: 600 } };
    expect(await text()).toBe('No visible elements found on the page; it may be empty or still loading.\n\nViewport: 800x600');
    expect(await text({ filter: 'interactive' })).toMatch(/^No visible interactive elements found on the page\./);
  });

  it('reports a ref error from the builder as is', async () => {
    const error = 'ref_9 no longer exists in the page. Call read_page without ref_id to get fresh element references.';
    pageResult = { ok: false, error };
    expect(await failure({ ref_id: 'ref_9' })).toBe(error);
  });

  it('rejects invalid arguments before touching the browser', async () => {
    expect(await failure({ depth: 0 })).toMatch(/^Invalid read_page arguments: depth must be a positive integer/);
    expect(await failure({ filter: 'links' })).toMatch(/^Invalid read_page arguments: Unknown filter "links"/);
    expect(browserMock.query).not.toHaveBeenCalled();
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('refuses a tab without a url before injecting', async () => {
    tabs.set(TAB, { id: TAB, windowId: 1, active: true });
    expect(await failure()).toBe(
      `Cannot read tab ${TAB} (): Invalid URL; site permissions only cover http and https pages`,
    );
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('reports a tab that does not exist', async () => {
    expect(await failure({ tabId: 99 })).toMatch(/^Failed to read the page: tab 99 does not exist/);
  });
});

describe('read_page: injection', () => {
  it('injects the page script once, then only calls the entry point', async () => {
    await text();
    expect(injections()).toEqual([
      expect.objectContaining({ target: { tabId: TAB }, func: expect.any(Function), args: [READ_PAGE_ENTRY, expect.anything()] }),
      { target: { tabId: TAB }, files: [READ_PAGE_SCRIPT] },
      expect.objectContaining({ target: { tabId: TAB }, func: expect.any(Function) }),
    ]);
    browserMock.scripting.executeScript.mockClear();
    await text();
    expect(injections()).toHaveLength(1);
    expect(injections()[0]?.files).toBeUndefined();
  });

  it('never injects into all frames or the main world', async () => {
    await text();
    for (const injection of injections()) {
      expect(injection.target).toEqual({ tabId: TAB });
      expect(injection.world).toBeUndefined();
    }
  });

  it('fails when the page script does not install the entry point', async () => {
    browserMock.scripting.executeScript.mockImplementation(async (injection) =>
      injection.files ? [{ frameId: 0, result: undefined }] : runInjection(injection),
    );
    expect(await failure()).toBe(`Failed to read tab ${TAB}: the page script did not load`);
  });

  it('rejects a malformed result', async () => {
    browserMock.scripting.executeScript.mockResolvedValue([{ frameId: 0, result: { ok: true, tree: 1 } }]);
    expect(await failure()).toBe(`Failed to read tab ${TAB}: the page returned no usable result`);
  });

  it('reports an error thrown in the page', async () => {
    browserMock.scripting.executeScript.mockResolvedValue([{ frameId: 0, error: new Error('boom') }]);
    expect(await failure()).toBe(`Failed to read tab ${TAB}: boom`);
  });

  it('times out with a still loading message', async () => {
    vi.useFakeTimers();
    try {
      browserMock.scripting.executeScript.mockImplementation(() => new Promise(() => {}));
      const response = run();
      await vi.advanceTimersByTimeAsync(READ_PAGE_TIMEOUT_MS);
      expect(await response).toMatchObject({ error: { content: [{ type: 'text', text: stillLoadingMessage(TAB) }] } });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('read_page: restricted pages', () => {
  it.each([
    'https://addons.mozilla.org/en-US/firefox/',
    'https://support.mozilla.org/',
  ])('refuses %s before asking for a permission', async (url) => {
    tabs.set(TAB, { id: TAB, windowId: 1, url, active: true });
    expect(await failure()).toMatch(new RegExp(`^Cannot read tab ${TAB} \\(.*\\): Firefox does not let extensions access this page`));
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it.each(['about:preferences', 'view-source:https://example.com/', 'moz-extension://abc/page.html'])(
    'refuses the non-http page %s',
    async (url) => {
      tabs.set(TAB, { id: TAB, windowId: 1, url, active: true });
      expect(await failure()).toMatch(new RegExp(`^Cannot read tab ${TAB} `));
      expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
    },
  );

  it('maps a missing host permission on a page Firefox protects to the restricted page message', async () => {
    browserMock.scripting.executeScript.mockRejectedValue(new Error('Missing host permission for the tab'));
    expect(await failure()).toMatch(new RegExp(`^Cannot read tab ${TAB} \\(${PAGE}\\): Firefox does not let extensions access this page`));
  });

  it('tells the user to grant site access in about:addons when the host permission is missing', async () => {
    browserMock.permissions.contains.mockResolvedValue(false);
    expect(await failure()).toBe(permissionMessage('read the page'));
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('checks the host permission again when the injection is refused', async () => {
    browserMock.permissions.contains.mockResolvedValueOnce(true).mockResolvedValue(false);
    browserMock.scripting.executeScript.mockRejectedValue(new Error('Missing host permission for the tab'));
    expect(await failure()).toMatch(/about:addons/);
  });

  it('reports other injection errors with their message', async () => {
    browserMock.scripting.executeScript.mockRejectedValue(new Error('No tab with id: 5'));
    expect(await failure()).toBe(`Failed to read tab ${TAB}: No tab with id: 5`);
  });
});

describe('read_page: site permission', () => {
  it('asks with the read_page_content action for a site without a stored decision', async () => {
    tabs.set(TAB, { id: TAB, windowId: 1, url: 'https://new.example/a', active: true });
    const prompt: ApprovalPrompt = {
      requestApproval: vi.fn(async () => ({ kind: 'answered' as const, answer: 'allow_once' as const, wildcard: false })),
    };
    const content = await readPage({}, prompt);
    expect(prompt.requestApproval).toHaveBeenCalledWith({
      host: 'new.example',
      url: 'https://new.example/a',
      tool: 'read_page',
      action: 'read_page_content',
    });
    expect(content).toEqual([{ type: 'text', text: `${TREE}\n\nViewport: 1280x720` }]);
  });

  it('does not inject when the user denies', async () => {
    tabs.set(TAB, { id: TAB, windowId: 1, url: 'https://new.example/', active: true });
    const prompt: ApprovalPrompt = {
      requestApproval: vi.fn(async () => ({ kind: 'answered' as const, answer: 'deny' as const, wildcard: false })),
    };
    await expect(readPage({}, prompt)).rejects.toThrow(/denied access to new\.example/);
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('refuses when the tab moved to another site before the injection', async () => {
    tabs.set(TAB, { id: TAB, windowId: 1, url: 'https://new.example/', active: true });
    const prompt: ApprovalPrompt = {
      requestApproval: vi.fn(async () => {
        tabs.set(TAB, { id: TAB, windowId: 1, url: 'https://other.example/', active: true });
        return { kind: 'answered' as const, answer: 'allow_once' as const, wildcard: false };
      }),
    };
    await expect(readPage({}, prompt)).rejects.toThrow(pageChangedMessage(TAB, 'new.example'));
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('drops the tree when the tab moved to another site during the injection', async () => {
    browserMock.scripting.executeScript.mockImplementation(async (injection) => {
      tabs.set(TAB, { id: TAB, windowId: 1, url: 'https://other.example/', active: true });
      return runInjection(injection);
    });
    expect(await failure()).toBe(pageChangedMessage(TAB, 'example.com'));
  });

  it('reports a tab closed during the read', async () => {
    browserMock.scripting.executeScript.mockImplementation(async (injection) => {
      tabs.delete(TAB);
      return runInjection(injection);
    });
    expect(await failure()).toBe(`Cannot read tab ${TAB}: the tab was closed`);
  });
});
