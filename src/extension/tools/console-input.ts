import { describe, isRecord, type ParseResult, parseTabId } from './navigation-input';
import { echo, parsePositiveInteger } from './read-page-input';

export const DEFAULT_CONSOLE_LIMIT = 100;
export const MAX_CONSOLE_LIMIT = 1000;
export const MAX_PATTERN_LENGTH = 500;

export interface ConsoleArgs {
  tabId?: number;
  onlyErrors: boolean;
  pattern?: string;
  limit: number;
  clear: boolean;
}

const PARAMETERS = ['tabId', 'onlyErrors', 'pattern', 'limit', 'clear'];

function parseFlag(name: string, value: unknown): ParseResult<boolean> {
  if (value === undefined) return { ok: true, value: false };
  if (typeof value !== 'boolean') return { ok: false, error: `${name} must be true or false, received ${echo(value)}` };
  return { ok: true, value };
}

function parsePattern(value: unknown): ParseResult<string> {
  if (typeof value !== 'string') return { ok: false, error: `pattern must be a string, received ${describe(value)}` };
  if (value === '') return { ok: false, error: 'pattern must not be empty' };
  if (value.length > MAX_PATTERN_LENGTH) {
    return { ok: false, error: `pattern must be at most ${MAX_PATTERN_LENGTH} characters, received ${value.length}` };
  }
  return { ok: true, value };
}

function parseLimit(value: unknown): ParseResult<number> {
  const limit = parsePositiveInteger('limit', value, DEFAULT_CONSOLE_LIMIT);
  if (limit.ok && limit.value > MAX_CONSOLE_LIMIT) {
    return { ok: false, error: `limit must be at most ${MAX_CONSOLE_LIMIT}, received ${limit.value}` };
  }
  return limit;
}

export function parseConsoleArgs(args: unknown): ParseResult<ConsoleArgs> {
  if (!isRecord(args)) {
    return {
      ok: false,
      error: `Expected an object with optional tabId, onlyErrors, pattern, limit and clear parameters, received ${describe(args)}`,
    };
  }
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || PARAMETERS.includes(key)) continue;
    return { ok: false, error: `Unknown parameter ${echo(key)}; allowed: ${PARAMETERS.join(', ')}` };
  }
  const tabId = args.tabId === undefined ? undefined : parseTabId(args.tabId);
  if (tabId && !tabId.ok) return tabId;
  const onlyErrors = parseFlag('onlyErrors', args.onlyErrors);
  if (!onlyErrors.ok) return onlyErrors;
  const pattern = args.pattern === undefined ? undefined : parsePattern(args.pattern);
  if (pattern && !pattern.ok) return pattern;
  const limit = parseLimit(args.limit);
  if (!limit.ok) return limit;
  const clear = parseFlag('clear', args.clear);
  if (!clear.ok) return clear;

  const value: ConsoleArgs = { onlyErrors: onlyErrors.value, limit: limit.value, clear: clear.value };
  if (tabId) value.tabId = tabId.value;
  if (pattern) value.pattern = pattern.value;
  return { ok: true, value };
}
