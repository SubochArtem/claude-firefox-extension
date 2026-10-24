import type { Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readJsonLines, writeJsonLine } from '../json-lines';

const MAX_LINE_BYTES = 64 * 1024 * 1024;

// readJsonLines only uses 'data' events and destroy(), which a PassThrough provides.
function fakeSocket(): Socket {
  return new PassThrough() as unknown as Socket;
}

// Emitting 'data' directly delivers each chunk synchronously and exactly as split by the test.
function feed(socket: Socket, chunk: string | Buffer): void {
  socket.emit('data', typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
}

function reader(): { socket: Socket; messages: unknown[] } {
  const socket = fakeSocket();
  const messages: unknown[] = [];
  readJsonLines(socket, (message) => messages.push(message), '[test]');
  return { socket, messages };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('readJsonLines', () => {
  it('parses a line split across chunks', () => {
    const { socket, messages } = reader();
    feed(socket, '{"type":"tool_');
    feed(socket, 'request","id":"1"');
    expect(messages).toEqual([]);
    feed(socket, '}\n');
    expect(messages).toEqual([{ type: 'tool_request', id: '1' }]);
  });

  it('parses several lines in one chunk and keeps the unfinished tail', () => {
    const { socket, messages } = reader();
    feed(socket, '{"n":1}\n{"n":2}\n{"n":');
    expect(messages).toEqual([{ n: 1 }, { n: 2 }]);
    feed(socket, '3}\n');
    expect(messages).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('decodes multibyte characters split across chunks', () => {
    const { socket, messages } = reader();
    const bytes = Buffer.from('{"text":"Привет 🦊"}\n', 'utf8');
    for (let i = 0; i < bytes.length; i++) feed(socket, bytes.subarray(i, i + 1));
    expect(messages).toEqual([{ text: 'Привет 🦊' }]);
  });

  it('skips blank lines and surrounding whitespace', () => {
    const { socket, messages } = reader();
    feed(socket, '\n  \r\n {"ok":true} \r\n');
    expect(messages).toEqual([{ ok: true }]);
  });

  it('skips an invalid JSON line and keeps reading', () => {
    const { socket, messages } = reader();
    feed(socket, '{oops\n{"after":1}\n');
    expect(messages).toEqual([{ after: 1 }]);
    expect(console.error).toHaveBeenCalledWith('[test] dropped invalid JSON line:', expect.any(SyntaxError));
    expect(socket.destroyed).toBe(false);
  });

  it('delivers JSON null and other non-object values to the handler', () => {
    const { socket, messages } = reader();
    feed(socket, 'null\n42\n"s"\n');
    expect(messages).toEqual([null, 42, 's']);
  });

  it('closes the connection when an unterminated line exceeds 64 MB', () => {
    const { socket, messages } = reader();
    feed(socket, Buffer.alloc(MAX_LINE_BYTES, 0x61));
    expect(socket.destroyed).toBe(false);
    feed(socket, Buffer.from('a'));
    expect(socket.destroyed).toBe(true);
    expect(messages).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(`[test] JSON line exceeds ${MAX_LINE_BYTES} bytes, closing the connection`);
  });

  it('closes the connection when a terminated line exceeds 64 MB', () => {
    const { socket, messages } = reader();
    feed(socket, Buffer.alloc(MAX_LINE_BYTES - 1, 0x20));
    feed(socket, Buffer.from('ab\n{"later":1}\n'));
    expect(socket.destroyed).toBe(true);
    expect(messages).toEqual([]);
  });
});

describe('writeJsonLine', () => {
  it('writes the message as one JSON line and reports completion', async () => {
    const socket = fakeSocket();
    const written = new Promise<Error | null | undefined>((resolve) =>
      writeJsonLine(socket, { type: 'tool_response', text: 'a\nb' }, resolve),
    );
    expect(await written).toBeFalsy();
    expect(String(socket.read())).toBe('{"type":"tool_response","text":"a\\nb"}\n');
  });
});
