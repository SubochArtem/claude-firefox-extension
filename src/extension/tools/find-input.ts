import { describe, isRecord, type ParseResult, parseTabId } from './navigation-input';
import { echo } from './read-page-input';

export const MAX_QUERY_LENGTH = 500;

export interface FindArgs {
  tabId?: number;
  query: string;
}

const PARAMETERS = ['query', 'tabId'];

function parseQuery(value: unknown): ParseResult<string> {
  if (value === undefined) {
    return { ok: false, error: 'query is required: describe the element to find, e.g. "search box"' };
  }
  if (typeof value !== 'string') return { ok: false, error: `query must be a string, received ${describe(value)}` };
  const query = value.trim();
  if (query === '') return { ok: false, error: 'query must not be empty' };
  if (query.length > MAX_QUERY_LENGTH) {
    return { ok: false, error: `query must be at most ${MAX_QUERY_LENGTH} characters, received ${query.length}` };
  }
  return { ok: true, value: query };
}

export function parseFindArgs(args: unknown): ParseResult<FindArgs> {
  if (args === undefined) args = {};
  if (!isRecord(args)) return { ok: false, error: `Expected an object of parameters, received ${describe(args)}` };
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || PARAMETERS.includes(key)) continue;
    return { ok: false, error: `Unknown parameter ${echo(key)}; allowed: ${PARAMETERS.join(', ')}` };
  }
  const query = parseQuery(args.query);
  if (!query.ok) return query;
  const tabId = args.tabId === undefined ? undefined : parseTabId(args.tabId);
  if (tabId && !tabId.ok) return tabId;

  const value: FindArgs = { query: query.value };
  if (tabId) value.tabId = tabId.value;
  return { ok: true, value };
}
