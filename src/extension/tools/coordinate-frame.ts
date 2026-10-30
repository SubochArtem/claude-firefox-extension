import type { Region } from './computer-input';
import type { Size } from './screenshot-size';
import { ToolError } from './tool-error';

export const FRAME_TOLERANCE_PX = 2;
export const VIEWPORT_TOLERANCE_PX = 1;

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CoordinateFrame {
  viewport: Size;
  frame: Size;
}

function checkSize(size: Size, name: string): void {
  for (const value of [size.width, size.height]) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${name} must have positive dimensions, received ${size.width}x${size.height}`);
    }
  }
}

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(value, max));
}

function insideFrame(value: number, max: number): boolean {
  return Number.isFinite(value) && value >= -FRAME_TOLERANCE_PX && value <= max + FRAME_TOLERANCE_PX;
}

export class CoordinateFrames {
  private readonly frames = new Map<number, CoordinateFrame>();

  record(tabId: number, viewport: Size, frame: Size): void {
    checkSize(viewport, 'viewport');
    checkSize(frame, 'frame');
    this.frames.set(tabId, { viewport: { ...viewport }, frame: { ...frame } });
  }

  get(tabId: number): CoordinateFrame | undefined {
    return this.frames.get(tabId);
  }

  forget(tabId: number): void {
    this.frames.delete(tabId);
  }

  require(tabId: number): CoordinateFrame {
    const recorded = this.frames.get(tabId);
    if (recorded === undefined) {
      throw new ToolError(`No screenshot of tab ${tabId} has been taken yet; take a screenshot first`);
    }
    return recorded;
  }

  toViewport(tabId: number, point: Point): Point {
    const { viewport, frame } = this.require(tabId);
    if (!insideFrame(point.x, frame.width) || !insideFrame(point.y, frame.height)) {
      throw new ToolError(
        `Coordinate (${point.x}, ${point.y}) is outside the last screenshot of tab ${tabId} (${frame.width}x${frame.height}); take a new screenshot`,
      );
    }
    return {
      x: clamp((point.x * viewport.width) / frame.width, viewport.width - 1),
      y: clamp((point.y * viewport.height) / frame.height, viewport.height - 1),
    };
  }

  // The rect is in CSS pixels relative to the viewport; current is the viewport size now, which may
  // differ from the one recorded with the screenshot.
  regionToViewport(tabId: number, region: Region, current: Size): Rect {
    const { viewport, frame } = this.require(tabId);
    const [x0, y0, x1, y1] = region;
    const label = `Region [${region.join(', ')}]`;
    const left = clamp((x0 * viewport.width) / frame.width, viewport.width);
    const top = clamp((y0 * viewport.height) / frame.height, viewport.height);
    const right = clamp((x1 * viewport.width) / frame.width, viewport.width);
    const bottom = clamp((y1 * viewport.height) / frame.height, viewport.height);
    const inside = region.every((value, index) => insideFrame(value, index % 2 === 0 ? frame.width : frame.height));
    if (!inside || right <= left || bottom <= top) {
      throw new ToolError(
        `${label} is outside the last screenshot of tab ${tabId} (${frame.width}x${frame.height}); take a new screenshot`,
      );
    }
    const clampedRight = Math.min(right, current.width);
    const clampedBottom = Math.min(bottom, current.height);
    if (
      right > current.width + VIEWPORT_TOLERANCE_PX ||
      bottom > current.height + VIEWPORT_TOLERANCE_PX ||
      clampedRight <= left ||
      clampedBottom <= top
    ) {
      throw new ToolError(
        `${label} is outside the current ${current.width}x${current.height} viewport of tab ${tabId}, which changed since the last screenshot; take a new screenshot`,
      );
    }
    return { x: left, y: top, width: clampedRight - left, height: clampedBottom - top };
  }
}
