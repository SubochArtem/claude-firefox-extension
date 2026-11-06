import { describe, expect, it } from 'vitest';
import type { ConsoleEntry, ConsoleReadResult } from '../page/console-capture-api';
import { MAX_CONSOLE_ENTRIES, MAX_ENTRY_CHARS } from '../page/console-capture-api';
import type { ConsoleArgs } from '../tools/console-input';
import { MAX_REPLY_ENTRY_CHARS, formatConsoleReport, formatConsoleTime, redactConsoleText } from '../tools/console-output';

const PAGE = 'https://example.com/app';
const T0 = new Date(2026, 0, 1, 12, 0, 0, 0).getTime();
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';
const ARGS: ConsoleArgs = { onlyErrors: false, limit: 100, clear: false };

function entry(level: ConsoleEntry['level'], text: string, offset: number, url = PAGE): ConsoleEntry {
  return { level, text, time: T0 + offset, url };
}

function result(entries: ConsoleEntry[], extra: Partial<ConsoleReadResult> = {}): ConsoleReadResult {
  return { ok: true, entries, matched: entries.length, total: entries.length, dropped: 0, since: T0, ...extra };
}

function report(read: ConsoleReadResult, args: Partial<ConsoleArgs> = {}, started = false, url = PAGE): string {
  return formatConsoleReport({ tabId: 5, url, started, args: { ...ARGS, ...args }, result: read });
}

describe('formatConsoleTime', () => {
  it('shows local hours, minutes, seconds and milliseconds', () => {
    expect(formatConsoleTime(new Date(2026, 0, 1, 9, 5, 7, 42).getTime())).toBe('09:05:07.042');
    expect(formatConsoleTime(new Date(2026, 0, 1, 23, 59, 59, 999).getTime())).toBe('23:59:59.999');
  });
});

