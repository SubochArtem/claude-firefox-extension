import { describe, expect, it } from 'vitest';
import { errorResponse, parseExtensionMessage, parseToolRequest, parseToolResponse, textOutput } from '../protocol';

const output = { content: [{ type: 'text', text: 'ok' }] };

describe('parseToolRequest', () => {
  it('accepts a well-formed request and drops unknown fields', () => {
    expect(parseToolRequest({ type: 'tool_request', id: '7', tool: 'tabs_context', args: { a: 1 }, extra: true })).toEqual({
      type: 'tool_request',
      id: '7',
      tool: 'tabs_context',
      args: { a: 1 },
    });
  });

  it.each([
    ['null', null],
    ['an array', [{ type: 'tool_request', id: '1', tool: 't', args: {} }]],
    ['a string', 'tool_request'],
    ['another type', { type: 'tool_response', id: '1', tool: 't', args: {} }],
    ['a numeric id', { type: 'tool_request', id: 1, tool: 't', args: {} }],
    ['a missing tool', { type: 'tool_request', id: '1', args: {} }],
    ['missing args', { type: 'tool_request', id: '1', tool: 't' }],
    ['array args', { type: 'tool_request', id: '1', tool: 't', args: [] }],
    ['null args', { type: 'tool_request', id: '1', tool: 't', args: null }],
  ])('rejects %s', (_label, value) => {
    expect(parseToolRequest(value)).toBeUndefined();
  });
});

describe('parseToolResponse', () => {
  it('accepts a result response', () => {
    expect(parseToolResponse({ type: 'tool_response', id: '1', result: output })).toEqual({
      type: 'tool_response',
      id: '1',
      result: output,
    });
  });

  it('accepts an error response', () => {
    expect(parseToolResponse({ type: 'tool_response', id: '1', error: output })).toEqual({
      type: 'tool_response',
      id: '1',
      error: output,
    });
  });

  it('prefers result when both result and error are present', () => {
    expect(parseToolResponse({ type: 'tool_response', id: '1', result: output, error: output })).toEqual({
      type: 'tool_response',
      id: '1',
      result: output,
    });
  });

  it.each([
    ['null', null],
    ['another type', { type: 'tool_request', id: '1', result: output }],
    ['a numeric id', { type: 'tool_response', id: 1, result: output }],
    ['no result or error', { type: 'tool_response', id: '1' }],
    ['content that is not an array', { type: 'tool_response', id: '1', result: { content: 'x' } }],
    ['an array result', { type: 'tool_response', id: '1', error: [output] }],
  ])('rejects %s', (_label, value) => {
    expect(parseToolResponse(value)).toBeUndefined();
  });
});

describe('parseExtensionMessage', () => {
  it('accepts ping', () => {
    expect(parseExtensionMessage({ type: 'ping', extra: 1 })).toEqual({ type: 'ping' });
  });

  it('accepts tool responses', () => {
    expect(parseExtensionMessage({ type: 'tool_response', id: '1', result: output })).toEqual({
      type: 'tool_response',
      id: '1',
      result: output,
    });
  });

  it.each([
    ['pong', { type: 'pong' }],
    ['a tool request', { type: 'tool_request', id: '1', tool: 't', args: {} }],
    ['an array', [{ type: 'ping' }]],
    ['a string', 'ping'],
  ])('rejects %s', (_label, value) => {
    expect(parseExtensionMessage(value)).toBeUndefined();
  });
});

describe('response helpers', () => {
  it('builds text output and error responses', () => {
    expect(textOutput('hi')).toEqual({ content: [{ type: 'text', text: 'hi' }] });
    expect(errorResponse('3', 'failed')).toEqual({
      type: 'tool_response',
      id: '3',
      error: { content: [{ type: 'text', text: 'failed' }] },
    });
  });
});
