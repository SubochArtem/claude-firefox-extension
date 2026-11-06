import { describe, expect, it } from 'vitest';
import type { NetworkEntry } from '../tools/network-buffer';
import type { NetworkArgs } from '../tools/network-input';
import { formatNetworkReport, MAX_REPLY_REQUEST_CHARS, type NetworkReport, redactRequestUrl } from '../tools/network-output';

const T0 = new Date(2026, 0, 1, 12, 0, 0, 0).getTime();
const PAGE = 'https://example.com/app';
const ARGS: NetworkArgs = { limit: 100, clear: false };

function entry(overrides: Partial<NetworkEntry> = {}): NetworkEntry {
  return { requestId: '1', url: 'https://example.com/app.js', method: 'GET', type: 'script', start: T0, ...overrides };
}

function report(entries: NetworkEntry[], overrides: Partial<NetworkReport> = {}, counts: Partial<NetworkReport['result']> = {}): string {
  return formatNetworkReport({
    tabId: 5,
    url: PAGE,
    started: false,
    args: ARGS,
    result: { entries, matched: entries.length, total: entries.length, dropped: 0, since: T0, ...counts },
    ...overrides,
  });
}

describe('redactRequestUrl', () => {
  it('removes credentials, the query and the fragment', () => {
    expect(redactRequestUrl('https://user:pw@example.com/a?token=1&b=2#frag')).toBe('https://example.com/a?[REDACTED]#[REDACTED]');
  });

  it('redacts the query of urls with characters that end a url in free text', () => {
    expect(redactRequestUrl('https://example.com/a(b)/c?secret=1')).toBe('https://example.com/a(b)/c?[REDACTED]');
    expect(redactRequestUrl("https://example.com/it's?secret=1")).toBe("https://example.com/it's?[REDACTED]");
  });

  it('redacts tokens in the path', () => {
    expect(redactRequestUrl('https://example.com/t/eyJhbGciOi.eyJzdWIiOi.c2ln/x')).toBe('https://example.com/t/[REDACTED]/x');
    expect(redactRequestUrl('https://example.com/a;session=abc')).toBe('https://example.com/a;session=[REDACTED]');
  });

  it('keeps urls without secrets', () => {
    expect(redactRequestUrl('https://example.com/static/app.js')).toBe('https://example.com/static/app.js');
    expect(redactRequestUrl('https://example.com/a?')).toBe('https://example.com/a?');
  });

  it('clips long urls', () => {
    const url = `https://example.com/${'p'.repeat(3_000)}`;
    expect(redactRequestUrl(url)).toBe(`${url.slice(0, 1_000)}…`);
  });
});

describe('formatNetworkReport', () => {
  it('says capture started on the first call', () => {
    expect(report([], { started: true })).toBe(
      'Network capture started for tab 5 (https://example.com/app) with this call; requests made before it were not recorded. Reload the page or repeat the action you want to observe, then call read_network_requests again.',
    );
  });

  it('says nothing was captured on a later call', () => {
    expect(report([])).toBe(
      'No network requests captured in tab 5 (https://example.com/app) since 12:00:00.000. The list starts over when the tab moves to another site; reload the page or repeat the action you want to observe, then call read_network_requests again.',
    );
  });

  it('lists completed, failed, redirected and pending requests oldest first', () => {
    const text = report([
      entry({ type: 'main_frame', url: 'http://example.com/app', end: T0 + 40, redirected: true }),
      entry({ type: 'main_frame', url: 'https://example.com/app', start: T0 + 40, end: T0 + 163.6, status: 200 }),
      entry({ method: 'POST', type: 'xmlhttprequest', url: 'https://api.example/x', end: T0 + 12, error: 'NS_ERROR_UNKNOWN_HOST' }),
      entry({ type: 'image', url: 'https://example.com/a.png' }),
    ]);
    expect(text).toBe(
      [
        'Network requests of tab 5 (https://example.com/app) captured since 12:00:00.000: showing 4 of 4.',
        'GET REDIRECT main_frame http://example.com/app [40 ms]',
        'GET 200 main_frame https://example.com/app [124 ms]',
        'POST ERROR NS_ERROR_UNKNOWN_HOST xmlhttprequest https://api.example/x [12 ms]',
        'GET PENDING image https://example.com/a.png',
      ].join('\n'),
    );
  });

  it('describes the filter and the counts', () => {
    const args = { ...ARGS, urlPattern: '/api/' };
    expect(report([entry({ status: 200, end: T0 + 1 })], { args }, { matched: 3, total: 9 })).toBe(
      [
        'Network requests of tab 5 (https://example.com/app) captured since 12:00:00.000: showing the last 1 of 3 matching (url containing "/api/"), 9 captured.',
        'GET 200 script https://example.com/app.js [1 ms]',
      ].join('\n'),
    );
    expect(report([], { args }, { matched: 0, total: 9 })).toBe(
      'Network requests of tab 5 (https://example.com/app) captured since 12:00:00.000: none of 9 match (url containing "/api/").',
    );
  });

  it('notes dropped entries and clearing', () => {
    expect(report([entry()], { args: { ...ARGS, clear: true } }, { total: 1, dropped: 7 })).toBe(
      [
        'Network requests of tab 5 (https://example.com/app) captured since 12:00:00.000: showing 1 of 1.',
        'GET PENDING script https://example.com/app.js',
        '7 older requests were dropped; the list keeps the last 1000.',
        'The list was cleared.',
      ].join('\n'),
    );
  });

  it('redacts the page url', () => {
    expect(report([], { url: 'https://example.com/app?code=secret' })).toContain('tab 5 (https://example.com/app?[REDACTED])');
  });

  it('keeps the most recent lines within the reply cap and says how many were omitted', () => {
    const url = `https://example.com/${'p'.repeat(1_900)}`;
    const entries = Array.from({ length: 100 }, (_, index) => entry({ requestId: String(index), url: `${url}${index}` }));
    const text = report(entries);
    const lines = text.split('\n');
    const shown = lines.filter((line) => line.startsWith('GET '));
    expect(shown.length).toBeLessThan(100);
    expect(shown.join('\n').length).toBeLessThanOrEqual(MAX_REPLY_REQUEST_CHARS);
    expect(shown.at(-1)).toContain(`${url}99`);
    expect(lines[0]).toBe(`Network requests of tab 5 (https://example.com/app) captured since 12:00:00.000: showing the last ${shown.length} of 100.`);
    expect(lines.at(-1)).toBe(
      `${100 - shown.length} older requests were omitted to keep the reply under 100 KB; use urlPattern or a smaller limit to see them.`,
    );
  });
});
