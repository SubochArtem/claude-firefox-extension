import { describe, expect, it } from 'vitest';
import type { ConsoleEntry, ConsoleLevel } from '../page/console-capture-api';
import { compilePattern, selectConsoleEntries } from '../page/console-filter';

function entry(level: ConsoleLevel, text: string, time = 0): ConsoleEntry {
  return { level, text, time, url: 'https://example.com/' };
}

const ENTRIES = [
  entry('log', 'Loaded app', 1),
  entry('error', 'Request failed: 500', 2),
  entry('warn', 'Deprecated API', 3),
  entry('error', 'Uncaught TypeError: x is undefined', 4),
  entry('info', 'FAILED to parse [config]', 5),
  entry('debug', 'tick', 6),
];

describe('compilePattern', () => {
  it('matches a valid pattern as a case-insensitive regular expression', () => {
    const matcher = compilePattern('fail(ed|ure)?\\b');
    expect(matcher.regex).toBe(true);
    expect(matcher.test('Request FAILED')).toBe(true);
    expect(matcher.test('failure')).toBe(true);
    expect(matcher.test('fails')).toBe(false);
  });

  it('falls back to a case-insensitive substring for an invalid regular expression', () => {
    const matcher = compilePattern('[config');
    expect(matcher.regex).toBe(false);
    expect(matcher.test('FAILED to parse [CONFIG]')).toBe(true);
    expect(matcher.test('config')).toBe(false);
  });

  it('gives the same answer on repeated calls', () => {
    const matcher = compilePattern('a');
    expect([matcher.test('a'), matcher.test('a'), matcher.test('a')]).toEqual([true, true, true]);
  });
});

describe('selectConsoleEntries', () => {
  it('returns every entry in order without a filter', () => {
    expect(selectConsoleEntries(ENTRIES, { onlyErrors: false, limit: 100 })).toEqual({ entries: ENTRIES, matched: 6 });
  });

  it('keeps only the error level with onlyErrors', () => {
    const selection = selectConsoleEntries(ENTRIES, { onlyErrors: true, limit: 100 });
    expect(selection.entries.map((item) => item.time)).toEqual([2, 4]);
    expect(selection.matched).toBe(2);
  });

  it('filters by pattern', () => {
    const selection = selectConsoleEntries(ENTRIES, { onlyErrors: false, pattern: 'fail', limit: 100 });
    expect(selection.entries.map((item) => item.time)).toEqual([2, 5]);
  });

  it('filters by an invalid pattern as text', () => {
    const selection = selectConsoleEntries(ENTRIES, { onlyErrors: false, pattern: '[config', limit: 100 });
    expect(selection.entries.map((item) => item.time)).toEqual([5]);
  });

  it('combines onlyErrors and pattern', () => {
    const selection = selectConsoleEntries(ENTRIES, { onlyErrors: true, pattern: 'type', limit: 100 });
    expect(selection.entries.map((item) => item.time)).toEqual([4]);
    expect(selection.matched).toBe(1);
  });

  it('keeps the most recent matching entries up to the limit, oldest first', () => {
    const selection = selectConsoleEntries(ENTRIES, { onlyErrors: false, limit: 2 });
    expect(selection.entries.map((item) => item.time)).toEqual([5, 6]);
    expect(selection.matched).toBe(6);
  });

  it('returns nothing when nothing matches', () => {
    expect(selectConsoleEntries(ENTRIES, { onlyErrors: false, pattern: 'absent', limit: 10 })).toEqual({ entries: [], matched: 0 });
    expect(selectConsoleEntries([], { onlyErrors: true, limit: 10 })).toEqual({ entries: [], matched: 0 });
  });
});