describe('redactConsoleText', () => {
  it('removes query strings, fragments and credentials from URLs', () => {
    expect(redactConsoleText('GET https://user:pw@api.example.com/v1/items?key=abc&x=1#frag failed')).toBe(
      'GET https://api.example.com/v1/items?[REDACTED]#[REDACTED] failed',
    );
    expect(redactConsoleText('see http://example.com/path.')).toBe('see http://example.com/path.');
    expect(redactConsoleText('(at https://example.com/a?b=c)')).toBe('(at https://example.com/a?[REDACTED])');
    expect(redactConsoleText('wss://socket.example/live?token=1')).toBe('wss://socket.example/live?[REDACTED]');
  });

  it('removes JWT-like tokens anywhere in the text', () => {
    expect(redactConsoleText(`token is ${JWT}, expires soon`)).toBe('token is [REDACTED], expires soon');
  });

  it('removes values after sensitive keys', () => {
    expect(redactConsoleText('password=hunter2 user=ann')).toBe('password=[REDACTED] user=ann');
    expect(redactConsoleText('{"accessToken": "abc123", "id": 4}')).toBe('{"accessToken": "[REDACTED]", "id": 4}');
    expect(redactConsoleText("{apiKey: 'k-1', name: 'x'}")).toBe("{apiKey: '[REDACTED]', name: 'x'}");
    expect(redactConsoleText('Authorization: Bearer abc.def')).toBe('Authorization: Bearer [REDACTED]');
    expect(redactConsoleText('session_id:42; theme:dark')).toBe('session_id:[REDACTED]; theme:dark');
  });

  it('removes bearer tokens without a key', () => {
    expect(redactConsoleText('sending Bearer abc123== now')).toBe('sending Bearer [REDACTED] now');
  });

  it('does not redact twice', () => {
    expect(redactConsoleText(`token=${JWT}`)).toBe('token=[REDACTED]');
    expect(redactConsoleText('https://example.com/?token=1')).toBe('https://example.com/?[REDACTED]');
  });

  it('keeps ordinary text', () => {
    expect(redactConsoleText('Loaded 3 items in 20 ms')).toBe('Loaded 3 items in 20 ms');
  });

  it('finds a sensitive key that follows a harmless one', () => {
    expect(redactConsoleText('user=password=hunter2')).toBe('user=password=[REDACTED]');
    expect(redactConsoleText('cfg.auth.secret: s3 next')).toBe('cfg.auth.secret: [REDACTED] next');
  });

  it('finds URLs glued to other text and keeps trailing punctuation', () => {
    expect(redactConsoleText('x(https://a.example/p?q=1)')).toBe('x(https://a.example/p?[REDACTED])');
    expect(redactConsoleText('at.http://a.example/p?q=1...')).toBe('at.http://a.example/p?[REDACTED]...');
    expect(redactConsoleText('://not-a-url?x=1')).toBe('://not-a-url?x=1');
  });

  it('redacts pathological page text in linear time', () => {
    const shapes = [
      'token'.repeat(400),
      'auth'.repeat(500),
      'a'.repeat(2_000),
      'a=b&'.repeat(500),
      'a=a='.repeat(500),
      'a.'.repeat(1_000),
      'eyJ-'.repeat(500),
      `https://${'a.'.repeat(995)}`,
      `http://x/${'.'.repeat(1_990)}x`,
      `${'a'.repeat(1_990)}://x?y`,
      'bearer '.repeat(285),
      `${'password'.repeat(249)} :`,
    ];
    const started = performance.now();
    for (let index = 0; index < 1_000; index += 1) redactConsoleText(shapes[index % shapes.length] ?? '');
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('formatConsoleReport', () => {
  it('lists entries oldest first with level and time', () => {
    const text = report(result([entry('log', 'Loaded app', 1_123), entry('error', 'Request failed: 500', 2_000)]));
    expect(text).toBe(
      [
        `Console messages of tab 5 (${PAGE}) captured since 12:00:00.000: showing 2 of 2.`,
        '[log] 12:00:01.123 Loaded app',
        '[error] 12:00:02.000 Request failed: 500',
      ].join('\n'),
    );
  });

  it('says when only the most recent matching entries are shown and names the filter', () => {
    const text = report(result([entry('error', 'b failed', 2)], { matched: 7, total: 30 }), { onlyErrors: true, pattern: 'fail', limit: 1 });
    expect(text.split('\n')[0]).toBe(
      `Console messages of tab 5 (${PAGE}) captured since 12:00:00.000: showing the last 1 of 7 matching (only errors, pattern "fail"), 30 captured.`,
    );
  });

  it('indents continuation lines of multi-line entries', () => {
    const text = report(result([entry('error', 'Uncaught Error: x\n    at run@https://example.com/a.js:1:2', 0)]));
    expect(text.split('\n').slice(1)).toEqual(['[error] 12:00:00.000 Uncaught Error: x', '      at run@https://example.com/a.js:1:2']);
  });

  it('names the page of an entry logged on another URL of the same document', () => {
    const text = report(result([entry('log', 'route changed', 0, 'https://example.com/app/settings?tab=2')]));
    expect(text.split('\n')[1]).toBe('[log] 12:00:00.000 route changed (on https://example.com/app/settings?[REDACTED])');
  });

  it('redacts the header URL and entry text', () => {
    const text = report(result([entry('log', `jwt ${JWT}`, 0)]), {}, false, 'https://example.com/cb?code=secret');
    expect(text).toContain('(https://example.com/cb?[REDACTED])');
    expect(text).toContain('jwt [REDACTED]');
    expect(text).not.toContain('secret');
  });

  it('clips long entry and page URLs before redacting them', () => {
    const long = `https://example.com/${'p'.repeat(5_000)}`;
    const lines = report(result([entry('log', 'x', 0, long)]), {}, false, long.replace('example', 'other')).split('\n');
    expect(lines[0]).toContain(`(https://other.com/${'p'.repeat(2_000 - 'https://other.com/'.length)}…)`);
    expect(lines[1]).toBe(`[log] 12:00:00.000 x (on ${long.slice(0, 2_000)}…)`);
  });

  it('clips entries longer than the per-entry cap', () => {
    const text = report(result([entry('log', 'y'.repeat(MAX_ENTRY_CHARS + 50), 0)]));
    expect(text.split('\n')[1]).toBe(`[log] 12:00:00.000 ${'y'.repeat(MAX_ENTRY_CHARS)}…`);
  });

  it('tells the agent that capture just started on the first call', () => {
    expect(report(result([]), {}, true)).toBe(
      `Console capture started for tab 5 (${PAGE}) with this call; messages logged before it were not recorded. Reload the page or repeat the action you want to observe, then call read_console_messages again.`,
    );
  });

  it('tells the agent when nothing was captured since the page loaded', () => {
    expect(report(result([]))).toBe(
      `No console messages captured in tab 5 (${PAGE}) since 12:00:00.000. Capture restarts with each page load; reload the page or repeat the action you want to observe, then call read_console_messages again.`,
    );
  });

  it('shows the entries when capture started but the page already had them', () => {
    expect(report(result([entry('log', 'kept', 0)]), {}, true).split('\n')).toHaveLength(2);
  });

  it('says when no entry matches the filter', () => {
    expect(report(result([], { total: 4 }), { pattern: 'absent' })).toBe(
      `Console messages of tab 5 (${PAGE}) captured since 12:00:00.000: none of 4 match (pattern "absent").`,
    );
  });

  it('notes an invalid pattern matched as text, dropped entries and clearing', () => {
    const text = report(result([entry('log', '[x', 0)], { dropped: 12 }), { pattern: '[x', clear: true });
    expect(text.split('\n').slice(2)).toEqual([
      'The pattern is not a valid regular expression, so it was matched as plain text.',
      `12 older messages were dropped; the buffer keeps the last ${MAX_CONSOLE_ENTRIES}.`,
      'The buffer was cleared.',
    ]);
  });

  it('keeps the most recent whole entries within the reply budget and says how many were omitted', () => {
    const entries = Array.from({ length: 1_000 }, (_, index) => entry('log', `${String(index).padStart(4, '0')} ${'z'.repeat(MAX_ENTRY_CHARS - 5)}`, index));
    const text = report(result(entries, { total: 1_200 }), { limit: 1_000, clear: true });
    const lines = text.split('\n');
    const shown = lines.filter((line) => line.startsWith('[log] '));
    const lineChars = `[log] 12:00:00.000 ${'z'.repeat(MAX_ENTRY_CHARS)}`.length + 1;
    const fit = Math.floor(MAX_REPLY_ENTRY_CHARS / lineChars);
    expect(shown).toHaveLength(fit);
    expect(shown.every((line) => line.length === lineChars - 1)).toBe(true);
    expect(shown.at(-1)).toContain(' 0999 ');
    expect(shown[0]).toContain(` ${String(1_000 - fit).padStart(4, '0')} `);
    expect(lines[0]).toBe(`Console messages of tab 5 (${PAGE}) captured since 12:00:00.000: showing the last ${fit} of 1200.`);
    expect(lines.slice(-2)).toEqual([
      `${1_000 - fit} older entries were omitted to keep the reply under 100 KB; use pattern, onlyErrors or a smaller limit to see them.`,
      'The buffer was cleared.',
    ]);
    expect(text.length).toBeLessThan(MAX_REPLY_ENTRY_CHARS + 1_000);
  });

  it('notes clearing an empty buffer too', () => {
    expect(report(result([]), { clear: true })).toMatch(/\nThe buffer was cleared\.$/);
  });
});
