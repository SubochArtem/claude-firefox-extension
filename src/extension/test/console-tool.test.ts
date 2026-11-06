import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONSOLE_ENTRY,
  CONSOLE_SCRIPT,
  type ConsoleReadOptions,
  type ConsoleReadResult,
  MAX_ENTRY_CHARS,
} from '../page/console-capture-api';
import type { ApprovalDecision, ApprovalPrompt, ApprovalRequest } from '../permissions/approval';
import type { ClientApprovals } from '../permissions/client-prompt';
import { deniedMessage } from '../permissions/site-access';
import type { ToolResponse } from '../protocol';
import type { executeTool as ExecuteTool } from '../tools';
import { consolePageChangedMessage } from '../tools/console';
import type * as Tracking from '../tools/console-tracking';
import { CONSOLE_SCRIPT_ID, CONSOLE_TABS_KEY } from '../tools/console-tracking';
import { restrictedPageMessage } from '../tools/tab-access';
import { mockBrowser } from './browser-mock';

const TAB = 5;
const PAGE = 'https://example.com/app';
const T0 = new Date(2026, 0, 1, 12, 0, 0, 0).getTime();

type Injection = browser.scripting.ScriptInjection<unknown[], unknown>;

let browserMock: ReturnType<typeof mockBrowser>;
let tabs: Map<number, Partial<browser.tabs.Tab>>;
let installed: Set<number>;
let pageResult: ConsoleReadResult;
let onRead: (() => void) | undefined;
let decision: ApprovalDecision;
let approvalRequests: ApprovalRequest[];
let executeTool: typeof ExecuteTool;
let tracking: typeof Tracking;

beforeEach(async () => {
  vi.resetModules();
  browserMock = mockBrowser();
  browserMock.allowSites('example.com');
  tabs = new Map([[TAB, { id: TAB, windowId: 1, url: PAGE, active: true }]]);
  browserMock.tabs.get.mockImplementation(async (tabId) => {
    const tab = tabs.get(tabId);
    if (!tab) throw new Error(`Invalid tab ID: ${tabId}`);
    return { ...tab };
  });
  browserMock.query.mockImplementation(async (query) => [...tabs.values()].filter((tab) => !query.active || tab.active));
  browserMock.permissions.contains.mockResolvedValue(true);
  installed = new Set();
  pageResult = { ok: true, entries: [], matched: 0, total: 0, dropped: 0, since: T0 };
  onRead = undefined;
  browserMock.scripting.executeScript.mockImplementation(async (injection) => {
    const { tabId } = injection.target;
    if (injection.files) {
      installed.add(tabId);
      return [{ frameId: 0, result: undefined }];
    }
    if (injection.args?.[0] !== CONSOLE_ENTRY) throw new Error('unexpected injection');
    onRead?.();
    return [{ frameId: 0, result: installed.has(tabId) ? pageResult : { ok: false, missing: true } }];
  });
  decision = { kind: 'answered', answer: 'allow_once', wildcard: false };
  approvalRequests = [];
  ({ executeTool } = await import('../tools'));
  tracking = await import('../tools/console-tracking');
});

const prompt: ApprovalPrompt = {
  requestApproval: async (request) => {
    approvalRequests.push(request);
    return decision;
  },
};
const approvals: ClientApprovals = { promptFor: () => prompt, handleResponse: () => {}, close: () => {} };

