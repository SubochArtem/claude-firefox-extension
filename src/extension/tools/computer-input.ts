import { DEFAULT_SCROLL_AMOUNT, MAX_SCROLL_AMOUNT, type ScrollDirection } from './input-actions';
import { parseModifiers } from './input-keys';
import { describe, isRecord, type ParseResult, parseTabId } from './navigation-input';

export const COMPUTER_ACTIONS = [
  'screenshot',
  'zoom',
  'left_click',
  'right_click',
  'double_click',
  'triple_click',
  'hover',
  'left_click_drag',
  'scroll',
  'scroll_to',
  'wait',
] as const;
export type ComputerAction = (typeof COMPUTER_ACTIONS)[number];

export const CLICK_ACTIONS = ['left_click', 'right_click', 'double_click', 'triple_click'] as const;
export type ClickAction = (typeof CLICK_ACTIONS)[number];

export const SCROLL_DIRECTIONS: readonly ScrollDirection[] = ['up', 'down', 'left', 'right'];
export const MAX_WAIT_SECONDS = 10;

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

export type Coordinate = [x: number, y: number];

export type PointerTarget = { coordinate: Coordinate } | { ref: string };

export interface ClickArgs {
  action: ClickAction;
  target: PointerTarget;
  modifiers?: string;
  tabId?: number;
}

export interface HoverArgs {
  action: 'hover';
  target: PointerTarget;
  tabId?: number;
}

export interface DragArgs {
  action: 'left_click_drag';
  start: Coordinate;
  end: Coordinate;
  tabId?: number;
}

export interface ScrollArgs {
  action: 'scroll';
  coordinate: Coordinate;
  direction: ScrollDirection;
  amount: number;
  tabId?: number;
}

export interface ScrollToArgs {
  action: 'scroll_to';
  ref: string;
  tabId?: number;
}

export interface WaitArgs {
  action: 'wait';
  duration: number;
}

export type PointerArgs = ClickArgs | HoverArgs | DragArgs | ScrollArgs | ScrollToArgs;

export type ComputerArgs = ScreenshotArgs | ZoomArgs | PointerArgs | WaitArgs;

const MAX_ECHOED_KEY_LENGTH = 100;

const CLICK_PARAMETERS = ['action', 'tabId', 'coordinate', 'ref', 'modifiers'];
const REF_PATTERN = /^ref_\d+$/;

const ACTION_PARAMETERS: Record<ComputerAction, readonly string[]> = {
  screenshot: ['action', 'tabId', 'scale'],
  zoom: ['action', 'tabId', 'region', 'scale'],
  left_click: CLICK_PARAMETERS,
  right_click: CLICK_PARAMETERS,
  double_click: CLICK_PARAMETERS,
  triple_click: CLICK_PARAMETERS,
  hover: ['action', 'tabId', 'coordinate', 'ref'],
  left_click_drag: ['action', 'tabId', 'start_coordinate', 'coordinate'],
  scroll: ['action', 'tabId', 'coordinate', 'scroll_direction', 'scroll_amount'],
  scroll_to: ['action', 'tabId', 'ref'],
  wait: ['action', 'tabId', 'duration'],
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

function parseCoordinate(value: unknown, name: string, action: ComputerAction): ParseResult<Coordinate> {
  if (value === undefined) {
    return {
      ok: false,
      error: `Missing required parameter ${name} ([x, y] in the last screenshot frame) for action "${action}"`,
    };
  }
  const expected = `${name} must be an array of 2 numbers [x, y]`;
  if (!Array.isArray(value)) return { ok: false, error: `${expected}, received ${describe(value)}` };
  if (value.length !== 2) return { ok: false, error: `${expected}, received ${value.length} elements` };
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'number' || !Number.isFinite(item)) {
      return { ok: false, error: `${name}[${index}] must be a finite number, received ${describe(item)}` };
    }
  }
  return { ok: true, value: [value[0] as number, value[1] as number] };
}

function parseRef(value: unknown, action: ComputerAction): ParseResult<string> {
  if (value === undefined) {
    return {
      ok: false,
      error: `Missing required parameter ref (an element reference like ref_12 from read_page or find) for action "${action}"`,
    };
  }
  if (typeof value !== 'string') return { ok: false, error: `ref must be a string, received ${describe(value)}` };
  if (!REF_PATTERN.test(value)) {
    return { ok: false, error: `ref must look like ref_12 (from read_page or find), received ${echoKey(value)}` };
  }
  return { ok: true, value };
}

function parseTarget(args: Record<string, unknown>, action: ComputerAction): ParseResult<PointerTarget> {
  const hasCoordinate = args.coordinate !== undefined;
  const hasRef = args.ref !== undefined;
  if (hasCoordinate && hasRef) {
    return { ok: false, error: `coordinate and ref are mutually exclusive for action "${action}"; pass only one of them` };
  }
  if (hasRef) {
    const ref = parseRef(args.ref, action);
    return ref.ok ? { ok: true, value: { ref: ref.value } } : ref;
  }
  if (!hasCoordinate) {
    return {
      ok: false,
      error: `Action "${action}" needs a target: coordinate ([x, y] in the last screenshot frame) or ref (ref_12 from read_page or find)`,
    };
  }
  const coordinate = parseCoordinate(args.coordinate, 'coordinate', action);
  return coordinate.ok ? { ok: true, value: { coordinate: coordinate.value } } : coordinate;
}

