import { describe, expect, it } from 'vitest';
import {
  denyPermission,
  errorResponse,
  MAX_PERMISSION_FIELD_LENGTH,
  parseExtensionMessage,
  parsePermissionRequest,
  parsePermissionResponse,
  parseToolRequest,
  parseToolResponse,
  textOutput,
} from '../protocol';

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

  it('keeps approvalViaClient only when it is true', () => {
    expect(parseToolRequest({ type: 'tool_request', id: '7', tool: 't', args: {}, approvalViaClient: true })).toEqual({
      type: 'tool_request',
      id: '7',
      tool: 't',
      args: {},
      approvalViaClient: true,
    });
    for (const approvalViaClient of [false, 'true', 1]) {
      expect(parseToolRequest({ type: 'tool_request', id: '7', tool: 't', args: {}, approvalViaClient })).not.toHaveProperty(
        'approvalViaClient',
      );
    }
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

  it('accepts permission requests', () => {
    expect(parseExtensionMessage(PERMISSION_REQUEST)).toEqual(PERMISSION_REQUEST);
  });

  it.each([
    ['pong', { type: 'pong' }],
    ['a tool request', { type: 'tool_request', id: '1', tool: 't', args: {} }],
    ['a permission response', { type: 'permission_response', requestId: 'r', answer: 'deny', includeSubdomains: false }],
    ['an array', [{ type: 'ping' }]],
    ['a string', 'ping'],
  ])('rejects %s', (_label, value) => {
    expect(parseExtensionMessage(value)).toBeUndefined();
  });
});

const PERMISSION_REQUEST = {
  type: 'permission_request',
  requestId: 'req-1',
  callId: '3:1',
  host: 'example.com',
  tool: 'navigate',
  action: 'navigate',
  canIncludeSubdomains: true,
};

describe('parsePermissionRequest', () => {
  it('accepts a well-formed request and drops unknown fields', () => {
    expect(parsePermissionRequest({ ...PERMISSION_REQUEST, extra: 1 })).toEqual(PERMISSION_REQUEST);
  });

  it.each([
    ['null', null],
    ['another type', { ...PERMISSION_REQUEST, type: 'permission_response' }],
    ['a numeric requestId', { ...PERMISSION_REQUEST, requestId: 1 }],
    ['an empty requestId', { ...PERMISSION_REQUEST, requestId: '' }],
    ['a missing callId', { ...PERMISSION_REQUEST, callId: undefined }],
    ['a numeric host', { ...PERMISSION_REQUEST, host: 1 }],
    ['a missing tool', { ...PERMISSION_REQUEST, tool: undefined }],
    ['a missing action', { ...PERMISSION_REQUEST, action: undefined }],
    ['a string canIncludeSubdomains', { ...PERMISSION_REQUEST, canIncludeSubdomains: 'true' }],
    ['an oversized host', { ...PERMISSION_REQUEST, host: 'a'.repeat(MAX_PERMISSION_FIELD_LENGTH + 1) }],
    ['an oversized requestId', { ...PERMISSION_REQUEST, requestId: 'r'.repeat(MAX_PERMISSION_FIELD_LENGTH + 1) }],
  ])('rejects %s', (_label, value) => {
    expect(parsePermissionRequest(value)).toBeUndefined();
  });
});

describe('parsePermissionResponse', () => {
  it('accepts a well-formed response and drops unknown fields', () => {
    expect(
      parsePermissionResponse({ type: 'permission_response', requestId: 'r', answer: 'allow_always', includeSubdomains: true, x: 1 }),
    ).toEqual({ type: 'permission_response', requestId: 'r', answer: 'allow_always', includeSubdomains: true });
  });

  it('turns a malformed answer into a deny for the same request', () => {
    expect(parsePermissionResponse({ type: 'permission_response', requestId: 'r', answer: 5, includeSubdomains: 'yes' })).toEqual(
      denyPermission('r'),
    );
    expect(
      parsePermissionResponse({ type: 'permission_response', requestId: 'r', answer: 'a'.repeat(MAX_PERMISSION_FIELD_LENGTH + 1) }),
    ).toEqual(denyPermission('r'));
    expect(denyPermission('r')).toEqual({ type: 'permission_response', requestId: 'r', answer: 'deny', includeSubdomains: false });
  });

  it.each([
    ['null', null],
    ['another type', { type: 'permission_request', requestId: 'r', answer: 'deny' }],
    ['a numeric requestId', { type: 'permission_response', requestId: 1, answer: 'deny' }],
    ['an oversized requestId', { type: 'permission_response', requestId: 'r'.repeat(MAX_PERMISSION_FIELD_LENGTH + 1), answer: 'deny' }],
  ])('rejects %s', (_label, value) => {
    expect(parsePermissionResponse(value)).toBeUndefined();
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
