import { describe, expect, it } from 'vitest';
import { pageTextInputSchema } from '../mcp-server';

describe('pageTextInputSchema', () => {
  it.each([{}, { tabId: 3 }, { tabId: 3, max_chars: 100 }])('accepts %j', (args) => {
    expect(pageTextInputSchema.safeParse(args).success).toBe(true);
  });

  it.each([{ tabId: 0 }, { tabId: 1.5 }, { max_chars: 0 }, { max_chars: 2.5 }, { maxChars: 10 }, { filter: 'all' }])(
    'rejects %j',
    (args) => {
      expect(pageTextInputSchema.safeParse(args).success).toBe(false);
    },
  );
});
