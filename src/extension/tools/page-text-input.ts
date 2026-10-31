import { describe, isRecord, type ParseResult, parseTabId } from './navigation-input';
import { echo, parsePositiveInteger } from './read-page-input';

export const DEFAULT_PAGE_TEXT_MAX_CHARS = 50_000;

export interface PageTextArgs {
  tabId?: number;
  maxChars: number;
}

const PARAMETERS = ['tabId', 'max_chars'];

export function parsePageTextArgs(args: unknown): ParseResult<PageTextArgs> {
  if (args === undefined) args = {};
  if (!isRecord(args)) return { ok: false, error: `Expected an object of parameters, received ${describe(args)}` };
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || PARAMETERS.includes(key)) continue;
    return { ok: false, error: `Unknown parameter ${echo(key)}; allowed: ${PARAMETERS.join(', ')}` };
  }
  const tabId = args.tabId === undefined ? undefined : parseTabId(args.tabId);
  if (tabId && !tabId.ok) return tabId;
  const maxChars = parsePositiveInteger('max_chars', args.max_chars, DEFAULT_PAGE_TEXT_MAX_CHARS);
  if (!maxChars.ok) return maxChars;

  const value: PageTextArgs = { maxChars: maxChars.value };
  if (tabId) value.tabId = tabId.value;
  return { ok: true, value };
}
