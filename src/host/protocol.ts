export const NATIVE_HOST_NAME = 'claude_firefox_extension';
// Must match the gecko id in extension/manifest.json; Firefox passes it to the native host as an argument.
export const EXTENSION_ID = 'claude-firefox-extension@localhost';
// Must match PROMPT_TIMEOUT_MS in extension/permissions/popup-prompt.ts.
export const PERMISSION_PROMPT_TIMEOUT_MS = 120_000;
// Environment variable that carries a sidebar chat session's token to the MCP server Claude Code
// starts for it; the MCP server presents the token in the bridge handshake.
export const CHAT_TOKEN_ENV = 'CLAUDE_FIREFOX_CHAT_TOKEN';
// A tool call may wait for the user's answer to a permission prompt before it acts, so the agent gets
// the tool's own answer as long as the prompt and the action after it end within this time.
export const TOOL_REQUEST_TIMEOUT_MS = PERMISSION_PROMPT_TIMEOUT_MS + 30_000;

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
  // Set by the MCP server when its client supports elicitation: the extension then asks the user
  // through permission_request instead of its popup.
  approvalViaClient?: true;
  // Set by the native host, never by a client, on calls from the MCP server of a sidebar chat
  // session: that Claude Code runs headless, so the extension asks in its popup.
  chatSessionId?: string;
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
  // Present when the MCP server runs for a sidebar chat session (CHAT_TOKEN_ENV).
  chatToken?: string;
}

export interface Ready {
  type: 'ready';
}

// Must match APPROVAL_ANSWERS in extension/permissions/approval.ts.
export const PERMISSION_ANSWERS = ['allow_once', 'allow_always', 'deny', 'deny_always'] as const;
export const MAX_PERMISSION_FIELD_LENGTH = 1024;

// Asks the MCP client that owns the tool call `callId` whether the call may act on `host`.
export interface PermissionRequest {
  type: 'permission_request';
  requestId: string;
  callId: string;
  host: string;
  tool: string;
  action: string;
  canIncludeSubdomains: boolean;
  // A preview of the code the tool will run (javascript_tool), shown with the question.
  code?: string;
}

// `answer` is one of PERMISSION_ANSWERS when well formed; the extension validates it and denies otherwise.
export interface PermissionResponse {
  type: 'permission_response';
  requestId: string;
  answer: string;
  includeSubdomains: boolean;
}

// Must match BIDI_INPUT_TIMEOUT_MS in extension/protocol.ts.
export const BIDI_INPUT_TIMEOUT_MS = 60_000;
export const MAX_BIDI_INPUT_SOURCES = 16;
export const MAX_BIDI_INPUT_ACTIONS = 10_000;
export const MAX_BIDI_INPUT_URL_LENGTH = 65_536;
const MARKER_NAME = /^[A-Za-z_][A-Za-z0-9_]{7,63}$/;
const MARKER_VALUE = /^[0-9a-f]{32,128}$/;

// A property the extension has set on `window` in the main world of the tab's top frame, so the
// host can find the tab's WebDriver BiDi browsing context.
export interface TabMarker {
  name: string;
  value: string;
}

// Asks the host to run WebDriver BiDi input.performActions with `actions` in the tab carrying `marker`.
export interface BidiInputRequest {
  type: 'bidi_input_request';
  requestId: string;
  marker: TabMarker;
  url: string;
  actions: Record<string, unknown>[];
}

export type BidiInputResponse =
  | { type: 'bidi_input_response'; requestId: string; ok: true }
  | { type: 'bidi_input_response'; requestId: string; ok: false; error: string; unavailable?: true };

// Must match BIDI_EVALUATE_TIMEOUT_MS in extension/protocol.ts.
export const BIDI_EVALUATE_TIMEOUT_MS = 90_000;
export const MAX_BIDI_EVALUATE_CODE_LENGTH = 1_000_000;

// Asks the host to run `code` with WebDriver BiDi script.evaluate in the main realm of the marked tab.
export interface BidiEvaluateRequest {
  type: 'bidi_evaluate_request';
  requestId: string;
  marker: TabMarker;
  url: string;
  code: string;
}

// `value` is the formatted result and `exception` the formatted uncaught exception; both are text,
// since a native message to the extension is limited to 1 MB.
export type BidiEvaluateResponse =
  | { type: 'bidi_evaluate_response'; requestId: string; ok: true; value: string }
  | { type: 'bidi_evaluate_response'; requestId: string; ok: true; exception: string }
  | { type: 'bidi_evaluate_response'; requestId: string; ok: false; error: string; unavailable?: true };

