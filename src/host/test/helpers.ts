import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { endianness, tmpdir } from 'node:os';
import { createConnection, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { inject, onTestFinished } from 'vitest';

export const APP_DIR = 'claude-firefox-extension';
const WAIT_TIMEOUT_MS = 4_000;
const littleEndian = endianness() === 'LE';
const isWindows = process.platform === 'win32';

// The variable that points the host and the MCP server at a test's runtime dir: the Unix socket
// directory lives under XDG_RUNTIME_DIR, bridge.json on Windows under LOCALAPPDATA.
export const RUNTIME_DIR_VAR = isWindows ? 'LOCALAPPDATA' : 'XDG_RUNTIME_DIR';

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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, ms));
}

// Short paths under the literal /tmp keep the socket path far below the 107-byte sun_path limit. On
// Windows the directory stands in for LOCALAPPDATA.
export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(process.platform === 'win32' ? join(tmpdir(), 'cfe-') : '/tmp/cfe-');
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export function socketPathIn(runtimeDir: string): string {
  return join(runtimeDir, APP_DIR, 'bridge.sock');
}

export function bridgeInfoPathIn(runtimeDir: string): string {
  return join(runtimeDir, APP_DIR, 'bridge.json');
}

// A fresh endpoint for a test listener: a socket file in `dir`, or on Windows a random pipe name in
// the format the host uses.
export function newEndpoint(dir: string, name: string): string {
  return isWindows ? `\\\\.\\pipe\\${APP_DIR}-${randomHex(16)}` : join(dir, `${name}.sock`);
}

// The endpoint of the host serving runtimeDir. A pipe name is random, so on Windows it is only known
// from bridge.json while that host runs.
export function endpointIn(runtimeDir: string): string {
  return isWindows ? readBridgeJson(bridgeInfoPathIn(runtimeDir)).endpoint : socketPathIn(runtimeDir);
}

