import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_TEXT_MAX_CHARS, parsePageTextArgs } from '../tools/page-text-input';

function error(args: unknown): string {
  const result = parsePageTextArgs(args);
  if (result.ok) throw new Error(`expected an error for ${JSON.stringify(args)}`);
  return result.error;
}

describe('parsePageTextArgs', () => {
  it('fills in the default max_chars', () => {
    expect(DEFAULT_PAGE_TEXT_MAX_CHARS).toBe(50_000);
    expect(parsePageTextArgs({})).toEqual({ ok: true, value: { maxChars: 50_000 } });
    expect(parsePageTextArgs(undefined)).toEqual(parsePageTextArgs({}));
    expect(parsePageTextArgs({ tabId: undefined, max_chars: undefined })).toEqual(parsePageTextArgs({}));
  });

  it('accepts every argument', () => {
    expect(parsePageTextArgs({ tabId: 7, max_chars: 1000 })).toEqual({ ok: true, value: { tabId: 7, maxChars: 1000 } });
  });

  it.each([0, -1, 1.5, '5', null, Number.MAX_SAFE_INTEGER + 1])('rejects tabId %j', (tabId) => {
    expect(error({ tabId })).toMatch(/tabId/);
  });

  it.each([0, -3, 2.5, '100', null, Number.POSITIVE_INFINITY])('rejects max_chars %j', (max_chars) => {
    expect(error({ max_chars })).toMatch(/^max_chars must be a positive integer/);
  });

  it('rejects unknown parameters', () => {
    expect(error({ maxChars: 10 })).toBe('Unknown parameter "maxChars"; allowed: tabId, max_chars');
  });

  it('rejects a non-object', () => {
    expect(error('tab')).toMatch(/^Expected an object of parameters/);
  });
});
