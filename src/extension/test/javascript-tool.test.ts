import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateInMainWorld, type MainWorldEvalResult } from '../page/main-world-eval';
import type { ApprovalDecision, ApprovalPrompt, ApprovalRequest } from '../permissions/approval';
import type { ClientApprovals } from '../permissions/client-prompt';
import { deniedMessage } from '../permissions/site-access';
import type { ToolResponse } from '../protocol';
import { executeTool } from '../tools';
import type { BidiEvaluateChannel, BidiEvaluateResult } from '../tools/bidi-evaluate';
import {
  blockedMessage,
  CODE_PREVIEW_CHARS,
  evalFallbackWarning,
  FALLBACK_TIMEOUT_MS,
  fallbackTimeoutMessage,
  javascriptPageChangedMessage,
  withheldText,
} from '../tools/javascript';
import { restrictedPageMessage } from '../tools/tab-access';
import { mockBrowser } from './browser-mock';

const TAB = 5;
const PAGE = 'https://example.com/app';
const CODE = 'document.title';
const LABEL = { verb: 'run JavaScript', target: 'run JavaScript in' };

type Injection = browser.scripting.ScriptInjection<unknown[], unknown>;

let browserMock: ReturnType<typeof mockBrowser>;
let tabs: Map<number, Partial<browser.tabs.Tab>>;
let evaluateResult: BidiEvaluateResult;
let mainWorldResult: () => Promise<browser.scripting.InjectionResult<unknown>[]>;
let channel: BidiEvaluateChannel & { request: ReturnType<typeof vi.fn<BidiEvaluateChannel['request']>> };
let decision: ApprovalDecision;
let approvalRequests: ApprovalRequest[];

function fallbackResult(result: MainWorldEvalResult): () => Promise<browser.scripting.InjectionResult<unknown>[]> {
  return async () => [{ frameId: 0, result }];
}

function evalInjections(): Injection[] {
  return browserMock.scripting.executeScript.mock.calls.map(([injection]) => injection).filter((injection) => injection.func === evaluateInMainWorld);
}

function navigateTab(url: string): void {
  const tab = tabs.get(TAB);
  if (tab) tab.url = url;
}

