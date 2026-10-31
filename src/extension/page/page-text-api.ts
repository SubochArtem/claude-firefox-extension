// Name of the entry point that page/page-text.js installs on the global of the extension's isolated
// world in the page; the page itself cannot see it.
export const PAGE_TEXT_ENTRY = '__claudeFirefoxPageText';
export const PAGE_TEXT_SCRIPT = 'page/page-text.js';

export interface PageTextOptions {
  maxChars: number;
}

export type PageTextResult =
  | { ok: true; title: string; url: string; source: string; text: string }
  | { ok: false; error: string };

export type PageTextEntry = (options: PageTextOptions) => PageTextResult;
