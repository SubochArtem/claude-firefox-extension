// Installed by page/read-page.js next to the read_page entry point, so both share one ref registry.
export const FIND_ENTRY = '__claudeFirefoxFind';

export interface FindOptions {
  query: string;
}

export type FindResult = { ok: true; text: string } | { ok: false; error: string };

export type FindEntry = (options: FindOptions) => FindResult;