function parseModifierText(value: unknown): ParseResult<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'string') return { ok: false, error: `modifiers must be a string, received ${describe(value)}` };
  const parsed = parseModifiers(value);
  if (!parsed.ok) return { ok: false, error: `modifiers: ${parsed.error}; use names like "ctrl+shift"` };
  return { ok: true, value };
}

function parseDirection(value: unknown): ParseResult<ScrollDirection> {
  const choices = SCROLL_DIRECTIONS.join(', ');
  if (value === undefined) {
    return { ok: false, error: `Missing required parameter scroll_direction (one of: ${choices}) for action "scroll"` };
  }
  const direction = SCROLL_DIRECTIONS.find((item) => item === value);
  if (direction === undefined) {
    const shown = typeof value === 'string' ? echoKey(value) : describe(value);
    return { ok: false, error: `scroll_direction must be one of: ${choices}, received ${shown}` };
  }
  return { ok: true, value: direction };
}

function parseAmount(value: unknown): ParseResult<number> {
  if (value === undefined) return { ok: true, value: DEFAULT_SCROLL_AMOUNT };
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_SCROLL_AMOUNT) {
    return { ok: false, error: `scroll_amount must be an integer between 1 and ${MAX_SCROLL_AMOUNT}, received ${describe(value)}` };
  }
  return { ok: true, value };
}

function parseDuration(value: unknown): ParseResult<number> {
  if (value === undefined) {
    return { ok: false, error: `Missing required parameter duration (seconds, up to ${MAX_WAIT_SECONDS}) for action "wait"` };
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, error: `duration must be a finite number of seconds, received ${describe(value)}` };
  }
  if (value <= 0 || value > MAX_WAIT_SECONDS) {
    return { ok: false, error: `duration must be greater than 0 and at most ${MAX_WAIT_SECONDS} seconds, received ${value}` };
  }
  return { ok: true, value };
}

function withTabId<T extends { tabId?: number }>(args: Record<string, unknown>, value: T): ParseResult<T> {
  const tabId = parseOptionalTabId(args.tabId);
  if (!tabId.ok) return tabId;
  if (tabId.value !== undefined) value.tabId = tabId.value;
  return { ok: true, value };
}

function parseClickArgs(args: Record<string, unknown>, action: ClickAction): ParseResult<ClickArgs> {
  const target = parseTarget(args, action);
  if (!target.ok) return target;
  const modifiers = parseModifierText(args.modifiers);
  if (!modifiers.ok) return modifiers;
  const value: ClickArgs = { action, target: target.value };
  if (modifiers.value !== undefined) value.modifiers = modifiers.value;
  return withTabId(args, value);
}

function parseHoverArgs(args: Record<string, unknown>): ParseResult<HoverArgs> {
  const target = parseTarget(args, 'hover');
  if (!target.ok) return target;
  return withTabId<HoverArgs>(args, { action: 'hover', target: target.value });
}

function parseDragArgs(args: Record<string, unknown>): ParseResult<DragArgs> {
  const start = parseCoordinate(args.start_coordinate, 'start_coordinate', 'left_click_drag');
  if (!start.ok) return start;
  const end = parseCoordinate(args.coordinate, 'coordinate', 'left_click_drag');
  if (!end.ok) return end;
  return withTabId<DragArgs>(args, { action: 'left_click_drag', start: start.value, end: end.value });
}

function parseScrollArgs(args: Record<string, unknown>): ParseResult<ScrollArgs> {
  const coordinate = parseCoordinate(args.coordinate, 'coordinate', 'scroll');
  if (!coordinate.ok) return coordinate;
  const direction = parseDirection(args.scroll_direction);
  if (!direction.ok) return direction;
  const amount = parseAmount(args.scroll_amount);
  if (!amount.ok) return amount;
  return withTabId<ScrollArgs>(args, { action: 'scroll', coordinate: coordinate.value, direction: direction.value, amount: amount.value });
}

function parseScrollToArgs(args: Record<string, unknown>): ParseResult<ScrollToArgs> {
  const ref = parseRef(args.ref, 'scroll_to');
  if (!ref.ok) return ref;
  return withTabId<ScrollToArgs>(args, { action: 'scroll_to', ref: ref.value });
}

// tabId is accepted for symmetry with the other actions; waiting touches no tab.
function parseWaitArgs(args: Record<string, unknown>): ParseResult<WaitArgs> {
  const duration = parseDuration(args.duration);
  if (!duration.ok) return duration;
  const tabId = parseOptionalTabId(args.tabId);
  if (!tabId.ok) return tabId;
  return { ok: true, value: { action: 'wait', duration: duration.value } };
}

const ACTION_PARSERS: Record<ComputerAction, (args: Record<string, unknown>) => ParseResult<ComputerArgs>> = {
  screenshot: parseScreenshotArgs,
  zoom: parseZoomArgs,
  left_click: (args) => parseClickArgs(args, 'left_click'),
  right_click: (args) => parseClickArgs(args, 'right_click'),
  double_click: (args) => parseClickArgs(args, 'double_click'),
  triple_click: (args) => parseClickArgs(args, 'triple_click'),
  hover: parseHoverArgs,
  left_click_drag: parseDragArgs,
  scroll: parseScrollArgs,
  scroll_to: parseScrollToArgs,
  wait: parseWaitArgs,
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