export const MAX_CHAT_SESSION_ID_LENGTH = 128;
export const MAX_CHAT_MODEL_LENGTH = 128;
// The prompt travels on claude's command line, which Windows limits to 32,767 characters.
export const MAX_CHAT_SYSTEM_PROMPT_LENGTH = 16_000;
export const MAX_CHAT_CONTENT_BLOCKS = 100;
const CHAT_SESSION_ID = /^[A-Za-z0-9_-]+$/;
// A model alias or full name; never starting with '-', so the CLI cannot read it as an option.
const CHAT_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/;
const CHAT_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;

export type ChatImageMediaType = (typeof CHAT_IMAGE_TYPES)[number];
export type ChatContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: ChatImageMediaType; data: string } };

// Starts a local Claude Code session; it ends with exactly one chat_closed.
export interface ChatStart {
  type: 'chat_start';
  sessionId: string;
  model?: string;
  appendSystemPrompt?: string;
}

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

export type ChatRequest = ChatStart | ChatSend | ChatInterrupt | ChatClose;

// One stream-json event of the session's claude process. `reduced` is set when large parts were
// replaced with markers to keep the message under the native messaging limit.
export interface ChatEvent {
  type: 'chat_event';
  sessionId: string;
  event: Record<string, unknown>;
  reduced?: true;
}

export type ChatErrorCode =
  | 'invalid_request'
  | 'unknown_session'
  | 'too_many_sessions'
  | 'claude_not_found'
  | 'claude_too_old'
  | 'not_logged_in'
  | 'spawn_failed'
  | 'exited';

export interface ChatError {
  type: 'chat_error';
  sessionId: string;
  code: ChatErrorCode;
  message: string;
}

export interface ChatClosed {
  type: 'chat_closed';
  sessionId: string;
}

export type ExtensionToHostMessage =
  | { type: 'ping' }
  | ToolResponse
  | PermissionRequest
  | BidiInputRequest
  | BidiEvaluateRequest
  | ChatRequest;
export type HostToExtensionMessage =
  | { type: 'pong' }
  | ToolRequest
  | PermissionResponse
  | BidiInputResponse
  | BidiEvaluateResponse
  | ChatEvent
  | ChatError
  | ChatClosed;

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
  return { type: 'tool_request', id, tool, args, ...(value['approvalViaClient'] === true ? { approvalViaClient: true } : {}) };
}

export function parseToolResponse(value: unknown): ToolResponse | undefined {
  if (!isRecord(value) || value['type'] !== 'tool_response') return undefined;
  const { id, result, error } = value;
  if (typeof id !== 'string') return undefined;
  if (isToolOutput(result)) return { type: 'tool_response', id, result };
  if (isToolOutput(error)) return { type: 'tool_response', id, error };
  return undefined;
}

function isField(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PERMISSION_FIELD_LENGTH;
}

export function parsePermissionRequest(value: unknown): PermissionRequest | undefined {
  if (!isRecord(value) || value['type'] !== 'permission_request') return undefined;
  const { requestId, callId, host, tool, action, canIncludeSubdomains, code } = value;
  if (!isField(requestId) || !isField(callId) || !isField(host) || !isField(tool) || !isField(action)) return undefined;
  if (typeof canIncludeSubdomains !== 'boolean') return undefined;
  if (code !== undefined && !isField(code)) return undefined;
  return { type: 'permission_request', requestId, callId, host, tool, action, canIncludeSubdomains, ...(code === undefined ? {} : { code }) };
}

export function denyPermission(requestId: string): PermissionResponse {
  return { type: 'permission_response', requestId, answer: 'deny', includeSubdomains: false };
}

// A response for a known request is never dropped for a malformed answer, which would leave the
// extension waiting for its timeout; it is passed on as a deny.
export function parsePermissionResponse(value: unknown): PermissionResponse | undefined {
  if (!isRecord(value) || value['type'] !== 'permission_response') return undefined;
  const { requestId, answer, includeSubdomains } = value;
  if (!isField(requestId)) return undefined;
  if (!isField(answer) || typeof includeSubdomains !== 'boolean') return denyPermission(requestId);
  return { type: 'permission_response', requestId, answer, includeSubdomains };
}

function parseMarker(value: unknown): TabMarker | undefined {
  if (!isRecord(value)) return undefined;
  const { name, value: markerValue } = value;
  if (typeof name !== 'string' || !MARKER_NAME.test(name)) return undefined;
  if (typeof markerValue !== 'string' || !MARKER_VALUE.test(markerValue)) return undefined;
  return { name, value: markerValue };
}

