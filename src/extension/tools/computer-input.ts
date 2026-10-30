import { describe, isRecord, type ParseResult, parseTabId } from './navigation-input';

export const COMPUTER_ACTIONS = ['screenshot'] as const;
export type ComputerAction = (typeof COMPUTER_ACTIONS)[number];

export const MIN_SCREENSHOT_SCALE = 0.1;
export const MAX_SCREENSHOT_SCALE = 1;

export interface ScreenshotArgs {
  action: 'screenshot';
  tabId?: number;
  scale?: number;
}

export type ComputerArgs = ScreenshotArgs;

const MAX_ECHOED_KEY_LENGTH = 100;

const ACTION_PARAMETERS: Record<ComputerAction, readonly string[]> = {
  screenshot: ['action', 'tabId', 'scale'],
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

const ACTION_PARSERS: Record<ComputerAction, (args: Record<string, unknown>) => ParseResult<ComputerArgs>> = {
  screenshot: parseScreenshotArgs,
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
