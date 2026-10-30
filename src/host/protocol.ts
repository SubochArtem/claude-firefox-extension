export const NATIVE_HOST_NAME = 'claude_firefox_extension';
export const TOOL_REQUEST_TIMEOUT_MS = 30_000;

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface ToolOutput {
  content: ContentBlock[];
}

export interface ToolRequest {
  type: 'tool_request';
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

export type ToolResponse =
  | { type: 'tool_response'; id: string; result: ToolOutput }
  | { type: 'tool_response'; id: string; error: ToolOutput };

export interface ClientHello {
  type: 'hello';
  nonce: string;
}

export interface HostHello {
  type: 'hello';
  nonce: string;
  proof: string;
}

export interface Auth {
  type: 'auth';
  proof: string;
}

export interface Ready {
  type: 'ready';
}

export type ExtensionToHostMessage = { type: 'ping' } | ToolResponse;
export type HostToExtensionMessage = { type: 'pong' } | ToolRequest;

export function textOutput(text: string): ToolOutput {
  return { content: [{ type: 'text', text }] };
}

export function errorResponse(id: string, text: string): ToolResponse {
  return { type: 'tool_response', id, error: textOutput(text) };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isToolOutput(value: unknown): value is ToolOutput {
  return isRecord(value) && Array.isArray(value['content']);
}

export function parseToolRequest(value: unknown): ToolRequest | undefined {
  if (!isRecord(value) || value['type'] !== 'tool_request') return undefined;
  const { id, tool, args } = value;
  if (typeof id !== 'string' || typeof tool !== 'string' || !isRecord(args)) return undefined;
  return { type: 'tool_request', id, tool, args };
}

export function parseToolResponse(value: unknown): ToolResponse | undefined {
  if (!isRecord(value) || value['type'] !== 'tool_response') return undefined;
  const { id, result, error } = value;
  if (typeof id !== 'string') return undefined;
  if (isToolOutput(result)) return { type: 'tool_response', id, result };
  if (isToolOutput(error)) return { type: 'tool_response', id, error };
  return undefined;
}

export function parseExtensionMessage(value: unknown): ExtensionToHostMessage | undefined {
  if (isRecord(value) && value['type'] === 'ping') return { type: 'ping' };
  return parseToolResponse(value);
}
