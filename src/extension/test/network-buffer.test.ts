import { describe, expect, it } from 'vitest';
import {
  addRequest,
  completeRequest,
  failRequest,
  isNetworkCapture,
  MAX_NETWORK_ENTRIES,
  type NetworkCapture,
  newCapture,
  selectRequests,
} from '../tools/network-buffer';

function start(capture: NetworkCapture, requestId: string, url = `https://example.com/${requestId}`, timeStamp = 1_000): void {
  addRequest(capture, { requestId, url, method: 'GET', type: 'script', timeStamp });
}

describe('network buffer', () => {
  it('records a request as pending until it completes', () => {
    const capture = newCapture('example.com', 500);
    start(capture, '1');
    expect(capture.entries).toEqual([{ requestId: '1', url: 'https://example.com/1', method: 'GET', type: 'script', start: 1_000 }]);
    expect(completeRequest(capture, { requestId: '1', statusCode: 404, timeStamp: 1_123.6 })).toBe(true);
    expect(capture.entries[0]).toMatchObject({ status: 404, end: 1_123.6 });
  });

  it('records the error of a failed request without a status', () => {
    const capture = newCapture('example.com', 0);
    start(capture, '1');
    expect(failRequest(capture, { requestId: '1', error: 'NS_ERROR_UNKNOWN_HOST', timeStamp: 1_050 })).toBe(true);
    expect(capture.entries[0]).toEqual({
      requestId: '1',
      url: 'https://example.com/1',
      method: 'GET',
      type: 'script',
      start: 1_000,
      end: 1_050,
      error: 'NS_ERROR_UNKNOWN_HOST',
    });
  });

  it('ignores completions and errors of requests it did not see start', () => {
    const capture = newCapture('example.com', 0);
    start(capture, '1');
    expect(completeRequest(capture, { requestId: '2', statusCode: 200, timeStamp: 2_000 })).toBe(false);
    expect(failRequest(capture, { requestId: '3', error: 'NS_BINDING_ABORTED', timeStamp: 2_000 })).toBe(false);
    expect(capture.entries).toHaveLength(1);
    expect(capture.entries[0]?.end).toBeUndefined();
  });

  it('ignores a second completion of a finished request', () => {
    const capture = newCapture('example.com', 0);
    start(capture, '1');
    completeRequest(capture, { requestId: '1', statusCode: 200, timeStamp: 1_100 });
    expect(failRequest(capture, { requestId: '1', error: 'NS_BINDING_ABORTED', timeStamp: 1_200 })).toBe(false);
    expect(capture.entries[0]).toMatchObject({ status: 200, end: 1_100 });
    expect(capture.entries[0]?.error).toBeUndefined();
  });

  it('marks a request redirected when the same request id starts again and records the new url', () => {
    const capture = newCapture('example.com', 0);
    start(capture, '1', 'http://example.com/a', 1_000);
    start(capture, '1', 'https://example.com/a', 1_040);
    completeRequest(capture, { requestId: '1', statusCode: 200, timeStamp: 1_100 });
    expect(capture.entries).toEqual([
      { requestId: '1', url: 'http://example.com/a', method: 'GET', type: 'script', start: 1_000, end: 1_040, redirected: true },
      { requestId: '1', url: 'https://example.com/a', method: 'GET', type: 'script', start: 1_040, end: 1_100, status: 200 },
    ]);
  });

  it('correlates interleaved requests by request id', () => {
    const capture = newCapture('example.com', 0);
    start(capture, '1');
    start(capture, '2');
    start(capture, '3');
    completeRequest(capture, { requestId: '2', statusCode: 204, timeStamp: 1_010 });
    failRequest(capture, { requestId: '1', error: 'NS_BINDING_ABORTED', timeStamp: 1_020 });
    expect(capture.entries.map((entry) => [entry.requestId, entry.status, entry.error])).toEqual([
      ['1', undefined, 'NS_BINDING_ABORTED'],
      ['2', 204, undefined],
      ['3', undefined, undefined],
    ]);
  });

  it('keeps the last entries and counts the dropped ones', () => {
    const capture = newCapture('example.com', 0);
    for (let index = 0; index < MAX_NETWORK_ENTRIES + 5; index += 1) start(capture, String(index));
    expect(MAX_NETWORK_ENTRIES).toBe(1000);
    expect(capture.entries).toHaveLength(MAX_NETWORK_ENTRIES);
    expect(capture.dropped).toBe(5);
    expect(capture.entries[0]?.requestId).toBe('5');
  });

  it('clips long methods, types and errors', () => {
    const capture = newCapture('example.com', 0);
    addRequest(capture, { requestId: '1', url: 'https://example.com/', method: 'M'.repeat(100), type: 't'.repeat(100), timeStamp: 0 });
    failRequest(capture, { requestId: '1', error: `${'e'.repeat(300)}\n  next`, timeStamp: 1 });
    const [entry] = capture.entries;
    expect(entry?.method).toBe(`${'M'.repeat(32)}…`);
    expect(entry?.type).toBe(`${'t'.repeat(32)}…`);
    expect(entry?.error).toBe(`${'e'.repeat(200)}…`);
    const other = newCapture('example.com', 0);
    start(other, '2');
    failRequest(other, { requestId: '2', error: 'Some\n error  text', timeStamp: 1 });
    expect(other.entries[0]?.error).toBe('Some error text');
  });
});