beforeEach(() => {
  browserMock = mockBrowser();
  browserMock.allowSites('example.com', 'allowed.example');
  tabs = new Map([[TAB, { id: TAB, windowId: 1, url: PAGE, active: true }]]);
  browserMock.tabs.get.mockImplementation(async (tabId) => {
    const tab = tabs.get(tabId);
    if (!tab) throw new Error(`Invalid tab ID: ${tabId}`);
    return { ...tab };
  });
  browserMock.query.mockImplementation(async (query) => [...tabs.values()].filter((tab) => !query.active || tab.active));
  browserMock.permissions.contains.mockResolvedValue(true);
  mainWorldResult = fallbackResult({ kind: 'value', value: { type: 'number', value: 3 } });
  browserMock.scripting.executeScript.mockImplementation(async (injection) => {
    if (injection.func === evaluateInMainWorld) return mainWorldResult();
    return [{ frameId: 0, result: undefined }];
  });
  evaluateResult = { ok: true, value: 'Example' };
  channel = {
    request: vi.fn<BidiEvaluateChannel['request']>(async () => evaluateResult),
    handleResponse: vi.fn(),
    close: vi.fn(),
  };
  decision = { kind: 'answered', answer: 'allow_once', wildcard: false };
  approvalRequests = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const prompt: ApprovalPrompt = {
  requestApproval: async (request) => {
    approvalRequests.push(request);
    return decision;
  },
};
const approvals: ClientApprovals = { promptFor: () => prompt, handleResponse: () => {}, close: () => {} };

function run(args: Record<string, unknown>, connected = true): Promise<ToolResponse> {
  return executeTool(
    { type: 'tool_request', id: '1:1', tool: 'javascript_tool', args, approvalViaClient: true },
    approvals,
    undefined,
    connected ? channel : undefined,
  );
}

function exec(text: string, extra: Record<string, unknown> = {}) {
  return { action: 'javascript_exec', text, ...extra };
}

async function text(args: Record<string, unknown>, connected = true): Promise<string> {
  const response = await run(args, connected);
  if (!('result' in response)) throw new Error(`expected a result, got ${JSON.stringify(response)}`);
  expect(response.result.content).toHaveLength(1);
  const [block] = response.result.content;
  return block?.type === 'text' ? block.text : '';
}

async function failure(args: Record<string, unknown>, connected = true): Promise<string> {
  const response = await run(args, connected);
  if (!('error' in response)) throw new Error(`expected an error, got ${JSON.stringify(response)}`);
  const [block] = response.error.content;
  return block?.type === 'text' ? block.text : '';
}

describe('javascript_tool through WebDriver BiDi', () => {
  it('returns the value formatted by the native host', async () => {
    expect(await text(exec(CODE))).toBe('Example');
    expect(channel.request).toHaveBeenCalledWith({ marker: expect.objectContaining({ name: expect.any(String) }), url: PAGE, code: CODE });
    expect(evalInjections()).toEqual([]);
  });

  it('runs in the given tab', async () => {
    tabs.set(7, { id: 7, windowId: 1, url: 'https://allowed.example/', active: false });
    await text(exec(CODE, { tabId: 7 }));
    expect(channel.request).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://allowed.example/' }));
  });

  it('reports an uncaught exception as a JavaScript error', async () => {
    evaluateResult = { ok: true, exception: 'TypeError: x is undefined\n    at <anonymous> (<script>:1:1)' };
    expect(await failure(exec('x.y'))).toBe('JavaScript error: TypeError: x is undefined\n    at <anonymous> (<script>:1:1)');
  });

  it('withholds the result when the tab is on a site without permission afterwards', async () => {
    channel.request.mockImplementation(async () => {
      navigateTab('https://unknown.example/');
      return evaluateResult;
    });
    expect(await text(exec('location.href = "https://unknown.example/"'))).toBe(
      `The script ran, but tab ${TAB} is now on unknown.example, which has no site permission, so its result is withheld. Check the tab with tabs_context; the next action on the new page will ask the user for permission.`,
    );
  });

  it('names the http host without permission, not a non-http page, after navigation to an IP address', async () => {
    channel.request.mockImplementation(async () => {
      navigateTab('http://127.0.0.2:8000/page');
      return evaluateResult;
    });
    const result = await text(exec('location.href = "http://127.0.0.2:8000/page"'));
    expect(result).toContain(`tab ${TAB} is now on 127.0.0.2, which has no site permission`);
    expect(result).not.toContain('http and https');
  });

  it('names a Firefox error page as outside site permissions', async () => {
    channel.request.mockImplementation(async () => {
      navigateTab('about:neterror?e=connectionFailure&u=http%3A//127.0.0.2%3A8000/');
      return evaluateResult;
    });
    expect(await text(exec(CODE))).toContain(
      `tab ${TAB} is now on about:neterror, which site permissions do not cover (only http and https pages), so its result is withheld`,
    );
  });

  it('names the scheme of a non-http page', async () => {
    channel.request.mockImplementation(async () => {
      navigateTab('file:///home/user/secret.txt');
      return evaluateResult;
    });
    const result = await text(exec(CODE));
    expect(result).toContain(`tab ${TAB} is now on a file page, which site permissions do not cover`);
    expect(result).not.toContain('secret');
  });

  it('says when the landed page address is not available', async () => {
    channel.request.mockImplementation(async () => {
      navigateTab('');
      return evaluateResult;
    });
    expect(await text(exec(CODE))).toContain(`tab ${TAB} is now on a page whose address is not available, so its result is withheld`);
  });

  it('withholds an exception when the tab left for a page outside site permissions', async () => {
    evaluateResult = { ok: true, exception: 'Error: secret page text' };
    channel.request.mockImplementation(async () => {
      navigateTab('about:blank');
      return evaluateResult;
    });
    expect(await text(exec(CODE))).toBe(
      `The script ran, but tab ${TAB} is now on about:blank, which site permissions do not cover (only http and https pages), so its result is withheld. Check the tab with tabs_context; the next action on the new page will ask the user for permission.`,
    );
  });

  it('withholds the result when the tab was closed', async () => {
    channel.request.mockImplementation(async () => {
      tabs.delete(TAB);
      return evaluateResult;
    });
    expect(await text(exec('window.close()'))).toBe(`The script ran, but tab ${TAB} was closed afterwards, so its result is withheld.`);
  });

  it('returns the result when the tab moved to another allowed site', async () => {
    channel.request.mockImplementation(async () => {
      navigateTab('https://allowed.example/');
      return evaluateResult;
    });
    expect(await text(exec(CODE))).toBe('Example');
  });

  it.each([
    ['a failed script.evaluate', { ok: false as const, error: 'Several tabs carry the marker' }],
    ['a host timeout', { ok: false as const, error: 'The native host did not finish the script within 90 s' }],
  ])('reports %s without falling back to eval', async (_label, result) => {
    evaluateResult = result;
    expect(await failure(exec(CODE))).toBe(result.error);
    expect(evalInjections()).toEqual([]);
  });

  it('reports a missing native host without falling back to eval', async () => {
    expect(await failure(exec(CODE), false)).toBe(`Failed to run the script in tab ${TAB}: the native host is not connected`);
    expect(evalInjections()).toEqual([]);
  });

  it('does not run the script when the tab left the approved site before it', async () => {
    browserMock.scripting.executeScript.mockImplementation(async () => {
      throw new Error('not reached');
    });
    browserMock.tabs.get.mockImplementationOnce(async () => ({ id: TAB, url: PAGE })).mockImplementation(async () => ({
      id: TAB,
      url: 'https://unknown.example/',
    }));
    expect(await failure(exec(CODE))).toBe(javascriptPageChangedMessage('javascript_tool', TAB, 'example.com'));
    expect(channel.request).not.toHaveBeenCalled();
  });

  it('rejects invalid arguments before touching the tab', async () => {
    expect(await failure({ action: 'run', text: CODE })).toBe('Invalid javascript_tool arguments: action must be "javascript_exec", received "run"');
    expect(await failure({ action: 'javascript_exec', text: ' ' })).toBe('Invalid javascript_tool arguments: text must not be empty');
    expect(browserMock.tabs.get).not.toHaveBeenCalled();
  });
});

describe('javascript_tool site permission', () => {
  beforeEach(() => {
    browserMock.storage.local.data.clear();
  });

  it('asks for the execute_javascript permission with a preview of the code', async () => {
    expect(await text(exec(CODE))).toBe('Example');
    expect(approvalRequests).toEqual([
      { host: 'example.com', url: PAGE, tool: 'javascript_tool', action: 'execute_javascript', code: CODE },
    ]);
  });

  it('clips the code preview', async () => {
    const code = `  ${'a'.repeat(CODE_PREVIEW_CHARS + 50)}  `;
    await text(exec(code));
    expect(approvalRequests[0]?.code).toBe(`${'a'.repeat(CODE_PREVIEW_CHARS)}… (${CODE_PREVIEW_CHARS + 50} characters)`);
    expect(channel.request).toHaveBeenCalledWith(expect.objectContaining({ code }));
  });

  it('does not run the script when the user denies', async () => {
    decision = { kind: 'answered', answer: 'deny', wildcard: false };
    expect(await failure(exec(CODE))).toBe(deniedMessage('example.com'));
    expect(channel.request).not.toHaveBeenCalled();
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('refuses a restricted Mozilla page before asking', async () => {
    navigateTab('https://addons.mozilla.org/en-US/firefox/');
    expect(await failure(exec(CODE))).toBe(restrictedPageMessage(LABEL, TAB, 'https://addons.mozilla.org/en-US/firefox/'));
    expect(approvalRequests).toEqual([]);
    expect(channel.request).not.toHaveBeenCalled();
  });

  it('refuses a page outside site permissions', async () => {
    navigateTab('about:config');
    expect(await failure(exec(CODE))).toMatch(new RegExp(`^Cannot run JavaScript in tab ${TAB} \\(about:config\\): `));
    expect(channel.request).not.toHaveBeenCalled();
  });
});

describe('javascript_tool eval fallback', () => {
  beforeEach(() => {
    evaluateResult = { ok: false, error: 'Nothing listens on port 9222', unavailable: true };
  });

  it('runs the code with eval in the MAIN world and warns', async () => {
    expect(await text(exec(CODE))).toBe(`3\n\n${evalFallbackWarning('Nothing listens on port 9222')}`);
    expect(evalInjections()).toEqual([{ target: { tabId: TAB }, world: 'MAIN', func: evaluateInMainWorld, args: [CODE] }]);
  });

  it('formats and redacts the page result with the host formatter rules', async () => {
    mainWorldResult = fallbackResult({
      kind: 'value',
      value: { type: 'object', value: [['password', { type: 'string', value: 'hunter2' }], ['user', { type: 'string', value: 'ann' }]] },
    });
    expect((await text(exec(CODE))).split('\n')[0]).toBe('{password: [REDACTED], user: "ann"}');
  });

  it('reports an exception with the warning', async () => {
    mainWorldResult = fallbackResult({ kind: 'exception', text: 'Error: boom' });
    expect(await failure(exec(CODE))).toBe(`JavaScript error: Error: boom\n\n${evalFallbackWarning('Nothing listens on port 9222')}`);
  });

  it('explains a page policy that blocks eval', async () => {
    mainWorldResult = fallbackResult({ kind: 'blocked', text: 'EvalError: call to eval() blocked by CSP' });
    expect(await failure(exec(CODE))).toBe(blockedMessage(TAB, 'EvalError: call to eval() blocked by CSP'));
    expect(blockedMessage(TAB, 'x')).toMatch(/--remote-debugging-port/);
  });

  it('stops waiting for a script that does not finish', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mainWorldResult = () => new Promise(() => {});
    const response = failure(exec('while (true) {}'));
    await vi.advanceTimersByTimeAsync(FALLBACK_TIMEOUT_MS);
    expect(await response).toBe(fallbackTimeoutMessage(TAB));
    expect(fallbackTimeoutMessage(TAB)).toMatch(/may still be running/);
  });

  it('withholds the fallback result when the tab left the approved site', async () => {
    mainWorldResult = async () => {
      navigateTab('https://unknown.example/');
      return [{ frameId: 0, result: { kind: 'value', value: { type: 'string', value: 'secret' } } }];
    };
    expect(await text(exec(CODE))).toBe(`${withheldText(TAB, 'https://unknown.example/')}\n${evalFallbackWarning('Nothing listens on port 9222')}`);
  });

  it('reports an injection the page refuses', async () => {
    mainWorldResult = async () => {
      throw new Error('Missing host permission for the tab');
    };
    expect(await failure(exec(CODE))).toBe(restrictedPageMessage(LABEL, TAB, PAGE));
  });

  it('reports a malformed page result', async () => {
    mainWorldResult = async () => [{ frameId: 0, result: 'nonsense' }];
    expect(await failure(exec(CODE))).toBe(`Failed to run JavaScript in tab ${TAB}: the page returned no usable result`);
  });
});
