import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PAGE_TEXT_ENTRY, PAGE_TEXT_SCRIPT, type PageTextEntry, type PageTextResult } from '../page/page-text-api';
import type { ApprovalPrompt } from '../permissions/approval';
import { executeTool } from '../tools';
import { PAGE_SCRIPT_TIMEOUT_MS, pageChangedMessage, stillLoadingMessage } from '../tools/page-script';
import { getPageText } from '../tools/page-text';
import { permissionMessage } from '../tools/tab-access';
import { mockBrowser } from './browser-mock';

const TAB = 5;
const OTHER_TAB = 6;
const PAGE = 'https://example.com/';
const OUTPUT = 'Title: Example\nURL: https://example.com/post\nSource element: <article>\n---\nSome article text';

let browserMock: ReturnType<typeof mockBrowser>;
let tabs: Map<number, Partial<browser.tabs.Tab>>;
let entry: ReturnType<typeof vi.fn<PageTextEntry>>;
let pageResult: PageTextResult;

type Injection = browser.scripting.ScriptInjection<unknown[], unknown>;

function runInjection(injection: Injection): browser.scripting.InjectionResult<unknown>[] {
  if (injection.files) {
    vi.stubGlobal(PAGE_TEXT_ENTRY, entry);
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
  pageResult = { ok: true, title: 'Example', url: 'https://example.com/post', source: '<article>', text: 'Some article text' };
  entry = vi.fn<PageTextEntry>(() => pageResult);
  browserMock.scripting.executeScript.mockImplementation(async (injection) => runInjection(injection));
});

async function run(args: Record<string, unknown> = {}) {
  return executeTool({ type: 'tool_request', id: '1:1', tool: 'get_page_text', args });
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

describe('get_page_text: output', () => {
  it('returns the title, URL and source lines, a separator and the text', async () => {
    expect(await text({ tabId: TAB })).toBe(OUTPUT);
  });

  it('reads the active tab by default with the default max_chars', async () => {
    await text();
    expect(browserMock.query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true, windowType: 'normal' });
    expect(injections()[0]?.target).toEqual({ tabId: TAB });
    expect(entry).toHaveBeenCalledWith({ maxChars: 50_000 });
  });

  it('passes max_chars to the page and reads the given tab', async () => {
    await text({ tabId: OTHER_TAB, max_chars: 100 });
    expect(entry).toHaveBeenCalledWith({ maxChars: 100 });
    expect(injections()[0]?.target).toEqual({ tabId: OTHER_TAB });
  });

  it('collapses whitespace in the title and clips it to 200 characters', async () => {
    pageResult = { ...pageResult, title: `Fake\nURL: x ${'t'.repeat(300)}` } as typeof pageResult;
    const title = (await text()).split('\n')[0] ?? '';
    expect(title).toBe(`Title: ${`Fake URL: x ${'t'.repeat(300)}`.slice(0, 200)}...`);
  });

  it('reports a page without readable text', async () => {
    pageResult = { ok: false, error: 'No readable text content found on the page' };
    expect(await failure()).toBe('No readable text content found on the page');
  });

  it('rejects invalid arguments before touching the browser', async () => {
    expect(await failure({ max_chars: 0 })).toMatch(/^Invalid get_page_text arguments: max_chars must be a positive integer/);
    expect(await failure({ filter: 'all' })).toMatch(/^Invalid get_page_text arguments: Unknown parameter "filter"/);
    expect(browserMock.query).not.toHaveBeenCalled();
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('rejects a malformed result', async () => {
    browserMock.scripting.executeScript.mockResolvedValue([{ frameId: 0, result: { ok: true, title: 'x', text: 'y' } }]);
    expect(await failure()).toBe(`Failed to read tab ${TAB}: the page returned no usable result`);
  });

  it('times out with a still loading message', async () => {
    vi.useFakeTimers();
    try {
      browserMock.scripting.executeScript.mockImplementation(() => new Promise(() => {}));
      const response = run();
      await vi.advanceTimersByTimeAsync(PAGE_SCRIPT_TIMEOUT_MS);
      expect(await response).toMatchObject({
        error: { content: [{ type: 'text', text: stillLoadingMessage('get_page_text', TAB) }] },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('get_page_text: injection', () => {
  it('injects the page script only when the entry point is missing', async () => {
    await text();
    expect(injections()).toEqual([
      expect.objectContaining({ target: { tabId: TAB }, func: expect.any(Function), args: [PAGE_TEXT_ENTRY, { maxChars: 50_000 }] }),
      { target: { tabId: TAB }, files: [PAGE_TEXT_SCRIPT] },
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
});

describe('get_page_text: restricted pages', () => {
  it('refuses a restricted domain before asking for a permission', async () => {
    tabs.set(TAB, { id: TAB, windowId: 1, url: 'https://addons.mozilla.org/en-US/firefox/', active: true });
    const prompt: ApprovalPrompt = { requestApproval: vi.fn() };
    await expect(getPageText({}, prompt)).rejects.toThrow(/^Cannot read tab 5 \(.*\): Firefox does not let extensions access this page/);
    expect(prompt.requestApproval).not.toHaveBeenCalled();
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('maps a missing host permission on a protected page to the restricted page message', async () => {
    browserMock.scripting.executeScript.mockRejectedValue(new Error('Missing host permission for the tab'));
    expect(await failure()).toMatch(new RegExp(`^Cannot read tab ${TAB} \\(${PAGE}\\): Firefox does not let extensions access this page`));
  });

  it('tells the user to grant site access in about:addons when the host permission is missing', async () => {
    browserMock.permissions.contains.mockResolvedValue(false);
    expect(await failure()).toBe(permissionMessage('read the page'));
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
  });
});

describe('get_page_text: site permission', () => {
  it('asks with the read_page_content action for a site without a stored decision', async () => {
    tabs.set(TAB, { id: TAB, windowId: 1, url: 'https://new.example/a', active: true });
    const prompt: ApprovalPrompt = {
      requestApproval: vi.fn(async () => ({ kind: 'answered' as const, answer: 'allow_once' as const, wildcard: false })),
    };
    const content = await getPageText({}, prompt);
    expect(prompt.requestApproval).toHaveBeenCalledWith({
      host: 'new.example',
      url: 'https://new.example/a',
      tool: 'get_page_text',
      action: 'read_page_content',
    });
    expect(content).toEqual([{ type: 'text', text: OUTPUT }]);
  });

  it('does not inject when the user denies', async () => {
    tabs.set(TAB, { id: TAB, windowId: 1, url: 'https://new.example/', active: true });
    const prompt: ApprovalPrompt = {
      requestApproval: vi.fn(async () => ({ kind: 'answered' as const, answer: 'deny' as const, wildcard: false })),
    };
    await expect(getPageText({}, prompt)).rejects.toThrow(/denied access to new\.example/);
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
    await expect(getPageText({}, prompt)).rejects.toThrow(pageChangedMessage('get_page_text', TAB, 'new.example'));
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('drops the text when the tab moved to another site during the injection', async () => {
    browserMock.scripting.executeScript.mockImplementation(async (injection) => {
      tabs.set(TAB, { id: TAB, windowId: 1, url: 'https://other.example/', active: true });
      return runInjection(injection);
    });
    expect(await failure()).toBe(pageChangedMessage('get_page_text', TAB, 'example.com'));
  });
});
