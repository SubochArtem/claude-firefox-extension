import { describe, expect, it } from 'vitest';
import {
  denyPermission,
  MAX_BIDI_INPUT_ACTIONS,
  MAX_BIDI_INPUT_SOURCES,
  MAX_BIDI_EVALUATE_CODE_LENGTH,
  MAX_BIDI_INPUT_URL_LENGTH,
  parseBidiEvaluateRequest,
  parseBidiInputRequest,
  errorResponse,
  MAX_CHAT_CONTENT_BLOCKS,
  MAX_CHAT_SESSION_ID_LENGTH,
  MAX_CHAT_SYSTEM_PROMPT_LENGTH,
  MAX_PERMISSION_FIELD_LENGTH,
  parseChatRequest,
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

  it('keeps a code preview', () => {
    const request = { ...PERMISSION_REQUEST, tool: 'javascript_tool', action: 'execute_javascript', code: 'document.title' };
    expect(parsePermissionRequest(request)).toEqual(request);
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
    ['a numeric code', { ...PERMISSION_REQUEST, code: 1 }],
    ['an empty code', { ...PERMISSION_REQUEST, code: '' }],
    ['an oversized code', { ...PERMISSION_REQUEST, code: 'c'.repeat(MAX_PERMISSION_FIELD_LENGTH + 1) }],
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

describe('parseBidiInputRequest', () => {
  const marker = { name: '__claudeTabMarker_0123456789abcdef', value: 'f'.repeat(32) };
  const source = { type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerDown', button: 0 }] };
  const valid = { type: 'bidi_input_request', requestId: 'r1', marker, url: 'https://a.example/', actions: [source] };

  it('accepts a well-formed request, passes the actions through and drops unknown fields', () => {
    expect(parseBidiInputRequest({ ...valid, extra: 1 })).toEqual(valid);
    expect(parseExtensionMessage(valid)).toEqual(valid);
  });

  it('accepts the size limits exactly', () => {
    const sources = Array.from({ length: MAX_BIDI_INPUT_SOURCES }, (_, i) => ({ type: 'key', id: `k${i}`, actions: [] }));
    expect(parseBidiInputRequest({ ...valid, actions: sources })).toBeDefined();
    const many = [{ type: 'key', id: 'k', actions: Array.from({ length: MAX_BIDI_INPUT_ACTIONS }, () => ({ type: 'pause' })) }];
    expect(parseBidiInputRequest({ ...valid, actions: many })).toBeDefined();
    expect(parseBidiInputRequest({ ...valid, url: 'x'.repeat(MAX_BIDI_INPUT_URL_LENGTH) })).toBeDefined();
  });

  it.each([
    ['a missing request id', { ...valid, requestId: undefined }],
    ['an empty request id', { ...valid, requestId: '' }],
    ['a non-string url', { ...valid, url: 1 }],
    ['a too long url', { ...valid, url: 'x'.repeat(MAX_BIDI_INPUT_URL_LENGTH + 1) }],
    ['a missing marker', { ...valid, marker: undefined }],
    ['a marker name that is not an identifier', { ...valid, marker: { ...marker, name: 'a"];alert(1);//' } }],
    ['a short marker name', { ...valid, marker: { ...marker, name: 'abc' } }],
    ['a marker value that is not hex', { ...valid, marker: { ...marker, value: 'g'.repeat(32) } }],
    ['a short marker value', { ...valid, marker: { ...marker, value: 'ab' } }],
    ['actions that are not an array', { ...valid, actions: source }],
    ['no sources', { ...valid, actions: [] }],
    ['too many sources', { ...valid, actions: Array.from({ length: MAX_BIDI_INPUT_SOURCES + 1 }, () => source) }],
    ['a source without an id', { ...valid, actions: [{ ...source, id: undefined }] }],
    ['a source without a type', { ...valid, actions: [{ ...source, type: undefined }] }],
    ['a source whose actions are not an array', { ...valid, actions: [{ ...source, actions: {} }] }],
    ['a source with a non-object action', { ...valid, actions: [{ ...source, actions: ['pointerDown'] }] }],
    [
      'too many actions in total',
      {
        ...valid,
        actions: [
          { type: 'key', id: 'a', actions: Array.from({ length: MAX_BIDI_INPUT_ACTIONS }, () => ({ type: 'pause' })) },
          { type: 'key', id: 'b', actions: [{ type: 'pause' }] },
        ],
      },
    ],
  ])('rejects %s', (_label, value) => {
    expect(parseBidiInputRequest(value)).toBeUndefined();
  });
});

describe('parseBidiEvaluateRequest', () => {
  const marker = { name: '__claudeTabMarker_0123456789abcdef', value: 'f'.repeat(32) };
  const valid = { type: 'bidi_evaluate_request', requestId: 'r1', marker, url: 'https://a.example/', code: 'document.title' };

  it('accepts a well-formed request and drops unknown fields', () => {
    expect(parseBidiEvaluateRequest({ ...valid, extra: 1 })).toEqual(valid);
    expect(parseExtensionMessage(valid)).toEqual(valid);
  });

  it('accepts the size limits exactly', () => {
    expect(parseBidiEvaluateRequest({ ...valid, code: 'x'.repeat(MAX_BIDI_EVALUATE_CODE_LENGTH) })).toBeDefined();
    expect(parseBidiEvaluateRequest({ ...valid, url: 'x'.repeat(MAX_BIDI_INPUT_URL_LENGTH) })).toBeDefined();
  });

  it.each([
    ['a missing request id', { ...valid, requestId: undefined }],
    ['a non-string url', { ...valid, url: 1 }],
    ['a too long url', { ...valid, url: 'x'.repeat(MAX_BIDI_INPUT_URL_LENGTH + 1) }],
    ['a missing marker', { ...valid, marker: undefined }],
    ['a marker name that is not an identifier', { ...valid, marker: { ...marker, name: 'a"];alert(1);//' } }],
    ['non-string code', { ...valid, code: 1 }],
    ['empty code', { ...valid, code: '' }],
    ['too long code', { ...valid, code: 'x'.repeat(MAX_BIDI_EVALUATE_CODE_LENGTH + 1) }],
  ])('rejects %s', (_label, value) => {
    expect(parseBidiEvaluateRequest(value)).toBeUndefined();
  });
});

describe('parseChatRequest', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } };

  it('accepts chat_start with optional model and system prompt and drops unknown fields', () => {
    expect(parseChatRequest({ type: 'chat_start', sessionId: 'a-1_B', extra: 1 })).toEqual({ type: 'chat_start', sessionId: 'a-1_B' });
    expect(
      parseChatRequest({ type: 'chat_start', sessionId: 's', model: 'claude-opus-5-5[1m]', appendSystemPrompt: 'Be brief.' }),
    ).toEqual({ type: 'chat_start', sessionId: 's', model: 'claude-opus-5-5[1m]', appendSystemPrompt: 'Be brief.' });
    expect(parseChatRequest({ type: 'chat_start', sessionId: 's', appendSystemPrompt: '' })).toEqual({ type: 'chat_start', sessionId: 's' });
  });

  it('accepts chat_send with text or text and image blocks', () => {
    expect(parseChatRequest({ type: 'chat_send', sessionId: 's', content: 'hi' })).toEqual({ type: 'chat_send', sessionId: 's', content: 'hi' });
    const content = [{ type: 'text', text: 'look' }, image];
    expect(parseChatRequest({ type: 'chat_send', sessionId: 's', content })).toEqual({ type: 'chat_send', sessionId: 's', content });
  });

  it('accepts chat_interrupt and chat_close', () => {
    expect(parseChatRequest({ type: 'chat_interrupt', sessionId: 's' })).toEqual({ type: 'chat_interrupt', sessionId: 's' });
    expect(parseExtensionMessage({ type: 'chat_close', sessionId: 's' })).toEqual({ type: 'chat_close', sessionId: 's' });
  });

  it('accepts the size limits exactly', () => {
    const sessionId = 's'.repeat(MAX_CHAT_SESSION_ID_LENGTH);
    expect(parseChatRequest({ type: 'chat_close', sessionId })).toBeDefined();
    expect(parseChatRequest({ type: 'chat_close', sessionId: `${sessionId}s` })).toBeUndefined();
    const prompt = 'p'.repeat(MAX_CHAT_SYSTEM_PROMPT_LENGTH);
    expect(parseChatRequest({ type: 'chat_start', sessionId: 's', appendSystemPrompt: prompt })).toBeDefined();
    expect(parseChatRequest({ type: 'chat_start', sessionId: 's', appendSystemPrompt: `${prompt}p` })).toBeUndefined();
    const blocks = Array.from({ length: MAX_CHAT_CONTENT_BLOCKS }, () => ({ type: 'text', text: 'x' }));
    expect(parseChatRequest({ type: 'chat_send', sessionId: 's', content: blocks })).toBeDefined();
    expect(parseChatRequest({ type: 'chat_send', sessionId: 's', content: [...blocks, { type: 'text', text: 'x' }] })).toBeUndefined();
  });

  it.each([
    ['an unknown chat type', { type: 'chat_resume', sessionId: 's' }],
    ['a missing session id', { type: 'chat_close' }],
    ['a session id with spaces', { type: 'chat_close', sessionId: 'a b' }],
    ['a model starting with a dash', { type: 'chat_start', sessionId: 's', model: '--bare' }],
    ['a model with spaces', { type: 'chat_start', sessionId: 's', model: 'a b' }],
    ['a non-string system prompt', { type: 'chat_start', sessionId: 's', appendSystemPrompt: 1 }],
    ['empty content', { type: 'chat_send', sessionId: 's', content: '' }],
    ['no blocks', { type: 'chat_send', sessionId: 's', content: [] }],
    ['an empty text block', { type: 'chat_send', sessionId: 's', content: [{ type: 'text', text: '' }] }],
    ['a tool_result block', { type: 'chat_send', sessionId: 's', content: [{ type: 'tool_result', tool_use_id: 't' }] }],
    ['an image of another type', { type: 'chat_send', sessionId: 's', content: [{ ...image, source: { ...image.source, media_type: 'image/svg+xml' } }] }],
    ['an image by URL', { type: 'chat_send', sessionId: 's', content: [{ type: 'image', source: { type: 'url', url: 'https://x' } }] }],
  ])('rejects %s', (_label, value) => {
    expect(parseChatRequest(value)).toBeUndefined();
    expect(parseExtensionMessage(value)).toBeUndefined();
  });
});
