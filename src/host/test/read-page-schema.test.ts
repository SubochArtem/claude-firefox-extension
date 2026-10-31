import { describe, expect, it } from 'vitest';
import { READ_PAGE_FILTERS } from '../../extension/tools/read-page-input';
import { readPageInputSchema } from '../mcp-server';

describe('readPageInputSchema', () => {
  it.each([
    {},
    { tabId: 3 },
    { filter: 'interactive', depth: 1, ref_id: 'ref_12', max_chars: 100 },
  ])('accepts %j', (args) => {
    expect(readPageInputSchema.safeParse(args).success).toBe(true);
  });

  it.each([
    { tabId: 0 },
    { filter: 'visible' },
    { depth: 0 },
    { depth: 1.5 },
    { ref_id: 'button' },
    { ref_id: 'ref_1 ' },
    { max_chars: 0 },
    { maxChars: 10 },
  ])('rejects %j', (args) => {
    expect(readPageInputSchema.safeParse(args).success).toBe(false);
  });

  it('offers exactly the filters the extension accepts', () => {
    expect(readPageInputSchema.shape.filter.unwrap().options).toEqual([...READ_PAGE_FILTERS]);
  });
});
