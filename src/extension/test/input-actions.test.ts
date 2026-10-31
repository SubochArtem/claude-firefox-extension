import { describe, expect, it } from 'vitest';
import {
  clickActions,
  DRAG_STEP_DURATION_MS,
  DRAG_STEPS,
  dragActions,
  hoverActions,
  keyActions,
  MAX_KEY_REPEAT,
  SCROLL_TICK_PX,
  scrollActions,
  typeActions,
} from '../tools/input-actions';
import { KEY_VALUES } from '../tools/input-keys';

const { CONTROL, SHIFT, META, ENTER, TAB } = KEY_VALUES;

const mouse = (actions: unknown[]) => ({ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions });
const keyboard = (actions: unknown[]) => ({ type: 'key', id: 'keyboard', actions });
const move = (x: number, y: number, duration = 0) => ({ type: 'pointerMove', x, y, origin: 'viewport', duration });
const down = (button = 0) => ({ type: 'pointerDown', button });
const up = (button = 0) => ({ type: 'pointerUp', button });
const keyDown = (value: string) => ({ type: 'keyDown', value });
const keyUp = (value: string) => ({ type: 'keyUp', value });
const pause = { type: 'pause' };

describe('keyActions', () => {
  it('presses and releases a single key', () => {
    expect(keyActions('Enter')).toEqual({ ok: true, value: [keyboard([keyDown(ENTER), keyUp(ENTER)])] });
  });

  it('presses modifiers in order and releases them in reverse around the key', () => {
    expect(keyActions('ctrl+shift+t')).toEqual({
      ok: true,
      value: [keyboard([keyDown(CONTROL), keyDown(SHIFT), keyDown('t'), keyUp('t'), keyUp(SHIFT), keyUp(CONTROL)])],
    });
  });

  it('plays tokens one after another', () => {
    expect(keyActions('a cmd+b')).toEqual({
      ok: true,
      value: [keyboard([keyDown('a'), keyUp('a'), keyDown(META), keyDown('b'), keyUp('b'), keyUp(META)])],
    });
  });

  it('repeats the whole sequence', () => {
    expect(keyActions('a Tab', 3)).toEqual({
      ok: true,
      value: [
        keyboard([
          keyDown('a'),
          keyUp('a'),
          keyDown(TAB),
          keyUp(TAB),
          keyDown('a'),
          keyUp('a'),
          keyDown(TAB),
          keyUp(TAB),
          keyDown('a'),
          keyUp('a'),
          keyDown(TAB),
          keyUp(TAB),
        ]),
      ],
    });
  });

  it('accepts the maximum repeat', () => {
    const result = keyActions('x', MAX_KEY_REPEAT);
    expect(MAX_KEY_REPEAT).toBe(100);
    expect(result.ok && result.value[0]?.actions.length).toBe(200);
  });

  it.each([0, 101, 1.5, -1, Number.NaN])('rejects repeat %s', (repeat) => {
    expect(keyActions('a', repeat)).toEqual({
      ok: false,
      error: `repeat must be an integer between 1 and 100, received ${repeat}`,
    });
  });

  it('passes key parse errors through', () => {
    expect(keyActions('ctrl+nope')).toEqual({ ok: false, error: 'Unknown key "nope" in "ctrl+nope"' });
    expect(keyActions(' ')).toEqual({ ok: false, error: 'key text must not be empty' });
  });
});

describe('typeActions', () => {
  it('types each character with keyDown and keyUp', () => {
    expect(typeActions('aé😀')).toEqual([
      keyboard([keyDown('a'), keyUp('a'), keyDown('é'), keyUp('é'), keyDown('😀'), keyUp('😀')]),
    ]);
  });

  it('turns line breaks into Enter and tabs into Tab', () => {
    expect(typeActions('a\r\nb\tc')).toEqual([
      keyboard([
        keyDown('a'),
        keyUp('a'),
        keyDown(ENTER),
        keyUp(ENTER),
        keyDown('b'),
        keyUp('b'),
        keyDown(TAB),
        keyUp(TAB),
        keyDown('c'),
        keyUp('c'),
      ]),
    ]);
  });

  it('builds an empty key source for empty text', () => {
    expect(typeActions('')).toEqual([keyboard([])]);
  });
});

