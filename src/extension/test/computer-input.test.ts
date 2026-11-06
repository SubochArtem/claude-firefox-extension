import { describe, expect, it } from 'vitest';
import { CLICK_ACTIONS, COMPUTER_ACTIONS, parseComputerArgs, SCROLL_DIRECTIONS } from '../tools/computer-input';

describe('parseComputerArgs', () => {
  it('lists the supported actions', () => {
    expect(COMPUTER_ACTIONS).toEqual([
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
      'type',
      'key',
      'wait',
    ]);
  });

  it('parses a bare screenshot', () => {
    expect(parseComputerArgs({ action: 'screenshot' })).toEqual({ ok: true, value: { action: 'screenshot' } });
  });

  it('parses tabId and scale', () => {
    expect(parseComputerArgs({ action: 'screenshot', tabId: 4, scale: 0.5 })).toEqual({
      ok: true,
      value: { action: 'screenshot', tabId: 4, scale: 0.5 },
    });
  });

  it.each([0.1, 1, 0.75])('accepts scale %s', (scale) => {
    expect(parseComputerArgs({ action: 'screenshot', scale })).toEqual({ ok: true, value: { action: 'screenshot', scale } });
  });

  it.each([
    [0.09, 'scale must be between 0.1 and 1, received 0.09'],
    [0, 'scale must be between 0.1 and 1, received 0'],
    [1.01, 'scale must be between 0.1 and 1, received 1.01'],
    [-1, 'scale must be between 0.1 and 1, received -1'],
    [Number.NaN, 'scale must be a finite number, received NaN'],
    [Number.POSITIVE_INFINITY, 'scale must be a finite number, received Infinity'],
    ['0.5', 'scale must be a finite number, received "0.5"'],
    [null, 'scale must be a finite number, received null'],
  ])('rejects scale %s', (scale, error) => {
    expect(parseComputerArgs({ action: 'screenshot', scale })).toEqual({ ok: false, error });
  });

  it.each([
    [0, 'tabId must be a positive safe integer, received 0'],
    [-3, 'tabId must be a positive safe integer, received -3'],
    [1.5, 'tabId must be an integer, received 1.5'],
    ['4', 'tabId must be an integer, received "4"'],
  ])('rejects tabId %s', (tabId, error) => {
    expect(parseComputerArgs({ action: 'screenshot', tabId })).toEqual({ ok: false, error });
  });

  it('requires action', () => {
    expect(parseComputerArgs({})).toEqual({
      ok: false,
      error: `Missing required parameter action (one of: ${COMPUTER_ACTIONS.join(', ')})`,
    });
  });

  it.each([
    [5, 'action must be a string, received 5'],
    [['screenshot'], 'action must be a string, received array'],
  ])('rejects a non-string action %s', (action, error) => {
    expect(parseComputerArgs({ action })).toEqual({ ok: false, error });
  });

  it.each(['click', 'Screenshot', '', 'toString', '__proto__'])('rejects unknown action %j', (action) => {
    expect(parseComputerArgs({ action })).toEqual({
      ok: false,
      error: `Unknown action ${JSON.stringify(action)}; supported actions: ${COMPUTER_ACTIONS.join(', ')}`,
    });
  });

  it('rejects unknown parameters', () => {
    expect(parseComputerArgs({ action: 'screenshot', coordinate: [1, 2] })).toEqual({
      ok: false,
      error: 'Unknown parameter "coordinate" for action "screenshot"; allowed: action, tabId, scale',
    });
  });

  it('allows region only for zoom', () => {
    expect(parseComputerArgs({ action: 'screenshot', region: [0, 0, 10, 10] })).toEqual({
      ok: false,
      error: 'Unknown parameter "region" for action "screenshot"; allowed: action, tabId, scale',
    });
  });

  it('escapes and caps unknown parameter names', () => {
    const result = parseComputerArgs({ action: 'screenshot', ['a\nb' + 'x'.repeat(300)]: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('"a\\nb');
    expect(result.error).not.toContain('\n');
    expect(result.error.length).toBeLessThan(300);
  });

  it('ignores parameters explicitly set to undefined', () => {
    expect(parseComputerArgs({ action: 'screenshot', tabId: undefined, scale: undefined })).toEqual({
      ok: true,
      value: { action: 'screenshot' },
    });
  });

  it.each([undefined, null, 'screenshot', ['screenshot']])('rejects arguments %j', (args) => {
    expect(parseComputerArgs(args)).toEqual({ ok: false, error: expect.stringContaining('Expected an object') });
  });
});

describe('parseComputerArgs zoom', () => {
  it('parses a zoom with region, tabId and scale', () => {
    expect(parseComputerArgs({ action: 'zoom', region: [10, 20, 110.5, 220], tabId: 4, scale: 0.5 })).toEqual({
      ok: true,
      value: { action: 'zoom', region: [10, 20, 110.5, 220], tabId: 4, scale: 0.5 },
    });
  });

  it('parses a zoom with only a region', () => {
    expect(parseComputerArgs({ action: 'zoom', region: [0, 0, 1, 1] })).toEqual({
      ok: true,
      value: { action: 'zoom', region: [0, 0, 1, 1] },
    });
  });

  it('requires region', () => {
    expect(parseComputerArgs({ action: 'zoom' })).toEqual({
      ok: false,
      error: 'Missing required parameter region ([x0, y0, x1, y1]) for action "zoom"',
    });
  });

  it.each([
    ['[1, 2, 3, 4]', 'region must be an array of 4 numbers [x0, y0, x1, y1], received "[1, 2, 3, 4]"'],
    [{ x0: 1 }, 'region must be an array of 4 numbers [x0, y0, x1, y1], received object'],
    [[1, 2, 3], 'region must be an array of 4 numbers [x0, y0, x1, y1], received 3 elements'],
    [[1, 2, 3, 4, 5], 'region must be an array of 4 numbers [x0, y0, x1, y1], received 5 elements'],
    [[0, 0, '10', 10], 'region[2] must be a finite number, received "10"'],
    [[0, Number.NaN, 10, 10], 'region[1] must be a finite number, received NaN'],
    [[0, 0, 10, Number.POSITIVE_INFINITY], 'region[3] must be a finite number, received Infinity'],
    [[-1, 0, 10, 10], 'region x0 and y0 must not be negative, received [-1, 0, 10, 10]'],
    [[0, -0.5, 10, 10], 'region x0 and y0 must not be negative, received [0, -0.5, 10, 10]'],
    [[10, 0, 10, 10], 'region x1 must be greater than x0, received [10, 0, 10, 10]'],
    [[10, 0, 5, 10], 'region x1 must be greater than x0, received [10, 0, 5, 10]'],
    [[0, 10, 10, 10], 'region y1 must be greater than y0, received [0, 10, 10, 10]'],
  ])('rejects region %j', (region, error) => {
    expect(parseComputerArgs({ action: 'zoom', region })).toEqual({ ok: false, error });
  });

  it('validates scale and tabId like screenshot', () => {
    expect(parseComputerArgs({ action: 'zoom', region: [0, 0, 1, 1], scale: 2 })).toEqual({
      ok: false,
      error: 'scale must be between 0.1 and 1, received 2',
    });
    expect(parseComputerArgs({ action: 'zoom', region: [0, 0, 1, 1], tabId: 0 })).toEqual({
      ok: false,
      error: 'tabId must be a positive safe integer, received 0',
    });
  });

  it('rejects unknown parameters', () => {
    expect(parseComputerArgs({ action: 'zoom', region: [0, 0, 1, 1], coordinate: [1, 2] })).toEqual({
      ok: false,
      error: 'Unknown parameter "coordinate" for action "zoom"; allowed: action, tabId, region, scale',
    });
  });
});

describe.each(CLICK_ACTIONS)('parseComputerArgs %s', (action) => {
  it('parses a coordinate target with modifiers and tabId', () => {
    expect(parseComputerArgs({ action, coordinate: [10, 20.5], modifiers: 'ctrl+shift', tabId: 4 })).toEqual({
      ok: true,
      value: { action, target: { coordinate: [10, 20.5] }, modifiers: 'ctrl+shift', tabId: 4 },
    });
  });

  it('parses a ref target', () => {
    expect(parseComputerArgs({ action, ref: 'ref_12' })).toEqual({ ok: true, value: { action, target: { ref: 'ref_12' } } });
  });

  it('refuses coordinate and ref together', () => {
    expect(parseComputerArgs({ action, coordinate: [1, 2], ref: 'ref_1' })).toEqual({
      ok: false,
      error: `coordinate and ref are mutually exclusive for action "${action}"; pass only one of them`,
    });
  });

  it('requires a target', () => {
    expect(parseComputerArgs({ action })).toEqual({
      ok: false,
      error: `Action "${action}" needs a target: coordinate ([x, y] in the last screenshot frame) or ref (ref_12 from read_page or find)`,
    });
  });

  it.each([
    [{ coordinate: [1] }, 'coordinate must be an array of 2 numbers [x, y], received 1 elements'],
    [{ coordinate: [1, 2, 3] }, 'coordinate must be an array of 2 numbers [x, y], received 3 elements'],
    [{ coordinate: '1,2' }, 'coordinate must be an array of 2 numbers [x, y], received "1,2"'],
    [{ coordinate: [1, '2'] }, 'coordinate[1] must be a finite number, received "2"'],
    [{ coordinate: [Number.NaN, 2] }, 'coordinate[0] must be a finite number, received NaN'],
    [{ ref: 'button' }, 'ref must look like ref_12 (from read_page or find), received "button"'],
    [{ ref: 12 }, 'ref must be a string, received 12'],
    [{ coordinate: [1, 2], modifiers: 'hyper' }, 'modifiers: Unknown modifier "hyper" in "hyper"; use names like "ctrl+shift"'],
    [{ coordinate: [1, 2], modifiers: 3 }, 'modifiers must be a string, received 3'],
    [{ coordinate: [1, 2], tabId: 0 }, 'tabId must be a positive safe integer, received 0'],
  ])('rejects %j', (args, error) => {
    expect(parseComputerArgs({ action, ...args })).toEqual({ ok: false, error });
  });

  it('rejects parameters of other actions', () => {
    expect(parseComputerArgs({ action, coordinate: [1, 2], scroll_amount: 3 })).toEqual({
      ok: false,
      error: `Unknown parameter "scroll_amount" for action "${action}"; allowed: action, tabId, coordinate, ref, modifiers`,
    });
  });
});

describe('parseComputerArgs hover', () => {
  it('parses a coordinate or a ref target', () => {
    expect(parseComputerArgs({ action: 'hover', coordinate: [3, 4] })).toEqual({
      ok: true,
      value: { action: 'hover', target: { coordinate: [3, 4] } },
    });
    expect(parseComputerArgs({ action: 'hover', ref: 'ref_2', tabId: 7 })).toEqual({
      ok: true,
      value: { action: 'hover', target: { ref: 'ref_2' }, tabId: 7 },
    });
  });

  it('refuses coordinate and ref together and requires one', () => {
    expect(parseComputerArgs({ action: 'hover', coordinate: [1, 2], ref: 'ref_1' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('mutually exclusive'),
    });
    expect(parseComputerArgs({ action: 'hover' })).toMatchObject({ ok: false, error: expect.stringContaining('needs a target') });
  });

  it('takes no modifiers', () => {
    expect(parseComputerArgs({ action: 'hover', coordinate: [1, 2], modifiers: 'ctrl' })).toEqual({
      ok: false,
      error: 'Unknown parameter "modifiers" for action "hover"; allowed: action, tabId, coordinate, ref',
    });
  });
});

describe('parseComputerArgs left_click_drag', () => {
  it('parses start and end coordinates', () => {
    expect(parseComputerArgs({ action: 'left_click_drag', start_coordinate: [1, 2], coordinate: [30, 40], tabId: 3 })).toEqual({
      ok: true,
      value: { action: 'left_click_drag', start: [1, 2], end: [30, 40], tabId: 3 },
    });
  });

  it('requires both coordinates', () => {
    expect(parseComputerArgs({ action: 'left_click_drag', coordinate: [1, 2] })).toEqual({
      ok: false,
      error: 'Missing required parameter start_coordinate ([x, y] in the last screenshot frame) for action "left_click_drag"',
    });
    expect(parseComputerArgs({ action: 'left_click_drag', start_coordinate: [1, 2] })).toEqual({
      ok: false,
      error: 'Missing required parameter coordinate ([x, y] in the last screenshot frame) for action "left_click_drag"',
    });
  });

  it('takes no ref', () => {
    expect(parseComputerArgs({ action: 'left_click_drag', start_coordinate: [1, 2], coordinate: [3, 4], ref: 'ref_1' })).toEqual({
      ok: false,
      error: 'Unknown parameter "ref" for action "left_click_drag"; allowed: action, tabId, start_coordinate, coordinate',
    });
  });
});

describe('parseComputerArgs scroll', () => {
  it('parses a scroll with the default amount', () => {
    expect(parseComputerArgs({ action: 'scroll', coordinate: [5, 6], scroll_direction: 'down' })).toEqual({
      ok: true,
      value: { action: 'scroll', coordinate: [5, 6], direction: 'down', amount: 3 },
    });
  });

  it.each(SCROLL_DIRECTIONS)('accepts direction %s', (direction) => {
    expect(parseComputerArgs({ action: 'scroll', coordinate: [5, 6], scroll_direction: direction, scroll_amount: 10, tabId: 2 })).toEqual({
      ok: true,
      value: { action: 'scroll', coordinate: [5, 6], direction, amount: 10, tabId: 2 },
    });
  });

  it.each([
    [{ scroll_direction: 'down' }, 'Missing required parameter coordinate ([x, y] in the last screenshot frame) for action "scroll"'],
    [{ coordinate: [1, 2] }, 'Missing required parameter scroll_direction (one of: up, down, left, right) for action "scroll"'],
    [{ coordinate: [1, 2], scroll_direction: 'sideways' }, 'scroll_direction must be one of: up, down, left, right, received "sideways"'],
    [{ coordinate: [1, 2], scroll_direction: 1 }, 'scroll_direction must be one of: up, down, left, right, received 1'],
    [{ coordinate: [1, 2], scroll_direction: 'up', scroll_amount: 0 }, 'scroll_amount must be an integer between 1 and 10, received 0'],
    [{ coordinate: [1, 2], scroll_direction: 'up', scroll_amount: 11 }, 'scroll_amount must be an integer between 1 and 10, received 11'],
    [{ coordinate: [1, 2], scroll_direction: 'up', scroll_amount: 1.5 }, 'scroll_amount must be an integer between 1 and 10, received 1.5'],
    [{ coordinate: [1, 2], scroll_direction: 'up', scroll_amount: '3' }, 'scroll_amount must be an integer between 1 and 10, received "3"'],
  ])('rejects %j', (args, error) => {
    expect(parseComputerArgs({ action: 'scroll', ...args })).toEqual({ ok: false, error });
  });

  it('takes no ref', () => {
    expect(parseComputerArgs({ action: 'scroll', ref: 'ref_1', scroll_direction: 'up' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^Unknown parameter "ref" for action "scroll"/),
    });
  });
});

describe('parseComputerArgs scroll_to', () => {
  it('parses a ref', () => {
    expect(parseComputerArgs({ action: 'scroll_to', ref: 'ref_9', tabId: 1 })).toEqual({
      ok: true,
      value: { action: 'scroll_to', ref: 'ref_9', tabId: 1 },
    });
  });

  it('requires a ref and takes no coordinate', () => {
    expect(parseComputerArgs({ action: 'scroll_to' })).toEqual({
      ok: false,
      error: 'Missing required parameter ref (an element reference like ref_12 from read_page or find) for action "scroll_to"',
    });
    expect(parseComputerArgs({ action: 'scroll_to', coordinate: [1, 2] })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^Unknown parameter "coordinate" for action "scroll_to"/),
    });
  });
});

describe('parseComputerArgs wait', () => {
  it.each([0.5, 1, 10])('accepts duration %s', (duration) => {
    expect(parseComputerArgs({ action: 'wait', duration })).toEqual({ ok: true, value: { action: 'wait', duration } });
  });

  it('accepts and ignores a tabId', () => {
    expect(parseComputerArgs({ action: 'wait', duration: 1, tabId: 3 })).toEqual({ ok: true, value: { action: 'wait', duration: 1 } });
  });

  it.each([
    [undefined, 'Missing required parameter duration (seconds, up to 10) for action "wait"'],
    [0, 'duration must be greater than 0 and at most 10 seconds, received 0'],
    [-1, 'duration must be greater than 0 and at most 10 seconds, received -1'],
    [10.5, 'duration must be greater than 0 and at most 10 seconds, received 10.5'],
    ['2', 'duration must be a finite number of seconds, received "2"'],
    [Number.POSITIVE_INFINITY, 'duration must be a finite number of seconds, received Infinity'],
  ])('rejects duration %s', (duration, error) => {
    expect(parseComputerArgs({ action: 'wait', duration })).toEqual({ ok: false, error });
  });
});

describe('parseComputerArgs type', () => {
  it('parses text and tabId', () => {
    expect(parseComputerArgs({ action: 'type', text: 'hello world', tabId: 2 })).toEqual({
      ok: true,
      value: { action: 'type', text: 'hello world', tabId: 2 },
    });
  });

  it('keeps whitespace and line breaks in the text', () => {
    expect(parseComputerArgs({ action: 'type', text: ' a\nb ' })).toEqual({ ok: true, value: { action: 'type', text: ' a\nb ' } });
  });

  it.each([
    [undefined, 'Missing required parameter text (the text to type) for action "type"'],
    ['', 'text must not be empty for action "type"'],
    [5, 'text must be a string, received 5'],
    [['a'], 'text must be a string, received array'],
  ])('rejects text %j', (text, error) => {
    expect(parseComputerArgs({ action: 'type', text })).toEqual({ ok: false, error });
  });

  it('takes no repeat or coordinate', () => {
    expect(parseComputerArgs({ action: 'type', text: 'a', repeat: 2 })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^Unknown parameter "repeat" for action "type"; allowed: action, tabId, text$/),
    });
    expect(parseComputerArgs({ action: 'type', text: 'a', coordinate: [1, 2] })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^Unknown parameter "coordinate" for action "type"/),
    });
  });
});

