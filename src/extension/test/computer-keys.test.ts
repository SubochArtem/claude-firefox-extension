import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalPrompt } from '../permissions/approval';
import type { ClientApprovals } from '../permissions/client-prompt';
import { deniedMessage } from '../permissions/site-access';
import { SYNTHETIC_INPUT_ENTRY, type SyntheticInputEntry, type SyntheticInputResult } from '../page/synthetic-input-api';
import type { ToolResponse } from '../protocol';
import { executeTool } from '../tools';
import type { BidiInputChannel, BidiInputResult } from '../tools/bidi-input';
import { ZOOM_SHORTCUT_MESSAGE } from '../tools/computer-keys';
import { inputPageChangedMessage } from '../tools/computer-pointer';
import { keyActions, typeActions } from '../tools/input-actions';
import { unapprovedText } from '../tools/navigate';
import { fallbackWarning } from '../tools/synthetic-input';
import { mockBrowser } from './browser-mock';

const TAB = 5;
const OTHER_TAB = 6;
const PAGE = 'https://example.com/';

type Injection = browser.scripting.ScriptInjection<unknown[], unknown>;

let browserMock: ReturnType<typeof mockBrowser>;
let tabs: Map<number, Partial<browser.tabs.Tab>>;
let inputResult: BidiInputResult;
let synthetic: ReturnType<typeof vi.fn<SyntheticInputEntry>>;
let syntheticResult: SyntheticInputResult;
let channel: BidiInputChannel & { request: ReturnType<typeof vi.fn<BidiInputChannel['request']>> };

function sentActions(): unknown[] {
  return channel.request.mock.calls.map(([request]) => request.actions);
}

