import { endianness } from 'node:os';
import { PassThrough, Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readNativeMessages, writeNativeMessage } from '../native-messaging';

function header(length: number): Buffer {
  const buffer = Buffer.alloc(4);
  if (endianness() === 'LE') buffer.writeUInt32LE(length, 0);
  else buffer.writeUInt32BE(length, 0);
  return buffer;
}

function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([header(body.length), body]);
}

// Emitting 'data' directly delivers each chunk synchronously and exactly as split by the test.
function feed(input: PassThrough, chunk: Buffer): void {
  input.emit('data', chunk);
}

function reader(): { input: PassThrough; messages: unknown[] } {
  const input = new PassThrough();
  const messages: unknown[] = [];
  readNativeMessages(input, (message) => messages.push(message));
  return { input, messages };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('writeNativeMessage', () => {
  it('writes a native-endian length header followed by the UTF-8 JSON body', () => {
    const output = new PassThrough();
    expect(writeNativeMessage(output, { type: 'pong', text: 'é' })).toBe(true);
    const written = output.read() as Buffer;
    const body = Buffer.from(JSON.stringify({ type: 'pong', text: 'é' }), 'utf8');
    expect(written.subarray(0, 4)).toEqual(header(body.length));
    expect(written.subarray(4)).toEqual(body);
  });

  it('refuses a message larger than 1 MB and writes nothing', () => {
    const output = new PassThrough();
    const write = vi.spyOn(output, 'write');
    expect(writeNativeMessage(output, { blob: 'a'.repeat(1024 * 1024) })).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/refused to send a \d+-byte native message/));
  });

  it('accepts a message of exactly 1 MB', () => {
    const output = new PassThrough();
    const overhead = JSON.stringify({ blob: '' }).length;
    expect(writeNativeMessage(output, { blob: 'a'.repeat(1024 * 1024 - overhead) })).toBe(true);
  });
});

describe('readNativeMessages', () => {
  it('round-trips messages written by writeNativeMessage', () => {
    const { input, messages } = reader();
    const sent = [{ type: 'ping' }, { type: 'tool_response', id: '1:1', result: { content: [] } }];
    const chunks: Buffer[] = [];
    const output = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    });
    for (const message of sent) writeNativeMessage(output, message);
    feed(input, Buffer.concat(chunks));
    expect(messages).toEqual(sent);
  });

  it('reassembles frames split at every byte, including inside the header', () => {
    const { input, messages } = reader();
    const bytes = Buffer.concat([frame({ a: 1 }), frame({ b: 'two' })]);
    for (let i = 0; i < bytes.length; i++) feed(input, bytes.subarray(i, i + 1));
    expect(messages).toEqual([{ a: 1 }, { b: 'two' }]);
  });

  it('parses several frames delivered in one chunk', () => {
    const { input, messages } = reader();
    feed(input, Buffer.concat([frame({ n: 1 }), frame({ n: 2 }), frame({ n: 3 })]));
    expect(messages).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('keeps a trailing partial frame until the rest arrives', () => {
    const { input, messages } = reader();
    const second = frame({ n: 2 });
    feed(input, Buffer.concat([frame({ n: 1 }), second.subarray(0, 6)]));
    expect(messages).toEqual([{ n: 1 }]);
    feed(input, second.subarray(6));
    expect(messages).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('decodes multibyte UTF-8 split across chunks using the byte length', () => {
    const { input, messages } = reader();
    const message = { text: 'Привет, 世界 🦊' };
    const bytes = frame(message);
    const splitInsideEmoji = bytes.length - 4;
    feed(input, bytes.subarray(0, splitInsideEmoji));
    expect(messages).toEqual([]);
    feed(input, bytes.subarray(splitInsideEmoji));
    expect(messages).toEqual([message]);
  });

  it('drops a frame with invalid JSON and keeps reading', () => {
    const { input, messages } = reader();
    const garbage = Buffer.from('{not json', 'utf8');
    feed(input, Buffer.concat([header(garbage.length), garbage, frame({ ok: true })]));
    expect(messages).toEqual([{ ok: true }]);
    expect(console.error).toHaveBeenCalledWith('[native-host] dropped invalid native message:', expect.any(SyntaxError));
  });

  it('destroys the input when a frame declares more than 64 MB', async () => {
    const { input, messages } = reader();
    const errored = new Promise<Error>((resolve) => input.once('error', resolve));
    feed(input, header(64 * 1024 * 1024 + 1));
    expect((await errored).message).toBe('native message too large');
    expect(input.destroyed).toBe(true);
    expect(messages).toEqual([]);
  });

  it('accepts a declared length of exactly 64 MB without destroying the input', () => {
    const { input } = reader();
    feed(input, header(64 * 1024 * 1024));
    expect(input.destroyed).toBe(false);
    input.destroy();
  });
});
