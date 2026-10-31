import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalPrompt } from '../permissions/approval';
import type { ClientApprovals } from '../permissions/client-prompt';
import { PERMISSION_STORAGE_KEY } from '../permissions/permission-store';
import { tabsContextText } from '../tools/tabs-context';
import { executeTool } from '../tools';
import { mockBrowser } from './browser-mock';

let browserMock: ReturnType<typeof mockBrowser>;

beforeEach(() => {
  browserMock = mockBrowser();
});

function request(tool: string, args: Record<string, unknown> = {}) {
  return { type: 'tool_request' as const, id: '1:7', tool, args };
}

describe('executeTool', () => {
  it('wraps handler output in a result response with the request id', async () => {
    expect(await executeTool(request('tabs_context'))).toEqual({
      type: 'tool_response',
      id: '1:7',
      result: { content: [{ type: 'text', text: '{"tabs":[],"activeTabId":null}' }] },
    });
  });

  it('answers an unknown tool with an error', async () => {
    expect(await executeTool(request('no_such_tool'))).toEqual({
      type: 'tool_response',
      id: '1:7',
      error: { content: [{ type: 'text', text: 'Unknown tool: no_such_tool' }] },
    });
  });

  it('turns a thrown Error into an error response', async () => {
    browserMock.query.mockRejectedValue(new Error('tabs API unavailable'));
    expect(await executeTool(request('tabs_context'))).toEqual({
      type: 'tool_response',
      id: '1:7',
      error: { content: [{ type: 'text', text: 'Tool execution failed: tabs API unavailable' }] },
    });
  });

  describe('approval prompt choice', () => {
    function clientApprovals() {
      const prompt: ApprovalPrompt = {
        requestApproval: vi.fn(async () => ({ kind: 'answered' as const, answer: 'deny' as const, wildcard: false })),
      };
      const approvals: ClientApprovals = { promptFor: vi.fn(() => prompt), handleResponse: vi.fn(), close: vi.fn() };
      return { approvals, prompt };
    }

    beforeEach(() => {
      browserMock.tabs.get.mockResolvedValue({ id: 5, windowId: 1, active: true, url: 'about:blank' });
    });
    const navigateRequest = (approvalViaClient: boolean) => ({
      ...request('navigate', { tabId: 5, url: 'https://unknown.example/' }),
      ...(approvalViaClient ? { approvalViaClient: true as const } : {}),
    });

    it('asks in the MCP client with the prompt for the request id when the call allows it', async () => {
      const { approvals, prompt } = clientApprovals();
      const response = await executeTool(navigateRequest(true), approvals);
      expect(approvals.promptFor).toHaveBeenCalledWith('1:7');
      expect(prompt.requestApproval).toHaveBeenCalledWith(expect.objectContaining({ host: 'unknown.example' }));
      expect(browserMock.windows.create).not.toHaveBeenCalled();
      expect(response).toHaveProperty('error');
    });

    it('opens the popup prompt when the call does not allow asking in the client', async () => {
      const { approvals, prompt } = clientApprovals();
      const response = await executeTool(navigateRequest(false), approvals);
      expect(prompt.requestApproval).not.toHaveBeenCalled();
      expect(browserMock.windows.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'popup' }));
      expect(response).toHaveProperty('error');
    });
  });

  it('stringifies a thrown non-Error value', async () => {
    browserMock.query.mockRejectedValue('plain string');
    expect(await executeTool(request('tabs_context'))).toEqual({
      type: 'tool_response',
      id: '1:7',
      error: { content: [{ type: 'text', text: 'Tool execution failed: plain string' }] },
    });
  });
});

