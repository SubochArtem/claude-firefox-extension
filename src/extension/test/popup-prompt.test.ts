import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ApprovalDecision, type ApprovalRequest, PROMPT_ANSWER_MESSAGE, PROMPT_GET_MESSAGE } from '../permissions/approval';
import {
  handlePromptMessage,
  PROMPT_HEIGHT,
  PROMPT_TIMEOUT_MS,
  PROMPT_WIDTH,
  popupApprovalPrompt,
} from '../permissions/popup-prompt';
import { NAVIGATION_TIMEOUT_MS } from '../tools/navigate';
import { ToolError } from '../tools/tool-error';
import { PERMISSION_PROMPT_TIMEOUT_MS, TOOL_REQUEST_TIMEOUT_MS } from '../../host/protocol';
import { EXTENSION_ID, EXTENSION_ORIGIN, mockBrowser } from './browser-mock';

const WINDOW = 50;
const REQUEST: ApprovalRequest = { host: 'example.com', url: 'https://example.com/', tool: 'navigate', action: 'navigate' };

let browserMock: ReturnType<typeof mockBrowser>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  browserMock = mockBrowser();
  browserMock.windows.create.mockResolvedValue({ id: WINDOW });
});

afterEach(() => {
  expect(browserMock.listenerCount()).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

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

async function open(request: ApprovalRequest = REQUEST) {
  const state = track<ApprovalDecision>(popupApprovalPrompt.requestApproval(request));
  await flush();
  const pageUrl = String(browserMock.windows.create.mock.calls.at(-1)?.[0].url ?? '');
  const id = new URL(pageUrl).searchParams.get('id') ?? '';
  return { state, pageUrl, id, sender: { id: EXTENSION_ID, url: pageUrl } as browser.runtime.MessageSender };
}

describe('popup approval prompt', () => {
  it('opens the prompt page in a focused popup window', async () => {
    const { state, pageUrl, id } = await open();
    expect(browserMock.windows.create).toHaveBeenCalledWith({
      type: 'popup',
      url: `${EXTENSION_ORIGIN}/permissions/prompt.html?id=${id}`,
      width: PROMPT_WIDTH,
      height: PROMPT_HEIGHT,
      focused: true,
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(pageUrl).toContain(id);
    expect(state.settled).toBe(false);
    browserMock.windows.onRemoved.emit(WINDOW);
    await flush();
  });

  it('hands the request details to its own prompt page', async () => {
    const { id, sender } = await open();
    expect(await handlePromptMessage({ type: PROMPT_GET_MESSAGE, id }, sender)).toEqual({
      pending: true,
      host: 'example.com',
      tool: 'navigate',
      action: 'navigate',
      canIncludeSubdomains: true,
    });
    browserMock.windows.onRemoved.emit(WINDOW);
    await flush();
  });

  it.each(['localhost', '127.0.0.1'])('offers no subdomain option for %s', async (host) => {
    const { id, sender } = await open({ ...REQUEST, host, url: `http://${host}/` });
    expect(await handlePromptMessage({ type: PROMPT_GET_MESSAGE, id }, sender)).toMatchObject({
      canIncludeSubdomains: false,
    });
    browserMock.windows.onRemoved.emit(WINDOW);
    await flush();
  });

  it.each([
    ['another extension', { id: 'other@example.com' }],
    ['another page of this extension', { url: `${EXTENSION_ORIGIN}/permissions/prompt.html` }],
    ['a web page', { url: 'https://example.com/permissions/prompt.html' }],
    ['no url', { url: undefined }],
  ])('ignores requests from %s', async (_name, override) => {
    const { state, id, sender } = await open();
    const from = { ...sender, ...override } as browser.runtime.MessageSender;
    expect(await handlePromptMessage({ type: PROMPT_GET_MESSAGE, id }, from)).toEqual({ pending: false });
    expect(await handlePromptMessage({ type: PROMPT_ANSWER_MESSAGE, id, answer: 'allow_once' }, from)).toEqual({
      accepted: false,
    });
    await flush();
    expect(state.settled).toBe(false);
    browserMock.windows.onRemoved.emit(WINDOW);
    await flush();
  });

  it('reports an unknown id as no longer pending', async () => {
    const { sender } = await open();
    expect(await handlePromptMessage({ type: PROMPT_GET_MESSAGE, id: 'unknown' }, sender)).toEqual({ pending: false });
    browserMock.windows.onRemoved.emit(WINDOW);
    await flush();
  });

  it.each([null, 'text', { type: 'other' }, { id: 'x' }])('leaves other messages (%j) unanswered', (message) => {
    expect(handlePromptMessage(message, { id: EXTENSION_ID })).toBeUndefined();
  });

  it.each([
    ['allow_once', false, { kind: 'answered', answer: 'allow_once', wildcard: false }],
    ['allow_once', true, { kind: 'answered', answer: 'allow_once', wildcard: false }],
    ['allow_always', false, { kind: 'answered', answer: 'allow_always', wildcard: false }],
    ['allow_always', true, { kind: 'answered', answer: 'allow_always', wildcard: true }],
    ['deny', true, { kind: 'answered', answer: 'deny', wildcard: false }],
    ['deny_always', true, { kind: 'answered', answer: 'deny_always', wildcard: true }],
  ])('resolves the answer %s (subdomains %s) and closes the window', async (answer, includeSubdomains, expected) => {
    const { state, id, sender } = await open();
    expect(await handlePromptMessage({ type: PROMPT_ANSWER_MESSAGE, id, answer, includeSubdomains }, sender)).toEqual({
      accepted: true,
    });
    await flush();
    expect(state.value).toEqual(expected);
    expect(browserMock.windows.remove).toHaveBeenCalledWith(WINDOW);
    expect(await handlePromptMessage({ type: PROMPT_GET_MESSAGE, id }, sender)).toEqual({ pending: false });
  });

  it('never stores a wildcard for a host that cannot have one', async () => {
    const { state, id, sender } = await open({ ...REQUEST, host: 'localhost', url: 'http://localhost/' });
    await handlePromptMessage({ type: PROMPT_ANSWER_MESSAGE, id, answer: 'allow_always', includeSubdomains: true }, sender);
    await flush();
    expect(state.value).toEqual({ kind: 'answered', answer: 'allow_always', wildcard: false });
  });

  it('ignores an unknown answer', async () => {
    const { state, id, sender } = await open();
    expect(await handlePromptMessage({ type: PROMPT_ANSWER_MESSAGE, id, answer: 'allow_forever' }, sender)).toEqual({
      accepted: false,
    });
    await flush();
    expect(state.settled).toBe(false);
    browserMock.windows.onRemoved.emit(WINDOW);
    await flush();
  });

  it('counts closing the window as deny', async () => {
    const { state } = await open();
    browserMock.windows.onRemoved.emit(WINDOW + 1);
    await flush();
    expect(state.settled).toBe(false);
    browserMock.windows.onRemoved.emit(WINDOW);
    await flush();
    expect(state.value).toEqual({ kind: 'answered', answer: 'deny', wildcard: false });
    expect(browserMock.windows.remove).not.toHaveBeenCalled();
  });

  it('times out after 120 s and closes the window', async () => {
    const { state } = await open();
    await vi.advanceTimersByTimeAsync(PROMPT_TIMEOUT_MS - 1);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.value).toEqual({ kind: 'timeout' });
    expect(browserMock.windows.remove).toHaveBeenCalledWith(WINDOW);
  });

  it('fails with a ToolError when the window cannot be created', async () => {
    browserMock.windows.create.mockRejectedValue(new Error('no display'));
    const { state } = await open();
    expect(state.error).toBeInstanceOf(ToolError);
    expect((state.error as Error).message).toBe(
      'Could not ask the user for permission to access example.com: the prompt window failed to open: no display',
    );
  });

  it('fails when the created window has no id', async () => {
    browserMock.windows.create.mockResolvedValue({});
    const { state } = await open();
    expect((state.error as Error).message).toMatch(/the prompt window failed to open: the window has no id$/);
  });

  it('closes a window that opens only after the prompt was answered', async () => {
    let created: (window: Partial<browser.windows.Window>) => void = () => {};
    browserMock.windows.create.mockReturnValue(new Promise((resolve) => (created = resolve)));
    const { state, id, sender } = await open();
    await handlePromptMessage({ type: PROMPT_ANSWER_MESSAGE, id, answer: 'deny' }, sender);
    await flush();
    expect(state.value).toEqual({ kind: 'answered', answer: 'deny', wildcard: false });
    created({ id: WINDOW });
    await flush();
    expect(browserMock.windows.remove).toHaveBeenCalledWith(WINDOW);
  });
});

describe('prompt timeout and the host tool request timeout', () => {
  it('matches the prompt timeout the host allows for', () => {
    expect(PROMPT_TIMEOUT_MS).toBe(PERMISSION_PROMPT_TIMEOUT_MS);
  });

  it('leaves the host enough time for a prompt followed by a navigation', () => {
    expect(PROMPT_TIMEOUT_MS + NAVIGATION_TIMEOUT_MS).toBeLessThan(TOOL_REQUEST_TIMEOUT_MS);
  });
});
