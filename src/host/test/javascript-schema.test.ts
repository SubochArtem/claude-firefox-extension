import { describe, expect, it } from 'vitest';
import { MAX_CODE_LENGTH } from '../../extension/tools/javascript-input';
import { javascriptInputSchema, MAX_JAVASCRIPT_CODE_LENGTH } from '../../shared/tool-definitions';

describe('javascriptInputSchema', () => {
  it('uses the code size cap of the extension', () => {
    expect(MAX_JAVASCRIPT_CODE_LENGTH).toBe(MAX_CODE_LENGTH);
  });

  it.each([
    { action: 'javascript_exec', text: 'document.title' },
    { action: 'javascript_exec', text: 'return await fetch("/").then((r) => r.status)', tabId: 3 },
    { action: 'javascript_exec', text: 'x'.repeat(MAX_JAVASCRIPT_CODE_LENGTH) },
  ])('accepts %j', (args) => {
    expect(javascriptInputSchema.safeParse(args).success).toBe(true);
  });

  it.each([
    {},
    { text: '1' },
    { action: 'javascript_exec' },
    { action: 'exec', text: '1' },
    { action: 'javascript_exec', text: '' },
    { action: 'javascript_exec', text: 1 },
    { action: 'javascript_exec', text: 'x'.repeat(MAX_JAVASCRIPT_CODE_LENGTH + 1) },
    { action: 'javascript_exec', text: '1', tabId: 0 },
    { action: 'javascript_exec', text: '1', code: '2' },
  ])('rejects %j', (args) => {
    expect(javascriptInputSchema.safeParse(args).success).toBe(false);
  });
});