describe('parseComputerArgs key', () => {
  it('parses keys with the default repeat', () => {
    expect(parseComputerArgs({ action: 'key', text: 'ctrl+a Enter' })).toEqual({
      ok: true,
      value: { action: 'key', text: 'ctrl+a Enter', repeat: 1 },
    });
  });

  it('parses repeat and tabId', () => {
    expect(parseComputerArgs({ action: 'key', text: 'Down', repeat: 100, tabId: 3 })).toEqual({
      ok: true,
      value: { action: 'key', text: 'Down', repeat: 100, tabId: 3 },
    });
  });

  it.each([
    [undefined, 'Missing required parameter text (space-separated keys or chords like "ctrl+a Enter") for action "key"'],
    ['', 'text must name at least one key for action "key", e.g. "Enter" or "ctrl+a"'],
    ['   ', 'text must name at least one key for action "key", e.g. "Enter" or "ctrl+a"'],
    [true, 'text must be a string, received true'],
  ])('rejects text %j', (text, error) => {
    expect(parseComputerArgs({ action: 'key', text })).toEqual({ ok: false, error });
  });

  it.each([0, 101, 1.5, -1, '2', null])('rejects repeat %j', (repeat) => {
    expect(parseComputerArgs({ action: 'key', text: 'a', repeat })).toEqual({
      ok: false,
      error: expect.stringMatching(/^repeat must be an integer between 1 and 100, received /),
    });
  });

  it('takes no modifiers', () => {
    expect(parseComputerArgs({ action: 'key', text: 'a', modifiers: 'ctrl' })).toMatchObject({
      ok: false,
      error: 'Unknown parameter "modifiers" for action "key"; allowed: action, tabId, text, repeat',
    });
  });
});
