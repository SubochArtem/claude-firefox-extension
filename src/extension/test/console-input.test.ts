import { describe, expect, it } from 'vitest';
import { DEFAULT_CONSOLE_LIMIT, MAX_CONSOLE_LIMIT, MAX_PATTERN_LENGTH, parseConsoleArgs } from '../tools/console-input';

function error(args: unknown): string {
  const result = parseConsoleArgs(args);
  if (result.ok) throw new Error(`expected an error for ${JSON.stringify(args)}`);
  return result.error;
}

describe('parseConsoleArgs', () => {
  it('fills in the defaults', () => {
    expect(DEFAULT_CONSOLE_LIMIT).toBe(100);
    expect(parseConsoleArgs({})).toEqual({ ok: true, value: { onlyErrors: false, limit: 100, clear: false } });
    expect(parseConsoleArgs({ tabId: undefined, pattern: undefined })).toEqual({
      ok: true,
      value: { onlyErrors: false, limit: 100, clear: false },
    });
  });

  it('accepts every parameter', () => {
    expect(parseConsoleArgs({ tabId: 3, onlyErrors: true, pattern: 'fail(ed)?', limit: 5, clear: true })).toEqual({
      ok: true,
      value: { tabId: 3, onlyErrors: true, pattern: 'fail(ed)?', limit: 5, clear: true },
    });
  });

  it('accepts the maximum limit and pattern length', () => {
    expect(MAX_CONSOLE_LIMIT).toBe(1000);
    expect(MAX_PATTERN_LENGTH).toBe(500);
    const pattern = 'x'.repeat(MAX_PATTERN_LENGTH);
    expect(parseConsoleArgs({ limit: MAX_CONSOLE_LIMIT, pattern })).toEqual({
      ok: true,
      value: { onlyErrors: false, limit: MAX_CONSOLE_LIMIT, clear: false, pattern },
    });
  });

  it('keeps an invalid regular expression, which is matched as text later', () => {
    expect(parseConsoleArgs({ pattern: '[unclosed' })).toMatchObject({ ok: true, value: { pattern: '[unclosed' } });
  });

  it.each([null, 'args', 3, [1]])('rejects non-object args %j', (args) => {
    expect(error(args)).toMatch(/^Expected an object with optional tabId, onlyErrors, pattern, limit and clear parameters, received /);
  });

  it('rejects unknown parameters', () => {
    expect(error({ errorsOnly: true })).toBe('Unknown parameter "errorsOnly"; allowed: tabId, onlyErrors, pattern, limit, clear');
  });

  it.each([
    ['onlyErrors', 'yes'],
    ['onlyErrors', 1],
    ['clear', 'true'],
    ['clear', null],
  ])('rejects a non-boolean %s %j', (name, value) => {
    expect(error({ [name]: value })).toMatch(new RegExp(`^${name} must be true or false, received `));
  });

  it.each([3, null, ['a']])('rejects a non-string pattern %j', (pattern) => {
    expect(error({ pattern })).toMatch(/^pattern must be a string, received /);
  });

  it('rejects an empty or too long pattern', () => {
    expect(error({ pattern: '' })).toBe('pattern must not be empty');
    expect(error({ pattern: 'x'.repeat(MAX_PATTERN_LENGTH + 1) })).toBe(
      `pattern must be at most ${MAX_PATTERN_LENGTH} characters, received ${MAX_PATTERN_LENGTH + 1}`,
    );
  });

  it.each([0, -1, 1.5, '10', Number.NaN])('rejects limit %j', (limit) => {
    expect(error({ limit })).toMatch(/^limit must be a positive integer, received /);
  });

  it('rejects a limit above the maximum', () => {
    expect(error({ limit: MAX_CONSOLE_LIMIT + 1 })).toBe(`limit must be at most ${MAX_CONSOLE_LIMIT}, received ${MAX_CONSOLE_LIMIT + 1}`);
  });

  it.each([0, -2, 1.5, '4'])('rejects tabId %j', (tabId) => {
    expect(error({ tabId })).toMatch(/^tabId must be /);
  });
});
