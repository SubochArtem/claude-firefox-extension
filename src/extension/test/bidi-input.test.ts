import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BIDI_INPUT_TIMEOUT_MS as HOST_BIDI_INPUT_TIMEOUT_MS, parseBidiInputRequest } from '../../host/protocol';
import { BIDI_INPUT_TIMEOUT_MS, type BidiInputRequest } from '../protocol';
import { type BidiInputChannel, createBidiInputChannel, newTabMarker, performInput } from '../tools/bidi-input';
import type { InputSource } from '../tools/input-actions';
import { ToolError } from '../tools/tool-error';
import { mockBrowser } from './browser-mock';

const ACTIONS: InputSource[] = [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: 'a' }, { type: 'keyUp', value: 'a' }] }];
const URL_A = 'https://a.example/';

function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T } = { settled: false };
  void promise.then((value) => {
    state.settled = true;
    state.value = value;
  });
  return state;
}

function setupChannel() {
  const sent: BidiInputRequest[] = [];
  const channel = createBidiInputChannel((message) => {
    sent.push(message);
  });
  const request = () => {
    const state = track(channel.request({ marker: newTabMarker(), url: URL_A, actions: ACTIONS }));
    const message = sent.at(-1);
    if (!message) throw new Error('no input request was sent');
    return { state, requestId: message.requestId };
  };
  return { channel, sent, request };
}

describe('tab marker', () => {
  it('is random and accepted by the native host', () => {
    const first = newTabMarker();
    const second = newTabMarker();
    expect(first.name).toMatch(/^__claudeTabMarker_[0-9a-f]{16}$/);
    expect(first.value).toMatch(/^[0-9a-f]{32}$/);
    expect(first.name).not.toBe(second.name);
    expect(first.value).not.toBe(second.value);
    const request = { type: 'bidi_input_request', requestId: 'r', marker: first, url: URL_A, actions: ACTIONS };
    expect(parseBidiInputRequest(request)).toEqual(request);
  });

  it('uses the same timeout as the native host', () => {
    expect(BIDI_INPUT_TIMEOUT_MS).toBe(HOST_BIDI_INPUT_TIMEOUT_MS);
  });
});

describe('bidi input channel', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('sends a request with a fresh id and settles it with the matching response', async () => {
    const { sent, request, channel } = setupChannel();
    const first = request();
    const second = request();
    expect(sent[0]).toEqual({ type: 'bidi_input_request', requestId: first.requestId, marker: expect.any(Object), url: URL_A, actions: ACTIONS });
    expect(first.requestId).not.toBe(second.requestId);

    channel.handleResponse({ type: 'bidi_input_response', requestId: 'other', ok: true });
    channel.handleResponse({ type: 'bidi_input_response', requestId: second.requestId, ok: false, error: 'no tab' });
    channel.handleResponse({ type: 'bidi_input_response', requestId: first.requestId, ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(first.state).toEqual({ settled: true, value: { ok: true } });
    expect(second.state).toEqual({ settled: true, value: { ok: false, error: 'no tab' } });
  });

  it('fails a request the host does not answer in time and ignores a late answer', async () => {
    const { request, channel } = setupChannel();
    const { state, requestId } = request();
    await vi.advanceTimersByTimeAsync(BIDI_INPUT_TIMEOUT_MS - 1);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.value).toEqual({ ok: false, error: 'The native host did not finish the input within 60 s' });
    channel.handleResponse({ type: 'bidi_input_response', requestId, ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.value).toEqual({ ok: false, error: 'The native host did not finish the input within 60 s' });
  });

  it('fails pending requests on close and new ones at once', async () => {
    const { request, channel, sent } = setupChannel();
    const { state } = request();
    channel.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.value).toEqual({ ok: false, error: 'The native host disconnected before the input finished' });
    await expect(channel.request({ marker: newTabMarker(), url: URL_A, actions: ACTIONS })).resolves.toEqual({
      ok: false,
      error: 'The native host is not connected',
    });
    expect(sent).toHaveLength(1);
  });

  it('fails a request whose send throws', async () => {
    const channel = createBidiInputChannel(() => {
      throw new Error('Attempt to postMessage on disconnected port');
    });
    await expect(channel.request({ marker: newTabMarker(), url: URL_A, actions: ACTIONS })).resolves.toEqual({
      ok: false,
      error: 'Could not send the input to the native host: Attempt to postMessage on disconnected port',
    });
  });
});

