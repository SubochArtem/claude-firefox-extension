import { lstatSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { readJsonLines, writeJsonLine } from './json-lines';
import { readNativeMessages, writeNativeMessage } from './native-messaging';
import {
  errorResponse,
  parseExtensionMessage,
  parseToolRequest,
  TOOL_REQUEST_TIMEOUT_MS,
  type HostToExtensionMessage,
  type ToolRequest,
  type ToolResponse,
} from './protocol';
import { bridgeSocketPath, prepareBridgeSocketDir, restrictBridgeSocket } from './socket-path';

const LOG = '[native-host]';
const SHUTDOWN_GRACE_MS = 1000;
// Longer than the MCP server's own timeout, so the MCP side reports the timeout first; this one
// only frees requests the extension never answers.
const HOST_REQUEST_TIMEOUT_MS = TOOL_REQUEST_TIMEOUT_MS + 5_000;

interface Client {
  id: number;
  socket: Socket;
  pendingIds: Set<string>;
}

interface PendingRequest {
  client: Client;
  originalId: string;
  timer: NodeJS.Timeout;
}

interface SocketIdentity {
  dev: number;
  ino: number;
}

const clients = new Map<number, Client>();
const pending = new Map<string, PendingRequest>();
let nextClientId = 1;
let shuttingDown = false;
// Undefined until this process has bound the socket path and recorded what it created there.
let socketIdentity: SocketIdentity | undefined;

function isSocketAlive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createConnection(path);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function isOwnSocket(path: string, identity: SocketIdentity): boolean {
  try {
    const stats = lstatSync(path);
    return stats.dev === identity.dev && stats.ino === identity.ino;
  } catch {
    return false;
  }
}

function sendToExtension(message: HostToExtensionMessage): boolean {
  if (shuttingDown) return false;
  return writeNativeMessage(process.stdout, message);
}

function respond(client: Client, response: ToolResponse): void {
  if (!client.socket.destroyed) writeJsonLine(client.socket, response);
}

function handleClientRequest(client: Client, message: unknown): void {
  const request = parseToolRequest(message);
  if (!request) {
    console.error(`${LOG} client ${client.id} sent an invalid message`);
    return;
  }
  const globalId = `${client.id}:${request.id}`;
  if (pending.has(globalId)) {
    respond(client, errorResponse(request.id, `Duplicate request id ${request.id}`));
    return;
  }
  const forwarded: ToolRequest = { ...request, id: globalId };
  if (!sendToExtension(forwarded)) {
    respond(client, errorResponse(request.id, `Could not forward ${request.tool} to the Firefox extension`));
    return;
  }
  const timer = setTimeout(() => {
    pending.delete(globalId);
    client.pendingIds.delete(globalId);
    respond(client, errorResponse(request.id, `The Firefox extension did not answer ${request.tool} in time`));
  }, HOST_REQUEST_TIMEOUT_MS);
  pending.set(globalId, { client, originalId: request.id, timer });
  client.pendingIds.add(globalId);
}

function handleConnection(socket: Socket): void {
  if (shuttingDown) {
    socket.destroy();
    return;
  }
  const client: Client = { id: nextClientId++, socket, pendingIds: new Set() };
  clients.set(client.id, client);
  readJsonLines(socket, (message) => handleClientRequest(client, message), LOG);
  socket.on('error', (error) => console.error(`${LOG} client ${client.id} socket error:`, error.message));
  socket.on('close', () => {
    for (const id of client.pendingIds) {
      clearTimeout(pending.get(id)?.timer);
      pending.delete(id);
    }
    clients.delete(client.id);
  });
}

function handleExtensionMessage(message: unknown): void {
  const parsed = parseExtensionMessage(message);
  if (!parsed) {
    console.error(`${LOG} extension sent an invalid message`);
    return;
  }
  if (parsed.type === 'ping') {
    sendToExtension({ type: 'pong' });
    return;
  }
  const entry = pending.get(parsed.id);
  if (!entry) {
    console.error(`${LOG} response for unknown request ${parsed.id}`);
    return;
  }
  clearTimeout(entry.timer);
  pending.delete(parsed.id);
  entry.client.pendingIds.delete(parsed.id);
  respond(entry.client, { ...parsed, id: entry.originalId });
}

function shutdown(server: Server, socketPath: string, reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`${LOG} shutting down: ${reason}`);
  for (const [globalId, entry] of pending) {
    clearTimeout(entry.timer);
    respond(entry.client, errorResponse(entry.originalId, 'The Firefox extension disconnected'));
    pending.delete(globalId);
  }
  for (const client of clients.values()) client.socket.end();
  setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
  // libuv unlinks the listening path on close without checking what it points to. If another
  // host has replaced the socket file, skip close() and let the grace timer end the process.
  if (socketIdentity && isOwnSocket(socketPath, socketIdentity)) server.close(() => process.exit(0));
  else if (!server.listening) process.exit(0);
}

export async function runNativeHost(): Promise<void> {
  await prepareBridgeSocketDir();
  const socketPath = bridgeSocketPath();

  const server = createServer(handleConnection);
  // server.close() unlinks the socket, but process.exit() and crashes skip it. A newer host may
  // own the path by then, so only the file this process created is removed.
  process.on('exit', () => {
    if (socketIdentity && isOwnSocket(socketPath, socketIdentity)) rmSync(socketPath, { force: true });
  });
  // Firefox closes stdin when the extension's port disconnects; that is the host's signal to exit.
  readNativeMessages(process.stdin, handleExtensionMessage);
  process.stdin.on('end', () => shutdown(server, socketPath, 'stdin closed'));
  process.stdin.on('error', (error) => shutdown(server, socketPath, `stdin error: ${error.message}`));
  process.stdout.on('error', (error) => shutdown(server, socketPath, `stdout error: ${error.message}`));
  // Attached before listening, so a signal during startup runs shutdown and the exit hook instead
  // of Node's default action, which would leave the socket file behind.
  process.on('SIGINT', () => shutdown(server, socketPath, 'SIGINT'));
  process.on('SIGTERM', () => shutdown(server, socketPath, 'SIGTERM'));

  try {
    await listen(server, socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    if (await isSocketAlive(socketPath)) {
      console.error(`${LOG} another native host is already listening on ${socketPath}`);
      process.exit(1);
    }
    await rm(socketPath, { force: true });
    await listen(server, socketPath);
  }
  // Synchronous on purpose: listen() binds synchronously and resolves from process.nextTick, and
  // signal handlers only run from the event loop, so none can run between the bind and this line.
  const { dev, ino } = lstatSync(socketPath);
  socketIdentity = { dev, ino };
  // Events queued with process.nextTick (stdin 'end', stream 'error') can run shutdown in that gap,
  // when it has no identity yet and closes nothing; the server is known to be ours now, so close it.
  if (shuttingDown) {
    server.close(() => process.exit(0));
    return;
  }
  try {
    await restrictBridgeSocket(socketPath);
  } catch (error) {
    // A shutdown during startup may already have closed the server and removed the socket.
    if (shuttingDown) return;
    throw error;
  }
  if (shuttingDown) return;
  console.error(`${LOG} listening on ${socketPath}`);
}
