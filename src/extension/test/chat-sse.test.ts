import { describe, expect, it } from 'vitest';
import { SseParser, type SseEvent } from '../chat/sse';

function parseAll(chunks: string[]): SseEvent[] {
  const parser = new SseParser();
  return chunks.flatMap((chunk) => parser.push(chunk));
}

const STREAM = 'event: message_start\ndata: {"a":1}\n\nevent: ping\ndata: {"type": "ping"}\n\n';

describe('SseParser', () => {
  it('parses event and data lines into events', () => {
    expect(parseAll([STREAM])).toEqual([
      { event: 'message_start', data: '{"a":1}' },
      { event: 'ping', data: '{"type": "ping"}' },
    ]);
  });

  it('gives the same events for every split point', () => {
    const whole = parseAll([STREAM]);
    for (let i = 0; i <= STREAM.length; i++) {
      expect(parseAll([STREAM.slice(0, i), STREAM.slice(i)])).toEqual(whole);
    }
    expect(parseAll([...STREAM])).toEqual(whole);
  });

  it('accepts CRLF and CR line endings, also split between chunks', () => {
    const crlf = 'event: a\r\ndata: 1\r\n\r\nevent: b\rdata: 2\r\r: end\n';
    const expected = [
      { event: 'a', data: '1' },
      { event: 'b', data: '2' },
    ];
    expect(parseAll([crlf])).toEqual(expected);
    for (let i = 0; i <= crlf.length; i++) {
      expect(parseAll([crlf.slice(0, i), crlf.slice(i)])).toEqual(expected);
    }
  });

  it('ends a line held at a trailing CR when the stream is flushed', () => {
    const parser = new SseParser();
    expect(parser.push('data: 1\r\r')).toEqual([]);
    expect(parser.flush()).toEqual([{ event: 'message', data: '1' }]);
    expect(parser.flush()).toEqual([]);
  });

  it('discards an unterminated last line on flush', () => {
    const parser = new SseParser();
    expect(parser.push('data: 1\n\ndata: 2')).toEqual([{ event: 'message', data: '1' }]);
    expect(parser.flush()).toEqual([]);
    expect(parser.push('\n\n')).toEqual([]);
  });

  it('joins several data lines with a newline', () => {
    expect(parseAll(['data: one\ndata: two\n\n'])).toEqual([{ event: 'message', data: 'one\ntwo' }]);
  });

  it('defaults the event name to message', () => {
    expect(parseAll(['data: x\n\n'])).toEqual([{ event: 'message', data: 'x' }]);
  });

  it('strips only one leading space and accepts values without a space', () => {
    expect(parseAll(['event:e\ndata:  x\n\n'])).toEqual([{ event: 'e', data: ' x' }]);
  });

  it('ignores comments, unknown fields and blank lines without data', () => {
    expect(parseAll([': comment\n\nid: 5\nretry: 10\n\nevent: e\nfoo\ndata: d\n\n'])).toEqual([{ event: 'e', data: 'd' }]);
  });

  it('does not dispatch an event that has no terminating blank line yet', () => {
    const parser = new SseParser();
    expect(parser.push('event: e\ndata: d\n')).toEqual([]);
    expect(parser.push('\n')).toEqual([{ event: 'e', data: 'd' }]);
  });

  it('resets the event name after each event', () => {
    expect(parseAll(['event: a\ndata: 1\n\ndata: 2\n\n'])).toEqual([
      { event: 'a', data: '1' },
      { event: 'message', data: '2' },
    ]);
  });
});
