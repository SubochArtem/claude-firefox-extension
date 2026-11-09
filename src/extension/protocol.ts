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
  // Set by the native host on calls from a sidebar Claude Code session: site permissions are then
  // asked in the popup, whatever approvalViaClient says.
  chatSessionId?: string;
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
  code?: string;
}

// The answer fields are left to parseApprovalAnswer, which denies anything it does not accept.
export interface PermissionResponse {
  type: 'permission_response';
  requestId: string;
  answer: unknown;
  includeSubdomains: unknown;
}

// Must match BIDI_INPUT_TIMEOUT_MS in host/protocol.ts.
export const BIDI_INPUT_TIMEOUT_MS = 60_000;

// A property set on `window` in the main world of the tab's top frame, by which the native host finds
// the tab's WebDriver BiDi browsing context.
export interface TabMarker {
  name: string;
  value: string;
}

// Asks the native host to run WebDriver BiDi input.performActions with `actions` in the marked tab.
export interface BidiInputRequest {
  type: 'bidi_input_request';
  requestId: string;
  marker: TabMarker;
  url: string;
  actions: unknown[];
}

export type BidiInputResponse =
  | { type: 'bidi_input_response'; requestId: string; ok: true }
  // unavailable: WebDriver BiDi itself cannot be used (no listener, no session, the tab is not visible to it).
  | { type: 'bidi_input_response'; requestId: string; ok: false; error: string; unavailable?: true };

// Must match BIDI_EVALUATE_TIMEOUT_MS in host/protocol.ts.
export const BIDI_EVALUATE_TIMEOUT_MS = 90_000;

// Asks the native host to run `code` with WebDriver BiDi script.evaluate in the marked tab's main realm.
export interface BidiEvaluateRequest {
  type: 'bidi_evaluate_request';
  requestId: string;
  marker: TabMarker;
  url: string;
  code: string;
}

// value: the result formatted as text by the host; exception: the uncaught exception with its stack.
export type BidiEvaluateResponse =
  | { type: 'bidi_evaluate_response'; requestId: string; ok: true; value: string }
  | { type: 'bidi_evaluate_response'; requestId: string; ok: true; exception: string }
  | { type: 'bidi_evaluate_response'; requestId: string; ok: false; error: string; unavailable?: true };

// Must match MAX_CHAT_SYSTEM_PROMPT_LENGTH in host/protocol.ts.
export const MAX_CHAT_SYSTEM_PROMPT_LENGTH = 16_000;

export type ChatContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

// Starts a Claude Code session in the native host; it ends with exactly one chat_closed.
export interface ChatStart {
  type: 'chat_start';
  sessionId: string;
  model?: string;
  appendSystemPrompt?: string;
}

// The host validates the content and answers chat_error invalid_request when it refuses it.
export interface ChatSend {
  type: 'chat_send';
  sessionId: string;
  content: string | ChatContentBlock[];
}

export interface ChatInterrupt {
  type: 'chat_interrupt';
  sessionId: string;
}

export interface ChatClose {
  type: 'chat_close';
  sessionId: string;
}

export interface ChatStatusRequest {
  type: 'chat_status_request';
  requestId: string;
}

export type HostChatRequest = ChatStart | ChatSend | ChatInterrupt | ChatClose | ChatStatusRequest;

// One stream-json event of the session's claude process, as the host passed it on.
export interface ChatEvent {
  type: 'chat_event';
  sessionId: string;
  event: Record<string, unknown>;
  reduced?: true;
}

export interface ChatError {
  type: 'chat_error';
  sessionId: string;
  code: string;
  message: string;
}

export interface ChatClosed {
  type: 'chat_closed';
  sessionId: string;
}

export interface ChatStatus {
  found: boolean;
  path?: string;
  version?: string;
  versionOk?: boolean;
  loggedIn?: boolean;
  authMethod?: string;
  ready: boolean;
  error?: string;
}

export type ChatStatusResponse = { type: 'chat_status_response'; requestId: string } & ChatStatus;

export type ChatHostMessage = ChatEvent | ChatError | ChatClosed | ChatStatusResponse;

export type ExtensionToHostMessage =
  | { type: 'ping' }
  | ToolResponse
  | PermissionRequest
  | BidiInputRequest
  | BidiEvaluateRequest
  | HostChatRequest;
export type HostToExtensionMessage =
  | { type: 'pong' }
  | ToolRequest
  | PermissionResponse
  | BidiInputResponse
  | BidiEvaluateResponse
  | ChatHostMessage;

