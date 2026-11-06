import { describe, isRecord, type ParseResult, parseTabId } from './navigation-input';
import { echo, parsePositiveInteger } from './read-page-input';

export const DEFAULT_NETWORK_LIMIT = 100;
export const MAX_NETWORK_LIMIT = 1000;
export const MAX_URL_PATTERN_LENGTH = 500;

export interface NetworkArgs {
  tabId?: number;
  urlPattern?: string;
  limit: number;
  clear: boolean;
}

const PARAMETERS = ['tabId', 'urlPattern', 'limit', 'clear'];

function parseUrlPattern(value: unknown): ParseResult<string> {
  if (typeof value !== 'string') return { ok: false, error: `urlPattern must be a string, received ${describe(value)}` };
  if (value === '') return { ok: false, error: 'urlPattern must not be empty' };
  if (value.length > MAX_URL_PATTERN_LENGTH) {
    return { ok: false, error: `urlPattern must be at most ${MAX_URL_PATTERN_LENGTH} characters, received ${value.length}` };
  }
  return { ok: true, value };
}

function parseLimit(value: unknown): ParseResult<number> {
  const limit = parsePositiveInteger('limit', value, DEFAULT_NETWORK_LIMIT);
  if (limit.ok && limit.value > MAX_NETWORK_LIMIT) {
    return { ok: false, error: `limit must be at most ${MAX_NETWORK_LIMIT}, received ${limit.value}` };
  }
  return limit;
}

function parseClear(value: unknown): ParseResult<boolean> {
  if (value === undefined) return { ok: true, value: false };
  if (typeof value !== 'boolean') return { ok: false, error: `clear must be true or false, received ${echo(value)}` };
  return { ok: true, value };
}

export function parseNetworkArgs(args: unknown): ParseResult<NetworkArgs> {
  if (!isRecord(args)) {
    return { ok: false, error: `Expected an object with optional tabId, urlPattern, limit and clear parameters, received ${describe(args)}` };
  }
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || PARAMETERS.includes(key)) continue;
    return { ok: false, error: `Unknown parameter ${echo(key)}; allowed: ${PARAMETERS.join(', ')}` };
  }
  const tabId = args.tabId === undefined ? undefined : parseTabId(args.tabId);
  if (tabId && !tabId.ok) return tabId;
  const urlPattern = args.urlPattern === undefined ? undefined : parseUrlPattern(args.urlPattern);
  if (urlPattern && !urlPattern.ok) return urlPattern;
  const limit = parseLimit(args.limit);
  if (!limit.ok) return limit;
  const clear = parseClear(args.clear);
  if (!clear.ok) return clear;

  const value: NetworkArgs = { limit: limit.value, clear: clear.value };
  if (tabId) value.tabId = tabId.value;
  if (urlPattern) value.urlPattern = urlPattern.value;
  return { ok: true, value };
}
