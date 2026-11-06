// Installed by page/read-page.js next to the read_page entry point, so it resolves the same refs.
export const ELEMENT_POINT_ENTRY = '__claudeFirefoxElementPoint';

// scrollOnly (scroll_to) skips the size and viewport checks that only matter for a point that receives input.
export interface ElementPointOptions {
  ref: string;
  scrollOnly?: boolean;
}

// x and y are the element's center in CSS pixels relative to the viewport, after scrolling it into view.
export type ElementPointResult = { ok: true; x: number; y: number } | { ok: false; error: string };

export type ElementPointEntry = (options: ElementPointOptions) => ElementPointResult;
