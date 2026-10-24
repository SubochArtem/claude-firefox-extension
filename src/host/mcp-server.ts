import { createConnection, type Socket } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import packageJson from '../package.json' with { type: 'json' };
import { readJsonLines, writeJsonLine } from './json-lines';
import { parseToolResponse, TOOL_REQUEST_TIMEOUT_MS, type ToolRequest, type ToolResponse } from './protocol';
import { bridgeSocketPath, checkBridgeSocketDir } from './socket-path';

const LOG = '[mcp-server]';
const NOT_CONNECTED_MESSAGE =
  'Firefox is not running or the Claude Firefox extension is not connected. Open Firefox with the extension enabled and try again.';

interface PendingCall {
  resolve: (response: ToolResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class BridgeConnection {
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
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ECONNREFUSED') return errorResult(NOT_CONNECTED_MESSAGE);
      return errorResult(`Could not reach the native host: ${(error as Error).message}`);
    }
    // The socket may have closed between connecting and this call resuming.
    if (socket.destroyed) return errorResult(NOT_CONNECTED_MESSAGE);

    const id = String(this.nextRequestId++);
    const request: ToolRequest = { type: 'tool_request', id, tool, args };
    try {
      const response = await new Promise<ToolResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${tool} timed out after ${TOOL_REQUEST_TIMEOUT_MS / 1000} s`));
        }, TOOL_REQUEST_TIMEOUT_MS);
        this.pending.set(id, { resolve, reject, timer });
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

  private connect(): Promise<Socket> {
    if (this.socket) return Promise.resolve(this.socket);
    this.connecting ??= checkBridgeSocketDir()
      .then(
        () =>
          new Promise<Socket>((resolve, reject) => {
            const socket = createConnection(bridgeSocketPath());
            socket.once('error', reject);
            socket.once('connect', () => {
              socket.off('error', reject);
              this.attach(socket);
              resolve(socket);
            });
          }),
      )
      .finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
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
    this.socket = socket;
    readJsonLines(socket, (message) => this.handleMessage(message), LOG);
    socket.on('error', (error) => console.error(`${LOG} bridge socket error:`, error.message));
    socket.on('close', () => {
      this.socket = undefined;
      this.rejectPending(new Error(NOT_CONNECTED_MESSAGE));
    });
  }

  private rejectPending(error: Error): void {
    for (const [id, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(error);
      this.pending.delete(id);
    }
  }

  private handleMessage(message: unknown): void {
    const response = parseToolResponse(message);
    if (!response) {
      console.error(`${LOG} native host sent an invalid message`);
      return;
    }
    const call = this.pending.get(response.id);
    if (!call) return;
    clearTimeout(call.timer);
    this.pending.delete(response.id);
    call.resolve(response);
  }
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