describe('clickActions', () => {
  it('moves and left-clicks at the rounded point by default', () => {
    expect(clickActions({ point: { x: 10.4, y: 20.6 } })).toEqual({
      ok: true,
      value: [mouse([move(10, 21), down(0), up(0)])],
    });
  });

  it('right-clicks with button 2', () => {
    expect(clickActions({ point: { x: 1, y: 2 }, button: 'right' })).toEqual({
      ok: true,
      value: [mouse([move(1, 2), down(2), up(2)])],
    });
  });

  it('repeats down and up for a triple click', () => {
    expect(clickActions({ point: { x: 5, y: 6 }, clickCount: 3 })).toEqual({
      ok: true,
      value: [mouse([move(5, 6), down(), up(), down(), up(), down(), up()])],
    });
  });

  it('treats empty modifiers as none', () => {
    expect(clickActions({ point: { x: 5, y: 6 }, modifiers: '' })).toEqual({
      ok: true,
      value: [mouse([move(5, 6), down(), up()])],
    });
  });

  it('holds one modifier on the key source for the whole click', () => {
    expect(clickActions({ point: { x: 5, y: 6 }, modifiers: 'cmd' })).toEqual({
      ok: true,
      value: [
        keyboard([keyDown(META), pause, pause, pause, keyUp(META)]),
        mouse([pause, move(5, 6), down(), up(), pause]),
      ],
    });
  });

  it('aligns several modifiers tick by tick with a double click', () => {
    expect(clickActions({ point: { x: 5, y: 6 }, button: 'left', clickCount: 2, modifiers: 'Ctrl+shift' })).toEqual({
      ok: true,
      value: [
        keyboard([
          keyDown(CONTROL),
          keyDown(SHIFT),
          pause,
          pause,
          pause,
          pause,
          pause,
          keyUp(SHIFT),
          keyUp(CONTROL),
        ]),
        mouse([pause, pause, move(5, 6), down(), up(), down(), up(), pause, pause]),
      ],
    });
  });

  it('rejects an unknown modifier', () => {
    expect(clickActions({ point: { x: 5, y: 6 }, modifiers: 'ctrl+hyper' })).toEqual({
      ok: false,
      error: 'Unknown modifier "hyper" in "ctrl+hyper"',
    });
  });

  it.each([0, 4, 1.5, Number.NaN])('rejects clickCount %s', (clickCount) => {
    expect(clickActions({ point: { x: 5, y: 6 }, clickCount })).toEqual({
      ok: false,
      error: `clickCount must be an integer between 1 and 3, received ${clickCount}`,
    });
  });

  it('rejects a non-finite point', () => {
    expect(clickActions({ point: { x: Number.NaN, y: 6 } })).toEqual({
      ok: false,
      error: 'coordinate must be finite, received (NaN, 6)',
    });
  });
});

describe('hoverActions', () => {
  it('only moves the pointer', () => {
    expect(hoverActions({ x: 99.5, y: 0.2 })).toEqual({ ok: true, value: [mouse([move(100, 0)])] });
  });

  it('rejects a non-finite point', () => {
    expect(hoverActions({ x: 1, y: Number.POSITIVE_INFINITY })).toEqual({
      ok: false,
      error: 'coordinate must be finite, received (1, Infinity)',
    });
  });
});

describe('dragActions', () => {
  it('presses at the start, moves in interpolated steps and releases at the end', () => {
    expect(DRAG_STEPS).toBe(5);
    expect(DRAG_STEP_DURATION_MS).toBe(50);
    expect(dragActions({ x: 0, y: 100 }, { x: 101, y: 50 })).toEqual({
      ok: true,
      value: [
        mouse([
          move(0, 100),
          down(0),
          move(20, 90, 50),
          move(40, 80, 50),
          move(61, 70, 50),
          move(81, 60, 50),
          move(101, 50, 50),
          up(0),
        ]),
      ],
    });
  });

  it('rounds the start and end points', () => {
    const result = dragActions({ x: 0.4, y: 0.6 }, { x: 9.6, y: 9.4 });
    expect(result.ok && result.value[0]?.actions.at(0)).toEqual(move(0, 1));
    expect(result.ok && result.value[0]?.actions.at(-2)).toEqual(move(10, 9, 50));
  });

  it('rejects a non-finite point', () => {
    expect(dragActions({ x: 0, y: 0 }, { x: Number.NaN, y: 1 })).toEqual({
      ok: false,
      error: 'coordinate must be finite, received (NaN, 1)',
    });
  });
});

describe('scrollActions', () => {
  const wheel = (deltaX: number, deltaY: number) => ({
    type: 'wheel',
    id: 'wheel',
    actions: [{ type: 'scroll', x: 300, y: 201, deltaX, deltaY, origin: 'viewport', duration: 0 }],
  });

  it('scrolls 3 ticks of 100 px by default', () => {
    expect(SCROLL_TICK_PX).toBe(100);
    expect(scrollActions({ point: { x: 300, y: 200.5 }, direction: 'down' })).toEqual({
      ok: true,
      value: [wheel(0, 300)],
    });
  });

  it.each([
    ['up', 2, 0, -200],
    ['down', 1, 0, 100],
    ['left', 10, -1000, 0],
    ['right', 4, 400, 0],
  ] as const)('scrolls %s by %s ticks', (direction, amount, deltaX, deltaY) => {
    expect(scrollActions({ point: { x: 300, y: 201 }, direction, amount })).toEqual({
      ok: true,
      value: [wheel(deltaX, deltaY)],
    });
  });

  it.each([0, 11, 2.5, Number.NaN])('rejects amount %s', (amount) => {
    expect(scrollActions({ point: { x: 1, y: 1 }, direction: 'up', amount })).toEqual({
      ok: false,
      error: `scroll amount must be an integer between 1 and 10, received ${amount}`,
    });
  });

  it('rejects a non-finite point', () => {
    expect(scrollActions({ point: { x: Number.NaN, y: 1 }, direction: 'up' })).toEqual({
      ok: false,
      error: 'coordinate must be finite, received (NaN, 1)',
    });
  });
});
