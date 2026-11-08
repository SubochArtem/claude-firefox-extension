import { describe, expect, it, vi } from 'vitest';
import { chatEventMessage, createLineReader, parseClaudeLine } from '../chat-events';
import { MAX_OUTGOING_BYTES } from '../native-messaging';

function bytes(message: unknown): number {
  return Buffer.byteLength(JSON.stringify(message));
}

describe('createLineReader', () => {
  it('joins lines split across chunks and anywhere inside a multi-byte character', () => {
    const lines: string[] = [];
    const read = createLineReader((line) => lines.push(line));
    const text = Buffer.from('{"a":"é"}\n\n{"b":2}\r\npartial', 'utf8');
    for (let i = 0; i < text.length; i++) read(text.subarray(i, i + 1));
    expect(lines).toEqual(['{"a":"é"}', '{"b":2}']);
    read(Buffer.from(' end\n'));
    expect(lines.at(-1)).toBe('partial end');
  });

  it('drops an oversized line up to its newline and reads on after it', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const lines: string[] = [];
    const read = createLineReader((line) => lines.push(line), 10);
    read(Buffer.from('0123456789abc'));
    read(Buffer.from('def\nok\n'));
    read(Buffer.from('also-too-long-line\nfine\n'));
    expect(lines).toEqual(['ok', 'fine']);
  });
});

describe('parseClaudeLine', () => {
  it('accepts JSON objects with a type and ignores anything else', () => {
    expect(parseClaudeLine('{"type":"result","subtype":"success"}')).toEqual({ type: 'result', subtype: 'success' });
    expect(parseClaudeLine('not json')).toBeUndefined();
    expect(parseClaudeLine('[1,2]')).toBeUndefined();
    expect(parseClaudeLine('{"subtype":"x"}')).toBeUndefined();
    expect(parseClaudeLine('"text"')).toBeUndefined();
  });
});

describe('chatEventMessage', () => {
  it('forwards a small event as it is', () => {
    const event = { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } };
    expect(chatEventMessage('s1', event)).toEqual({ type: 'chat_event', sessionId: 's1', event });
  });

  it('replaces images first and keeps the rest of the event', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'A'.repeat(2_000) } };
    const event = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'shot' }, image] }] },
    };
    const message = chatEventMessage('s1', event, 1_000);
    expect(message.reduced).toBe(true);
    expect(message.event).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [
              { type: 'text', text: 'shot' },
              { type: 'text', text: '[image omitted: too large to forward]' },
            ],
          },
        ],
      },
    });
    expect(bytes(message)).toBeLessThanOrEqual(1_000);
  });

  it('then replaces large tool result content with a marker', () => {
    const event = {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(5_000) }, { type: 'text', text: 'kept' }] },
    };
    const message = chatEventMessage('s1', event, 2_000);
    expect(message.event).toEqual({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '[tool result omitted: too large to forward]' }] },
          { type: 'text', text: 'kept' },
        ],
      },
    });
    expect(bytes(message)).toBeLessThanOrEqual(2_000);
  });

  it('then clips long strings anywhere in the event', () => {
    const event = { type: 'assistant', message: { content: [{ type: 'text', text: 'y'.repeat(50_000) }] } };
    const message = chatEventMessage('s1', event, 20_000);
    expect(message.reduced).toBe(true);
    const text = (message.event as { message: { content: { text: string }[] } }).message.content[0]?.text ?? '';
    expect(text.startsWith('yyy')).toBe(true);
    expect(text.endsWith('[clipped: too large to forward]')).toBe(true);
    expect(bytes(message)).toBeLessThanOrEqual(20_000);
  });

  it('falls back to a summary of the event when nothing else fits', () => {
    const event = { type: 'system', subtype: 'init', session_id: 'abc', tools: Array.from({ length: 5_000 }, (_, i) => `tool_${i}`) };
    const message = chatEventMessage('s1', event, 2_000);
    expect(message).toEqual({ type: 'chat_event', sessionId: 's1', event: { type: 'system', subtype: 'init', session_id: 'abc' }, reduced: true });
  });

  it('stays under the default native messaging limit for a 2 MB screenshot', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'A'.repeat(2 * 1024 * 1024) } };
    const message = chatEventMessage('s1', { type: 'user', message: { content: [{ type: 'tool_result', content: [image] }] } });
    expect(message.reduced).toBe(true);
    expect(bytes(message)).toBeLessThan(1024 * 1024);
  });

  it('measures the limit in UTF-8 bytes, not characters', () => {
    const event = { type: 'assistant', message: { content: [{ type: 'text', text: '€'.repeat(400_000) }] } };
    const message = chatEventMessage('s1', event);
    expect(message.reduced).toBe(true);
    expect(bytes(message)).toBeLessThanOrEqual(MAX_OUTGOING_BYTES);
    const smaller = chatEventMessage('s1', event, 100_000);
    expect(smaller.reduced).toBe(true);
    expect(bytes(smaller)).toBeLessThanOrEqual(100_000);
  });
});
