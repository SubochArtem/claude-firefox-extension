// Must match NATIVE_HOST_NAME in host/protocol.ts and the installed native messaging manifest.
export const NATIVE_HOST_NAME = 'claude_firefox_extension';

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

export type ExtensionToHostMessage = { type: 'ping' } | ToolResponse;
export type HostToExtensionMessage = { type: 'pong' } | ToolRequest;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseHostMessage(value: unknown): HostToExtensionMessage | undefined {
  if (!isRecord(value)) return undefined;
  if (value['type'] === 'pong') return { type: 'pong' };
  if (value['type'] !== 'tool_request') return undefined;
  const { id, tool, args } = value;
  if (typeof id !== 'string' || typeof tool !== 'string' || !isRecord(args)) return undefined;
  return { type: 'tool_request', id, tool, args };
}
