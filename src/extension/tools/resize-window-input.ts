import { describe, isRecord, type ParseResult, parseTabId } from './navigation-input';
import { echo } from './read-page-input';

export const MAX_WINDOW_WIDTH = 7680;
export const MAX_WINDOW_HEIGHT = 4320;

export interface ResizeWindowArgs {
  width: number;
  height: number;
  tabId?: number;
}

const PARAMETERS = ['width', 'height', 'tabId'];

function parseSize(name: string, value: unknown, max: number): ParseResult<number> {
  if (value === undefined) return { ok: false, error: `Missing required parameter ${name} (number)` };
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, error: `${name} must be a finite number, received ${describe(value)}` };
  }
  if (value < 1) return { ok: false, error: `${name} must be at least 1, received ${value}` };
  if (value > max) return { ok: false, error: `${name} must be at most ${max}, received ${value}` };
  return { ok: true, value: Math.floor(value) };
}

export function parseResizeWindowArgs(args: unknown): ParseResult<ResizeWindowArgs> {
  if (!isRecord(args)) {
    return { ok: false, error: `Expected an object with width and height parameters, received ${describe(args)}` };
  }
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || PARAMETERS.includes(key)) continue;
    return { ok: false, error: `Unknown parameter ${echo(key)}; allowed: ${PARAMETERS.join(', ')}` };
  }
  const width = parseSize('width', args.width, MAX_WINDOW_WIDTH);
  if (!width.ok) return width;
  const height = parseSize('height', args.height, MAX_WINDOW_HEIGHT);
  if (!height.ok) return height;
  const tabId = args.tabId === undefined ? undefined : parseTabId(args.tabId);
  if (tabId && !tabId.ok) return tabId;

  const value: ResizeWindowArgs = { width: width.value, height: height.value };
  if (tabId) value.tabId = tabId.value;
  return { ok: true, value };
}