// Must match isChatSessionId in host/protocol.ts.
export function isChatSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEvaluateResponse(value: Record<string, unknown>): BidiEvaluateResponse | undefined {
  const { requestId, ok, error } = value;
  if (typeof requestId !== 'string') return undefined;
  const type = 'bidi_evaluate_response';
  if (ok === true && typeof value['value'] === 'string') return { type, requestId, ok, value: value['value'] };
  if (ok === true && typeof value['exception'] === 'string') return { type, requestId, ok, exception: value['exception'] };
  // A malformed reply still settles its request instead of leaving it to the timeout.
  if (ok !== false || typeof error !== 'string') {
    return { type, requestId, ok: false, error: 'The native host sent a malformed evaluate response' };
  }
  return { type, requestId, ok, error, ...(value['unavailable'] === true ? { unavailable: true as const } : {}) };
}

function optionalString<K extends string>(value: Record<string, unknown>, key: K): { [P in K]?: string } {
  const field = value[key];
  return (typeof field === 'string' ? { [key]: field } : {}) as { [P in K]?: string };
}

function optionalBoolean<K extends string>(value: Record<string, unknown>, key: K): { [P in K]?: boolean } {
  const field = value[key];
  return (typeof field === 'boolean' ? { [key]: field } : {}) as { [P in K]?: boolean };
}

function parseChatStatusResponse(value: Record<string, unknown>): ChatStatusResponse | undefined {
  const { requestId } = value;
  if (typeof requestId !== 'string') return undefined;
  return {
    type: 'chat_status_response',
    requestId,
    found: value['found'] === true,
    ...optionalString(value, 'path'),
    ...optionalString(value, 'version'),
    ...optionalBoolean(value, 'versionOk'),
    ...optionalBoolean(value, 'loggedIn'),
    ...optionalString(value, 'authMethod'),
    ready: value['ready'] === true,
    ...optionalString(value, 'error'),
  };
}

function parseChatHostMessage(value: Record<string, unknown>): ChatHostMessage | undefined {
  if (value['type'] === 'chat_status_response') return parseChatStatusResponse(value);
  const { sessionId } = value;
  if (!isChatSessionId(sessionId)) return undefined;
  if (value['type'] === 'chat_closed') return { type: 'chat_closed', sessionId };
  if (value['type'] === 'chat_event') {
    const { event } = value;
    if (!isRecord(event)) return undefined;
    return { type: 'chat_event', sessionId, event, ...(value['reduced'] === true ? { reduced: true as const } : {}) };
  }
  const { code, message } = value;
  if (typeof code !== 'string' || typeof message !== 'string') return undefined;
  return { type: 'chat_error', sessionId, code, message };
}

const CHAT_HOST_MESSAGE_TYPES = new Set(['chat_event', 'chat_error', 'chat_closed', 'chat_status_response']);

export function isChatHostMessage(message: HostToExtensionMessage): message is ChatHostMessage {
  return CHAT_HOST_MESSAGE_TYPES.has(message.type);
}

export function parseHostMessage(value: unknown): HostToExtensionMessage | undefined {
  if (!isRecord(value)) return undefined;
  if (value['type'] === 'pong') return { type: 'pong' };
  if (typeof value['type'] === 'string' && CHAT_HOST_MESSAGE_TYPES.has(value['type'])) return parseChatHostMessage(value);
  if (value['type'] === 'permission_response') {
    const { requestId, answer, includeSubdomains } = value;
    if (typeof requestId !== 'string') return undefined;
    return { type: 'permission_response', requestId, answer, includeSubdomains };
  }
  if (value['type'] === 'bidi_input_response') {
    const { requestId, ok, error } = value;
    if (typeof requestId !== 'string') return undefined;
    if (ok === true) return { type: 'bidi_input_response', requestId, ok: true };
    // A malformed reply still settles its request instead of leaving it to the timeout.
    if (ok !== false || typeof error !== 'string') {
      return { type: 'bidi_input_response', requestId, ok: false, error: 'The native host sent a malformed input response' };
    }
    const unavailable = value['unavailable'] === true ? { unavailable: true as const } : {};
    return { type: 'bidi_input_response', requestId, ok: false, error, ...unavailable };
  }
  if (value['type'] === 'bidi_evaluate_response') return parseEvaluateResponse(value);
  if (value['type'] !== 'tool_request') return undefined;
  const { id, tool, args } = value;
  if (typeof id !== 'string' || typeof tool !== 'string' || !isRecord(args)) return undefined;
  const chatSessionId = value['chatSessionId'];
  return {
    type: 'tool_request',
    id,
    tool,
    args,
    ...(value['approvalViaClient'] === true ? { approvalViaClient: true } : {}),
    ...(isChatSessionId(chatSessionId) ? { chatSessionId } : {}),
  };
}