function run(args: Record<string, unknown> = {}): Promise<ToolResponse> {
  return executeTool({ type: 'tool_request', id: '1:1', tool: 'read_console_messages', args, approvalViaClient: true }, approvals);
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

function injections(): Injection[] {
  return browserMock.scripting.executeScript.mock.calls.map(([injection]) => injection);
}

function readOptions(): ConsoleReadOptions[] {
  return injections()
    .filter((injection) => injection.func !== undefined)
    .map((injection) => injection.args?.[1] as ConsoleReadOptions);
}

function trackedTabs(): unknown {
  return browserMock.storage.session.data.get(CONSOLE_TABS_KEY);
}

function registeredMatches(): string[] | undefined {
  return browserMock.scripting.contentScripts.get(CONSOLE_SCRIPT_ID)?.matches;
}

function commit(tabId: number, url: string, frameId = 0): Promise<void> {
  return tracking.handleConsoleCommit({ tabId, frameId, url });
}

describe('read_console_messages', () => {
  it('starts capture on the first call and tells the agent to reload', async () => {
    expect(await text()).toBe(
      `Console capture started for tab ${TAB} (${PAGE}) with this call; messages logged before it were not recorded. Reload the page or repeat the action you want to observe, then call read_console_messages again.`,
    );
    expect(trackedTabs()).toEqual([{ tabId: TAB, host: 'example.com' }]);
    expect(registeredMatches()).toEqual(['*://example.com/*']);
    expect(injections()).toEqual([
      expect.objectContaining({ target: { tabId: TAB }, world: 'MAIN', args: [CONSOLE_ENTRY, { onlyErrors: false, limit: 100, clear: false }] }),
      { target: { tabId: TAB }, world: 'MAIN', files: [CONSOLE_SCRIPT] },
      expect.objectContaining({ target: { tabId: TAB }, world: 'MAIN', args: [CONSOLE_ENTRY, expect.any(Object)] }),
    ]);
  });

  it('lists captured messages on later calls without injecting again', async () => {
    await text();
    pageResult = {
      ok: true,
      entries: [{ level: 'error', text: 'Request failed: 500', time: T0 + 1_500, url: PAGE }],
      matched: 1,
      total: 1,
      dropped: 0,
      since: T0,
    };
    browserMock.scripting.executeScript.mockClear();
    expect(await text()).toBe(
      [`Console messages of tab ${TAB} (${PAGE}) captured since 12:00:00.000: showing 1 of 1.`, '[error] 12:00:01.500 Request failed: 500'].join('\n'),
    );
    expect(injections()).toHaveLength(1);
  });

  it('says nothing was captured when a tracked page has no messages', async () => {
    await text();
    expect(await text()).toMatch(/^No console messages captured in tab 5 /);
  });

  it('passes the filter, limit and clear to the page', async () => {
    await text({ onlyErrors: true, pattern: 'fail', limit: 3, clear: true });
    expect(readOptions()[0]).toEqual({ onlyErrors: true, pattern: 'fail', limit: 3, clear: true });
  });

  it('reads the given tab', async () => {
    tabs.set(7, { id: 7, windowId: 1, url: 'https://example.com/other', active: false });
    await text({ tabId: 7 });
    expect(trackedTabs()).toEqual([{ tabId: 7, host: 'example.com' }]);
    expect(injections()[0]?.target).toEqual({ tabId: 7 });
  });

  it('asks for the read_console_messages permission and stops when denied', async () => {
    browserMock.allowSites();
    decision = { kind: 'answered', answer: 'deny', wildcard: false };
    expect(await failure()).toBe(deniedMessage('example.com'));
    expect(approvalRequests).toEqual([
      expect.objectContaining({ host: 'example.com', tool: 'read_console_messages', action: 'read_console_messages' }),
    ]);
    expect(trackedTabs()).toBeUndefined();
    expect(injections()).toEqual([]);
  });

  it('refuses restricted pages without asking', async () => {
    tabs.set(TAB, { id: TAB, windowId: 1, url: 'https://addons.mozilla.org/en-US/firefox/', active: true });
    expect(await failure()).toBe(
      restrictedPageMessage({ verb: 'read console messages', target: 'read console messages of' }, TAB, 'https://addons.mozilla.org/en-US/firefox/'),
    );
    expect(approvalRequests).toEqual([]);
    expect(injections()).toEqual([]);
  });

  it('withholds messages when the page moved to another site during the read', async () => {
    installed.add(TAB);
    pageResult = { ok: true, entries: [{ level: 'log', text: 'secret', time: T0, url: PAGE }], matched: 1, total: 1, dropped: 0, since: T0 };
    onRead = () => tabs.set(TAB, { id: TAB, windowId: 1, url: 'https://other.example/', active: true });
    expect(await failure()).toBe(consolePageChangedMessage('read_console_messages', TAB, 'example.com'));
  });

  it('rejects a page result of the wrong shape', async () => {
    installed.add(TAB);
    pageResult = { ok: true, entries: [{ level: 'trace', text: 'x', time: 0, url: PAGE }], matched: 1, total: 1, dropped: 0, since: T0 } as unknown as ConsoleReadResult;
    expect(await failure()).toBe(`Failed to read console messages of tab ${TAB}: the page returned no usable result`);
  });

  it('rejects entry text longer than the capture produces', async () => {
    installed.add(TAB);
    const long = { level: 'log', text: 'x'.repeat(MAX_ENTRY_CHARS + 2), time: T0, url: PAGE } as const;
    pageResult = { ok: true, entries: [long], matched: 1, total: 1, dropped: 0, since: T0 };
    expect(await failure()).toBe(`Failed to read console messages of tab ${TAB}: the page returned no usable result`);
    pageResult = { ...pageResult, entries: [{ ...long, text: `${'x'.repeat(MAX_ENTRY_CHARS)}…` }] };
    expect(await text()).toContain(`[log] 12:00:00.000 ${'x'.repeat(MAX_ENTRY_CHARS)}…`);
  });

  it('rejects invalid arguments', async () => {
    expect(await failure({ limit: 0 })).toBe('Invalid read_console_messages arguments: limit must be a positive integer, received 0');
    expect(injections()).toEqual([]);
  });
});

describe('console tracking', () => {
  it('registers the capture at document_start in the main world of the top frame for the tracked host', async () => {
    expect(await tracking.trackConsole(TAB, PAGE)).toBe(true);
    expect([...browserMock.scripting.contentScripts.values()]).toEqual([
      {
        id: CONSOLE_SCRIPT_ID,
        js: [CONSOLE_SCRIPT],
        matches: ['*://example.com/*'],
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: false,
        persistAcrossSessions: false,
      },
    ]);
  });

  it('covers the hosts of all tracked tabs once each', async () => {
    await tracking.trackConsole(TAB, PAGE);
    await tracking.trackConsole(8, 'http://example.com:8080/x');
    await tracking.trackConsole(9, 'https://b.example.org/');
    expect(registeredMatches()).toEqual(['*://b.example.org/*', '*://example.com/*']);
    expect(browserMock.scripting.registerContentScripts).toHaveBeenCalledTimes(1);
    expect(browserMock.scripting.updateContentScripts).toHaveBeenCalledTimes(1);
    expect(await tracking.trackConsole(8, 'http://example.com/y')).toBe(false);
    expect(browserMock.scripting.updateContentScripts).toHaveBeenCalledTimes(1);
  });

  it('tracks hosts no match pattern can name without registering them', async () => {
    expect(await tracking.trackConsole(TAB, 'http://[::1]:8000/')).toBe(true);
    expect(await tracking.trackConsole(8, 'https://example.com./')).toBe(true);
    expect(trackedTabs()).toEqual([
      { tabId: TAB, host: '' },
      { tabId: 8, host: '' },
    ]);
    expect(browserMock.scripting.contentScripts.size).toBe(0);
  });

  it('moves the registration with a tracked tab that commits on another host', async () => {
    await tracking.trackConsole(TAB, PAGE);
    await tracking.trackConsole(8, 'https://example.com/b');
    await commit(TAB, 'https://other.example/');
    expect(registeredMatches()).toEqual(['*://example.com/*', '*://other.example/*']);
    await commit(8, 'https://other.example/2');
    expect(registeredMatches()).toEqual(['*://other.example/*']);
    expect(trackedTabs()).toEqual([
      { tabId: TAB, host: 'other.example' },
      { tabId: 8, host: 'other.example' },
    ]);
  });

  it('ignores commits in subframes and untracked tabs', async () => {
    await tracking.trackConsole(TAB, PAGE);
    browserMock.scripting.executeScript.mockClear();
    await commit(TAB, 'https://other.example/', 3);
    await commit(9, 'https://other.example/');
    expect(injections()).toEqual([]);
    expect(registeredMatches()).toEqual(['*://example.com/*']);
  });

  it('also injects the capture on top-frame commits, for hosts the registration did not cover yet', async () => {
    await tracking.trackConsole(TAB, PAGE);
    browserMock.scripting.executeScript.mockClear();
    await commit(TAB, 'https://other.example/');
    expect(injections()).toEqual([{ target: { tabId: TAB }, world: 'MAIN', files: [CONSOLE_SCRIPT], injectImmediately: true }]);
  });

  it('unregisters a host when its last tracked tab closes and the script when no tab is left', async () => {
    await tracking.trackConsole(TAB, PAGE);
    await tracking.trackConsole(8, 'https://other.example/');
    await tracking.handleConsoleTabRemoved(TAB);
    expect(trackedTabs()).toEqual([{ tabId: 8, host: 'other.example' }]);
    expect(registeredMatches()).toEqual(['*://other.example/*']);
    await tracking.handleConsoleTabRemoved(8);
    expect(browserMock.scripting.contentScripts.size).toBe(0);
    browserMock.scripting.executeScript.mockClear();
    await commit(TAB, PAGE);
    expect(injections()).toEqual([]);
    expect(await tracking.trackConsole(TAB, PAGE)).toBe(true);
  });

  it('reconciles the registration with the stored tabs when the background script starts', async () => {
    browserMock.storage.session.data.set(CONSOLE_TABS_KEY, [
      { tabId: TAB, host: 'example.com' },
      { tabId: 8, host: 'other.example' },
    ]);
    await browserMock.scripting.registerContentScripts([{ id: CONSOLE_SCRIPT_ID, js: [CONSOLE_SCRIPT], matches: ['*://stale.example/*'] }]);
    await tracking.syncConsoleRegistration();
    expect(registeredMatches()).toEqual(['*://example.com/*', '*://other.example/*']);
    await commit(TAB, PAGE);
    expect(injections()).toHaveLength(1);
    expect(await tracking.trackConsole(TAB, PAGE)).toBe(false);
  });

  it('removes a leftover registration on start when nothing is tracked', async () => {
    await browserMock.scripting.registerContentScripts([{ id: CONSOLE_SCRIPT_ID, js: [CONSOLE_SCRIPT], matches: ['*://stale.example/*'] }]);
    await tracking.syncConsoleRegistration();
    expect(browserMock.scripting.contentScripts.size).toBe(0);
  });

  it('keeps tracking when the registration fails and heals it on the next change', async () => {
    browserMock.scripting.registerContentScripts.mockRejectedValueOnce(new Error('registration failed'));
    expect(await tracking.trackConsole(TAB, PAGE)).toBe(true);
    expect(browserMock.scripting.contentScripts.size).toBe(0);
    await tracking.trackConsole(8, 'https://other.example/');
    expect(registeredMatches()).toEqual(['*://example.com/*', '*://other.example/*']);
  });

  it('keeps the cached list unchanged when storing it fails', async () => {
    browserMock.storage.session.set.mockRejectedValueOnce(new Error('quota exceeded'));
    await expect(tracking.trackConsole(TAB, PAGE)).rejects.toThrow('quota exceeded');
    expect(await tracking.isConsoleTracked(TAB)).toBe(false);
    expect(browserMock.scripting.contentScripts.size).toBe(0);
    expect(await tracking.trackConsole(TAB, PAGE)).toBe(true);
    browserMock.storage.session.set.mockRejectedValueOnce(new Error('quota exceeded'));
    await expect(tracking.untrackConsole(TAB)).rejects.toThrow('quota exceeded');
    expect(await tracking.isConsoleTracked(TAB)).toBe(true);
  });

  it('ignores injection failures on commit', async () => {
    await tracking.trackConsole(TAB, PAGE);
    browserMock.scripting.executeScript.mockRejectedValue(new Error('Missing host permission for the tab'));
    await expect(commit(TAB, PAGE)).resolves.toBeUndefined();
  });

  it('ignores malformed stored data', async () => {
    browserMock.storage.session.data.set(CONSOLE_TABS_KEY, [5, { tabId: '5', host: 'a' }, { tabId: 6.5, host: 'b' }, { tabId: 2, host: 'c.example' }, null]);
    expect(await tracking.isConsoleTracked(2)).toBe(true);
    expect(await tracking.isConsoleTracked(TAB)).toBe(false);
    await tracking.syncConsoleRegistration();
    expect(registeredMatches()).toEqual(['*://c.example/*']);
  });
});
