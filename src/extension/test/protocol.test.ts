import { describe, expect, it } from 'vitest';
import { parseHostMessage } from '../protocol';

describe('parseHostMessage', () => {
  it('accepts pong and drops unknown fields', () => {
    expect(parseHostMessage({ type: 'pong', extra: 1 })).toEqual({ type: 'pong' });
  });

  it('accepts a well-formed tool request', () => {
    expect(parseHostMessage({ type: 'tool_request', id: '1:2', tool: 'tabs_context', args: { x: 1 }, extra: 1 })).toEqual({
      type: 'tool_request',
      id: '1:2',
      tool: 'tabs_context',
      args: { x: 1 },
    });
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'pong'],
    ['an array', [{ type: 'pong' }]],
    ['ping', { type: 'ping' }],
    ['a tool response', { type: 'tool_response', id: '1', result: { content: [] } }],
    ['a numeric id', { type: 'tool_request', id: 1, tool: 't', args: {} }],
    ['a missing tool', { type: 'tool_request', id: '1', args: {} }],
    ['missing args', { type: 'tool_request', id: '1', tool: 't' }],
    ['array args', { type: 'tool_request', id: '1', tool: 't', args: [] }],
  ])('rejects %s', (_label, value) => {
    expect(parseHostMessage(value)).toBeUndefined();
  });
});
