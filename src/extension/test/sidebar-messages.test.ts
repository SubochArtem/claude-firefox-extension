import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_TOOL_CALL_MESSAGE, createSidebarMessageHandler, SIDEBAR_PAGE } from '../sidebar/sidebar-messages';
import { EXTENSION_ID, EXTENSION_ORIGIN, mockBrowser } from './browser-mock';

let browserMock: ReturnType<typeof mockBrowser>;

const SIDEBAR_SENDER = { id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}/${SIDEBAR_PAGE}` } as browser.runtime.MessageSender;

function call(name: string, input: unknown = {}) {
  return { type: CHAT_TOOL_CALL_MESSAGE, name, input };
}

beforeEach(() => {
  browserMock = mockBrowser();
});

describe('sidebar tool calls', () => {
  const handle = createSidebarMessageHandler(() => ({}));

  it('runs a tool through the registry for the sidebar page', async () => {
    expect(await handle(call('tabs_context'), SIDEBAR_SENDER)).toEqual({
      content: [{ type: 'text', text: '{"tabs":[],"activeTabId":null}' }],
      isError: false,
    });
  });

  it('converts image blocks to Anthropic image blocks', async () => {
    const handler = createSidebarMessageHandler(() => ({}));
    const tools = await import('../tools');
    vi.spyOn(tools, 'executeTool').mockResolvedValue({
      type: 'tool_response',
      id: 'x',
      result: {
        content: [
          { type: 'text', text: 'shot' },
          { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
          { type: 'image', data: 'BBBB', mimeType: 'image/bmp' },
        ],
      },
    });
    expect(await handler(call('computer', { action: 'screenshot' }), SIDEBAR_SENDER)).toEqual({
      content: [
        { type: 'text', text: 'shot' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
        { type: 'text', text: '[image of unsupported type image/bmp]' },
      ],
      isError: false,
    });
  });

  it('answers an unknown tool with an error result', async () => {
    expect(await handle(call('no_such_tool'), SIDEBAR_SENDER)).toEqual({
      content: [{ type: 'text', text: 'Unknown tool: no_such_tool' }],
      isError: true,
    });
  });

  it('answers invalid tool input with an error result', async () => {
    expect(await handle(call('navigate', { url: 7 }), SIDEBAR_SENDER)).toMatchObject({ isError: true });
  });

  it.each([null, 'text', ['list'], 3])('refuses input that is not an object (%o)', async (input) => {
    expect(await handle(call('tabs_context', input), SIDEBAR_SENDER)).toEqual({
      content: [{ type: 'text', text: 'Invalid tool call: the input must be an object' }],
      isError: true,
    });
    expect(browserMock.query).not.toHaveBeenCalled();
  });

  it('refuses a call without a tool name', async () => {
    expect(await handle({ type: CHAT_TOOL_CALL_MESSAGE, input: {} }, SIDEBAR_SENDER)).toMatchObject({ isError: true });
  });

  it.each<[string, Partial<browser.runtime.MessageSender>]>([
    ['another extension', { id: 'other@example', url: `${EXTENSION_ORIGIN}/${SIDEBAR_PAGE}` }],
    ['the options page', { id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}/options/options.html` }],
    ['the prompt page', { id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}/permissions/prompt.html` }],
    ['a content script', { id: EXTENSION_ID, url: 'https://example.com/' }],
    ['a sender without a URL', { id: EXTENSION_ID }],
  ])('refuses a call from %s', async (_label, sender) => {
    expect(await handle(call('tabs_context'), sender as browser.runtime.MessageSender)).toEqual({
      content: [{ type: 'text', text: 'Tool calls are accepted only from the sidebar chat' }],
      isError: true,
    });
    expect(browserMock.query).not.toHaveBeenCalled();
  });

  it.each([undefined, 'text', { type: 'permission_revoke' }])('ignores other messages (%o)', (message) => {
    expect(handle(message, SIDEBAR_SENDER)).toBeUndefined();
  });

  it('asks for site permission in the popup prompt', async () => {
    browserMock.tabs.get.mockResolvedValue({ id: 5, windowId: 1, active: true, url: 'about:blank' });
    const reply = await handle(call('navigate', { tabId: 5, url: 'https://unknown.example/' }), SIDEBAR_SENDER);
    expect(browserMock.windows.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'popup' }));
    expect(reply).toMatchObject({ isError: true });
  });

  it('passes the current BiDi channels to the tools', async () => {
    const input = { request: vi.fn(), handleResponse: vi.fn(), close: vi.fn() };
    const evaluate = { request: vi.fn(), handleResponse: vi.fn(), close: vi.fn() };
    const channels = vi.fn(() => ({ input, evaluate }));
    const tools = await import('../tools');
    const execute = vi.spyOn(tools, 'executeTool').mockResolvedValue({ type: 'tool_response', id: 'x', result: { content: [] } });
    await createSidebarMessageHandler(channels)(call('tabs_context'), SIDEBAR_SENDER);
    expect(channels).toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ tool: 'tabs_context', args: {} }), undefined, input, evaluate);
  });
});
