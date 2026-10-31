import { lstatSync, rmSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import {
  bridgeInfoDir,
  newBridgeInfo,
  readBridgeInfo,
  removeBridgeInfoIfOwn,
  removeBridgeInfoTempFiles,
  writeBridgeInfo,
  type BridgeInfo,
} from './bridge-info';
import { BidiError, bidiPort } from './bidi-client';
import { createSerialQueue, runBidiInput } from './bidi-input';
import {
  clientProof,
  createNonce,
  HANDSHAKE_TIMEOUT_MS,
  hostProof,
  MAX_UNAUTHENTICATED_CONNECTIONS,
  parseAuth,
  parseClientHello,
  verifyProof,
} from './handshake';
import { isAuthenticatedHostAlive } from './host-probe';
import { MAX_LINE_BYTES, readJsonLines, writeJsonLine } from './json-lines';
import { listen, listenWithRetry } from './listen';
import { readNativeMessages, writeNativeMessage } from './native-messaging';
import {
  type BidiInputRequest,
  type BidiInputResponse,
  denyPermission,
  errorResponse,
  isRecord,
  MAX_PERMISSION_FIELD_LENGTH,
  parseExtensionMessage,
  parsePermissionResponse,
  parseToolRequest,
  BIDI_INPUT_TIMEOUT_MS,
  TOOL_REQUEST_TIMEOUT_MS,
  type HostToExtensionMessage,
  type PermissionRequest,
  type ToolRequest,
  type ToolResponse,
} from './protocol';
import { bridgeSocketPath, prepareBridgeSocketDir, restrictBridgeSocket } from './socket-path';

const LOG = '[native-host]';
const SHUTDOWN_GRACE_MS = 1000;
// How long an exit waits for a running BiDi input request to end its session.
const BIDI_SHUTDOWN_WAIT_MS = 3000;
const MAX_BIDI_INPUT_QUEUE = 8;
// Handshake lines are tiny; without this cap an unauthenticated peer could make the host buffer up to
// the 64 MB line limit that only authenticated clients need.
const HANDSHAKE_MAX_LINE_BYTES = 4 * 1024;
const isWindows = process.platform === 'win32';
// Longer than the MCP server's own timeout, so the MCP side reports the timeout first; this one
// only frees requests the extension never answers.
const HOST_REQUEST_TIMEOUT_MS = TOOL_REQUEST_TIMEOUT_MS + 5_000;

interface Client {
  id: number;
  socket: Socket;
  pendingIds: Set<string>;
  permissionIds: Set<string>;
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
// Permission requests from the extension by requestId, with the client asked to answer them.
const permissionRequests = new Map<string, Client>();
const unauthenticated = new Set<Socket>();
// Firefox allows a single WebDriver BiDi session, so input requests run one at a time. The extension
// gives up after BIDI_INPUT_TIMEOUT_MS, so a request that waited longer is skipped.
const bidiQueue = createSerialQueue({ maxLength: MAX_BIDI_INPUT_QUEUE, maxWaitMs: BIDI_INPUT_TIMEOUT_MS });
const bidiShutdown = new AbortController();
let runningBidiInput: Promise<void> | undefined;
let nextClientId = 1;
let shuttingDown = false;
// The extension takes a pong as a working connection, so a host that is about to step aside for
// another one must not answer anything: messages wait here until this host has decided to serve.
let serving = false;
const earlyExtensionMessages: unknown[] = [];
// Undefined until this process has bound the socket path and recorded what it created there.
let socketIdentity: SocketIdentity | undefined;
// Undefined until this process has bound its endpoint and generated the secret for bridge.json.
let bridgeInfo: BridgeInfo | undefined;

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

function isOwnSocket(path: string, identity: SocketIdentity): boolean {
  try {
    const stats = lstatSync(path);
    return stats.dev === identity.dev && stats.ino === identity.ino;
  } catch {
    return false;
  }
}

// Windows pipes get a random name, so a second host never collides with the first on bind and would
// silently take bridge.json over. The pid in bridge.json is not trusted for this: a recycled pid
// proves nothing, so only a host that completes the handshake with the recorded secret counts.
async function isOtherHostRunning(): Promise<boolean> {
  let existing: BridgeInfo;
  try {
    existing = await readBridgeInfo();
  } catch {
    return false;
  }
  return isAuthenticatedHostAlive(existing);
}

function sendToExtension(message: HostToExtensionMessage): boolean {
  if (shuttingDown || !serving) return false;
  return writeNativeMessage(process.stdout, message);
}

function respond(client: Client, response: ToolResponse): void {
  if (!client.socket.destroyed) writeJsonLine(client.socket, response);
}

// Only the client that owns the call is asked; without one the extension gets a deny at once.
function handlePermissionRequest(request: PermissionRequest): void {
  if (permissionRequests.has(request.requestId)) {
    console.error(`${LOG} duplicate permission request ${request.requestId}`);
    return;
  }
  const call = pending.get(request.callId);
  if (!call || call.client.socket.destroyed) {
    sendToExtension(denyPermission(request.requestId));
    return;
  }
  permissionRequests.set(request.requestId, call.client);
  call.client.permissionIds.add(request.requestId);
  writeJsonLine(call.client.socket, { ...request, callId: call.originalId });
}

function handlePermissionResponse(client: Client, message: unknown): void {
  const response = parsePermissionResponse(message);
  if (!response) {
    console.error(`${LOG} client ${client.id} sent an invalid message`);
    return;
  }
  if (permissionRequests.get(response.requestId) !== client) {
    console.error(`${LOG} permission response for unknown request ${response.requestId}`);
    return;
  }
  permissionRequests.delete(response.requestId);
  client.permissionIds.delete(response.requestId);
  sendToExtension(response);
}

function handleClientMessage(client: Client, message: unknown): void {
  if (isRecord(message) && message['type'] === 'permission_response') handlePermissionResponse(client, message);
  else handleClientRequest(client, message);
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

// Until ready the host stays silent towards a peer that has not sent a well-formed hello, and any
// unexpected line ends the connection: tool requests are routed only after the client has proved it
// knows the secret.
function handleConnection(socket: Socket): void {
  const info = bridgeInfo;
  if (shuttingDown || !info || unauthenticated.size >= MAX_UNAUTHENTICATED_CONNECTIONS) {
    socket.destroy();
    return;
  }
  const id = nextClientId++;
  let nonces: { client: string; server: string } | undefined;
  let client: Client | undefined;
  // Called before the host closes an unauthenticated connection itself, not only on 'close': that
  // event runs after the peer can already see the close, and a peer reconnecting at once would be
  // refused for a slot still counted.
  const releaseSlot = (): void => {
    clearTimeout(timer);
    unauthenticated.delete(socket);
  };
  const reject = (reason: string): void => {
    if (socket.destroyed) return;
    console.error(`${LOG} connection ${id} failed the handshake: ${reason}`);
    releaseSlot();
    socket.destroy();
  };
  unauthenticated.add(socket);
  const timer = setTimeout(() => reject('no auth within the handshake timeout'), HANDSHAKE_TIMEOUT_MS);

  const handleHandshake = (message: unknown): void => {
    if (!nonces) {
      const hello = parseClientHello(message);
      if (!hello) return reject('expected hello');
      nonces = { client: hello.nonce, server: createNonce() };
      writeJsonLine(socket, { type: 'hello', nonce: nonces.server, proof: hostProof(info.secret, nonces.client, nonces.server) });
      return;
    }
    const auth = parseAuth(message);
    if (!auth) return reject('expected auth');
    if (!verifyProof(clientProof(info.secret, nonces.client, nonces.server), auth.proof)) return reject('wrong proof');
    releaseSlot();
    client = { id, socket, pendingIds: new Set(), permissionIds: new Set() };
    clients.set(id, client);
    writeJsonLine(socket, { type: 'ready' });
  };

  readJsonLines(
    socket,
    (message) => {
      if (client) handleClientMessage(client, message);
      else handleHandshake(message);
    },
    LOG,
    {
      maxLineBytes: () => (client ? MAX_LINE_BYTES : HANDSHAKE_MAX_LINE_BYTES),
      onInvalidJson: () => {
        if (!client) reject('invalid JSON');
      },
      onOverflow: () => {
        if (!client) releaseSlot();
      },
    },
  );
  socket.on('error', (error) => console.error(`${LOG} client ${id} socket error:`, error.message));
  socket.on('close', () => {
    releaseSlot();
    if (!client) return;
    for (const pendingId of client.pendingIds) {
      clearTimeout(pending.get(pendingId)?.timer);
      pending.delete(pendingId);
    }
    for (const requestId of client.permissionIds) {
      permissionRequests.delete(requestId);
      sendToExtension(denyPermission(requestId));
    }
    clients.delete(id);
  });
}

async function performBidiInput(request: BidiInputRequest): Promise<BidiInputResponse> {
  const { requestId } = request;
  try {
    await bidiQueue.run(async () => {
      const run = runBidiInput(request, bidiPort(), undefined, bidiShutdown.signal);
      runningBidiInput = run.then(
        () => undefined,
        () => undefined,
      );
      try {
        await run;
      } finally {
        runningBidiInput = undefined;
      }
    });
    return { type: 'bidi_input_response', requestId, ok: true };
  } catch (error) {
    if (!(error instanceof BidiError)) console.error(`${LOG} bidi input ${requestId} failed:`, error);
    const text = error instanceof BidiError ? error.message : `WebDriver BiDi input failed: ${String(error)}`;
    return { type: 'bidi_input_response', requestId, ok: false, error: text };
  }
}

// A malformed input request that still names its id is answered with an error, so the extension does
// not wait for its timeout.
function rejectInvalidBidiInput(message: unknown): void {
  if (!isRecord(message) || message['type'] !== 'bidi_input_request') return;
  const requestId = message['requestId'];
  if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > MAX_PERMISSION_FIELD_LENGTH) return;
  sendToExtension({ type: 'bidi_input_response', requestId, ok: false, error: 'The extension sent an invalid input request' });
}

function handleExtensionMessage(message: unknown): void {
  const parsed = parseExtensionMessage(message);
  if (!parsed) {
    console.error(`${LOG} extension sent an invalid message`);
    rejectInvalidBidiInput(message);
    return;
  }
  if (parsed.type === 'ping') {
    sendToExtension({ type: 'pong' });
    return;
  }
  if (parsed.type === 'permission_request') {
    handlePermissionRequest(parsed);
    return;
  }
  if (parsed.type === 'bidi_input_request') {
    void performBidiInput(parsed).then(sendToExtension);
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

function receiveExtensionMessage(message: unknown): void {
  if (shuttingDown) return;
  if (serving) handleExtensionMessage(message);
  else earlyExtensionMessages.push(message);
}

function startServing(): void {
  serving = true;
  for (const message of earlyExtensionMessages.splice(0)) {
    if (shuttingDown) return;
    handleExtensionMessage(message);
  }
}

function ownsEndpoint(server: Server, socketPath: string | undefined): boolean {
  // Windows pipes vanish with their owner, so only Unix socket files need the identity check.
  if (isWindows) return server.listening;
  return socketPath !== undefined && socketIdentity !== undefined && isOwnSocket(socketPath, socketIdentity);
}

// A BiDi session left open blocks every later session until Firefox restarts, so an exit waits for
// the running request's cleanup, capped so a hung Firefox cannot keep the host alive.
function exitAfterBidiInput(code: number): void {
  const running = runningBidiInput;
  if (!running) process.exit(code);
  const cap = new Promise<void>((resolve) => setTimeout(resolve, BIDI_SHUTDOWN_WAIT_MS).unref());
  void Promise.race([running, cap]).then(() => process.exit(code));
}

function shutdown(server: Server, socketPath: string | undefined, reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`${LOG} shutting down: ${reason}`);
  if (bridgeInfo) removeBridgeInfoIfOwn(bridgeInfo);
  for (const [globalId, entry] of pending) {
    clearTimeout(entry.timer);
    respond(entry.client, errorResponse(entry.originalId, 'The Firefox extension disconnected'));
    pending.delete(globalId);
  }
  for (const client of clients.values()) client.socket.end();
  for (const socket of unauthenticated) socket.destroy();
  bidiShutdown.abort();
  setTimeout(() => exitAfterBidiInput(0), SHUTDOWN_GRACE_MS).unref();
  // libuv unlinks the listening path on close without checking what it points to. If another
  // host has replaced the socket file, skip close() and let the grace timer end the process.
  if (ownsEndpoint(server, socketPath)) server.close(() => exitAfterBidiInput(0));
  else if (!server.listening) exitAfterBidiInput(0);
}

export async function runNativeHost(): Promise<void> {
  await prepareBridgeSocketDir();
  if (isWindows) await mkdir(bridgeInfoDir(), { recursive: true });
  // A Unix socket path is fixed up front; a Windows pipe gets a random name when it is bound.
  const socketPath = isWindows ? undefined : bridgeSocketPath();

  const server = createServer(handleConnection);
  // server.close() unlinks the socket, but process.exit() and crashes skip it. A newer host may
  // own the path and bridge.json by then, so only what this process created is removed.
  process.on('exit', () => {
    if (bridgeInfo) removeBridgeInfoIfOwn(bridgeInfo);
    removeBridgeInfoTempFiles();
    if (socketPath && socketIdentity && isOwnSocket(socketPath, socketIdentity)) rmSync(socketPath, { force: true });
  });
  // Firefox closes stdin when the extension's port disconnects; that is the host's signal to exit.
  readNativeMessages(process.stdin, receiveExtensionMessage);
  process.stdin.on('end', () => shutdown(server, socketPath, 'stdin closed'));
  process.stdin.on('error', (error) => shutdown(server, socketPath, `stdin error: ${error.message}`));
  process.stdout.on('error', (error) => shutdown(server, socketPath, `stdout error: ${error.message}`));
  // Attached before listening, so a signal during startup runs shutdown and the exit hook instead
  // of Node's default action, which would leave the socket file behind.
  process.on('SIGINT', () => shutdown(server, socketPath, 'SIGINT'));
  process.on('SIGTERM', () => shutdown(server, socketPath, 'SIGTERM'));

  let endpoint: string;
  if (socketPath === undefined) {
    endpoint = await listenWithRetry(server, bridgeSocketPath);
  } else {
    endpoint = socketPath;
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
  }
  // Events queued with process.nextTick (stdin 'end', stream 'error') can run shutdown in that gap,
  // when it has no identity yet and closes nothing; the server is known to be ours now, so close it.
  if (shuttingDown) {
    server.close(() => process.exit(0));
    return;
  }
  try {
    await restrictBridgeSocket(endpoint);
  } catch (error) {
    // A shutdown during startup may already have closed the server and removed the socket.
    if (shuttingDown) return;
    throw error;
  }
  if (shuttingDown) return;

  if (isWindows && (await isOtherHostRunning())) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`${LOG} another native host is already running, exiting`);
    setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
    server.close(() => process.exit(1));
    return;
  }
  if (shuttingDown) return;

  const info = newBridgeInfo(endpoint);
  bridgeInfo = info;
  try {
    await writeBridgeInfo(info);
  } catch (error) {
    if (shuttingDown) return;
    throw error;
  }
  // shutdown() may have run while the file was being written and found nothing to remove.
  if (shuttingDown) {
    removeBridgeInfoIfOwn(info);
    return;
  }
  console.error(`${LOG} listening on ${endpoint}`);
  startServing();
}
