import type { TreeFilter } from './accessibility-tree';

// Name of the entry point that page/read-page.js installs on the global of the extension's isolated
// world in the page; the page itself cannot see it.
export const READ_PAGE_ENTRY = '__claudeFirefoxReadPage';
export const READ_PAGE_SCRIPT = 'page/read-page.js';

export interface ReadPageOptions {
  filter: TreeFilter;
  depth: number;
  maxChars: number;
  refId?: string;
}

export interface Viewport {
  width: number;
  height: number;
}

export type ReadPageResult = { ok: true; tree: string; viewport: Viewport } | { ok: false; error: string };

export type ReadPageEntry = (options: ReadPageOptions) => ReadPageResult;
