import { describe, expect, it } from 'vitest';
import { resizeWindowInputSchema } from '../mcp-server';

describe('resizeWindowInputSchema', () => {
  it.each([
    { width: 1280, height: 720 },
    { width: 1, height: 1 },
    { width: 7680, height: 4320 },
    { width: 7680.5, height: 4320.5 },
    { width: 1024.5, height: 768, tabId: 3 },
  ])('accepts %j', (args) => {
    expect(resizeWindowInputSchema.safeParse(args).success).toBe(true);
  });

  it.each([
    {},
    { width: 800 },
    { height: 600 },
    { width: 0, height: 600 },
    { width: 800, height: -1 },
    { width: 7681, height: 600 },
    { width: 800, height: 4321 },
    { width: '800', height: 600 },
    { width: 800, height: 600, tabId: 0 },
    { width: 800, height: 600, windowId: 1 },
  ])('rejects %j', (args) => {
    expect(resizeWindowInputSchema.safeParse(args).success).toBe(false);
  });
});
