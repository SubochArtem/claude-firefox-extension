// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { installPageText } from '../page/page-text';
import { PAGE_TEXT_ENTRY, type PageTextEntry } from '../page/page-text-api';

function entryOf(scope: Record<string, unknown>): PageTextEntry {
  const entry = scope[PAGE_TEXT_ENTRY];
  if (typeof entry !== 'function') throw new Error('entry point not installed');
  return entry as PageTextEntry;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('installPageText', () => {
  it('installs itself on the global when the bundle loads', () => {
    expect(typeof (globalThis as unknown as Record<string, unknown>)[PAGE_TEXT_ENTRY]).toBe('function');
  });

  it('returns the main text of the document', () => {
    const scope: Record<string, unknown> = {};
    installPageText(scope, document);
    document.body.innerHTML = '<article>Some article text</article>';
    expect(entryOf(scope)({ maxChars: 100 })).toMatchObject({ ok: true, source: '<article>', text: 'Some article text' });
  });

  it('keeps the first entry point when injected again', () => {
    const scope: Record<string, unknown> = {};
    installPageText(scope, document);
    const first = entryOf(scope);
    installPageText(scope, document);
    expect(entryOf(scope)).toBe(first);
  });
});
