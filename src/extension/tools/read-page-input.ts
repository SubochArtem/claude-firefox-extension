import { describe, isRecord, type ParseResult, parseTabId } from './navigation-input';

// Kept free of the DOM-typed tree builder, so the host can check its schema against these values;
// a test keeps them equal to the builder's.
export const READ_PAGE_FILTERS = ['all', 'interactive'] as const;
export type ReadPageFilter = (typeof READ_PAGE_FILTERS)[number];
export const DEFAULT_READ_DEPTH = 15;
export const DEFAULT_READ_MAX_CHARS = 50_000;

export interface ReadPageArgs {
  tabId?: number;
  filter: ReadPageFilter;
  depth: number;
  maxChars: number;
  refId?: string;
}

const PARAMETERS = ['tabId', 'filter', 'depth', 'ref_id', 'max_chars'];
const REF_ID_PATTERN = /^ref_\d+$/;
const MAX_ECHOED_LENGTH = 100;

function echo(value: unknown): string {
  if (typeof value !== 'string') return describe(value);
  return JSON.stringify(value.length > MAX_ECHOED_LENGTH ? `${value.slice(0, MAX_ECHOED_LENGTH)}…` : value);
}

function isReadPageFilter(value: string): value is ReadPageFilter {
  return (READ_PAGE_FILTERS as readonly string[]).includes(value);
}

function parseFilter(value: unknown): ParseResult<ReadPageFilter> {
  if (value === undefined) return { ok: true, value: 'all' };
  if (typeof value !== 'string') return { ok: false, error: `filter must be a string, received ${describe(value)}` };
  if (!isReadPageFilter(value)) {
    return { ok: false, error: `Unknown filter ${echo(value)}; supported filters: ${READ_PAGE_FILTERS.join(', ')}` };
  }
  return { ok: true, value };
}

function parsePositiveInteger(name: string, value: unknown, fallback: number): ParseResult<number> {
  if (value === undefined) return { ok: true, value: fallback };
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return { ok: false, error: `${name} must be a positive integer, received ${echo(value)}` };
  }
  return { ok: true, value };
}

function parseRefId(value: unknown): ParseResult<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'string') return { ok: false, error: `ref_id must be a string, received ${describe(value)}` };
  if (!REF_ID_PATTERN.test(value)) {
    return { ok: false, error: `ref_id must look like ref_12 (from an earlier read_page), received ${echo(value)}` };
  }
  return { ok: true, value };
}

export function parseReadPageArgs(args: unknown): ParseResult<ReadPageArgs> {
  if (args === undefined) args = {};
  if (!isRecord(args)) return { ok: false, error: `Expected an object of parameters, received ${describe(args)}` };
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || PARAMETERS.includes(key)) continue;
    return { ok: false, error: `Unknown parameter ${echo(key)}; allowed: ${PARAMETERS.join(', ')}` };
  }
  const tabId = args.tabId === undefined ? undefined : parseTabId(args.tabId);
  if (tabId && !tabId.ok) return tabId;
  const filter = parseFilter(args.filter);
  if (!filter.ok) return filter;
  const depth = parsePositiveInteger('depth', args.depth, DEFAULT_READ_DEPTH);
  if (!depth.ok) return depth;
  const refId = parseRefId(args.ref_id);
  if (!refId.ok) return refId;
  const maxChars = parsePositiveInteger('max_chars', args.max_chars, DEFAULT_READ_MAX_CHARS);
  if (!maxChars.ok) return maxChars;

  const value: ReadPageArgs = { filter: filter.value, depth: depth.value, maxChars: maxChars.value };
  if (tabId) value.tabId = tabId.value;
  if (refId.value !== undefined) value.refId = refId.value;
  return { ok: true, value };
}
