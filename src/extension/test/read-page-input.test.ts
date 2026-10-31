import { describe, expect, it } from 'vitest';
import { DEFAULT_DEPTH, DEFAULT_MAX_CHARS, type TreeFilter } from '../page/accessibility-tree';
import {
  DEFAULT_READ_DEPTH,
  DEFAULT_READ_MAX_CHARS,
  parseReadPageArgs,
  READ_PAGE_FILTERS,
  type ReadPageFilter,
} from '../tools/read-page-input';

function error(args: unknown): string {
  const result = parseReadPageArgs(args);
  if (result.ok) throw new Error(`expected an error for ${JSON.stringify(args)}`);
  return result.error;
}

describe('parseReadPageArgs', () => {
  it('fills in the defaults', () => {
    expect(parseReadPageArgs({})).toEqual({
      ok: true,
      value: { filter: 'all', depth: DEFAULT_DEPTH, maxChars: DEFAULT_MAX_CHARS },
    });
    expect(parseReadPageArgs(undefined)).toEqual(parseReadPageArgs({}));
  });

  it('accepts every argument', () => {
    expect(parseReadPageArgs({ tabId: 7, filter: 'interactive', depth: 3, ref_id: 'ref_12', max_chars: 1000 })).toEqual({
      ok: true,
      value: { tabId: 7, filter: 'interactive', depth: 3, refId: 'ref_12', maxChars: 1000 },
    });
  });

  it('ignores parameters set to undefined', () => {
    expect(parseReadPageArgs({ tabId: undefined, ref_id: undefined })).toEqual(parseReadPageArgs({}));
  });

  it('offers the filters and defaults of the tree builder', () => {
    const filters: readonly TreeFilter[] = READ_PAGE_FILTERS;
    const covered: TreeFilter extends ReadPageFilter ? true : false = true;
    expect(filters).toEqual(['all', 'interactive']);
    expect(covered).toBe(true);
    expect(DEFAULT_READ_DEPTH).toBe(DEFAULT_DEPTH);
    expect(DEFAULT_READ_MAX_CHARS).toBe(DEFAULT_MAX_CHARS);
  });

  it.each([null, 'tab', 5, [1]])('rejects non-object args %j', (args) => {
    expect(error(args)).toMatch(/^Expected an object/);
  });

  it.each([
    [{ tabId: 0 }, /^tabId must be a positive safe integer/],
    [{ tabId: 1.5 }, /^tabId must be an integer/],
    [{ tabId: '3' }, /^tabId must be an integer, received "3"/],
    [{ filter: 'visible' }, /^Unknown filter "visible"; supported filters: all, interactive/],
    [{ filter: 1 }, /^filter must be a string/],
    [{ depth: 0 }, /^depth must be a positive integer, received 0/],
    [{ depth: 2.5 }, /^depth must be a positive integer/],
    [{ depth: '5' }, /^depth must be a positive integer, received "5"/],
    [{ max_chars: -1 }, /^max_chars must be a positive integer/],
    [{ max_chars: Number.MAX_SAFE_INTEGER + 2 }, /^max_chars must be a positive integer/],
    [{ ref_id: 'ref_' }, /^ref_id must look like ref_12/],
    [{ ref_id: ' ref_1' }, /^ref_id must look like ref_12/],
    [{ ref_id: 'ref_1\n' }, /^ref_id must look like ref_12/],
    [{ ref_id: 12 }, /^ref_id must be a string/],
  ])('rejects %j', (args, message) => {
    expect(error(args)).toMatch(message);
  });

  it('rejects unknown parameters and names the allowed ones', () => {
    expect(error({ maxChars: 10 })).toBe(
      'Unknown parameter "maxChars"; allowed: tabId, filter, depth, ref_id, max_chars',
    );
  });

  it('caps echoed input', () => {
    expect(error({ ref_id: 'x'.repeat(500) }).length).toBeLessThan(200);
    expect(error({ ['k'.repeat(500)]: 1 }).length).toBeLessThan(250);
  });
});
