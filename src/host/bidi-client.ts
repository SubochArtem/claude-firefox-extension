import { createConnection } from 'node:net';
import { isRecord } from './protocol';

export const BIDI_PORT_ENV = 'CLAUDE_FIREFOX_BIDI_PORT';
export const DEFAULT_BIDI_PORT = 9222;
export const BIDI_CONNECT_TIMEOUT_MS = 5_000;
export const BIDI_COMMAND_TIMEOUT_MS = 5_000;

// An expected failure whose message is passed to the agent as is.
export class BidiError extends Error {}

// An error response from Firefox to one command; `code` is the BiDi error code.
export class BidiCommandError extends BidiError {
  constructor(
    readonly method: string,
    readonly code: string,
    readonly detail: string,
  ) {
    super(`Firefox WebDriver BiDi ${method} failed: ${code}${detail ? `: ${detail}` : ''}`);
  }
}

export function startFirefoxHint(port: number): string {
  return `Close every Firefox window and start Firefox with the --remote-debugging-port=${port} flag (for example \`firefox --remote-debugging-port=${port}\`). To use another port, start Firefox with that port and set ${BIDI_PORT_ENV} to it in the environment Firefox is started from: Firefox starts the native host, which inherits its environment.`;
}

export function bidiPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[BIDI_PORT_ENV]?.trim();
  if (raw === undefined || raw === '') return DEFAULT_BIDI_PORT;
  const port = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
  if (!(port >= 1 && port <= 65535)) {
    throw new BidiError(
      `${BIDI_PORT_ENV} must be a port number from 1 to 65535, received "${raw.slice(0, 32)}". Fix or unset it in the environment Firefox is started from and restart Firefox.`,
    );
  }
  return port;
}

function isPortClosed(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createConnection({ host: '127.0.0.1', port });
    probe.once('connect', () => {
      probe.destroy();
      resolve(false);
    });
    probe.once('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'ECONNREFUSED'));
  });
}

// Node's WebSocket reports no reason for a failed handshake, so a plain TCP probe tells a closed port
// apart from another program listening on it.
async function connectFailure(port: number): Promise<BidiError> {
  if (await isPortClosed(port)) {
    return new BidiError(`Firefox is not listening for WebDriver BiDi on port ${port}. ${startFirefoxHint(port)}`);
  }
  return new BidiError(
    `Could not open a WebDriver BiDi connection at ws://127.0.0.1:${port}/session: the port is open, but it did not accept a WebDriver BiDi WebSocket. Another program may be using port ${port}. ${startFirefoxHint(port)}`,
  );
}

interface PendingCommand {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface BidiConnection {
  command(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  // Rejects every command waiting for an answer and keeps the socket open for later commands.
  cancelPending(error: Error): void;
  close(): void;
}

export async function connectBidi(port: number, timeoutMs = BIDI_CONNECT_TIMEOUT_MS): Promise<BidiConnection> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/session`);
  const opened = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    const finish = (value: boolean) => {
      clearTimeout(timer);
      resolve(value);
    };
    socket.addEventListener('open', () => finish(true), { once: true });
    socket.addEventListener('error', () => finish(false), { once: true });
    socket.addEventListener('close', () => finish(false), { once: true });
  });
  if (!opened) {
    socket.close();
    throw await connectFailure(port);
  }

  const pending = new Map<number, PendingCommand>();
  let nextId = 1;
  let closed = false;

  const failAll = (error: Error) => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(error);
    }
  };

  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return;
    let message: unknown;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!isRecord(message) || typeof message['id'] !== 'number') return;
    const entry = pending.get(message['id']);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(message['id']);
    if (message['type'] === 'success') entry.resolve(message['result']);
    else {
      const code = typeof message['error'] === 'string' ? message['error'] : 'unknown error';
      const detail = typeof message['message'] === 'string' ? message['message'] : '';
      entry.reject(new BidiCommandError(entry.method, code, detail));
    }
  });
  socket.addEventListener('close', () => {
    closed = true;
    failAll(new BidiError('The WebDriver BiDi connection to Firefox closed unexpectedly'));
  });

  return {
    command(method, params, commandTimeoutMs = BIDI_COMMAND_TIMEOUT_MS) {
      if (closed) return Promise.reject(new BidiError('The WebDriver BiDi connection to Firefox is closed'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new BidiError(`Firefox did not answer WebDriver BiDi ${method} within ${commandTimeoutMs / 1000} s`));
        }, commandTimeoutMs);
        pending.set(id, { method, resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    cancelPending(error) {
      failAll(error);
    },
    close() {
      closed = true;
      failAll(new BidiError('The WebDriver BiDi connection to Firefox is closed'));
      socket.close();
    },
  };
}
