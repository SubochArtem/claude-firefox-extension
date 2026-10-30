import { describe, expect, it } from 'vitest';
import {
  fitFrameSize,
  imageTokens,
  MAX_IMAGE_SIDE,
  MAX_IMAGE_TOKENS,
  screenshotSize,
  type Size,
  zoomOutputSize,
} from '../tools/screenshot-size';

function fits({ width, height }: Size): boolean {
  return width <= MAX_IMAGE_SIDE && height <= MAX_IMAGE_SIDE && imageTokens(width, height) <= MAX_IMAGE_TOKENS;
}

describe('imageTokens', () => {
  it('counts started 28 px tiles on each side', () => {
    expect(imageTokens(28, 28)).toBe(1);
    expect(imageTokens(29, 28)).toBe(2);
    expect(imageTokens(1, 1)).toBe(1);
    expect(imageTokens(1568, 784)).toBe(1568);
  });
});

describe('fitFrameSize', () => {
  it.each([
    [390, 844],
    [1366, 768],
    [1, 1],
    [1092, 1092],
    [1568, 784],
    [784, 1568],
  ])('keeps %ix%i that already fits', (width, height) => {
    expect(fitFrameSize({ width, height })).toEqual({ width, height });
  });

  it.each([
    [1920, 1080, 1456, 819],
    [2560, 1440, 1456, 819],
    [1080, 1920, 819, 1456],
    [3000, 3000, 1092, 1092],
    [1120, 1120, 1092, 1092],
    [1093, 1093, 1092, 1092],
    [1568, 785, 1567, 784],
    [785, 1568, 784, 1567],
    [10000, 50, 1568, 8],
    [50, 10000, 8, 1568],
    [100000, 1, 1568, 1],
    [1, 100000, 1, 1568],
  ])('fits %ix%i into %ix%i', (width, height, fittedWidth, fittedHeight) => {
    expect(fitFrameSize({ width, height })).toEqual({ width: fittedWidth, height: fittedHeight });
  });

  it.each([
    [1920, 1080],
    [1080, 1920],
    [4000, 1000],
    [1000, 4000],
    [2000, 1600],
    [7, 9000],
  ])('returns the largest size for %ix%i that fits', (width, height) => {
    const fitted = fitFrameSize({ width, height });
    expect(fits(fitted)).toBe(true);
    const longIsWidth = width >= height;
    const longer = longIsWidth ? fitted.width + 1 : fitted.height + 1;
    const shorter = Math.max(1, Math.round((longer * Math.min(width, height)) / Math.max(width, height)));
    const next = longIsWidth ? { width: longer, height: shorter } : { width: shorter, height: longer };
    expect(fits(next)).toBe(false);
  });

  it('keeps the aspect ratio', () => {
    const fitted = fitFrameSize({ width: 1920, height: 1080 });
    expect(fitted.width / fitted.height).toBeCloseTo(1920 / 1080, 2);
  });

  it('rounds fractional viewport sizes', () => {
    expect(fitFrameSize({ width: 800.4, height: 600.6 })).toEqual({ width: 800, height: 601 });
  });

  it.each([
    [0, 100],
    [100, 0],
    [-5, 100],
    [Number.NaN, 100],
    [100, Number.POSITIVE_INFINITY],
  ])('rejects a viewport of %s x %s', (width, height) => {
    expect(() => fitFrameSize({ width, height })).toThrow(RangeError);
  });
});

describe('screenshotSize', () => {
  it('returns the fitted frame as output without a scale', () => {
    expect(screenshotSize({ width: 1920, height: 1080 })).toEqual({
      frame: { width: 1456, height: 819 },
      output: { width: 1456, height: 819 },
    });
  });

  it('scales the fitted frame and rounds', () => {
    expect(screenshotSize({ width: 1920, height: 1080 }, 0.5)).toEqual({
      frame: { width: 1456, height: 819 },
      output: { width: 728, height: 410 },
    });
    expect(screenshotSize({ width: 1366, height: 768 }, 0.3)).toEqual({
      frame: { width: 1366, height: 768 },
      output: { width: 410, height: 230 },
    });
  });

  it('never scales a side below 1 px', () => {
    expect(screenshotSize({ width: 100000, height: 1 }, 0.1)).toEqual({
      frame: { width: 1568, height: 1 },
      output: { width: 157, height: 1 },
    });
    expect(screenshotSize({ width: 3, height: 3 }, 0.1).output).toEqual({ width: 1, height: 1 });
  });
});

describe('zoomOutputSize', () => {
  it('renders a small region at device pixels without upscaling further', () => {
    expect(zoomOutputSize({ width: 200, height: 100 }, 2)).toEqual({ width: 400, height: 200 });
    expect(zoomOutputSize({ width: 200, height: 100 }, 1)).toEqual({ width: 200, height: 100 });
  });

  it('fits a wide region into the token budget', () => {
    const output = zoomOutputSize({ width: 1600, height: 200 }, 2);
    expect(fits(output)).toBe(true);
    expect(output).toEqual(fitFrameSize({ width: 3200, height: 400 }));
    expect(output.width / output.height).toBeCloseTo(8, 1);
  });

  it('fits a tall region into the token budget', () => {
    const output = zoomOutputSize({ width: 150, height: 1000 }, 1.5);
    expect(fits(output)).toBe(true);
    expect(output).toEqual(fitFrameSize({ width: 225, height: 1500 }));
  });

  it('keeps a tiny region at least 1 px on each side', () => {
    expect(zoomOutputSize({ width: 0.4, height: 3 }, 1)).toEqual({ width: 1, height: 3 });
    expect(zoomOutputSize({ width: 3, height: 3 }, 1, 0.1)).toEqual({ width: 1, height: 1 });
  });

  it('applies the scale after fitting', () => {
    expect(zoomOutputSize({ width: 200, height: 100 }, 2, 0.5)).toEqual({ width: 200, height: 100 });
    expect(zoomOutputSize({ width: 1920, height: 1080 }, 1, 0.5)).toEqual({ width: 728, height: 410 });
  });

  it.each([
    [{ width: 0, height: 10 }, 1],
    [{ width: 10, height: 10 }, 0],
    [{ width: 10, height: 10 }, Number.NaN],
  ])('rejects region %o at device pixel ratio %s', (region, ratio) => {
    expect(() => zoomOutputSize(region, ratio)).toThrow(RangeError);
  });
});