// A socket file is checked on disk; a pipe exists while something can connect to it.
export async function endpointExists(endpoint: string): Promise<boolean> {
  if (!isWindows) return existsSync(endpoint);
  return new Promise((resolve) => {
    const socket = createConnection(endpoint);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

export interface BridgeTarget {
  readonly endpoint: string;
  readonly bridgeInfoPath: string;
}

export function bridgeTargetIn(runtimeDir: string): BridgeTarget {
  return {
    get endpoint() {
      return endpointIn(runtimeDir);
    },
    bridgeInfoPath: bridgeInfoPathIn(runtimeDir),
  };
}

// The environment for a native host child serving runtimeDir.
export function hostEnv(runtimeDir: string): NodeJS.ProcessEnv {
  return isWindows ? childEnv({ LOCALAPPDATA: runtimeDir }) : { ...process.env, XDG_RUNTIME_DIR: runtimeDir };
}

export interface BridgeJson {
  version: number;
  endpoint: string;
  secret: string;
  pid: number;
}

export function readBridgeJson(path: string): BridgeJson {
  return JSON.parse(readFileSync(path, 'utf8')) as BridgeJson;
}

export function randomHex(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

// Independent of ../handshake on purpose, so the process tests check the wire format, not the module.
export function proof(secret: string, label: 'host' | 'client', clientNonce: string, serverNonce: string): string {
  return createHmac('sha256', Buffer.from(secret, 'hex')).update(`${label}:${clientNonce}:${serverNonce}`, 'utf8').digest('hex');
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

export interface FakeExtension extends ChildHandle, BridgeTarget {
  // The Unix socket path; meaningless on Windows, where `endpoint` is the pipe from bridge.json.
  socketPath: string;
  received: unknown[];
  stdoutBytes: () => number;
  send: (message: unknown) => void;
  sendRaw: (bytes: Buffer) => void;
  nextRequest: () => Promise<Record<string, unknown>>;
  respondWith: (handler: (request: Record<string, unknown>) => unknown) => void;
}

// Runs the built native host the way Firefox does and plays the extension on its stdio. `env`
// replaces the default environment (the test's own pointed at runtimeDir, see hostEnv).
export async function startHost(
  runtimeDir: string,
  { waitUntilListening = true, env }: { waitUntilListening?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<FakeExtension> {
  const child = spawn(process.execPath, [hostEntry, '--native-host'], {
    env: env ?? hostEnv(runtimeDir),
  });
  const handle = track(child);
  const received: unknown[] = [];
  let consumed = 0;
  let handler: ((request: Record<string, unknown>) => unknown) | undefined;
  let buffered = Buffer.alloc(0);
  let stdoutBytes = 0;
  child.stdin.on('error', () => {});
  const send = (message: unknown): void => {
    child.stdin.write(encodeNativeMessage(message));
  };
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.length;
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
  let pipeName: string | undefined;
  const host: FakeExtension = {
    ...handle,
    socketPath: socketPathIn(runtimeDir),
    // On Windows, taken from bridge.json once it names this host, so another host's file never counts.
    get endpoint(): string {
      if (!isWindows) return socketPathIn(runtimeDir);
      if (pipeName === undefined) {
        const info = readBridgeJson(bridgeInfoPathIn(runtimeDir));
        if (info.pid !== child.pid) throw new Error(`bridge.json names pid ${info.pid}, not this host (${String(child.pid)})`);
        pipeName = info.endpoint;
      }
      return pipeName;
    },
    bridgeInfoPath: bridgeInfoPathIn(runtimeDir),
    received,
    stdoutBytes: () => stdoutBytes,
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

// Builds a child environment from `base` (process.env by default) with every key named in
// `overrides` removed case-insensitively, then sets the overrides that are not undefined. Windows
// environment names are case-insensitive, but a copied env object is not, so a plain spread could
// leave both 'LocalAppData' and 'LOCALAPPDATA' in place.
export function childEnv(
  overrides: Record<string, string | undefined>,
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const replaced = new Set(Object.keys(overrides).map((key) => key.toUpperCase()));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !replaced.has(key.toUpperCase())) env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) if (value !== undefined) env[key] = value;
  return env;
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
  isClosed: () => boolean;
}

// A bridge connection without the handshake: one JSON object per line in both directions.
export async function connectRaw(endpoint: string): Promise<BridgeClient> {
  return (await openClient(endpoint)).client;
}

// Connects the way the MCP server does: performs the handshake with the secret from the target's
// bridge.json (or the one given with an endpoint), checks the host proof, and waits for ready. The
// handshake lines are then dropped, so `lines` and `nextLine` only see tool traffic.
export async function connectClient(target: BridgeTarget): Promise<BridgeClient>;
export async function connectClient(endpoint: string, secret: string): Promise<BridgeClient>;
export async function connectClient(target: BridgeTarget | string, secret?: string): Promise<BridgeClient> {
  const endpoint = typeof target === 'string' ? target : target.endpoint;
  const key = typeof target === 'string' ? secret : readBridgeJson(target.bridgeInfoPath).secret;
  if (key === undefined) throw new Error('connectClient needs a secret with a bare endpoint');
  const { client, forget } = await openClient(endpoint);
  const clientNonce = randomHex();
  client.send({ type: 'hello', nonce: clientNonce });
  const hello = await client.nextLine();
  const serverNonce = hello['nonce'];
  if (hello['type'] !== 'hello' || typeof serverNonce !== 'string') throw new Error(`unexpected host hello ${JSON.stringify(hello)}`);
  if (hello['proof'] !== proof(key, 'host', clientNonce, serverNonce)) throw new Error('the host proof is wrong');
  client.send({ type: 'auth', proof: proof(key, 'client', clientNonce, serverNonce) });
  const ready = await client.nextLine();
  if (ready['type'] !== 'ready') throw new Error(`expected ready, got ${JSON.stringify(ready)}`);
  forget();
  return client;
}

async function openClient(endpoint: string): Promise<{ client: BridgeClient; forget: () => void }> {
  const socket = createConnection(endpoint);
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
  let isClosed = false;
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    const parts = (partial + chunk).split('\n');
    partial = parts.pop() ?? '';
    for (const part of parts) if (part.trim() !== '') lines.push(JSON.parse(part) as Record<string, unknown>);
  });
  const closed = new Promise<void>((resolve) =>
    socket.once('close', () => {
      isClosed = true;
      resolve();
    }),
  );
  const client: BridgeClient = {
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
    isClosed: () => isClosed,
  };
  const forget = (): void => {
    lines.splice(0, consumed);
    consumed = 0;
  };
  return { client, forget };
}

export type FakeHostMode =
  | 'normal'
  | 'wrong-secret'
  | 'replay-proof'
  | 'short-proof'
  | 'non-hex-proof'
  | 'silent'
  | 'close-after-hello'
  | 'ready-without-hello'
  | 'no-ready'
  | 'close-after-ready'
  | 'response-after-hello'
  | 'response-instead-of-ready';

// The id the MCP server gives its first tool request, which the 'response-*' modes answer early.
export const FIRST_REQUEST_ID = '1';
export const INJECTED_TEXT = 'injected before ready';

export interface FakeHost {
  endpoint: string;
  secret: string;
  received: Record<string, unknown>[];
  requests: Record<string, unknown>[];
  connections: () => number;
  closedConnections: () => number;
  answer: (message: unknown) => void;
  respondWith: (handler: (request: Record<string, unknown>) => unknown) => void;
  close: () => Promise<void>;
}

// Plays the native host on the bridge socket in the test process and writes a matching bridge.json.
// 'normal' runs the host side of the handshake; the other modes break it in one specific way:
// - 'wrong-secret' proves a different secret;
// - 'replay-proof' answers every hello with one fixed server nonce and a genuine host proof for it,
//   computed with the right secret but for another client nonce, as if captured from an earlier
//   handshake;
// - 'short-proof' and 'non-hex-proof' send a malformed proof;
// - 'response-after-hello' writes a tool_response for the first request id in the same write as its
//   hello, then completes the handshake;
// - 'response-instead-of-ready' accepts the auth but sends that tool_response instead of ready;
// - 'close-after-ready' sends ready and ends the connection in the same call.
// Every line the MCP server sends lands in `received`; `requests` holds the lines that are not part
// of the handshake.
export async function startFakeHost(runtimeDir: string, mode: FakeHostMode = 'normal'): Promise<FakeHost> {
  mkdirSync(join(runtimeDir, APP_DIR), { recursive: true, mode: 0o700 });
  const secret = randomHex();
  const endpoint = newEndpoint(join(runtimeDir, APP_DIR), 'bridge');
  const received: Record<string, unknown>[] = [];
  const requests: Record<string, unknown>[] = [];
  const sockets: Socket[] = [];
  let closedConnections = 0;
  const replayedServerNonce = randomHex();
  const replayedProof = proof(secret, 'host', randomHex(), replayedServerNonce);
  const injected = textResult(FIRST_REQUEST_ID, INJECTED_TEXT);
  let handler: ((request: Record<string, unknown>) => unknown) | undefined;
  const toLine = (message: unknown): string => `${JSON.stringify(message)}\n`;
  const write = (socket: Socket, message: unknown): void => {
    socket.write(toLine(message));
  };
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => {});
    socket.on('close', () => closedConnections++);
    let clientNonce: string | undefined;
    let serverNonce: string | undefined;
    let partial = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      const lines = (partial + chunk).split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim() === '') continue;
        const message = JSON.parse(line) as Record<string, unknown>;
        received.push(message);
        if (message['type'] === 'hello') {
          clientNonce = String(message['nonce']);
          serverNonce = mode === 'replay-proof' ? replayedServerNonce : randomHex();
          const hostProof = proof(mode === 'wrong-secret' ? randomHex() : secret, 'host', clientNonce, serverNonce);
          if (mode === 'silent') continue;
          if (mode === 'close-after-hello') socket.destroy();
          else if (mode === 'ready-without-hello') write(socket, { type: 'ready' });
          else if (mode === 'replay-proof') write(socket, { type: 'hello', nonce: serverNonce, proof: replayedProof });
          else if (mode === 'short-proof') write(socket, { type: 'hello', nonce: serverNonce, proof: hostProof.slice(0, 62) });
          else if (mode === 'non-hex-proof') write(socket, { type: 'hello', nonce: serverNonce, proof: 'zz'.repeat(32) });
          else if (mode === 'response-after-hello') {
            socket.write(toLine({ type: 'hello', nonce: serverNonce, proof: hostProof }) + toLine(injected));
          } else write(socket, { type: 'hello', nonce: serverNonce, proof: hostProof });
        } else if (message['type'] === 'auth') {
          if (mode === 'no-ready') continue;
          if (clientNonce && serverNonce && message['proof'] === proof(secret, 'client', clientNonce, serverNonce)) {
            if (mode === 'close-after-ready') socket.end(toLine({ type: 'ready' }));
            else write(socket, mode === 'response-instead-of-ready' ? injected : { type: 'ready' });
          } else socket.destroy();
        } else {
          requests.push(message);
          const response = handler?.(message);
          if (response !== undefined) write(socket, response);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(endpoint, resolve));
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }));
  onTestFinished(close);
  writeFileSync(bridgeInfoPathIn(runtimeDir), JSON.stringify({ version: 1, endpoint, secret, pid: process.pid }), {
    mode: 0o600,
  });
  return {
    endpoint,
    secret,
    received,
    requests,
    connections: () => sockets.length,
    closedConnections: () => closedConnections,
    answer: (message) => {
      const socket = sockets.at(-1);
      if (socket) write(socket, message);
    },
    respondWith: (next) => {
      handler = next;
    },
    close,
  };
}
