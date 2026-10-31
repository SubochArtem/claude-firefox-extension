import { extractMainText } from './main-text';
import { PAGE_TEXT_ENTRY, type PageTextEntry } from './page-text-api';

export function installPageText(scope: Record<string, unknown>, doc: Document): void {
  if (typeof scope[PAGE_TEXT_ENTRY] === 'function') return;
  const entry: PageTextEntry = (options) => extractMainText(doc, options.maxChars);
  scope[PAGE_TEXT_ENTRY] = entry;
}

installPageText(globalThis as unknown as Record<string, unknown>, document);