describe('performInput', () => {
  let browserMock: ReturnType<typeof mockBrowser>;
  // A page `window` per test, so the injected functions run against something real.
  let page: Record<string, unknown>;

  beforeEach(() => {
    browserMock = mockBrowser();
    page = {};
    vi.stubGlobal('window', page);
    browserMock.scripting.executeScript.mockImplementation(async (injection) => {
      const { func, args } = injection as { func: (...args: unknown[]) => unknown; args: unknown[] };
      return [{ frameId: 0, result: func(...args) }];
    });
  });

  function channelAnswering(answer: (request: Parameters<BidiInputChannel['request']>[0]) => { ok: true } | { ok: false; error: string }) {
    const seen: { marker: unknown; markerOnPage: unknown }[] = [];
    const channel: BidiInputChannel = {
      request: vi.fn(async (input) => {
        seen.push({ marker: input.marker, markerOnPage: page[input.marker.name] });
        return answer(input);
      }),
      handleResponse: vi.fn(),
      close: vi.fn(),
    };
    return { channel, seen };
  }

  it('marks the top frame in the main world, asks the host and removes the marker', async () => {
    const { channel, seen } = channelAnswering(() => ({ ok: true }));
    await performInput(channel, 7, URL_A, ACTIONS);
    const [entry] = seen;
    const marker = entry?.marker as { name: string; value: string };
    expect(entry?.markerOnPage).toBe(marker.value);
    expect(channel.request).toHaveBeenCalledWith({ marker, url: URL_A, actions: ACTIONS });
    const injections = browserMock.scripting.executeScript.mock.calls.map(([injection]) => injection);
    expect(injections).toHaveLength(2);
    for (const injection of injections) {
      expect(injection).toMatchObject({ target: { tabId: 7 }, world: 'MAIN' });
      expect(injection.target).not.toHaveProperty('allFrames');
    }
    expect(Object.getOwnPropertyNames(page)).toEqual([]);
    expect(browserMock.tabs.update).not.toHaveBeenCalled();
  });

  it('turns a host error into a ToolError and still removes the marker', async () => {
    const { channel } = channelAnswering(() => ({ ok: false, error: 'Firefox is not listening for WebDriver BiDi on port 9222.' }));
    const error = await performInput(channel, 7, URL_A, ACTIONS).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as Error).message).toBe('Firefox is not listening for WebDriver BiDi on port 9222.');
    expect(Object.getOwnPropertyNames(page)).toEqual([]);
  });

  it('fails without asking the host when the marker cannot be set', async () => {
    browserMock.scripting.executeScript.mockRejectedValue(new Error('Missing host permission for the tab'));
    const { channel } = channelAnswering(() => ({ ok: true }));
    await expect(performInput(channel, 7, URL_A, ACTIONS)).rejects.toThrow(
      new ToolError('Failed to send input to tab 7: Missing host permission for the tab'),
    );
    expect(channel.request).not.toHaveBeenCalled();
  });

  it('reports an error thrown inside the page while setting the marker', async () => {
    browserMock.scripting.executeScript.mockResolvedValueOnce([{ frameId: 0, error: new Error('window is frozen') }]);
    const { channel } = channelAnswering(() => ({ ok: true }));
    await expect(performInput(channel, 7, URL_A, ACTIONS)).rejects.toThrow('Failed to send input to tab 7: window is frozen');
    expect(channel.request).not.toHaveBeenCalled();
  });

  it('keeps the host result when removing the marker fails', async () => {
    const { channel } = channelAnswering(() => ({ ok: true }));
    browserMock.scripting.executeScript
      .mockImplementationOnce(async () => [{ frameId: 0, result: undefined }])
      .mockRejectedValueOnce(new Error('tab closed'));
    await expect(performInput(channel, 7, URL_A, ACTIONS)).resolves.toBeUndefined();
  });

  it('fails when the native host is not connected', async () => {
    await expect(performInput(undefined, 7, URL_A, ACTIONS)).rejects.toThrow(
      new ToolError('Failed to send input to tab 7: the native host is not connected'),
    );
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
  });
});
