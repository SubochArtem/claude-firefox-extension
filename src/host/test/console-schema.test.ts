import { describe, expect, it } from 'vitest';
import { MAX_CONSOLE_LIMIT, MAX_PATTERN_LENGTH } from '../../extension/tools/console-input';
import { consoleInputSchema, MAX_CONSOLE_MESSAGES_LIMIT, MAX_CONSOLE_PATTERN_LENGTH } from '../mcp-server';

describe('consoleInputSchema', () => {
  it('uses the limits of the extension', () => {
    expect(MAX_CONSOLE_MESSAGES_LIMIT).toBe(MAX_CONSOLE_LIMIT);
    expect(MAX_CONSOLE_PATTERN_LENGTH).toBe(MAX_PATTERN_LENGTH);
  });

  it.each([
    {},
    { tabId: 3 },
    { onlyErrors: true, pattern: 'fail(ed)?', limit: 5, clear: true },
    { pattern: '[not a regex' },
    { limit: MAX_CONSOLE_MESSAGES_LIMIT, pattern: 'x'.repeat(MAX_CONSOLE_PATTERN_LENGTH) },
  ])('accepts %j', (args) => {
    expect(consoleInputSchema.safeParse(args).success).toBe(true);
  });

  it.each([
    { tabId: 0 },
    { onlyErrors: 'yes' },
    { pattern: '' },
    { pattern: 3 },
    { pattern: 'x'.repeat(MAX_CONSOLE_PATTERN_LENGTH + 1) },
    { limit: 0 },
    { limit: 1.5 },
    { limit: MAX_CONSOLE_MESSAGES_LIMIT + 1 },
    { clear: 1 },
    { errorsOnly: true },
  ])('rejects %j', (args) => {
    expect(consoleInputSchema.safeParse(args).success).toBe(false);
  });
});
