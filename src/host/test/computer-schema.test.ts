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
    { action: 'zoom', region: [0, 0, 10] },
    { action: 'zoom', region: [0, 0, 10, '10'] },
  ])('rejects %j', (args) => {
    expect(computerInputSchema.safeParse(args).success).toBe(false);
  });

  it('accepts a zoom with a region', () => {
    expect(computerInputSchema.safeParse({ action: 'zoom', region: [0, 0, 10, 10] }).success).toBe(true);
    expect(computerInputSchema.safeParse({ action: 'zoom', tabId: 3, region: [1, 2, 3.5, 4], scale: 0.5 }).success).toBe(true);
  });

  it('describes region in screenshot frame coordinates', () => {
    expect(computerInputSchema.shape.region.description).toContain('[x0, y0, x1, y1]');
    expect(computerInputSchema.shape.region.description).toContain('screenshot frame');
  });

  it('tells the agent that coordinates refer to the full-resolution frame', () => {
    expect(computerInputSchema.shape.scale.description).toContain('full-resolution');
  });

  it.each([
    { action: 'left_click', coordinate: [10, 20.5] },
    { action: 'right_click', ref: 'ref_3', tabId: 2 },
    { action: 'double_click', coordinate: [1, 2], modifiers: 'ctrl+shift' },
    { action: 'triple_click', ref: 'ref_1' },
    { action: 'hover', coordinate: [0, 0] },
    { action: 'left_click_drag', start_coordinate: [1, 2], coordinate: [3, 4] },
    { action: 'scroll', coordinate: [5, 6], scroll_direction: 'down', scroll_amount: 10 },
    { action: 'scroll_to', ref: 'ref_9' },
    { action: 'wait', duration: 0.5 },
  ])('accepts pointer and wait actions %j', (args) => {
    expect(computerInputSchema.safeParse(args).success).toBe(true);
  });

  it.each([
    { action: 'left_click', coordinate: [1] },
    { action: 'left_click', coordinate: [1, '2'] },
    { action: 'left_click', ref: 'button' },
    { action: 'left_click_drag', start_coordinate: [1, 2, 3], coordinate: [3, 4] },
    { action: 'scroll', coordinate: [1, 2], scroll_direction: 'sideways' },
    { action: 'scroll', coordinate: [1, 2], scroll_direction: 'up', scroll_amount: 0 },
    { action: 'scroll', coordinate: [1, 2], scroll_direction: 'up', scroll_amount: 11 },
    { action: 'scroll', coordinate: [1, 2], scroll_direction: 'up', scroll_amount: 1.5 },
    { action: 'wait', duration: 0 },
    { action: 'wait', duration: 10.5 },
  ])('rejects pointer and wait arguments %j', (args) => {
    expect(computerInputSchema.safeParse(args).success).toBe(false);
  });

  it('describes coordinates in the last screenshot frame', () => {
    expect(computerInputSchema.shape.coordinate.description).toContain('last screenshot frame');
    expect(computerInputSchema.shape.start_coordinate.description).toContain('last screenshot frame');
  });

  it('offers exactly the actions the extension accepts', () => {
    expect(computerInputSchema.shape.action.options).toEqual([...COMPUTER_ACTIONS]);
  });
});
