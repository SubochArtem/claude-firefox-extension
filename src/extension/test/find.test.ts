import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FIND_ENTRY, type FindEntry, type FindResult } from '../page/find-api';
import { READ_PAGE_SCRIPT } from '../page/read-page-api';
import type { ApprovalPrompt } from '../permissions/approval';
import { executeTool } from '../tools';
import { findTool } from '../tools/find';
import { PAGE_SCRIPT_TIMEOUT_MS, pageChangedMessage, stillLoadingMessage } from '../tools/page-script';
import { permissionMessage } from '../tools/tab-access';
import { mockBrowser } from './browser-mock';

const TAB = 5;
const OTHER_TAB = 6;
const PAGE = 'https://example.com/';
const OUTPUT = 'Found 1 matching element\n- ref_1: button "Save" - name matches "save"';

let browserMock: ReturnType<typeof mockBrowser>;
let tabs: Map<number, Partial<browser.tabs.Tab>>;
let entry: ReturnType<typeof vi.fn<FindEntry>>;
let pageResult: FindResult;

type Injection = browser.scripting.ScriptInjection<unknown[], unknown>;

function runInjection(injection: Injection): browser.scripting.InjectionResult<unknown>[] {
  if (injection.files) {
    vi.stubGlobal(FIND_ENTRY, entry);
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
  pageResult = { ok: true, text: OUTPUT };
  entry = vi.fn<FindEntry>(() => pageResult);
  browserMock.scripting.executeScript.mockImplementation(async (injection) => runInjection(injection));
});

async function run(args: Record<string, unknown> = { query: 'save' }) {
  return executeTool({ type: 'tool_request', id: '1:1', tool: 'find', args });
}

async function text(args?: Record<string, unknown>): Promise<string> {
  const response = await run(args);
  if (!('result' in response)) throw new Error(`expected a result, got ${JSON.stringify(response)}`);
  const [block] = response.result.content;
  return block?.type === 'text' ? block.text : '';
}

async function failure(args?: Record<string, unknown>): Promise<string> {
  const response = await run(args);
  if (!('error' in response)) throw new Error(`expected an error, got ${JSON.stringify(response)}`);
  const [block] = response.error.content;
  return block?.type === 'text' ? block.text : '';
}

describe('find: output', () => {
  it('returns the matches from the page', async () => {
    expect(await text()).toBe(OUTPUT);
  });

  it('searches the active tab by default with the trimmed query', async () => {
    await text({ query: '  save  ' });
    expect(browserMock.query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true, windowType: 'normal' });
    expect(injections()[0]?.target).toEqual({ tabId: TAB });
    expect(entry).toHaveBeenCalledWith({ query: 'save' });
  });

  it('searches the given tab', async () => {
    await text({ query: 'save', tabId: OTHER_TAB });
    expect(injections()[0]?.target).toEqual({ tabId: OTHER_TAB });
  });

  it('reports no match as an error', async () => {
    pageResult = { ok: false, error: 'No matching elements found for "save"' };
    expect(await failure()).toBe('No matching elements found for "save"');
  });

  it('rejects invalid arguments before touching the browser', async () => {
    expect(await failure({})).toMatch(/^Invalid find arguments: query is required/);
    expect(await failure({ query: ' ' })).toBe('Invalid find arguments: query must not be empty');
    expect(await failure({ query: 'x'.repeat(501) })).toMatch(/^Invalid find arguments: query must be at most 500/);
    expect(browserMock.query).not.toHaveBeenCalled();
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('rejects a malformed result', async () => {
    browserMock.scripting.executeScript.mockResolvedValue([{ frameId: 0, result: { ok: true, tree: 'x' } }]);
    expect(await failure()).toBe(`Failed to read tab ${TAB}: the page returned no usable result`);
  });

  it('times out with a still loading message', async () => {
    vi.useFakeTimers();
    try {
      browserMock.scripting.executeScript.mockImplementation(() => new Promise(() => {}));
      const response = run();
      await vi.advanceTimersByTimeAsync(PAGE_SCRIPT_TIMEOUT_MS);
      expect(await response).toMatchObject({ error: { content: [{ type: 'text', text: stillLoadingMessage('find', TAB) }] } });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('find: injection', () => {
  it('injects the read_page bundle only when the entry point is missing, so both share refs', async () => {
    await text();
    expect(injections()).toEqual([
      expect.objectContaining({ target: { tabId: TAB }, func: expect.any(Function), args: [FIND_ENTRY, { query: 'save' }] }),
      { target: { tabId: TAB }, files: [READ_PAGE_SCRIPT] },
      expect.objectContaining({ target: { tabId: TAB }, func: expect.any(Function) }),
    ]);
    browserMock.scripting.executeScript.mockClear();
    await text();
    expect(injections()).toHaveLength(1);
    for (const injection of injections()) expect(injection.world).toBeUndefined();
  });
});

describe('find: restricted pages and permissions', () => {
  it('refuses a restricted domain before asking for a permission', async () => {
    tabs.set(TAB, { id: TAB, windowId: 1, url: 'https://addons.mozilla.org/en-US/firefox/', active: true });
    const prompt: ApprovalPrompt = { requestApproval: vi.fn() };
    await expect(findTool({ query: 'save' }, prompt)).rejects.toThrow(/^Cannot read tab 5 \(.*\): Firefox does not let extensions access this page/);
    expect(prompt.requestApproval).not.toHaveBeenCalled();
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('tells the user to grant site access in about:addons when the host permission is missing', async () => {
    browserMock.permissions.contains.mockResolvedValue(false);
    expect(await failure()).toBe(permissionMessage('read the page'));
  });

  it('asks with the read_page_content action for a site without a stored decision', async () => {
    tabs.set(TAB, { id: TAB, windowId: 1, url: 'https://new.example/a', active: true });
    const prompt: ApprovalPrompt = {
      requestApproval: vi.fn(async () => ({ kind: 'answered' as const, answer: 'allow_once' as const, wildcard: false })),
    };
    expect(await findTool({ query: 'save' }, prompt)).toEqual([{ type: 'text', text: OUTPUT }]);
    expect(prompt.requestApproval).toHaveBeenCalledWith({
      host: 'new.example',
      url: 'https://new.example/a',
      tool: 'find',
      action: 'read_page_content',
    });
  });

  it('does not inject when the user denies', async () => {
    tabs.set(TAB, { id: TAB, windowId: 1, url: 'https://new.example/', active: true });
    const prompt: ApprovalPrompt = {
      requestApproval: vi.fn(async () => ({ kind: 'answered' as const, answer: 'deny' as const, wildcard: false })),
    };
    await expect(findTool({ query: 'save' }, prompt)).rejects.toThrow(/denied access to new\.example/);
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('drops the matches when the tab moved to another site during the injection', async () => {
    browserMock.scripting.executeScript.mockImplementation(async (injection) => {
      tabs.set(TAB, { id: TAB, windowId: 1, url: 'https://other.example/', active: true });
      return runInjection(injection);
    });
    expect(await failure()).toBe(pageChangedMessage('find', TAB, 'example.com'));
  });
});
