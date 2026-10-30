import { describe, expect, it } from 'vitest';
import { COMPUTER_ACTIONS, parseComputerArgs } from '../tools/computer-input';

describe('parseComputerArgs', () => {
  it('lists the supported actions', () => {
    expect(COMPUTER_ACTIONS).toEqual(['screenshot', 'zoom']);
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
      error: 'Missing required parameter action (one of: screenshot, zoom)',
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
      error: `Unknown action ${JSON.stringify(action)}; supported actions: screenshot, zoom`,
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
