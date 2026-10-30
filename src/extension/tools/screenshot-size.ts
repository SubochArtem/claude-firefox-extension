export const PIXELS_PER_TOKEN = 28;
export const MAX_IMAGE_SIDE = 1568;
export const MAX_IMAGE_TOKENS = 1568;

export interface Size {
  width: number;
  height: number;
}

export interface ScreenshotSize {
  frame: Size;
  output: Size;
}

export function imageTokens(width: number, height: number): number {
  return Math.ceil(width / PIXELS_PER_TOKEN) * Math.ceil(height / PIXELS_PER_TOKEN);
}

function fits(width: number, height: number): boolean {
  return width <= MAX_IMAGE_SIDE && height <= MAX_IMAGE_SIDE && imageTokens(width, height) <= MAX_IMAGE_TOKENS;
}

function pixels(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive number, received ${value}`);
  return Math.max(1, Math.round(value));
}

export function fitFrameSize(viewport: Size): Size {
  const width = pixels(viewport.width, 'viewport width');
  const height = pixels(viewport.height, 'viewport height');
  if (fits(width, height)) return { width, height };

  // Long side 1 always fits, so the search below terminates.
  const landscape = width >= height;
  const longSide = landscape ? width : height;
  const shortSide = landscape ? height : width;
  const sizeFor = (long: number): Size => {
    const short = Math.max(1, Math.round((long * shortSide) / longSide));
    return landscape ? { width: long, height: short } : { width: short, height: long };
  };

  let low = 1;
  let high = longSide;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = sizeFor(middle);
    if (fits(candidate.width, candidate.height)) low = middle;
    else high = middle - 1;
  }
  return sizeFor(low);
}

export function screenshotSize(viewport: Size, scale = 1): ScreenshotSize {
  const frame = fitFrameSize(viewport);
  const output = {
    width: Math.max(1, Math.round(frame.width * scale)),
    height: Math.max(1, Math.round(frame.height * scale)),
  };
  return { frame, output };
}
