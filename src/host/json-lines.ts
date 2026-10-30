import type { Socket } from 'node:net';

const NEWLINE = 0x0a;
export const MAX_LINE_BYTES = 64 * 1024 * 1024;

export interface JsonLinesOptions {
  // Read again for every check, so a connection can raise its limit once the peer is trusted.
  maxLineBytes?: () => number;
  onInvalidJson?: () => void;
  // Runs right before an oversized line closes the connection.
  onOverflow?: () => void;
}

export function readJsonLines(
  socket: Socket,
  onMessage: (message: unknown) => void,
  logPrefix: string,
  { maxLineBytes = () => MAX_LINE_BYTES, onInvalidJson, onOverflow }: JsonLinesOptions = {},
): void {
  // Raw bytes, not decoded strings: '\n' never occurs inside a multi-byte UTF-8 sequence, so only
  // the new chunk has to be scanned, and parts are joined once per line.
  let parts: Buffer[] = [];
  let partsBytes = 0;
  socket.on('data', (chunk: Buffer) => {
    let start = 0;
    let newline = chunk.indexOf(NEWLINE);
    while (newline !== -1) {
      if (partsBytes + newline - start > maxLineBytes()) {
        overflow(socket, logPrefix, maxLineBytes(), onOverflow);
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
          onInvalidJson?.();
        }
        if (message !== undefined) onMessage(message);
      }
      // A handler may close the connection; lines that arrived in the same chunk must not be handled.
      if (socket.destroyed) return;
      start = newline + 1;
      newline = chunk.indexOf(NEWLINE, start);
    }
    if (start < chunk.length) {
      parts.push(chunk.subarray(start));
      partsBytes += chunk.length - start;
      if (partsBytes > maxLineBytes()) overflow(socket, logPrefix, maxLineBytes(), onOverflow);
    }
  });
}

function overflow(socket: Socket, logPrefix: string, limit: number, onOverflow?: () => void): void {
  console.error(`${logPrefix} JSON line exceeds ${limit} bytes, closing the connection`);
  onOverflow?.();
  socket.destroy();
}

export function writeJsonLine(socket: Socket, message: unknown, onWritten?: (error?: Error | null) => void): void {
  socket.write(`${JSON.stringify(message)}\n`, onWritten);
}
