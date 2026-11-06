import { formatConsoleTime, redactConsoleText } from './console-output';
import { MAX_NETWORK_ENTRIES, type NetworkEntry, type NetworkSelection } from './network-buffer';
import type { NetworkArgs } from './network-input';

const REDACTED = '[REDACTED]';
const MAX_URL_CHARS = 1_000;
export const MAX_REPLY_REQUEST_CHARS = 100_000;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// A request URL is one whole URL, so its credentials, query and fragment are removed here even when it holds
// characters that end a URL in free text; the console redaction then catches tokens and key values in the path.
export function redactRequestUrl(url: string): string {
  const stripped = url
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, '$1')
    .replace(/\?[^#]+/, `?${REDACTED}`)
    .replace(/#.+$/, `#${REDACTED}`);
  return redactConsoleText(clip(stripped, MAX_URL_CHARS));
}

function outcome(entry: NetworkEntry): string {
  if (entry.end === undefined) return 'PENDING';
  if (entry.redirected) return 'REDIRECT';
  if (entry.error !== undefined) return `ERROR ${entry.error}`;
  return String(entry.status ?? '?');
}

function entryLine(entry: NetworkEntry): string {
  const duration = entry.end === undefined ? '' : ` [${Math.max(0, Math.round(entry.end - entry.start))} ms]`;
  return `${entry.method} ${outcome(entry)} ${entry.type} ${entry.url}${duration}`;
}

export interface NetworkReadResult extends NetworkSelection {
  dropped: number;
  since: number;
}

export interface NetworkReport {
  tabId: number;
  url: string;
  // Capture was started for the tab by this call.
  started: boolean;
  args: NetworkArgs;
  result: NetworkReadResult;
}

function summary({ tabId, url, started, args, result }: NetworkReport, shownCount: number): string {
  const where = `tab ${tabId} (${redactRequestUrl(url)})`;
  const since = formatConsoleTime(result.since);
  const again = 'reload the page or repeat the action you want to observe, then call read_network_requests again.';
  if (result.total === 0) {
    if (started) {
      return `Network capture started for ${where} with this call; requests made before it were not recorded. ${again[0]?.toUpperCase()}${again.slice(1)}`;
    }
    return `No network requests captured in ${where} since ${since}. The list starts over when the tab moves to another site; ${again}`;
  }
  const head = `Network requests of ${where} captured since ${since}:`;
  const filter = args.urlPattern === undefined ? '' : `url containing ${JSON.stringify(args.urlPattern)}`;
  if (result.matched === 0) return `${head} none of ${result.total} match (${filter}).`;
  const shown = `showing ${shownCount < result.matched ? 'the last ' : ''}${shownCount}`;
  if (filter === '') return `${head} ${shown} of ${result.total}.`;
  return `${head} ${shown} of ${result.matched} matching (${filter}), ${result.total} captured.`;
}

function notes(args: NetworkArgs, result: NetworkReadResult, omitted: number): string[] {
  const lines: string[] = [];
  if (omitted > 0) {
    lines.push(
      `${omitted} older requests were omitted to keep the reply under ${MAX_REPLY_REQUEST_CHARS / 1_000} KB; use urlPattern or a smaller limit to see them.`,
    );
  }
  if (result.dropped > 0) lines.push(`${result.dropped} older requests were dropped; the list keeps the last ${MAX_NETWORK_ENTRIES}.`);
  if (args.clear) lines.push('The list was cleared.');
  return lines;
}

function recentLines(lines: string[]): string[] {
  let size = 0;
  let start = lines.length;
  while (start > 0) {
    size += (lines[start - 1]?.length ?? 0) + 1;
    if (size > MAX_REPLY_REQUEST_CHARS) break;
    start -= 1;
  }
  return lines.slice(start);
}

export function formatNetworkReport(report: NetworkReport): string {
  const all = report.result.entries.map(entryLine);
  const lines = recentLines(all);
  const omitted = all.length - lines.length;
  return [summary(report, lines.length), ...lines, ...notes(report.args, report.result, omitted)].join('\n');
}
