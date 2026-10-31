import { describe, expect, it } from 'vitest';
import { MAX_QUERY_LENGTH, parseFindArgs } from '../tools/find-input';

function error(args: unknown): string {
  const result = parseFindArgs(args);
  if (result.ok) throw new Error(`expected an error for ${JSON.stringify(args)}`);
  return result.error;
}

describe('parseFindArgs', () => {
  it('trims the query', () => {
    expect(parseFindArgs({ query: '  login button \n' })).toEqual({ ok: true, value: { query: 'login button' } });
  });

  it('accepts a tab id', () => {
    expect(parseFindArgs({ query: 'save', tabId: 7 })).toEqual({ ok: true, value: { query: 'save', tabId: 7 } });
    expect(parseFindArgs({ query: 'save', tabId: undefined })).toEqual({ ok: true, value: { query: 'save' } });
  });

  it('requires a query', () => {
    expect(error({})).toBe('query is required: describe the element to find, e.g. "search box"');
    expect(error(undefined)).toBe(error({}));
  });

  it.each([42, null, ['save'], { text: 'save' }])('rejects a non-string query %j', (query) => {
    expect(error({ query })).toMatch(/^query must be a string/);
  });

  it.each(['', '   ', '\n\t'])('rejects the empty query %j', (query) => {
    expect(error({ query })).toBe('query must not be empty');
  });

  it('caps the query length after trimming', () => {
    expect(MAX_QUERY_LENGTH).toBe(500);
    expect(parseFindArgs({ query: ` ${'a'.repeat(500)} ` })).toEqual({ ok: true, value: { query: 'a'.repeat(500) } });
    expect(error({ query: 'a'.repeat(501) })).toBe('query must be at most 500 characters, received 501');
  });

  it.each([0, -1, 1.5, '5', null])('rejects tabId %j', (tabId) => {
    expect(error({ query: 'save', tabId })).toMatch(/tabId/);
  });

  it('rejects unknown parameters', () => {
    expect(error({ query: 'save', max_chars: 10 })).toBe('Unknown parameter "max_chars"; allowed: query, tabId');
  });

  it('rejects a non-object', () => {
    expect(error('save')).toMatch(/^Expected an object of parameters/);
  });
});
