import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { endianness } from 'node:os';
import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';
import { inject, onTestFinished } from 'vitest';

export const APP_DIR = 'claude-firefox-extension';
const WAIT_TIMEOUT_MS = 4_000;
const littleEndian = endianness() === 'LE';

export const hostEntry = inject('hostEntry');

// Captured before any test installs fake timers. vi.waitFor is not used because it advances fake
// time on every poll, which would shift the timeouts under test.
const realSetTimeout = globalThis.setTimeout;
const POLL_INTERVAL_MS = 5;

export async function waitFor<T>(check: () => T | Promise<T>, timeout = WAIT_TIMEOUT_MS): Promise<T> {
  for (let waited = 0; ; waited += POLL_INTERVAL_MS) {
    try {
      return await check();
    } catch (error) {
      if (waited >= timeout) throw error;
    }
    await new Promise((resolve) => realSetTimeout(resolve, POLL_INTERVAL_MS));
  }
}

// Short paths under the literal /tmp keep the socket path far below the 107-byte sun_path limit.
export async function tempDir(): Promise<string> {
  const dir = await mkdtemp('/tmp/cfe-');
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export function socketPathIn(runtimeDir: string): string {
  return join(runtimeDir, APP_DIR, 'bridge.sock');
}

export function encodeNativeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([nativeHeader(body.length), body]);
}

export function nativeLength(buffer: Buffer, offset = 0): number {
  return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
}

export function nativeHeader(length: number): Buffer {
  const header = Buffer.alloc(4);
  if (littleEndian) header.writeUInt32LE(length, 0);
  else header.writeUInt32BE(length, 0);
  return header;
}

export interface ChildHandle {
  child: ChildProcessWithoutNullStreams;
  stderr: () => string;
  exited: Promise<number | null>;
  waitForStderr: (pattern: RegExp) => Promise<void>;
}

// Every child is killed and awaited when the test ends, whether it passed or not.
export function track(child: ChildProcessWithoutNullStreams): ChildHandle {
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  return {
    child,
    stderr: () => stderr,
    exited,
    waitForStderr: (pattern) =>
      waitFor(() => {
        if (!pattern.test(stderr)) throw new Error(`stderr does not match ${pattern}:\n${stderr}`);
      }),
  };
}

export interface FakeExtension extends ChildHandle {
  socketPath: string;
  received: unknown[];
  send: (message: unknown) => void;
  sendRaw: (bytes: Buffer) => void;
  nextRequest: () => Promise<Record<string, unknown>>;
  respondWith: (handler: (request: Record<string, unknown>) => unknown) => void;
}

// Runs the built native host the way Firefox does and plays the extension on its stdio.
export async function startHost(runtimeDir: string, { waitUntilListening = true } = {}): Promise<FakeExtension> {
  const child = spawn(process.execPath, [hostEntry, '--native-host'], {
    env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir },
  });
  const handle = track(child);
  const received: unknown[] = [];
  let consumed = 0;
  let handler: ((request: Record<string, unknown>) => unknown) | undefined;
  let buffered = Buffer.alloc(0);
  child.stdin.on('error', () => {});
  const send = (message: unknown): void => {
    child.stdin.write(encodeNativeMessage(message));
  };
  child.stdout.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const length = nativeLength(buffered);
      if (buffered.length < 4 + length) break;
      const message = JSON.parse(buffered.subarray(4, 4 + length).toString('utf8')) as Record<string, unknown>;
      buffered = buffered.subarray(4 + length);
      received.push(message);
      if (handler && message['type'] === 'tool_request') {
        const response = handler(message);
        if (response !== undefined) send(response);
      }
    }
  });
  const host: FakeExtension = {
    ...handle,
    socketPath: socketPathIn(runtimeDir),
    received,
    send,
    sendRaw: (bytes) => child.stdin.write(bytes),
    nextRequest: () =>
      waitFor(() => {
        const index = received.findIndex(
          (message, i) => i >= consumed && (message as Record<string, unknown>)['type'] === 'tool_request',
        );
        if (index === -1) throw new Error('no tool request reached the fake extension');
        consumed = index + 1;
        return received[index] as Record<string, unknown>;
      }),
    respondWith: (next) => {
      handler = next;
    },
  };
  if (waitUntilListening) {
    await waitFor(() => {
      if (/listening on/.test(handle.stderr())) return;
      if (child.exitCode !== null) throw new Error(`native host exited early:\n${handle.stderr()}`);
      throw new Error(`native host is not listening yet:\n${handle.stderr()}`);
    });
  }
  return host;
}

export function textResult(id: unknown, text: string): unknown {
  return { type: 'tool_response', id, result: { content: [{ type: 'text', text }] } };
}

export interface BridgeClient {
  socket: Socket;
  lines: Record<string, unknown>[];
  send: (message: unknown) => void;
  nextLine: () => Promise<Record<string, unknown>>;
  closed: Promise<void>;
}

// Talks to the bridge socket the way the MCP server does: one JSON object per line.
export async function connectClient(socketPath: string): Promise<BridgeClient> {
  const socket = createConnection(socketPath);
  onTestFinished(() => {
    socket.destroy();
  });
  socket.on('error', () => {});
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const lines: Record<string, unknown>[] = [];
  let consumed = 0;
  let partial = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    const parts = (partial + chunk).split('\n');
    partial = parts.pop() ?? '';
    for (const part of parts) if (part.trim() !== '') lines.push(JSON.parse(part) as Record<string, unknown>);
  });
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  return {
    socket,
    lines,
    send: (message) => socket.write(`${JSON.stringify(message)}\n`),
    nextLine: () =>
      waitFor(() => {
        const line = lines[consumed];
        if (!line) throw new Error('no line from the native host yet');
        consumed++;
        return line;
      }),
    closed,
  };
}
