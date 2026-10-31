import type { Point } from './coordinate-frame';
import { type KeyChord, parseKeyText, parseModifiers, typedKeyValues } from './input-keys';
import type { ParseResult } from './navigation-input';

export const MAX_KEY_REPEAT = 100;
export const MAX_CLICK_COUNT = 3;
export const DRAG_STEPS = 5;
export const DRAG_STEP_DURATION_MS = 50;
export const SCROLL_TICK_PX = 100;
export const DEFAULT_SCROLL_AMOUNT = 3;
export const MAX_SCROLL_AMOUNT = 10;

const POINTER_SOURCE_ID = 'mouse';
const KEY_SOURCE_ID = 'keyboard';
const WHEEL_SOURCE_ID = 'wheel';

export type MouseButton = 'left' | 'right';
export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

export interface PauseAction {
  type: 'pause';
  duration?: number;
}

export type PointerAction =
  | PauseAction
  | { type: 'pointerMove'; x: number; y: number; origin: 'viewport'; duration: number }
  | { type: 'pointerDown'; button: number }
  | { type: 'pointerUp'; button: number };

export type KeyAction = PauseAction | { type: 'keyDown'; value: string } | { type: 'keyUp'; value: string };

export type WheelAction =
  | PauseAction
  | { type: 'scroll'; x: number; y: number; deltaX: number; deltaY: number; origin: 'viewport'; duration: number };

export interface PointerSource {
  type: 'pointer';
  id: string;
  parameters: { pointerType: 'mouse' };
  actions: PointerAction[];
}

export interface KeySource {
  type: 'key';
  id: string;
  actions: KeyAction[];
}

export interface WheelSource {
  type: 'wheel';
  id: string;
  actions: WheelAction[];
}

export type InputSource = PointerSource | KeySource | WheelSource;

export interface ClickOptions {
  point: Point;
  button?: MouseButton;
  clickCount?: number;
  modifiers?: string;
}

export interface ScrollOptions {
  point: Point;
  direction: ScrollDirection;
  amount?: number;
}

const BUTTONS: Readonly<Record<MouseButton, number>> = { left: 0, right: 2 };

const SCROLL_VECTORS: Readonly<Record<ScrollDirection, Point>> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const PAUSE: PauseAction = { type: 'pause' };

function pointerSource(actions: PointerAction[]): PointerSource {
  return { type: 'pointer', id: POINTER_SOURCE_ID, parameters: { pointerType: 'mouse' }, actions };
}

function keySource(actions: KeyAction[]): KeySource {
  return { type: 'key', id: KEY_SOURCE_ID, actions };
}

function pauses(count: number): PauseAction[] {
  return Array.from({ length: count }, () => ({ ...PAUSE }));
}

function checkInteger(value: number, name: string, max: number): ParseResult<number> {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    return { ok: false, error: `${name} must be an integer between 1 and ${max}, received ${value}` };
  }
  return { ok: true, value };
}

function roundPoint(point: Point): ParseResult<Point> {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return { ok: false, error: `coordinate must be finite, received (${point.x}, ${point.y})` };
  }
  return { ok: true, value: { x: Math.round(point.x), y: Math.round(point.y) } };
}

function moveTo(point: Point, duration = 0): PointerAction {
  return { type: 'pointerMove', x: point.x, y: point.y, origin: 'viewport', duration };
}

function pressAndRelease(value: string): KeyAction[] {
  return [
    { type: 'keyDown', value },
    { type: 'keyUp', value },
  ];
}

function pressAll(modifiers: readonly string[]): KeyAction[] {
  return modifiers.map((value) => ({ type: 'keyDown', value }));
}

function releaseAll(modifiers: readonly string[]): KeyAction[] {
  return [...modifiers].reverse().map((value) => ({ type: 'keyUp', value }));
}

function chordActions({ modifiers, key }: KeyChord): KeyAction[] {
  return [...pressAll(modifiers), ...pressAndRelease(key), ...releaseAll(modifiers)];
}

export function keyActions(text: string, repeat = 1): ParseResult<InputSource[]> {
  const count = checkInteger(repeat, 'repeat', MAX_KEY_REPEAT);
  if (!count.ok) return count;
  const chords = parseKeyText(text);
  if (!chords.ok) return chords;
  const sequence = chords.value.flatMap(chordActions);
  const actions = Array.from({ length: count.value }, () => sequence).flat();
  return { ok: true, value: [keySource(actions)] };
}

export function typeActions(text: string): InputSource[] {
  return [keySource(typedKeyValues(text).flatMap(pressAndRelease))];
}

export function clickActions({ point, button = 'left', clickCount = 1, modifiers = '' }: ClickOptions): ParseResult<
  InputSource[]
> {
  const target = roundPoint(point);
  if (!target.ok) return target;
  const count = checkInteger(clickCount, 'clickCount', MAX_CLICK_COUNT);
  if (!count.ok) return count;
  const held = parseModifiers(modifiers);
  if (!held.ok) return held;
  const buttonId = BUTTONS[button];
  const clicks = Array.from({ length: count.value }, (): PointerAction[] => [
    { type: 'pointerDown', button: buttonId },
    { type: 'pointerUp', button: buttonId },
  ]).flat();
  const pointer = [moveTo(target.value), ...clicks];
  if (held.value.length === 0) return { ok: true, value: [pointerSource(pointer)] };
  const modifierTicks = held.value.length;
  return {
    ok: true,
    value: [
      keySource([...pressAll(held.value), ...pauses(pointer.length), ...releaseAll(held.value)]),
      pointerSource([...pauses(modifierTicks), ...pointer, ...pauses(modifierTicks)]),
    ],
  };
}

export function hoverActions(point: Point): ParseResult<InputSource[]> {
  const target = roundPoint(point);
  if (!target.ok) return target;
  return { ok: true, value: [pointerSource([moveTo(target.value)])] };
}

export function dragActions(start: Point, end: Point): ParseResult<InputSource[]> {
  const from = roundPoint(start);
  if (!from.ok) return from;
  const to = roundPoint(end);
  if (!to.ok) return to;
  const steps = Array.from({ length: DRAG_STEPS }, (_, i) => {
    const fraction = (i + 1) / DRAG_STEPS;
    const point = {
      x: Math.round(from.value.x + (to.value.x - from.value.x) * fraction),
      y: Math.round(from.value.y + (to.value.y - from.value.y) * fraction),
    };
    return moveTo(point, DRAG_STEP_DURATION_MS);
  });
  return {
    ok: true,
    value: [
      pointerSource([
        moveTo(from.value),
        { type: 'pointerDown', button: BUTTONS.left },
        ...steps,
        { type: 'pointerUp', button: BUTTONS.left },
      ]),
    ],
  };
}

export function scrollActions({ point, direction, amount = DEFAULT_SCROLL_AMOUNT }: ScrollOptions): ParseResult<
  InputSource[]
> {
  const target = roundPoint(point);
  if (!target.ok) return target;
  const ticks = checkInteger(amount, 'scroll amount', MAX_SCROLL_AMOUNT);
  if (!ticks.ok) return ticks;
  const vector = SCROLL_VECTORS[direction];
  const distance = ticks.value * SCROLL_TICK_PX;
  return {
    ok: true,
    value: [
      {
        type: 'wheel',
        id: WHEEL_SOURCE_ID,
        actions: [
          {
            type: 'scroll',
            x: target.value.x,
            y: target.value.y,
            deltaX: vector.x * distance,
            deltaY: vector.y * distance,
            origin: 'viewport',
            duration: 0,
          },
        ],
      },
    ],
  };
}
