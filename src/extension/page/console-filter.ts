import type { ConsoleEntry, ConsoleFilter } from './console-capture-api';

export interface ConsoleMatcher {
  regex: boolean;
  test: (text: string) => boolean;
}

export function compilePattern(pattern: string): ConsoleMatcher {
  try {
    const expression = new RegExp(pattern, 'i');
    return { regex: true, test: (text) => expression.test(text) };
  } catch {
    const needle = pattern.toLowerCase();
    return { regex: false, test: (text) => text.toLowerCase().includes(needle) };
  }
}

// Keeps the most recent `limit` matching entries, oldest first.
export function selectConsoleEntries(
  entries: readonly ConsoleEntry[],
  filter: ConsoleFilter,
): { entries: ConsoleEntry[]; matched: number } {
  const matcher = filter.pattern === undefined ? undefined : compilePattern(filter.pattern);
  const matching = entries.filter(
    (entry) => (!filter.onlyErrors || entry.level === 'error') && (matcher === undefined || matcher.test(entry.text)),
  );
  return { entries: matching.slice(Math.max(0, matching.length - filter.limit)), matched: matching.length };
}