function navigateTab(tabId: number, url: string): void {
  const tab = tabs.get(tabId);
  if (tab) tab.url = url;
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
  browserMock.scripting.executeScript.mockImplementation(async (injection: Injection) => {
    if (injection.world === 'MAIN') return [{ frameId: 0, result: undefined }];
    if (injection.files) {
      vi.stubGlobal(SYNTHETIC_INPUT_ENTRY, synthetic);
      return [{ frameId: 0, result: undefined }];
    }
    const func = injection.func as (...args: unknown[]) => unknown;
    return [{ frameId: 0, result: func(...(injection.args ?? [])) }];
  });
  inputResult = { ok: true };
  syntheticResult = { ok: true };
  synthetic = vi.fn<SyntheticInputEntry>(() => syntheticResult);
  channel = {
    request: vi.fn<BidiInputChannel['request']>(async () => inputResult),
    handleResponse: vi.fn(),
    close: vi.fn(),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function run(args: Record<string, unknown>, connected = true): Promise<ToolResponse> {
  return executeTool({ type: 'tool_request', id: '1:1', tool: 'computer', args }, undefined, connected ? channel : undefined);
}

async function text(args: Record<string, unknown>): Promise<string> {
  const response = await run(args);
  if (!('result' in response)) throw new Error(`expected a result, got ${JSON.stringify(response)}`);
  const blocks = response.result.content;
  expect(blocks).toHaveLength(1);
  const [block] = blocks;
  return block?.type === 'text' ? block.text : '';
}

async function failure(args: Record<string, unknown>, connected = true): Promise<string> {
  const response = await run(args, connected);
  if (!('error' in response)) throw new Error(`expected an error, got ${JSON.stringify(response)}`);
  const [block] = response.error.content;
  return block?.type === 'text' ? block.text : '';
}

function built<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

describe('computer type', () => {
  it('types the text through BiDi', async () => {
    expect(await text({ action: 'type', text: 'Hello, world' })).toBe('Typed "Hello, world"');
    expect(channel.request).toHaveBeenCalledWith({
      marker: expect.objectContaining({ name: expect.any(String) }),
      url: PAGE,
      actions: typeActions('Hello, world'),
    });
  });

  it('types into a background tab without activating it', async () => {
    expect(await text({ action: 'type', text: 'x', tabId: OTHER_TAB })).toBe('Typed "x"');
    expect(channel.request).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://other.example/' }));
    expect(browserMock.tabs.update).not.toHaveBeenCalled();
    expect(tabs.get(OTHER_TAB)?.active).toBe(false);
  });

  it('needs no screenshot of the tab', async () => {
    expect(await text({ action: 'type', text: 'abc' })).toBe('Typed "abc"');
    expect(browserMock.tabs.captureTab).not.toHaveBeenCalled();
  });

  it('reports a missing native host connection', async () => {
    expect(await failure({ action: 'type', text: 'a' }, false)).toBe(
      `Failed to send input to tab ${TAB}: the native host is not connected`,
    );
  });

  it('notes that typing moved the tab to a site without permission', async () => {
    channel.request.mockImplementation(async () => {
      navigateTab(TAB, 'https://evil.example/');
      return { ok: true };
    });
    expect(await text({ action: 'type', text: 'q\n' })).toBe(`Typed "q\n"\n${unapprovedText(TAB, 'evil.example')}`);
  });
});

describe('computer key', () => {
  it('presses the keys through BiDi', async () => {
    expect(await text({ action: 'key', text: 'ctrl+a Delete' })).toBe('Pressed 2 keys: ctrl+a Delete');
    expect(sentActions()).toEqual([built(keyActions('ctrl+a Delete'))]);
    expect(channel.request).toHaveBeenCalledWith(expect.objectContaining({ url: PAGE }));
  });

  it('says key for a single key', async () => {
    expect(await text({ action: 'key', text: 'Enter' })).toBe('Pressed 1 key: Enter');
  });

  it('repeats the sequence in one input request', async () => {
    expect(await text({ action: 'key', text: 'Down Down', repeat: 3 })).toBe('Pressed 2 keys: Down Down (repeated 3 times)');
    expect(sentActions()).toEqual([built(keyActions('Down Down', 3))]);
  });

  it('normalises the whitespace between keys in the result', async () => {
    expect(await text({ action: 'key', text: '  Tab \n Enter ' })).toBe('Pressed 2 keys: Tab Enter');
  });

  it('presses keys in a background tab without activating it', async () => {
    await text({ action: 'key', text: 'Escape', tabId: OTHER_TAB });
    expect(channel.request).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://other.example/' }));
    expect(browserMock.tabs.update).not.toHaveBeenCalled();
  });

  it('rejects unknown keys before touching the browser', async () => {
    expect(await failure({ action: 'key', text: 'ctrl+Nope' })).toBe('Invalid computer arguments: Unknown key "Nope" in "ctrl+Nope"');
    expect(browserMock.query).not.toHaveBeenCalled();
    expect(channel.request).not.toHaveBeenCalled();
  });

  it.each(['ctrl+plus', 'ctrl+minus', 'ctrl+0', 'ctrl+=', 'cmd+-', 'ctrl+shift++', 'a ctrl+plus'])(
    'refuses the page zoom shortcut %j before touching the browser',
    async (keys) => {
      expect(await failure({ action: 'key', text: keys })).toBe(ZOOM_SHORTCUT_MESSAGE);
      expect(browserMock.query).not.toHaveBeenCalled();
      expect(channel.request).not.toHaveBeenCalled();
    },
  );

  it('points the agent to the zoom action or a screenshot', () => {
    expect(ZOOM_SHORTCUT_MESSAGE).toMatch(/"zoom" action/);
    expect(ZOOM_SHORTCUT_MESSAGE).toMatch(/screenshot/);
  });

  it.each([
    ['F5', undefined],
    ['ctrl+r', undefined],
    ['cmd+r', undefined],
    ['ctrl+shift+r', { bypassCache: true }],
    ['shift+F5', { bypassCache: true }],
    ['ctrl+F5', { bypassCache: true }],
  ])('reloads the tab for %s instead of sending input', async (keys, properties) => {
    expect(await text({ action: 'key', text: keys })).toBe(`Executed ${keys} (reload page)`);
    if (properties) expect(browserMock.tabs.reload).toHaveBeenCalledWith(TAB, properties);
    else expect(browserMock.tabs.reload).toHaveBeenCalledWith(TAB);
    expect(browserMock.tabs.reload).toHaveBeenCalledTimes(1);
    expect(channel.request).not.toHaveBeenCalled();
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('reloads a background tab without activating it and without a native host', async () => {
    const response = await run({ action: 'key', text: 'F5', tabId: OTHER_TAB }, false);
    expect(response).toMatchObject({ result: { content: [{ type: 'text', text: 'Executed F5 (reload page)' }] } });
    expect(browserMock.tabs.reload).toHaveBeenCalledWith(OTHER_TAB);
    expect(browserMock.tabs.update).not.toHaveBeenCalled();
  });

  it('reloads once whatever the repeat', async () => {
    await text({ action: 'key', text: 'F5', repeat: 4 });
    expect(browserMock.tabs.reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload when the tab left the site before the reload', async () => {
    browserMock.tabs.get.mockImplementationOnce(async (tabId) => ({ ...tabs.get(tabId) }));
    browserMock.tabs.get.mockImplementationOnce(async (tabId) => ({ ...tabs.get(tabId), url: 'https://evil.example/' }));
    expect(await failure({ action: 'key', text: 'F5' })).toBe(
      inputPageChangedMessage('press keys in')('computer', TAB, 'example.com'),
    );
    expect(browserMock.tabs.reload).not.toHaveBeenCalled();
  });

  it('notes a reload that landed on a site without permission', async () => {
    browserMock.tabs.reload.mockImplementation(async (tabId) => navigateTab(tabId, 'https://evil.example/'));
    expect(await text({ action: 'key', text: 'F5' })).toBe(`Executed F5 (reload page)\n${unapprovedText(TAB, 'evil.example')}`);
  });

  it('reports a failed reload', async () => {
    browserMock.tabs.reload.mockRejectedValue(new Error('Invalid tab ID: 5'));
    expect(await failure({ action: 'key', text: 'F5' })).toBe(`Failed to reload tab ${TAB}: Invalid tab ID: 5`);
  });

  it('does not treat a reload key inside a sequence as a reload', async () => {
    expect(await text({ action: 'key', text: 'Escape F5' })).toBe('Pressed 2 keys: Escape F5');
    expect(browserMock.tabs.reload).not.toHaveBeenCalled();
    expect(sentActions()).toEqual([built(keyActions('Escape F5'))]);
  });

  it('notes that the keys moved the tab to a site without permission', async () => {
    channel.request.mockImplementation(async () => {
      navigateTab(TAB, 'https://evil.example/');
      return { ok: true };
    });
    expect(await text({ action: 'key', text: 'Enter' })).toBe(`Pressed 1 key: Enter\n${unapprovedText(TAB, 'evil.example')}`);
  });

  it('notes that the tab was closed by the keys', async () => {
    channel.request.mockImplementation(async () => {
      tabs.delete(TAB);
      return { ok: true };
    });
    expect(await text({ action: 'key', text: 'ctrl+w' })).toBe(`Pressed 1 key: ctrl+w\nTab ${TAB} was closed after the input.`);
  });

  it('reports a failed input', async () => {
    inputResult = { ok: false, error: 'Firefox was not started with --remote-debugging-port' };
    expect(await failure({ action: 'key', text: 'Enter' })).toBe(inputResult.error);
  });
});

describe('computer keyboard: synthetic fallback', () => {
  const CAUSE = 'Firefox refused a new WebDriver BiDi session (session not created).';
  const NONE = { ctrl: false, shift: false, alt: false, meta: false };

  beforeEach(() => {
    inputResult = { ok: false, error: CAUSE, unavailable: true };
  });

  it('types with synthetic events when BiDi is unavailable and warns about it', async () => {
    expect(await text({ action: 'type', text: 'Hi\nthere' })).toBe(`Typed "Hi\nthere"\n${fallbackWarning(CAUSE)}`);
    expect(synthetic).toHaveBeenCalledWith({ kind: 'type', text: 'Hi\nthere' });
    expect(browserMock.tabs.update).not.toHaveBeenCalled();
  });

  it('presses keys with DOM key names, modifiers and the repeat count', async () => {
    expect(await text({ action: 'key', text: 'cmd+a Backspace shift+Tab F2', repeat: 2 })).toBe(
      `Pressed 4 keys: cmd+a Backspace shift+Tab F2 (repeated 2 times)\n${fallbackWarning(CAUSE)}`,
    );
    expect(synthetic).toHaveBeenCalledWith({
      kind: 'key',
      keys: [
        { key: 'a', modifiers: { ...NONE, meta: true } },
        { key: 'Backspace', modifiers: NONE },
        { key: 'Tab', modifiers: { ...NONE, shift: true } },
        { key: 'F2', modifiers: NONE },
      ],
      repeat: 2,
    });
  });

  it('reports a page with nothing editable focused', async () => {
    syntheticResult = { ok: false, error: 'No editable element is focused in the page, so nothing was typed.' };
    expect(await failure({ action: 'type', text: 'x' })).toBe(syntheticResult.error);
  });

  it('does not fall back on a real input error or a lost native host', async () => {
    inputResult = { ok: false, error: 'The native host disconnected before the input finished' };
    expect(await failure({ action: 'type', text: 'x' })).toBe(inputResult.error);
    expect(await failure({ action: 'key', text: 'Enter' }, false)).toBe(
      `Failed to send input to tab ${TAB}: the native host is not connected`,
    );
    expect(synthetic).not.toHaveBeenCalled();
  });

  it('still reloads through the tabs API', async () => {
    expect(await text({ action: 'key', text: 'F5' })).toBe('Executed F5 (reload page)');
    expect(synthetic).not.toHaveBeenCalled();
  });
});

describe('computer keyboard: site permissions', () => {
  function clientApprovals() {
    const prompt: ApprovalPrompt = {
      requestApproval: vi.fn(async () => ({ kind: 'answered' as const, answer: 'deny' as const, wildcard: false })),
    };
    const approvals: ClientApprovals = { promptFor: vi.fn(() => prompt), handleResponse: vi.fn(), close: vi.fn() };
    return { approvals, prompt };
  }

  it.each([
    [{ action: 'type', text: 'secret' }],
    [{ action: 'key', text: 'Enter' }],
    [{ action: 'key', text: 'F5' }],
  ])('asks for the type permission of %j and sends nothing when denied', async (args) => {
    navigateTab(TAB, 'https://unknown.example/');
    const { approvals, prompt } = clientApprovals();
    const response = await executeTool(
      { type: 'tool_request', id: '1:1', tool: 'computer', args, approvalViaClient: true },
      approvals,
      channel,
    );
    expect(prompt.requestApproval).toHaveBeenCalledWith({
      host: 'unknown.example',
      url: 'https://unknown.example/',
      tool: 'computer',
      action: 'type',
    });
    expect(response).toMatchObject({ error: { content: [{ type: 'text', text: deniedMessage('unknown.example') }] } });
    expect(channel.request).not.toHaveBeenCalled();
    expect(browserMock.tabs.reload).not.toHaveBeenCalled();
  });

  it('sends no input when the tab left the site before the input', async () => {
    browserMock.tabs.get.mockImplementationOnce(async (tabId) => ({ ...tabs.get(tabId) }));
    browserMock.tabs.get.mockImplementationOnce(async (tabId) => ({ ...tabs.get(tabId), url: 'https://evil.example/' }));
    expect(await failure({ action: 'type', text: 'x' })).toBe(inputPageChangedMessage('type in')('computer', TAB, 'example.com'));
    expect(channel.request).not.toHaveBeenCalled();
  });

  it('refuses a restricted page before asking', async () => {
    navigateTab(TAB, 'https://addons.mozilla.org/');
    expect(await failure({ action: 'type', text: 'x' })).toMatch(/^Cannot type in tab 5 \(https:\/\/addons\.mozilla\.org\/\)/);
    expect(channel.request).not.toHaveBeenCalled();
  });
});
