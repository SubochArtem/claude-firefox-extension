import { describe, expect, it } from 'vitest';
import { formInputInputSchema } from '../mcp-server';

describe('formInputInputSchema', () => {
  it.each([
    { ref: 'ref_1', value: 'text' },
    { ref: 'ref_12', value: true },
    { ref: 'ref_3', value: 4.5 },
    { ref: 'ref_3', value: '', tabId: 2 },
  ])('accepts %j', (args) => {
    expect(formInputInputSchema.safeParse(args).success).toBe(true);
  });

  it.each([
    {},
    { ref: 'ref_1' },
    { value: 'x' },
    { ref: 'button', value: 'x' },
    { ref: 'ref_1', value: null },
    { ref: 'ref_1', value: ['a'] },
    { ref: 'ref_1', value: 'x', tabId: 0 },
    { ref: 'ref_1', value: 'x', text: 'y' },
  ])('rejects %j', (args) => {
    expect(formInputInputSchema.safeParse(args).success).toBe(false);
  });
});
