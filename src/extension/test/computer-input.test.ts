import { describe, expect, it } from 'vitest';
import { COMPUTER_ACTIONS, parseComputerArgs } from '../tools/computer-input';

describe('parseComputerArgs', () => {
  it('lists the supported actions', () => {
    expect(COMPUTER_ACTIONS).toEqual(['screenshot']);
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
      error: 'Missing required parameter action (one of: screenshot)',
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
      error: `Unknown action ${JSON.stringify(action)}; supported actions: screenshot`,
    });
  });

  it('rejects unknown parameters', () => {
    expect(parseComputerArgs({ action: 'screenshot', coordinate: [1, 2] })).toEqual({
      ok: false,
      error: 'Unknown parameter "coordinate" for action "screenshot"; allowed: action, tabId, scale',
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
