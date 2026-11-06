import { SENSITIVE_KEY } from '../../host/remote-value-format';
import { type ConsoleEntry, type ConsoleReadResult, MAX_CONSOLE_ENTRIES, MAX_ENTRY_CHARS } from '../page/console-capture-api';
import { compilePattern } from '../page/console-filter';
import type { ConsoleArgs } from './console-input';

const REDACTED = '[REDACTED]';
const MAX_URL_CHARS = 2_000;
export const MAX_REPLY_ENTRY_CHARS = 100_000;
// Everything here runs on page-controlled text, so nothing may rescan a long run from many start positions:
// URLs are found from their "://", JWTs start only at the start of a segment run with lookaheads standing in
// for atomic groups, and keys are checked for sensitive words outside the regular expression.
const MAX_SCHEME_CHARS = 32;
const SCHEME_CHAR = /^[a-z0-9+.-]$/i;
const SCHEME_START = /^[a-z]$/i;
const URL_BODY = /[^\s"'<>`()[\]{}]+/y;
const URL_PUNCTUATION = '.,;:!?';
const JWT_TEXT = /(?<![A-Za-z0-9_-])eyJ(?=([A-Za-z0-9_-]{4,}))\1\.(?=([A-Za-z0-9_-]{4,}))\2\.[A-Za-z0-9_-]*/g;
const KEY_SEPARATOR = /(?<![\w$.-])([\w$.-]+)(["']?\s*[:=]\s*)(["']?)/g;
const KEY_VALUE = /((?:bearer|basic)\s+)?(?!\[REDACTED\])[^\s"'&,;}\])]+/iy;
const BEARER = /\b(bearer|basic)\s+(?!\[REDACTED\])[A-Za-z0-9._~+/-]+=*/gi;

function redactUrl(match: string): string {
  let end = match.length;
  while (end > 0 && URL_PUNCTUATION.includes(match[end - 1] ?? '')) end -= 1;
  const url = match
    .slice(0, end)
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, '$1')
    .replace(/\?[^#]+/, `?${REDACTED}`)
    .replace(/#.+$/, `#${REDACTED}`);
  return url + match.slice(end);
}

function schemeStart(text: string, separator: number, floor: number): number {
  let start = -1;
  for (let at = separator - 1; at >= floor && separator - at <= MAX_SCHEME_CHARS && SCHEME_CHAR.test(text[at] ?? ''); at -= 1) {
    if (SCHEME_START.test(text[at] ?? '')) start = at;
  }
  return start;
}

function redactUrls(text: string): string {
  let result = '';
  let copied = 0;
  for (let separator = text.indexOf('://'); separator !== -1; ) {
    const start = schemeStart(text, separator, copied);
    URL_BODY.lastIndex = separator + 3;
    const body = start === -1 ? null : URL_BODY.exec(text);
    if (!body) {
      separator = text.indexOf('://', separator + 1);
      continue;
    }
    const end = separator + 3 + body[0].length;
    result += text.slice(copied, start) + redactUrl(text.slice(start, end));
    copied = end;
    separator = text.indexOf('://', end);
  }
  return result + text.slice(copied);
}

function redactKeyValues(text: string): string {
  let result = '';
  let copied = 0;
  KEY_SEPARATOR.lastIndex = 0;
  for (let match = KEY_SEPARATOR.exec(text); match; match = KEY_SEPARATOR.exec(text)) {
    const [head, key = '', separator = '', quote = ''] = match;
    const valueStart = match.index + head.length;
    KEY_VALUE.lastIndex = valueStart;
    const value = SENSITIVE_KEY.test(key) ? KEY_VALUE.exec(text) : null;
    if (!value) {
      KEY_SEPARATOR.lastIndex = match.index + key.length;
      continue;
    }
    result += `${text.slice(copied, match.index)}${key}${separator}${quote}${value[1] ?? ''}${REDACTED}`;
    copied = valueStart + value[0].length;
    KEY_SEPARATOR.lastIndex = copied;
  }
  return result + text.slice(copied);
}

// Best effort, like the javascript_tool formatter: catches common shapes of secrets in console text
// (URL query strings, fragments and credentials, JWTs, values after sensitive keys, bearer tokens).
export function redactConsoleText(text: string): string {
  const masked = redactUrls(text).replace(JWT_TEXT, REDACTED);
  return redactKeyValues(masked).replace(BEARER, (_match, scheme: string) => `${scheme} ${REDACTED}`);
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

export function formatConsoleTime(time: number): string {
  const date = new Date(time);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function entryLine(entry: ConsoleEntry, pageUrl: string): string {
  const where = entry.url === pageUrl ? '' : ` (on ${redactConsoleText(clip(entry.url, MAX_URL_CHARS))})`;
  const text = `[${entry.level}] ${formatConsoleTime(entry.time)} ${redactConsoleText(clip(entry.text, MAX_ENTRY_CHARS))}${where}`;
  return text.replaceAll('\n', '\n  ');
}

function filterText(args: ConsoleArgs): string {
  const parts: string[] = [];
  if (args.onlyErrors) parts.push('only errors');
  if (args.pattern !== undefined) parts.push(`pattern ${JSON.stringify(args.pattern)}`);
  return parts.join(', ');
}

function notes(args: ConsoleArgs, result: ConsoleReadResult, omitted: number): string[] {
  const lines: string[] = [];
  if (omitted > 0) {
    lines.push(
      `${omitted} older entries were omitted to keep the reply under ${MAX_REPLY_ENTRY_CHARS / 1_000} KB; use pattern, onlyErrors or a smaller limit to see them.`,
    );
  }
  if (args.pattern !== undefined && !compilePattern(args.pattern).regex) {
    lines.push('The pattern is not a valid regular expression, so it was matched as plain text.');
  }
  if (result.dropped > 0) {
    lines.push(`${result.dropped} older messages were dropped; the buffer keeps the last ${MAX_CONSOLE_ENTRIES}.`);
  }
  if (args.clear) lines.push('The buffer was cleared.');
  return lines;
}

export interface ConsoleReport {
  tabId: number;
  url: string;
  // Capture was started for the tab by this call.
  started: boolean;
  args: ConsoleArgs;
  result: ConsoleReadResult;
}

function summary({ tabId, url, started, args, result }: ConsoleReport, shownCount: number): string {
  const where = `tab ${tabId} (${redactConsoleText(clip(url, MAX_URL_CHARS))})`;
  const since = formatConsoleTime(result.since);
  const again = 'reload the page or repeat the action you want to observe, then call read_console_messages again.';
  if (result.total === 0) {
    if (started) {
      return `Console capture started for ${where} with this call; messages logged before it were not recorded. ${again[0]?.toUpperCase()}${again.slice(1)}`;
    }
    return `No console messages captured in ${where} since ${since}. Capture restarts with each page load; ${again}`;
  }
  const head = `Console messages of ${where} captured since ${since}:`;
  const filters = filterText(args);
  if (result.matched === 0) return `${head} none of ${result.total} match (${filters}).`;
  const shown = `showing ${shownCount < result.matched ? 'the last ' : ''}${shownCount}`;
  if (filters === '') return `${head} ${shown} of ${result.total}.`;
  return `${head} ${shown} of ${result.matched} matching (${filters}), ${result.total} captured.`;
}

// Keeps the most recent whole lines that fit the budget, so a large limit of long entries stays readable.
function recentLines(lines: string[]): string[] {
  let size = 0;
  let start = lines.length;
  while (start > 0) {
    size += (lines[start - 1]?.length ?? 0) + 1;
    if (size > MAX_REPLY_ENTRY_CHARS) break;
    start -= 1;
  }
  return lines.slice(start);
}

export function formatConsoleReport(report: ConsoleReport): string {
  const all = report.result.entries.map((entry) => entryLine(entry, report.url));
  const lines = recentLines(all);
  const omitted = all.length - lines.length;
  return [summary(report, lines.length), ...lines, ...notes(report.args, report.result, omitted)].join('\n');
}