describe('selectRequests', () => {
  function capture(urls: string[]): NetworkCapture {
    const result = newCapture('example.com', 0);
    urls.forEach((url, index) => start(result, String(index), url));
    return result;
  }

  it('returns the most recent entries up to the limit, oldest first', () => {
    const selection = selectRequests(capture(['https://a/1', 'https://a/2', 'https://a/3']), { limit: 2 });
    expect(selection.entries.map((entry) => entry.url)).toEqual(['https://a/2', 'https://a/3']);
    expect(selection).toMatchObject({ matched: 3, total: 3 });
  });

  it('filters by a case-insensitive url substring', () => {
    const selection = selectRequests(capture(['https://a/API/x', 'https://a/style.css', 'https://a/api/y']), { urlPattern: '/api/', limit: 10 });
    expect(selection.entries.map((entry) => entry.url)).toEqual(['https://a/API/x', 'https://a/api/y']);
    expect(selection).toMatchObject({ matched: 2, total: 3 });
  });

  it('treats the pattern as plain text', () => {
    const selection = selectRequests(capture(['https://a/x.js', 'https://a/xxjs']), { urlPattern: '.js', limit: 10 });
    expect(selection.entries.map((entry) => entry.url)).toEqual(['https://a/x.js']);
  });
});

describe('isNetworkCapture', () => {
  it('accepts a capture with valid entries', () => {
    const value = newCapture('example.com', 1);
    start(value, '1');
    completeRequest(value, { requestId: '1', statusCode: 200, timeStamp: 1_100 });
    start(value, '2');
    failRequest(value, { requestId: '2', error: 'NS_BINDING_ABORTED', timeStamp: 1_100 });
    start(value, '3', 'https://example.com/3');
    start(value, '3', 'https://example.com/4');
    expect(isNetworkCapture(structuredClone(value))).toBe(true);
  });

  it.each([
    null,
    'capture',
    { host: 1, since: 0, dropped: 0, entries: [] },
    { host: 'a', since: 'now', dropped: 0, entries: [] },
    { host: 'a', since: 0, dropped: -1, entries: [] },
    { host: 'a', since: 0, dropped: 0, entries: {} },
    { host: 'a', since: 0, dropped: 0, entries: [{ requestId: '1', url: 'u', method: 'GET', type: 'script' }] },
    { host: 'a', since: 0, dropped: 0, entries: [{ requestId: '1', url: 'u', method: 'GET', type: 'script', start: 0, status: '200' }] },
    { host: 'a', since: 0, dropped: 0, entries: [{ requestId: 1, url: 'u', method: 'GET', type: 'script', start: 0 }] },
    { host: 'a', since: 0, dropped: 0, entries: [{ requestId: '1', url: 'u', method: 'GET', type: 'script', start: 0, error: 3 }] },
  ])('rejects %j', (value) => {
    expect(isNetworkCapture(value)).toBe(false);
  });

  it('rejects more entries than the buffer keeps', () => {
    const value = newCapture('a', 0);
    value.entries = Array.from({ length: MAX_NETWORK_ENTRIES + 1 }, (_, index) => ({
      requestId: String(index),
      url: 'u',
      method: 'GET',
      type: 'script',
      start: 0,
    }));
    expect(isNetworkCapture(value)).toBe(false);
  });
});
