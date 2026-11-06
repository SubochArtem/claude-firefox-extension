import { describe, expect, it } from 'vitest';
import { MAX_WINDOW_HEIGHT, MAX_WINDOW_WIDTH, parseResizeWindowArgs } from '../tools/resize-window-input';

function error(args: unknown): string {
  const result = parseResizeWindowArgs(args);
  if (result.ok) throw new Error(`expected an error for ${JSON.stringify(args)}`);
  return result.error;
}

describe('parseResizeWindowArgs', () => {
  it('accepts a width and height and an optional tabId', () => {
    expect(parseResizeWindowArgs({ width: 1280, height: 720 })).toEqual({ ok: true, value: { width: 1280, height: 720 } });
    expect(parseResizeWindowArgs({ width: 800, height: 600, tabId: 4 })).toEqual({
      ok: true,
      value: { width: 800, height: 600, tabId: 4 },
    });
    expect(parseResizeWindowArgs({ width: 800, height: 600, tabId: undefined })).toEqual({
      ok: true,
      value: { width: 800, height: 600 },
    });
  });

  it('floors fractional sizes', () => {
    expect(parseResizeWindowArgs({ width: 1024.9, height: 1.5 })).toEqual({ ok: true, value: { width: 1024, height: 1 } });
  });

  it('accepts the maximum size', () => {
    expect(MAX_WINDOW_WIDTH).toBe(7680);
    expect(MAX_WINDOW_HEIGHT).toBe(4320);
    expect(parseResizeWindowArgs({ width: 7680, height: 4320 })).toEqual({ ok: true, value: { width: 7680, height: 4320 } });
  });

  it.each([
    [{ height: 600 }, 'Missing required parameter width (number)'],
    [{ width: 800 }, 'Missing required parameter height (number)'],
  ])('requires both sizes (%j)', (args, message) => {
    expect(error(args)).toBe(message);
  });

  it.each(['800', null, true, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('rejects width %j', (width) => {
    expect(error({ width, height: 600 })).toMatch(/^width must be a finite number, received /);
  });

  it.each([0, -5, 0.5])('rejects width %j below 1', (width) => {
    expect(error({ width, height: 600 })).toBe(`width must be at least 1, received ${width}`);
  });

  it.each([0, -1])('rejects height %j below 1', (height) => {
    expect(error({ width: 800, height })).toBe(`height must be at least 1, received ${height}`);
  });

  it('rejects sizes above the maximum', () => {
    expect(error({ width: 7681, height: 600 })).toBe('width must be at most 7680, received 7681');
    expect(error({ width: 800, height: 4320.5 })).toBe('height must be at most 4320, received 4320.5');
  });

  it.each([0, -1, 1.5, '5', null])('rejects tabId %j', (tabId) => {
    expect(error({ width: 800, height: 600, tabId })).toMatch(/tabId/);
  });

  it('rejects unknown parameters', () => {
    expect(error({ width: 800, height: 600, windowId: 1 })).toBe('Unknown parameter "windowId"; allowed: width, height, tabId');
  });

  it.each([undefined, 'big', [800, 600]])('rejects a non-object %j', (args) => {
    expect(error(args)).toMatch(/^Expected an object with width and height parameters/);
  });
});
