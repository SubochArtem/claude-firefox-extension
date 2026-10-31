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
  // Set when the MCP client can ask the user: site permissions are then asked through
  // permission_request instead of the popup.
  approvalViaClient?: true;
}

export type ToolResponse =
  | { type: 'tool_response'; id: string; result: ToolOutput }
  | { type: 'tool_response'; id: string; error: ToolOutput };

// Asks the MCP client that owns the tool call `callId` whether the call may act on `host`.
export interface PermissionRequest {
  type: 'permission_request';
  requestId: string;
  callId: string;
  host: string;
  tool: string;
  action: string;
  canIncludeSubdomains: boolean;
}

// The answer fields are left to parseApprovalAnswer, which denies anything it does not accept.
export interface PermissionResponse {
  type: 'permission_response';
  requestId: string;
  answer: unknown;
  includeSubdomains: unknown;
}

export type ExtensionToHostMessage = { type: 'ping' } | ToolResponse | PermissionRequest;
export type HostToExtensionMessage = { type: 'pong' } | ToolRequest | PermissionResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseHostMessage(value: unknown): HostToExtensionMessage | undefined {
  if (!isRecord(value)) return undefined;
  if (value['type'] === 'pong') return { type: 'pong' };
  if (value['type'] === 'permission_response') {
    const { requestId, answer, includeSubdomains } = value;
    if (typeof requestId !== 'string') return undefined;
    return { type: 'permission_response', requestId, answer, includeSubdomains };
  }
  if (value['type'] !== 'tool_request') return undefined;
  const { id, tool, args } = value;
  if (typeof id !== 'string' || typeof tool !== 'string' || !isRecord(args)) return undefined;
  return { type: 'tool_request', id, tool, args, ...(value['approvalViaClient'] === true ? { approvalViaClient: true } : {}) };
}
