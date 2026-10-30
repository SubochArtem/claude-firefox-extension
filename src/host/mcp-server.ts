import { createConnection, type Socket } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';
import packageJson from '../package.json' with { type: 'json' };
import { readBridgeInfo } from './bridge-info';
import { authenticateToHost, HandshakeError } from './handshake';
import { writeJsonLine } from './json-lines';
import { parseToolResponse, TOOL_REQUEST_TIMEOUT_MS, type ToolRequest, type ToolResponse } from './protocol';
import { checkBridgeSocketDir } from './socket-path';

const LOG = '[mcp-server]';
const NOT_CONNECTED_MESSAGE =
  'Firefox is not running or the Claude Firefox extension is not connected. Open Firefox with the extension enabled and try again.';

class AuthenticationError extends Error {
  constructor(reason: string) {
    super(`Authentication with the native host failed: ${reason}`);
  }
}

interface PendingCall {
  socket: Socket;
  resolve: (response: ToolResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class BridgeConnection {
  private socket: Socket | undefined;
  private connecting: Promise<Socket> | undefined;
  private readonly pending = new Map<string, PendingCall>();
  private nextRequestId = 1;
  private closed = false;

  async call(tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (this.closed) return errorResult('The MCP server is shutting down');
    let socket: Socket;
    try {
      socket = await this.connect();
    } catch (error) {
      if (error instanceof AuthenticationError) return errorResult(error.message);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ECONNREFUSED') return errorResult(NOT_CONNECTED_MESSAGE);
      return errorResult(`Could not reach the native host: ${(error as Error).message}`);
    }
    // The socket may have closed between connecting and this call resuming.
    if (!isOpen(socket)) return errorResult(NOT_CONNECTED_MESSAGE);

    const id = String(this.nextRequestId++);
    const request: ToolRequest = { type: 'tool_request', id, tool, args };
    try {
      const response = await new Promise<ToolResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${tool} timed out after ${TOOL_REQUEST_TIMEOUT_MS / 1000} s`));
        }, TOOL_REQUEST_TIMEOUT_MS);
        this.pending.set(id, { socket, resolve, reject, timer });
        writeJsonLine(socket, request, (error) => {
          if (!error || !this.pending.has(id)) return;
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error(`Could not send ${tool} to the native host: ${error.message}`));
        });
      });
      if ('error' in response) return { content: response.error.content, isError: true };
      return { content: response.result.content };
    } catch (error) {
      return errorResult((error as Error).message);
    }
  }

  // Concurrent calls share one connection attempt and one handshake. bridge.json is read on every
  // attempt, because a restarted host has a new secret and, on Windows, a new pipe name.
  private connect(): Promise<Socket> {
    // A socket is destroyed or ended by the host synchronously but its 'close' event follows later,
    // so a dead socket can still be cached here; it is dropped instead of being handed to another call.
    if (this.socket && !isOpen(this.socket)) this.socket = undefined;
    if (this.socket) return Promise.resolve(this.socket);
    this.connecting ??= this.open().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async open(): Promise<Socket> {
    await checkBridgeSocketDir();
    const { endpoint, secret } = await readBridgeInfo();
    const socket = await new Promise<Socket>((resolve, reject) => {
      const socket = createConnection(endpoint);
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.off('error', reject);
        socket.on('error', (error) => console.error(`${LOG} bridge socket error:`, error.message));
        resolve(socket);
      });
    });
    try {
      await authenticateToHost(socket, secret, { logPrefix: LOG, onMessage: (message) => this.handleMessage(socket, message) });
    } catch (error) {
      if (error instanceof HandshakeError) throw new AuthenticationError(error.message);
      throw error;
    }
    this.attach(socket);
    return socket;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket?.destroy();
    this.rejectPending(new Error('The MCP server is shutting down'));
  }

  private attach(socket: Socket): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    // The host half-closes its connections on shutdown. Writing to such a socket fails with "This
    // socket has been ended by the other party", so it is torn down to take the regular close path.
    if (socket.readableEnded) socket.destroy();
    else socket.once('end', () => socket.destroy());
    this.socket = socket;
    // The close event of a socket that has already been replaced must not drop the new connection.
    socket.on('close', () => {
      if (this.socket === socket) this.socket = undefined;
      this.rejectPending(new Error(NOT_CONNECTED_MESSAGE), socket);
    });
  }

  private rejectPending(error: Error, socket?: Socket): void {
    for (const [id, call] of this.pending) {
      if (socket && call.socket !== socket) continue;
      clearTimeout(call.timer);
      call.reject(error);
      this.pending.delete(id);
    }
  }

  private handleMessage(socket: Socket, message: unknown): void {
    const response = parseToolResponse(message);
    if (!response) {
      console.error(`${LOG} native host sent an invalid message`);
      return;
    }
    const call = this.pending.get(response.id);
    if (call?.socket !== socket) return;
    clearTimeout(call.timer);
    this.pending.delete(response.id);
    call.resolve(response);
  }
}

function isOpen(socket: Socket): boolean {
  return !socket.destroyed && !socket.readableEnded && !socket.writableEnded;
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export async function runMcpServer(): Promise<void> {
  const bridge = new BridgeConnection();
  const server = new McpServer({ name: packageJson.name, version: packageJson.version });

  server.registerTool(
    'tabs_context',
    {
      description:
        'List the tabs currently open in Firefox together with their tab ids. Call this first to get a tab id that the other browser tools can target.',
      inputSchema: {},
    },
    (args) => bridge.call('tabs_context', args),
  );

  server.registerTool(
    'navigate',
    {
      description:
        'Navigate a tab to a URL, or go back or forward in its history. A URL without a scheme gets https://; only http and https URLs are allowed. Pass "back" or "forward" as the url to move through the tab\'s history. Waits until the page has loaded (up to 20 s) and returns the final URL, the page title and the current tabs. Get the tab id from tabs_context.',
      inputSchema: z.object({
        tabId: z.number().int().positive().describe('Id of the tab to navigate, from tabs_context'),
        url: z.string().describe('URL to open, or "back" / "forward" to move through the tab history'),
      }),
    },
    (args) => bridge.call('navigate', args),
  );

  // StdioServerTransport does not exit on stdin EOF, and an open bridge socket would keep the
  // process alive after Claude Code has gone away.
  let exiting = false;
  const exit = (reason: string): void => {
    if (exiting) return;
    exiting = true;
    console.error(`${LOG} exiting: ${reason}`);
    bridge.close();
    process.exit(0);
  };
  process.stdin.on('end', () => exit('stdin closed'));
  process.stdin.on('close', () => exit('stdin closed'));
  process.on('SIGINT', () => exit('SIGINT'));
  process.on('SIGTERM', () => exit('SIGTERM'));

  await server.connect(new StdioServerTransport());
  console.error(`${LOG} ready`);
}
