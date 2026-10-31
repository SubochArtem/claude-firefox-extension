import { describe, expect, it } from 'vitest';
import { findInputSchema } from '../mcp-server';

describe('findInputSchema', () => {
  it.each([{ query: 'login button' }, { query: 'search box', tabId: 3 }])('accepts %j', (args) => {
    expect(findInputSchema.safeParse(args).success).toBe(true);
  });

  it.each([
    {},
    { query: '' },
    { query: 'x'.repeat(501) },
    { query: 42 },
    { query: 'save', tabId: 0 },
    { query: 'save', tabId: 1.5 },
    { query: 'save', max_chars: 10 },
  ])('rejects %j', (args) => {
    expect(findInputSchema.safeParse(args).success).toBe(false);
  });
});
