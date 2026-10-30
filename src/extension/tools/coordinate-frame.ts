import type { Size } from './screenshot-size';
import { ToolError } from './tool-error';

export const FRAME_TOLERANCE_PX = 2;

export interface Point {
  x: number;
  y: number;
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

  toViewport(tabId: number, point: Point): Point {
    const recorded = this.frames.get(tabId);
    if (recorded === undefined) {
      throw new ToolError(`No screenshot of tab ${tabId} has been taken yet; take a screenshot first`);
    }
    const { viewport, frame } = recorded;
    const inside = (value: number, max: number) =>
      Number.isFinite(value) && value >= -FRAME_TOLERANCE_PX && value <= max + FRAME_TOLERANCE_PX;
    if (!inside(point.x, frame.width) || !inside(point.y, frame.height)) {
      throw new ToolError(
        `Coordinate (${point.x}, ${point.y}) is outside the last screenshot of tab ${tabId} (${frame.width}x${frame.height}); take a new screenshot`,
      );
    }
    return {
      x: clamp((point.x * viewport.width) / frame.width, viewport.width - 1),
      y: clamp((point.y * viewport.height) / frame.height, viewport.height - 1),
    };
  }
}
