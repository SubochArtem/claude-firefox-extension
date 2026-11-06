import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BIDI_EVALUATE_TIMEOUT_MS as HOST_BIDI_EVALUATE_TIMEOUT_MS, parseBidiEvaluateRequest } from '../../host/protocol';
import { BIDI_EVALUATE_TIMEOUT_MS, type BidiEvaluateRequest } from '../protocol';
import { type BidiEvaluateChannel, type BidiEvaluateResult, createBidiEvaluateChannel, evaluateInTab } from '../tools/bidi-evaluate';
import { BidiUnavailableError, newTabMarker } from '../tools/bidi-input';
import { ToolError } from '../tools/tool-error';
import { mockBrowser } from './browser-mock';

const URL_A = 'https://a.example/';
const CODE = 'document.title';

describe('bidi evaluate channel', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  function setupChannel() {
    const sent: BidiEvaluateRequest[] = [];
    const channel = createBidiEvaluateChannel((message) => {
      sent.push(message);
    });
    const request = () => {
      const result = channel.request({ marker: newTabMarker(), url: URL_A, code: CODE });
      const message = sent.at(-1);
      if (!message) throw new Error('no evaluate request was sent');
      return { result, requestId: message.requestId };
    };
    return { channel, sent, request };
  }

  it('uses the same timeout as the native host', () => {
    expect(BIDI_EVALUATE_TIMEOUT_MS).toBe(HOST_BIDI_EVALUATE_TIMEOUT_MS);
  });

  it('sends a request the native host accepts and settles it with the matching response', async () => {
    const { channel, sent, request } = setupChannel();
    const first = request();
    const second = request();
    const third = request();
    expect(parseBidiEvaluateRequest(sent[0])).toEqual(sent[0]);
    expect(sent[0]).toEqual({ type: 'bidi_evaluate_request', requestId: first.requestId, marker: expect.any(Object), url: URL_A, code: CODE });
    channel.handleResponse({ type: 'bidi_evaluate_response', requestId: 'other', ok: true, value: 'x' });
    channel.handleResponse({ type: 'bidi_evaluate_response', requestId: third.requestId, ok: false, error: 'no port', unavailable: true });
    channel.handleResponse({ type: 'bidi_evaluate_response', requestId: second.requestId, ok: true, exception: 'Error: boom' });
    channel.handleResponse({ type: 'bidi_evaluate_response', requestId: first.requestId, ok: true, value: 'Example' });
    await expect(first.result).resolves.toEqual({ ok: true, value: 'Example' });
    await expect(second.result).resolves.toEqual({ ok: true, exception: 'Error: boom' });
    await expect(third.result).resolves.toEqual({ ok: false, error: 'no port', unavailable: true });
  });

  it('fails a request the host does not answer in time', async () => {
    const { request } = setupChannel();
    const { result } = request();
    await vi.advanceTimersByTimeAsync(BIDI_EVALUATE_TIMEOUT_MS);
    await expect(result).resolves.toEqual({ ok: false, error: 'The native host did not finish the script within 90 s' });
  });

  it('fails pending requests on close', async () => {
    const { request, channel } = setupChannel();
    const { result } = request();
    channel.close();
    await expect(result).resolves.toEqual({ ok: false, error: 'The native host disconnected before the script finished' });
  });

  it('fails a request whose send throws', async () => {
    const channel = createBidiEvaluateChannel(() => {
      throw new Error('Attempt to postMessage on disconnected port');
    });
    await expect(channel.request({ marker: newTabMarker(), url: URL_A, code: CODE })).resolves.toEqual({
      ok: false,
      error: 'Could not send the script to the native host: Attempt to postMessage on disconnected port',
    });
  });
});

describe('evaluateInTab', () => {
  let browserMock: ReturnType<typeof mockBrowser>;
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

  function channelAnswering(result: BidiEvaluateResult) {
    const seen: unknown[] = [];
    const channel: BidiEvaluateChannel = {
      request: vi.fn(async (input) => {
        seen.push(page[input.marker.name] === input.marker.value);
        return result;
      }),
      handleResponse: vi.fn(),
      close: vi.fn(),
    };
    return { channel, seen };
  }

  it('marks the tab in the main world, returns the value and removes the marker', async () => {
    const { channel, seen } = channelAnswering({ ok: true, value: 'Example' });
    await expect(evaluateInTab(channel, 7, URL_A, CODE)).resolves.toEqual({ value: 'Example' });
    expect(seen).toEqual([true]);
    expect(channel.request).toHaveBeenCalledWith({ marker: expect.any(Object), url: URL_A, code: CODE });
    for (const [injection] of browserMock.scripting.executeScript.mock.calls) {
      expect(injection).toMatchObject({ target: { tabId: 7 }, world: 'MAIN' });
    }
    expect(Object.getOwnPropertyNames(page)).toEqual([]);
    expect(browserMock.tabs.update).not.toHaveBeenCalled();
  });

  it('returns an uncaught exception', async () => {
    const { channel } = channelAnswering({ ok: true, exception: 'Error: boom' });
    await expect(evaluateInTab(channel, 7, URL_A, CODE)).resolves.toEqual({ exception: 'Error: boom' });
  });

  it('throws BidiUnavailableError when the host reports BiDi unavailable', async () => {
    const { channel } = channelAnswering({ ok: false, error: 'No port.', unavailable: true });
    const error = await evaluateInTab(channel, 7, URL_A, CODE).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BidiUnavailableError);
    expect((error as Error).message).toBe('No port.');
    expect(Object.getOwnPropertyNames(page)).toEqual([]);
  });

  it('throws a ToolError for other host errors', async () => {
    const { channel } = channelAnswering({ ok: false, error: 'The script did not finish within 30 s.' });
    const error = await evaluateInTab(channel, 7, URL_A, CODE).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ToolError);
    expect(error).not.toBeInstanceOf(BidiUnavailableError);
    expect((error as Error).message).toBe('The script did not finish within 30 s.');
  });

  it('fails without asking the host when the marker cannot be set', async () => {
    browserMock.scripting.executeScript.mockRejectedValue(new Error('Missing host permission for the tab'));
    const { channel } = channelAnswering({ ok: true, value: '1' });
    await expect(evaluateInTab(channel, 7, URL_A, CODE)).rejects.toThrow(
      new ToolError('Failed to run the script in tab 7: Missing host permission for the tab'),
    );
    expect(channel.request).not.toHaveBeenCalled();
  });

  it('fails when the native host is not connected', async () => {
    await expect(evaluateInTab(undefined, 7, URL_A, CODE)).rejects.toThrow(
      new ToolError('Failed to run the script in tab 7: the native host is not connected'),
    );
    expect(browserMock.scripting.executeScript).not.toHaveBeenCalled();
  });
});
