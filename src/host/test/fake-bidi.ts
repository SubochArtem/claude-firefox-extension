import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { onTestFinished } from 'vitest';

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const HANG = Symbol('hang');

export interface BidiCommand {
  connection: number;
  method: string;
  params: Record<string, unknown>;
}

export type BidiReply = { result: unknown } | { error: string; message: string } | typeof HANG;

export interface FakeContext {
  context: string;
  url: string;
  // The marker value window[markerName] holds in this context, if any.
  marker?: string;
  // The context never answers script.evaluate.
  hangs?: boolean;
}

export interface FakeBidi {
  port: number;
  commands: BidiCommand[];
  contexts: FakeContext[];
  methods: () => string[];
  // Overrides the reply to one method; the default replies are a working Firefox.
  reply: (
    method: string,
    handler: (params: Record<string, unknown>, connection: number) => BidiReply | Promise<BidiReply>,
  ) => void;
  // Messages sent to every new connection right after the handshake, e.g. stray events.
  greeting: unknown[];
  openConnections: () => number;
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  if (length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, length]), payload]);
  if (length < 0x10000) {
    const header = Buffer.from([0x80 | opcode, 126, 0, 0]);
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, payload]);
}

// Client frames are always masked; fragmentation is not used by Node's WebSocket for small messages.
function readFrames(socket: Socket, onFrame: (opcode: number, payload: Buffer) => void): void {
  let buffered = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    for (;;) {
      if (buffered.length < 2) return;
      const opcode = (buffered[0] ?? 0) & 0x0f;
      let length = (buffered[1] ?? 0) & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffered.length < 4) return;
        length = buffered.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffered.length < 10) return;
        length = Number(buffered.readBigUInt64BE(2));
        offset = 10;
      }
      if (buffered.length < offset + 4 + length) return;
      const mask = buffered.subarray(offset, offset + 4);
      const payload = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
      buffered = buffered.subarray(offset + 4 + length);
      onFrame(opcode, payload);
    }
  });
}

function defaultReply(fake: FakeBidi, method: string, params: Record<string, unknown>): BidiReply {
  switch (method) {
    case 'session.new':
      return { result: { sessionId: 'session-1', capabilities: {} } };
    case 'browsingContext.getTree':
      return {
        result: { contexts: fake.contexts.map(({ context, url }) => ({ context, url, children: null, parent: null })) },
      };
    case 'script.evaluate': {
      const target = params['target'] as { context: string };
      const context = fake.contexts.find((entry) => entry.context === target.context);
      if (!context) return { error: 'no such frame', message: target.context };
      if (context.hangs) return HANG;
      const match = /^window\[("[^"]*")\] === ("[^"]*")$/.exec(String(params['expression']));
      const value = match?.[2] !== undefined ? (JSON.parse(match[2]) as string) : undefined;
      return {
        result: { type: 'success', result: { type: 'boolean', value: context.marker !== undefined && context.marker === value }, realm: 'r' },
      };
    }
    default:
      return { result: {} };
  }
}

// A WebDriver BiDi endpoint at ws://127.0.0.1:<port>/session built on the HTTP upgrade, closed when
// the test ends.
export async function startFakeBidi(): Promise<FakeBidi> {
  const handlers = new Map<string, (params: Record<string, unknown>, connection: number) => BidiReply | Promise<BidiReply>>();
  const sockets = new Set<Socket>();
  let connections = 0;
  const server: Server = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  const fake: FakeBidi = {
    port: 0,
    commands: [],
    contexts: [],
    greeting: [],
    methods: () => fake.commands.map((command) => command.method),
    reply: (method, handler) => handlers.set(method, handler),
    openConnections: () => [...sockets].filter((socket) => !socket.destroyed).length,
  };
  server.on('upgrade', (request, socket: Socket) => {
    if (request.url !== '/session') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    const key = String(request.headers['sec-websocket-key']);
    const accept = createHash('sha1').update(key + WEBSOCKET_GUID).digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const connection = ++connections;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const send = (message: unknown) => {
      if (!socket.destroyed) socket.write(encodeFrame(1, Buffer.from(JSON.stringify(message))));
    };
    for (const message of fake.greeting) send(message);
    readFrames(socket, (opcode, payload) => {
      if (opcode === 8) {
        socket.end(encodeFrame(8, Buffer.alloc(0)));
        return;
      }
      if (opcode !== 1) return;
      const { id, method, params } = JSON.parse(payload.toString('utf8')) as {
        id: number;
        method: string;
        params: Record<string, unknown>;
      };
      fake.commands.push({ connection, method, params });
      const handler = handlers.get(method);
      void Promise.resolve(handler ? handler(params, connection) : defaultReply(fake, method, params)).then((reply) => {
        if (reply === HANG) return;
        if ('result' in reply) send({ type: 'success', id, result: reply.result });
        else send({ type: 'error', id, error: reply.error, message: reply.message });
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.port = (server.address() as AddressInfo).port;
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  return fake;
}

// A port nothing listens on: bound once to get a free number, then released.
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

// An HTTP server that refuses WebSocket upgrades, like another program on the port.
export async function startPlainHttp(): Promise<number> {
  const server = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  server.on('upgrade', (_request, socket: Socket) => socket.end('HTTP/1.1 404 Not Found\r\n\r\n'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  return (server.address() as AddressInfo).port;
}
