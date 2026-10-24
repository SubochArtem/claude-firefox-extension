import { endianness } from 'node:os';
import type { Readable, Writable } from 'node:stream';

const HEADER_BYTES = 4;
// Firefox drops the host when a single host-to-extension message exceeds 1 MB.
const MAX_OUTGOING_BYTES = 1024 * 1024;
const MAX_INCOMING_BYTES = 64 * 1024 * 1024;
const littleEndian = endianness() === 'LE';

export function readNativeMessages(input: Readable, onMessage: (message: unknown) => void): void {
  let buffered: Buffer = Buffer.alloc(0);
  input.on('data', (chunk: Buffer) => {
    buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
    while (buffered.length >= HEADER_BYTES) {
      const length = littleEndian ? buffered.readUInt32LE(0) : buffered.readUInt32BE(0);
      if (length > MAX_INCOMING_BYTES) {
        // A bogus length means the framing is lost and the stream cannot be resynced. Destroying
        // the input with an error makes the native host shut down through its stdin 'error' handler.
        console.error(`[native-host] incoming native message declares ${length} bytes (limit ${MAX_INCOMING_BYTES})`);
        input.destroy(new Error('native message too large'));
        return;
      }
      if (buffered.length < HEADER_BYTES + length) break;
      const body = buffered.subarray(HEADER_BYTES, HEADER_BYTES + length);
      buffered = buffered.subarray(HEADER_BYTES + length);
      let message: unknown;
      try {
        message = JSON.parse(body.toString('utf8'));
      } catch (error) {
        console.error('[native-host] dropped invalid native message:', error);
      }
      if (message !== undefined) onMessage(message);
    }
  });
}

export function writeNativeMessage(output: Writable, message: unknown): boolean {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > MAX_OUTGOING_BYTES) {
    console.error(`[native-host] refused to send a ${body.length}-byte native message (limit ${MAX_OUTGOING_BYTES})`);
    return false;
  }
  const header = Buffer.alloc(HEADER_BYTES);
  if (littleEndian) header.writeUInt32LE(body.length, 0);
  else header.writeUInt32BE(body.length, 0);
  output.write(Buffer.concat([header, body]));
  return true;
}
