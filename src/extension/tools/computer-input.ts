import { describe, isRecord, type ParseResult, parseTabId } from './navigation-input';

export const COMPUTER_ACTIONS = ['screenshot', 'zoom'] as const;
export type ComputerAction = (typeof COMPUTER_ACTIONS)[number];

export const MIN_SCREENSHOT_SCALE = 0.1;
export const MAX_SCREENSHOT_SCALE = 1;

export interface ScreenshotArgs {
  action: 'screenshot';
  tabId?: number;
  scale?: number;
}

export type Region = [x0: number, y0: number, x1: number, y1: number];

export interface ZoomArgs {
  action: 'zoom';
  region: Region;
  tabId?: number;
  scale?: number;
}

export type ComputerArgs = ScreenshotArgs | ZoomArgs;

const MAX_ECHOED_KEY_LENGTH = 100;

const ACTION_PARAMETERS: Record<ComputerAction, readonly string[]> = {
  screenshot: ['action', 'tabId', 'scale'],
  zoom: ['action', 'tabId', 'region', 'scale'],
};

function isComputerAction(value: string): value is ComputerAction {
  return (COMPUTER_ACTIONS as readonly string[]).includes(value);
}

function echoKey(key: string): string {
  const capped = key.length > MAX_ECHOED_KEY_LENGTH ? `${key.slice(0, MAX_ECHOED_KEY_LENGTH)}…` : key;
  return JSON.stringify(capped);
}

function parseAction(value: unknown): ParseResult<ComputerAction> {
  if (value === undefined) {
    return { ok: false, error: `Missing required parameter action (one of: ${COMPUTER_ACTIONS.join(', ')})` };
  }
  if (typeof value !== 'string') return { ok: false, error: `action must be a string, received ${describe(value)}` };
  if (!isComputerAction(value)) {
    return {
      ok: false,
      error: `Unknown action ${echoKey(value)}; supported actions: ${COMPUTER_ACTIONS.join(', ')}`,
    };
  }
  return { ok: true, value };
}

function checkParameters(args: Record<string, unknown>, action: ComputerAction): ParseResult<void> {
  const allowed = ACTION_PARAMETERS[action];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || allowed.includes(key)) continue;
    return {
      ok: false,
      error: `Unknown parameter ${echoKey(key)} for action "${action}"; allowed: ${allowed.join(', ')}`,
    };
  }
  return { ok: true, value: undefined };
}

function parseOptionalTabId(value: unknown): ParseResult<number | undefined> {
  return value === undefined ? { ok: true, value: undefined } : parseTabId(value);
}

function parseScale(value: unknown): ParseResult<number | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, error: `scale must be a finite number, received ${describe(value)}` };
  }
  if (value < MIN_SCREENSHOT_SCALE || value > MAX_SCREENSHOT_SCALE) {
    return {
      ok: false,
      error: `scale must be between ${MIN_SCREENSHOT_SCALE} and ${MAX_SCREENSHOT_SCALE}, received ${value}`,
    };
  }
  return { ok: true, value };
}

function parseRegion(value: unknown): ParseResult<Region> {
  if (value === undefined) {
    return { ok: false, error: 'Missing required parameter region ([x0, y0, x1, y1]) for action "zoom"' };
  }
  const expected = 'region must be an array of 4 numbers [x0, y0, x1, y1]';
  if (!Array.isArray(value)) return { ok: false, error: `${expected}, received ${describe(value)}` };
  if (value.length !== 4) return { ok: false, error: `${expected}, received ${value.length} elements` };
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'number' || !Number.isFinite(item)) {
      return { ok: false, error: `region[${index}] must be a finite number, received ${describe(item)}` };
    }
  }
  const region = value as Region;
  const [x0, y0, x1, y1] = region;
  const received = `received [${region.join(', ')}]`;
  if (x0 < 0 || y0 < 0) return { ok: false, error: `region x0 and y0 must not be negative, ${received}` };
  if (x1 <= x0) return { ok: false, error: `region x1 must be greater than x0, ${received}` };
  if (y1 <= y0) return { ok: false, error: `region y1 must be greater than y0, ${received}` };
  return { ok: true, value: [x0, y0, x1, y1] };
}

function parseScreenshotArgs(args: Record<string, unknown>): ParseResult<ScreenshotArgs> {
  const tabId = parseOptionalTabId(args.tabId);
  if (!tabId.ok) return tabId;
  const scale = parseScale(args.scale);
  if (!scale.ok) return scale;
  const value: ScreenshotArgs = { action: 'screenshot' };
  if (tabId.value !== undefined) value.tabId = tabId.value;
  if (scale.value !== undefined) value.scale = scale.value;
  return { ok: true, value };
}

function parseZoomArgs(args: Record<string, unknown>): ParseResult<ZoomArgs> {
  const region = parseRegion(args.region);
  if (!region.ok) return region;
  const tabId = parseOptionalTabId(args.tabId);
  if (!tabId.ok) return tabId;
  const scale = parseScale(args.scale);
  if (!scale.ok) return scale;
  const value: ZoomArgs = { action: 'zoom', region: region.value };
  if (tabId.value !== undefined) value.tabId = tabId.value;
  if (scale.value !== undefined) value.scale = scale.value;
  return { ok: true, value };
}

const ACTION_PARSERS: Record<ComputerAction, (args: Record<string, unknown>) => ParseResult<ComputerArgs>> = {
  screenshot: parseScreenshotArgs,
  zoom: parseZoomArgs,
};

export function parseComputerArgs(args: unknown): ParseResult<ComputerArgs> {
  if (!isRecord(args)) {
    return { ok: false, error: `Expected an object with an action parameter, received ${describe(args)}` };
  }
  const action = parseAction(args.action);
  if (!action.ok) return action;
  const parameters = checkParameters(args, action.value);
  if (!parameters.ok) return parameters;
  return ACTION_PARSERS[action.value](args);
}