describe('tabs_context', () => {
  async function context(): Promise<unknown> {
    const response = await executeTool(request('tabs_context'));
    if (!('result' in response)) throw new Error('expected a result');
    const [block] = response.result.content;
    if (block?.type !== 'text') throw new Error('expected a text block');
    return JSON.parse(block.text);
  }

  it('lists normal-window tabs and the active tab of the last focused window', async () => {
    browserMock.allowSites('one.example', 'two.example');
    browserMock.query.mockImplementation(async (query) =>
      query.active
        ? [{ id: 12, windowId: 2, active: true }]
        : [
            { id: 11, windowId: 1, title: 'One', url: 'https://one.example/', active: true, index: 0 },
            { id: 12, windowId: 2, title: 'Two', url: 'https://two.example/', active: true, index: 0 },
            { id: 13, windowId: 2, title: 'Three', url: 'about:blank', active: false, index: 1 },
          ],
    );
    expect(await context()).toEqual({
      tabs: [
        { tabId: 11, windowId: 1, title: 'One', url: 'https://one.example/', active: true },
        { tabId: 12, windowId: 2, title: 'Two', url: 'https://two.example/', active: true },
        { tabId: 13, windowId: 2, title: 'Three', url: 'about:blank', active: false },
      ],
      activeTabId: 12,
    });
    expect(browserMock.query).toHaveBeenCalledWith({ windowType: 'normal' });
    expect(browserMock.query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true, windowType: 'normal' });
  });

  it('skips tabs without an id', async () => {
    browserMock.query.mockImplementation(async (query) =>
      query.active
        ? []
        : [
            { windowId: 1, title: 'No id', url: 'about:blank', active: false },
            { id: 5, windowId: 1, title: 'Has id', url: 'about:home', active: true },
          ],
    );
    expect(await context()).toEqual({
      tabs: [{ tabId: 5, windowId: 1, title: 'Has id', url: 'about:home', active: true }],
      activeTabId: null,
    });
  });

  it('reports activeTabId null when no normal window is focused', async () => {
    browserMock.query.mockImplementation(async (query) =>
      query.active ? [] : [{ id: 1, windowId: 1, title: 't', url: 'about:blank', active: true }],
    );
    expect(await context()).toMatchObject({ activeTabId: null });
  });

  it('drops title and url when the tabs API omits them', async () => {
    browserMock.query.mockImplementation(async (query) => (query.active ? [] : [{ id: 3, windowId: 1, active: false }]));
    expect(await context()).toEqual({ tabs: [{ tabId: 3, windowId: 1, active: false }], activeTabId: null });
  });

  it('withholds the title and path of http(s) tabs on hosts without an allow, without prompting', async () => {
    browserMock.allowSites('approved.example');
    browserMock.storage.local.data.set(PERMISSION_STORAGE_KEY, [
      ...(browserMock.storage.local.data.get(PERMISSION_STORAGE_KEY) as unknown[]),
      { id: 'deny', host: 'blocked.example', wildcard: false, decision: 'deny', duration: 'always', createdAt: 0 },
    ]);
    browserMock.query.mockImplementation(async (query) =>
      query.active
        ? []
        : [
            { id: 1, windowId: 1, title: 'Approved', url: 'https://www.approved.example/a?b', active: true },
            { id: 2, windowId: 1, title: 'Secret', url: 'https://unknown.example:8443/inbox?id=7', active: false },
            { id: 3, windowId: 1, title: 'Blocked', url: 'http://blocked.example/x', active: false },
            { id: 4, windowId: 1, title: 'New Tab', url: 'about:newtab', active: false },
          ],
    );
    expect(await context()).toEqual({
      tabs: [
        { tabId: 1, windowId: 1, title: 'Approved', url: 'https://www.approved.example/a?b', active: true },
        { tabId: 2, windowId: 1, url: 'https://unknown.example:8443', unapproved: true, active: false },
        { tabId: 3, windowId: 1, url: 'http://blocked.example', unapproved: true, active: false },
        { tabId: 4, windowId: 1, title: 'New Tab', url: 'about:newtab', active: false },
      ],
      activeTabId: null,
    });
    expect(browserMock.windows.create).not.toHaveBeenCalled();
    expect(browserMock.storage.local.set).not.toHaveBeenCalled();
  });

  it('treats the host approved for the current call as approved', async () => {
    browserMock.query.mockImplementation(async (query) =>
      query.active ? [] : [{ id: 1, windowId: 1, title: 'Once', url: 'https://once.example/page', active: false }],
    );
    expect(JSON.parse(await tabsContextText('once.example'))).toEqual({
      tabs: [{ tabId: 1, windowId: 1, title: 'Once', url: 'https://once.example/page', active: false }],
      activeTabId: null,
    });
  });
});
