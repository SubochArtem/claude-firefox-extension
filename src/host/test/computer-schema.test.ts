import { describe, expect, it } from 'vitest';
import { COMPUTER_ACTIONS } from '../../extension/tools/computer-input';
import { computerInputSchema } from '../mcp-server';

describe('computerInputSchema', () => {
  it('accepts a screenshot with optional tabId and scale', () => {
    expect(computerInputSchema.safeParse({ action: 'screenshot' }).success).toBe(true);
    expect(computerInputSchema.safeParse({ action: 'screenshot', tabId: 3, scale: 0.1 }).success).toBe(true);
    expect(computerInputSchema.safeParse({ action: 'screenshot', scale: 1 }).success).toBe(true);
  });

  it.each([
    {},
    { action: 'click' },
    { action: 'screenshot', tabId: 0 },
    { action: 'screenshot', tabId: 1.5 },
    { action: 'screenshot', scale: 0.09 },
    { action: 'screenshot', scale: 1.1 },
    { action: 'screenshot', unknown: true },
  ])('rejects %j', (args) => {
    expect(computerInputSchema.safeParse(args).success).toBe(false);
  });

  it('tells the agent that coordinates refer to the full-resolution frame', () => {
    expect(computerInputSchema.shape.scale.description).toContain('full-resolution');
  });

  it('offers exactly the actions the extension accepts', () => {
    expect(computerInputSchema.shape.action.options).toEqual([...COMPUTER_ACTIONS]);
  });
});