// Only the outer shape is checked; Firefox validates the actions themselves.
function parseInputSources(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BIDI_INPUT_SOURCES) return undefined;
  let total = 0;
  for (const source of value) {
    if (!isRecord(source) || typeof source['type'] !== 'string' || typeof source['id'] !== 'string') return undefined;
    const actions = source['actions'];
    if (!Array.isArray(actions) || !actions.every(isRecord)) return undefined;
    total += actions.length;
    if (total > MAX_BIDI_INPUT_ACTIONS) return undefined;
  }
  return value as Record<string, unknown>[];
}

export function parseBidiInputRequest(value: unknown): BidiInputRequest | undefined {
  if (!isRecord(value) || value['type'] !== 'bidi_input_request') return undefined;
  const { requestId, url } = value;
  if (!isField(requestId)) return undefined;
  if (typeof url !== 'string' || url.length > MAX_BIDI_INPUT_URL_LENGTH) return undefined;
  const marker = parseMarker(value['marker']);
  const actions = parseInputSources(value['actions']);
  if (!marker || !actions) return undefined;
  return { type: 'bidi_input_request', requestId, marker, url, actions };
}

export function parseBidiEvaluateRequest(value: unknown): BidiEvaluateRequest | undefined {
  if (!isRecord(value) || value['type'] !== 'bidi_evaluate_request') return undefined;
  const { requestId, url, code } = value;
  if (!isField(requestId)) return undefined;
  if (typeof url !== 'string' || url.length > MAX_BIDI_INPUT_URL_LENGTH) return undefined;
  if (typeof code !== 'string' || code.length === 0 || code.length > MAX_BIDI_EVALUATE_CODE_LENGTH) return undefined;
  const marker = parseMarker(value['marker']);
  if (!marker) return undefined;
  return { type: 'bidi_evaluate_request', requestId, marker, url, code };
}

export function isChatSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_CHAT_SESSION_ID_LENGTH && CHAT_SESSION_ID.test(value);
}

function parseChatContentBlock(value: unknown): ChatContentBlock | undefined {
  if (!isRecord(value)) return undefined;
  if (value['type'] === 'text') {
    const text = value['text'];
    return typeof text === 'string' && text.length > 0 ? { type: 'text', text } : undefined;
  }
  if (value['type'] !== 'image') return undefined;
  const source = value['source'];
  if (!isRecord(source) || source['type'] !== 'base64') return undefined;
  const { media_type: mediaType, data } = source;
  if (!CHAT_IMAGE_TYPES.some((type) => type === mediaType) || typeof data !== 'string' || data.length === 0) return undefined;
  return { type: 'image', source: { type: 'base64', media_type: mediaType as ChatImageMediaType, data } };
}

function parseChatContent(value: unknown): string | ChatContentBlock[] | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CHAT_CONTENT_BLOCKS) return undefined;
  const blocks: ChatContentBlock[] = [];
  for (const item of value) {
    const block = parseChatContentBlock(item);
    if (!block) return undefined;
    blocks.push(block);
  }
  return blocks;
}

export function parseChatRequest(value: unknown): ChatRequest | undefined {
  if (!isRecord(value)) return undefined;
  const { type, sessionId } = value;
  if (!isChatSessionId(sessionId)) return undefined;
  if (type === 'chat_interrupt' || type === 'chat_close') return { type, sessionId };
  if (type === 'chat_send') {
    const content = parseChatContent(value['content']);
    return content === undefined ? undefined : { type, sessionId, content };
  }
  if (type !== 'chat_start') return undefined;
  const { model, appendSystemPrompt } = value;
  if (model !== undefined && (typeof model !== 'string' || model.length > MAX_CHAT_MODEL_LENGTH || !CHAT_MODEL.test(model))) {
    return undefined;
  }
  if (
    appendSystemPrompt !== undefined &&
    (typeof appendSystemPrompt !== 'string' || appendSystemPrompt.length > MAX_CHAT_SYSTEM_PROMPT_LENGTH)
  ) {
    return undefined;
  }
  return {
    type,
    sessionId,
    ...(model === undefined ? {} : { model }),
    ...(appendSystemPrompt === undefined || appendSystemPrompt === '' ? {} : { appendSystemPrompt }),
  };
}

export function isChatRequestType(value: unknown): boolean {
  return isRecord(value) && typeof value['type'] === 'string' && value['type'].startsWith('chat_');
}

export function parseExtensionMessage(value: unknown): ExtensionToHostMessage | undefined {
  if (isRecord(value) && value['type'] === 'ping') return { type: 'ping' };
  if (isChatRequestType(value)) return parseChatRequest(value);
  if (isRecord(value) && value['type'] === 'permission_request') return parsePermissionRequest(value);
  if (isRecord(value) && value['type'] === 'bidi_input_request') return parseBidiInputRequest(value);
  if (isRecord(value) && value['type'] === 'bidi_evaluate_request') return parseBidiEvaluateRequest(value);
  return parseToolResponse(value);
}
