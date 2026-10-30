import { describe, expect, it } from 'vitest';
import { CoordinateFrames, FRAME_TOLERANCE_PX } from '../tools/coordinate-frame';
import { ToolError } from '../tools/tool-error';

function store(): CoordinateFrames {
  const frames = new CoordinateFrames();
  frames.record(5, { width: 1920, height: 1080 }, { width: 1456, height: 819 });
  return frames;
}

describe('CoordinateFrames', () => {
  it('returns the recorded frame', () => {
    expect(store().get(5)).toEqual({ viewport: { width: 1920, height: 1080 }, frame: { width: 1456, height: 819 } });
    expect(store().get(6)).toBeUndefined();
  });

  it('maps frame coordinates to viewport CSS coordinates', () => {
    const frames = store();
    expect(frames.toViewport(5, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(frames.toViewport(5, { x: 728, y: 409.5 })).toEqual({ x: 960, y: 540 });
    const mapped = frames.toViewport(5, { x: 100, y: 200 });
    expect(mapped.x).toBeCloseTo((100 * 1920) / 1456, 9);
    expect(mapped.y).toBeCloseTo((200 * 1080) / 819, 9);
  });

  it('maps one to one when the frame equals the viewport', () => {
    const frames = new CoordinateFrames();
    frames.record(1, { width: 800, height: 600 }, { width: 800, height: 600 });
    expect(frames.toViewport(1, { x: 123, y: 456 })).toEqual({ x: 123, y: 456 });
  });

  it('accepts coordinates up to the tolerance beyond the frame and clamps them into the viewport', () => {
    const frames = store();
    expect(FRAME_TOLERANCE_PX).toBe(2);
    expect(frames.toViewport(5, { x: -2, y: -2 })).toEqual({ x: 0, y: 0 });
    expect(frames.toViewport(5, { x: 1458, y: 821 })).toEqual({ x: 1919, y: 1079 });
  });

  it.each([
    [-2.5, 10],
    [10, -3],
    [1458.5, 10],
    [10, 822],
  ])('rejects (%s, %s) outside the frame', (x, y) => {
    const frames = store();
    expect(() => frames.toViewport(5, { x, y })).toThrow(ToolError);
    expect(() => frames.toViewport(5, { x, y })).toThrow(
      `Coordinate (${x}, ${y}) is outside the last screenshot of tab 5 (1456x819); take a new screenshot`,
    );
  });

  it('requires a screenshot of the tab first', () => {
    expect(() => store().toViewport(6, { x: 1, y: 1 })).toThrow(ToolError);
    expect(() => store().toViewport(6, { x: 1, y: 1 })).toThrow(
      'No screenshot of tab 6 has been taken yet; take a screenshot first',
    );
  });

  it('replaces the frame on a new screenshot', () => {
    const frames = store();
    frames.record(5, { width: 800, height: 600 }, { width: 400, height: 300 });
    expect(frames.toViewport(5, { x: 100, y: 100 })).toEqual({ x: 200, y: 200 });
    expect(() => frames.toViewport(5, { x: 1000, y: 100 })).toThrow(ToolError);
  });

  it('forgets a closed tab', () => {
    const frames = store();
    frames.forget(5);
    expect(frames.get(5)).toBeUndefined();
    expect(() => frames.toViewport(5, { x: 1, y: 1 })).toThrow('take a screenshot first');
    frames.forget(5);
  });

  it('keeps tabs separate', () => {
    const frames = store();
    frames.record(7, { width: 100, height: 100 }, { width: 50, height: 50 });
    expect(frames.toViewport(7, { x: 10, y: 20 })).toEqual({ x: 20, y: 40 });
    expect(frames.toViewport(5, { x: 728, y: 409.5 })).toEqual({ x: 960, y: 540 });
    frames.forget(7);
    expect(frames.get(5)).toBeDefined();
  });

  it.each([
    [{ width: 0, height: 10 }, { width: 10, height: 10 }],
    [{ width: 10, height: 10 }, { width: 10, height: -1 }],
    [{ width: Number.NaN, height: 10 }, { width: 10, height: 10 }],
  ])('rejects invalid sizes %o / %o', (viewport, frame) => {
    expect(() => new CoordinateFrames().record(1, viewport, frame)).toThrow(RangeError);
  });

  it('rejects non-finite coordinates', () => {
    expect(() => store().toViewport(5, { x: Number.NaN, y: 1 })).toThrow(ToolError);
  });
});
