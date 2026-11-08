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

  it('keeps approvalViaClient only when it is true', () => {
    expect(parseHostMessage({ type: 'tool_request', id: '1:2', tool: 't', args: {}, approvalViaClient: true })).toEqual({
      type: 'tool_request',
      id: '1:2',
      tool: 't',
      args: {},
      approvalViaClient: true,
    });
    expect(parseHostMessage({ type: 'tool_request', id: '1:2', tool: 't', args: {}, approvalViaClient: 'yes' })).not.toHaveProperty(
      'approvalViaClient',
    );
  });

  it('keeps a well-formed chat session id and drops a malformed one', () => {
    expect(parseHostMessage({ type: 'tool_request', id: '1:2', tool: 't', args: {}, chatSessionId: 'chat_1-a' })).toEqual({
      type: 'tool_request',
      id: '1:2',
      tool: 't',
      args: {},
      chatSessionId: 'chat_1-a',
    });
    for (const chatSessionId of ['', 'bad id', 'x'.repeat(129), 7]) {
      expect(parseHostMessage({ type: 'tool_request', id: '1:2', tool: 't', args: {}, chatSessionId })).not.toHaveProperty('chatSessionId');
    }
  });

  it('accepts a permission response and leaves the answer to the approval parser', () => {
    expect(parseHostMessage({ type: 'permission_response', requestId: 'r', answer: 'maybe', includeSubdomains: 1, x: 1 })).toEqual({
      type: 'permission_response',
      requestId: 'r',
      answer: 'maybe',
      includeSubdomains: 1,
    });
  });

  it('accepts a bidi input response and settles a malformed one as an error', () => {
    expect(parseHostMessage({ type: 'bidi_input_response', requestId: 'r', ok: true, x: 1 })).toEqual({
      type: 'bidi_input_response',
      requestId: 'r',
      ok: true,
    });
    expect(parseHostMessage({ type: 'bidi_input_response', requestId: 'r', ok: false, error: 'no tab' })).toEqual({
      type: 'bidi_input_response',
      requestId: 'r',
      ok: false,
      error: 'no tab',
    });
    expect(
      parseHostMessage({ type: 'bidi_input_response', requestId: 'r', ok: false, error: 'no port', unavailable: true }),
    ).toEqual({ type: 'bidi_input_response', requestId: 'r', ok: false, error: 'no port', unavailable: true });
    expect(
      parseHostMessage({ type: 'bidi_input_response', requestId: 'r', ok: false, error: 'no port', unavailable: 'yes' }),
    ).toEqual({ type: 'bidi_input_response', requestId: 'r', ok: false, error: 'no port' });
    for (const malformed of [{ ok: false }, { ok: 'yes' }, { ok: false, error: 1 }, { ok: false, unavailable: true }]) {
      expect(parseHostMessage({ type: 'bidi_input_response', requestId: 'r', ...malformed })).toEqual({
        type: 'bidi_input_response',
        requestId: 'r',
        ok: false,
        error: 'The native host sent a malformed input response',
      });
    }
    expect(parseHostMessage({ type: 'bidi_input_response', ok: true })).toBeUndefined();
  });

  it('accepts a bidi evaluate response and settles a malformed one as an error', () => {
    const base = { type: 'bidi_evaluate_response', requestId: 'r' };
    expect(parseHostMessage({ ...base, ok: true, value: '42', x: 1 })).toEqual({ ...base, ok: true, value: '42' });
    expect(parseHostMessage({ ...base, ok: true, exception: 'Error: boom' })).toEqual({ ...base, ok: true, exception: 'Error: boom' });
    expect(parseHostMessage({ ...base, ok: false, error: 'no tab' })).toEqual({ ...base, ok: false, error: 'no tab' });
    expect(parseHostMessage({ ...base, ok: false, error: 'no port', unavailable: true })).toEqual({
      ...base,
      ok: false,
      error: 'no port',
      unavailable: true,
    });
    expect(parseHostMessage({ ...base, ok: false, error: 'no port', unavailable: 'yes' })).toEqual({ ...base, ok: false, error: 'no port' });
    for (const malformed of [{ ok: true }, { ok: true, value: 1 }, { ok: false }, { ok: 'yes', value: '1' }, { ok: false, error: 1 }]) {
      expect(parseHostMessage({ ...base, ...malformed })).toEqual({
        ...base,
        ok: false,
        error: 'The native host sent a malformed evaluate response',
      });
    }
    expect(parseHostMessage({ type: 'bidi_evaluate_response', ok: true, value: '1' })).toBeUndefined();
  });

  it.each([
    ['undefined', undefined],
    ['a permission response without a requestId', { type: 'permission_response', answer: 'deny' }],
    ['a permission response with a numeric requestId', { type: 'permission_response', requestId: 1, answer: 'deny' }],
    ['a permission request', { type: 'permission_request', requestId: 'r', callId: '1:1' }],
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

describe('parseHostMessage chat messages', () => {
  it('accepts chat events, errors and closes and drops unknown fields', () => {
    expect(parseHostMessage({ type: 'chat_event', sessionId: 's-1', event: { type: 'assistant' }, x: 1 })).toEqual({
      type: 'chat_event',
      sessionId: 's-1',
      event: { type: 'assistant' },
    });
    expect(parseHostMessage({ type: 'chat_event', sessionId: 's', event: { type: 'user' }, reduced: true })).toEqual({
      type: 'chat_event',
      sessionId: 's',
      event: { type: 'user' },
      reduced: true,
    });
    expect(parseHostMessage({ type: 'chat_error', sessionId: 's', code: 'exited', message: 'gone', x: 1 })).toEqual({
      type: 'chat_error',
      sessionId: 's',
      code: 'exited',
      message: 'gone',
    });
    expect(parseHostMessage({ type: 'chat_closed', sessionId: 's', x: 1 })).toEqual({ type: 'chat_closed', sessionId: 's' });
  });

  it.each([
    ['an event without a valid session id', { type: 'chat_event', sessionId: 'a b', event: {} }],
    ['an event that is not an object', { type: 'chat_event', sessionId: 's', event: [] }],
    ['an error without a message', { type: 'chat_error', sessionId: 's', code: 'exited' }],
    ['an error without a code', { type: 'chat_error', sessionId: 's', message: 'x' }],
    ['a close without a session id', { type: 'chat_closed' }],
    ['a status response without a request id', { type: 'chat_status_response', found: true, ready: true }],
  ])('rejects %s', (_label, value) => {
    expect(parseHostMessage(value)).toBeUndefined();
  });

  it('accepts a status response with only the well-formed fields', () => {
    expect(
      parseHostMessage({
        type: 'chat_status_response',
        requestId: 'chat-status-1',
        found: true,
        path: '/usr/bin/claude',
        version: '2.1.316',
        versionOk: true,
        loggedIn: true,
        authMethod: 'claude.ai',
        ready: true,
        email: 'someone@example.com',
      }),
    ).toEqual({
      type: 'chat_status_response',
      requestId: 'chat-status-1',
      found: true,
      path: '/usr/bin/claude',
      version: '2.1.316',
      versionOk: true,
      loggedIn: true,
      authMethod: 'claude.ai',
      ready: true,
    });
    expect(parseHostMessage({ type: 'chat_status_response', requestId: 'r', found: 'yes', ready: 1, version: 2, error: 'e' })).toEqual({
      type: 'chat_status_response',
      requestId: 'r',
      found: false,
      ready: false,
      error: 'e',
    });
  });
});
