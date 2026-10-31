// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { installReadPage } from '../page/read-page';
import { FIND_ENTRY, type FindEntry } from '../page/find-api';
import { FORM_INPUT_ENTRY, type FormInputEntry } from '../page/form-input-api';
import { READ_PAGE_ENTRY, type ReadPageEntry } from '../page/read-page-api';

const OPTIONS = { filter: 'all', depth: 15, maxChars: 50_000 } as const;

function entryOf(scope: Record<string, unknown>): ReadPageEntry {
  const entry = scope[READ_PAGE_ENTRY];
  if (typeof entry !== 'function') throw new Error('entry point not installed');
  return entry as ReadPageEntry;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('installReadPage', () => {
  it('installs itself on the global when the bundle loads', () => {
    expect(typeof (globalThis as unknown as Record<string, unknown>)[READ_PAGE_ENTRY]).toBe('function');
  });

  it('returns the tree and the viewport size', () => {
    const scope: Record<string, unknown> = {};
    const view = { innerWidth: 1024, innerHeight: 768 } as Window;
    installReadPage(scope, document, view);
    document.body.innerHTML = '<button>Save</button>';
    const result = entryOf(scope)(OPTIONS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.viewport).toEqual({ width: 1024, height: 768 });
    expect(result.tree).toMatch(/^button "Save" \[ref_\d+\]$/);
  });

  it('keeps the first registry when injected again, so refs stay stable', () => {
    const scope: Record<string, unknown> = {};
    installReadPage(scope, document, window);
    const first = entryOf(scope);
    document.body.innerHTML = '<button>Save</button>';
    const before = first(OPTIONS);
    installReadPage(scope, document, window);
    expect(entryOf(scope)).toBe(first);
    const after = entryOf(scope)(OPTIONS);
    expect(after).toEqual(before);
  });

  it('replaces the entries of an older bundle that lacks some, sharing one new registry', () => {
    const scope: Record<string, unknown> = {};
    const oldReadPage = (): unknown => ({ ok: false, error: 'old bundle' });
    const oldFind = (): unknown => ({ ok: false, error: 'old bundle' });
    scope[READ_PAGE_ENTRY] = oldReadPage;
    scope[FIND_ENTRY] = oldFind;
    installReadPage(scope, document, window);
    expect(scope[READ_PAGE_ENTRY]).not.toBe(oldReadPage);
    expect(scope[FIND_ENTRY]).not.toBe(oldFind);
    expect(typeof scope[FORM_INPUT_ENTRY]).toBe('function');
    document.body.innerHTML = '<input aria-label="City" value="Rome">';
    const tree = entryOf(scope)(OPTIONS);
    const ref = tree.ok ? (/ref_\d+/.exec(tree.tree)?.[0] ?? '') : '';
    const formInput = scope[FORM_INPUT_ENTRY] as FormInputEntry;
    expect(formInput({ ref, value: 'Paris' })).toEqual({ ok: true, text: 'Set text value to "Paris" (previous: "Rome")' });
  });

  it('passes ref errors through', () => {
    const scope: Record<string, unknown> = {};
    installReadPage(scope, document, window);
    const result = entryOf(scope)({ ...OPTIONS, refId: 'ref_999' });
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/^ref_999 was not found in this page/) });
  });

  it('installs find with the same registry, so its refs work with read_page', () => {
    const scope: Record<string, unknown> = {};
    installReadPage(scope, document, window);
    const find = scope[FIND_ENTRY] as FindEntry;
    document.body.innerHTML = '<h1>Shop</h1><button>Buy now</button>';
    const result = find({ query: 'buy now' });
    expect(result).toEqual({ ok: true, text: expect.stringMatching(/^Found 1 matching element\n- ref_\d+: button "Buy now"/) });
    const ref = result.ok ? (/ref_\d+/.exec(result.text)?.[0] ?? '') : '';
    expect(entryOf(scope)({ ...OPTIONS, refId: ref })).toMatchObject({ ok: true, tree: `button "Buy now" [${ref}]` });
  });

  it('installs form_input with the same registry, so refs from find work with it', () => {
    const scope: Record<string, unknown> = {};
    installReadPage(scope, document, window);
    const find = scope[FIND_ENTRY] as FindEntry;
    const formInput = scope[FORM_INPUT_ENTRY] as FormInputEntry;
    document.body.innerHTML = '<input aria-label="City" value="Rome">';
    const found = find({ query: 'city' });
    const ref = found.ok ? (/ref_\d+/.exec(found.text)?.[0] ?? '') : '';
    expect(formInput({ ref, value: 'Paris' })).toEqual({ ok: true, text: 'Set text value to "Paris" (previous: "Rome")' });
    expect(document.querySelector('input')?.value).toBe('Paris');
    expect(formInput({ ref: 'ref_999', value: 'x' })).toEqual({ ok: false, error: expect.stringMatching(/^ref_999 was not found/) });
  });
});
