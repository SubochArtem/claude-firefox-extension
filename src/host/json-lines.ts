import type { Socket } from 'node:net';

const NEWLINE = 0x0a;
const MAX_LINE_BYTES = 64 * 1024 * 1024;

export function readJsonLines(socket: Socket, onMessage: (message: unknown) => void, logPrefix: string): void {
  // Raw bytes, not decoded strings: '\n' never occurs inside a multi-byte UTF-8 sequence, so only
  // the new chunk has to be scanned, and parts are joined once per line.
  let parts: Buffer[] = [];
  let partsBytes = 0;
  socket.on('data', (chunk: Buffer) => {
    let start = 0;
    let newline = chunk.indexOf(NEWLINE);
    while (newline !== -1) {
      if (partsBytes + newline - start > MAX_LINE_BYTES) {
        overflow(socket, logPrefix);
        return;
      }
      parts.push(chunk.subarray(start, newline));
      const line = Buffer.concat(parts).toString('utf8').trim();
      parts = [];
      partsBytes = 0;
      if (line !== '') {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch (error) {
          console.error(`${logPrefix} dropped invalid JSON line:`, error);
        }
        if (message !== undefined) onMessage(message);
      }
      start = newline + 1;
      newline = chunk.indexOf(NEWLINE, start);
    }
    if (start < chunk.length) {
      parts.push(chunk.subarray(start));
      partsBytes += chunk.length - start;
      if (partsBytes > MAX_LINE_BYTES) overflow(socket, logPrefix);
    }
  });
}

function overflow(socket: Socket, logPrefix: string): void {
  console.error(`${logPrefix} JSON line exceeds ${MAX_LINE_BYTES} bytes, closing the connection`);
  socket.destroy();
}

export function writeJsonLine(socket: Socket, message: unknown, onWritten?: (error?: Error | null) => void): void {
  socket.write(`${JSON.stringify(message)}\n`, onWritten);
}
