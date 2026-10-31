import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FORM_INPUT_ENTRY, type FormInputEntry, type FormInputResult } from '../page/form-input-api';
import { READ_PAGE_SCRIPT } from '../page/read-page-api';
import type { ApprovalPrompt } from '../permissions/approval';
import { executeTool } from '../tools';
import { formInputPageChangedMessage, formInputTool } from '../tools/form-input';
import { PAGE_SCRIPT_TIMEOUT_MS, stillLoadingMessage } from '../tools/page-script';
import { permissionMessage } from '../tools/tab-access';
import { mockBrowser } from './browser-mock';

const TAB = 5;
const OTHER_TAB = 6;
const PAGE = 'https://example.com/';
const OUTPUT = 'Set text value to "Paris" (previous: "")';
const ARGS = { ref: 'ref_3', value: 'Paris' };

let browserMock: ReturnType<typeof mockBrowser>;
let tabs: Map<number, Partial<browser.tabs.Tab>>;
let entry: ReturnType<typeof vi.fn<FormInputEntry>>;
let pageResult: FormInputResult;

type Injection = browser.scripting.ScriptInjection<unknown[], unknown>;

function runInjection(injection: Injection): browser.scripting.InjectionResult<unknown>[] {
  if (injection.files) {
    vi.stubGlobal(FORM_INPUT_ENTRY, entry);
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
  entry = vi.fn<FormInputEntry>(() => pageResult);
  browserMock.scripting.executeScript.mockImplementation(async (injection) => runInjection(injection));
});

async function run(args: Record<string, unknown> = ARGS) {
  return executeTool({ type: 'tool_request', id: '1:1', tool: 'form_input', args });
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

describe('form_input: output', () => {
  it('returns the page result', async () => {
    expect(await text()).toBe(OUTPUT);
  });

  it('sets the value in the active tab by default', async () => {
    await text({ ref: 'ref_3', value: true });
    expect(browserMock.query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true, windowType: 'normal' });
    expect(injections()[0]?.target).toEqual({ tabId: TAB });
    expect(entry).toHaveBeenCalledWith({ ref: 'ref_3', value: true });
  });

  it('sets the value in the given tab', async () => {
    await text({ ...ARGS, tabId: OTHER_TAB });
    expect(injections()[0]?.target).toEqual({ tabId: OTHER_TAB });
  });

  it('reports a page error', async () => {
    pageResult = { ok: false, error: 'ref_3 was not found in this page. Call read_page or find to get fresh element references.' };
    expect(await failure()).toBe(pageResult.error);
  });

  it('rejects invalid arguments before touching the browser', async () => {
    expect(await failure({ value: 'x' })).toMatch(/^Invalid form_input arguments: ref is required/);
    expect(await failure({ ref: 'ref_1' })).toBe('Invalid form_input arguments: value is required: a string, boolean or number');
    expect(await failure({ ref: 'button', value: 'x' })).toMatch(/^Invalid form_input arguments: ref must look like ref_12/);
    expect(browserMock.query).not.toHaveBeenCalled();
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('rejects a malformed result', async () => {
    browserMock.scripting.executeScript.mockResolvedValue([{ frameId: 0, result: { ok: true } }]);
    expect(await failure()).toBe(`Failed to edit tab ${TAB}: the page returned no usable result`);
  });

  it('times out with a still loading message', async () => {
    vi.useFakeTimers();
    try {
      browserMock.scripting.executeScript.mockImplementation(() => new Promise(() => {}));
      const response = run();
      await vi.advanceTimersByTimeAsync(PAGE_SCRIPT_TIMEOUT_MS);
      expect(await response).toMatchObject({
        error: { content: [{ type: 'text', text: stillLoadingMessage('form_input', TAB, 'edit') }] },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('form_input: injection', () => {
  it('injects the read_page bundle only when the entry point is missing, so refs from read_page and find work', async () => {
    await text();
    expect(injections()).toEqual([
      expect.objectContaining({ target: { tabId: TAB }, func: expect.any(Function), args: [FORM_INPUT_ENTRY, ARGS] }),
      { target: { tabId: TAB }, files: [READ_PAGE_SCRIPT] },
      expect.objectContaining({ target: { tabId: TAB }, func: expect.any(Function) }),
    ]);
    browserMock.scripting.executeScript.mockClear();
    await text();
    expect(injections()).toHaveLength(1);
  });
});

describe('form_input: restricted pages and permissions', () => {
  it('refuses a restricted domain before asking for a permission', async () => {
    tabs.set(TAB, { id: TAB, windowId: 1, url: 'https://addons.mozilla.org/en-US/firefox/', active: true });
    const prompt: ApprovalPrompt = { requestApproval: vi.fn() };
    await expect(formInputTool(ARGS, prompt)).rejects.toThrow(
      /^Cannot edit tab 5 \(.*\): Firefox does not let extensions access this page/,
    );
    expect(prompt.requestApproval).not.toHaveBeenCalled();
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('tells the user to grant site access in about:addons when the host permission is missing', async () => {
    browserMock.permissions.contains.mockResolvedValue(false);
    expect(await failure()).toBe(permissionMessage('set a form value'));
  });

  it('asks with the type action for a site without a stored decision', async () => {
    tabs.set(TAB, { id: TAB, windowId: 1, url: 'https://new.example/a', active: true });
    const prompt: ApprovalPrompt = {
      requestApproval: vi.fn(async () => ({ kind: 'answered' as const, answer: 'allow_once' as const, wildcard: false })),
    };
    expect(await formInputTool(ARGS, prompt)).toEqual([{ type: 'text', text: OUTPUT }]);
    expect(prompt.requestApproval).toHaveBeenCalledWith({
      host: 'new.example',
      url: 'https://new.example/a',
      tool: 'form_input',
      action: 'type',
    });
  });

  it('does not inject when the user denies', async () => {
    tabs.set(TAB, { id: TAB, windowId: 1, url: 'https://new.example/', active: true });
    const prompt: ApprovalPrompt = {
      requestApproval: vi.fn(async () => ({ kind: 'answered' as const, answer: 'deny' as const, wildcard: false })),
    };
    await expect(formInputTool(ARGS, prompt)).rejects.toThrow(/denied access to new\.example/);
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('does not inject when the tab moved to another site during the prompt', async () => {
    tabs.set(TAB, { id: TAB, windowId: 1, url: 'https://new.example/', active: true });
    const prompt: ApprovalPrompt = {
      requestApproval: vi.fn(async () => {
        tabs.set(TAB, { id: TAB, windowId: 1, url: 'https://other.example/', active: true });
        return { kind: 'answered' as const, answer: 'allow_once' as const, wildcard: false };
      }),
    };
    await expect(formInputTool(ARGS, prompt)).rejects.toThrow(formInputPageChangedMessage('form_input', TAB, 'new.example'));
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('withholds the result when the tab moved to another site during the injection', async () => {
    browserMock.scripting.executeScript.mockImplementation(async (injection) => {
      tabs.set(TAB, { id: TAB, windowId: 1, url: 'https://other.example/', active: true });
      return runInjection(injection);
    });
    expect(await failure()).toBe(formInputPageChangedMessage('form_input', TAB, 'example.com'));
  });
});
