import { describe, expect, it } from 'vitest';
import { DEFAULT_NETWORK_LIMIT, MAX_NETWORK_LIMIT, MAX_URL_PATTERN_LENGTH, parseNetworkArgs } from '../tools/network-input';

function error(args: unknown): string {
  const result = parseNetworkArgs(args);
  if (result.ok) throw new Error(`expected an error for ${JSON.stringify(args)}`);
  return result.error;
}

describe('parseNetworkArgs', () => {
  it('fills in the defaults', () => {
    expect(DEFAULT_NETWORK_LIMIT).toBe(100);
    expect(parseNetworkArgs({})).toEqual({ ok: true, value: { limit: 100, clear: false } });
    expect(parseNetworkArgs({ tabId: undefined, urlPattern: undefined })).toEqual({ ok: true, value: { limit: 100, clear: false } });
  });

  it('accepts every parameter', () => {
    expect(parseNetworkArgs({ tabId: 3, urlPattern: '/api/', limit: 5, clear: true })).toEqual({
      ok: true,
      value: { tabId: 3, urlPattern: '/api/', limit: 5, clear: true },
    });
  });

  it('accepts the maximum limit and pattern length', () => {
    expect(MAX_NETWORK_LIMIT).toBe(1000);
    expect(MAX_URL_PATTERN_LENGTH).toBe(500);
    const urlPattern = 'x'.repeat(MAX_URL_PATTERN_LENGTH);
    expect(parseNetworkArgs({ limit: MAX_NETWORK_LIMIT, urlPattern })).toEqual({
      ok: true,
      value: { limit: MAX_NETWORK_LIMIT, clear: false, urlPattern },
    });
  });

  it.each([null, 'args', 3, [1]])('rejects non-object args %j', (args) => {
    expect(error(args)).toMatch(/^Expected an object with optional tabId, urlPattern, limit and clear parameters, received /);
  });

  it('rejects unknown parameters', () => {
    expect(error({ pattern: 'api' })).toBe('Unknown parameter "pattern"; allowed: tabId, urlPattern, limit, clear');
  });

  it.each(['true', null, 1])('rejects a non-boolean clear %j', (clear) => {
    expect(error({ clear })).toMatch(/^clear must be true or false, received /);
  });

  it.each([3, null, ['a']])('rejects a non-string urlPattern %j', (urlPattern) => {
    expect(error({ urlPattern })).toMatch(/^urlPattern must be a string, received /);
  });

  it('rejects an empty or too long urlPattern', () => {
    expect(error({ urlPattern: '' })).toBe('urlPattern must not be empty');
    expect(error({ urlPattern: 'x'.repeat(MAX_URL_PATTERN_LENGTH + 1) })).toBe(
      `urlPattern must be at most ${MAX_URL_PATTERN_LENGTH} characters, received ${MAX_URL_PATTERN_LENGTH + 1}`,
    );
  });

  it.each([0, -1, 1.5, '10', Number.NaN])('rejects limit %j', (limit) => {
    expect(error({ limit })).toMatch(/^limit must be a positive integer, received /);
  });

  it('rejects a limit above the maximum', () => {
    expect(error({ limit: MAX_NETWORK_LIMIT + 1 })).toBe(`limit must be at most ${MAX_NETWORK_LIMIT}, received ${MAX_NETWORK_LIMIT + 1}`);
  });

  it.each([0, -2, 1.5, '4'])('rejects tabId %j', (tabId) => {
    expect(error({ tabId })).toMatch(/^tabId must be /);
  });
});
