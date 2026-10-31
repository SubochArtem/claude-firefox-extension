export const NATIVE_HOST_NAME = 'claude_firefox_extension';
// Must match PROMPT_TIMEOUT_MS in extension/permissions/popup-prompt.ts.
export const PERMISSION_PROMPT_TIMEOUT_MS = 120_000;
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
  | { type: 'bidi_input_response'; requestId: string; ok: false; error: string };

export type ExtensionToHostMessage = { type: 'ping' } | ToolResponse | PermissionRequest | BidiInputRequest;
export type HostToExtensionMessage = { type: 'pong' } | ToolRequest | PermissionResponse | BidiInputResponse;

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
  const { requestId, callId, host, tool, action, canIncludeSubdomains } = value;
  if (!isField(requestId) || !isField(callId) || !isField(host) || !isField(tool) || !isField(action)) return undefined;
  if (typeof canIncludeSubdomains !== 'boolean') return undefined;
  return { type: 'permission_request', requestId, callId, host, tool, action, canIncludeSubdomains };
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

export function parseExtensionMessage(value: unknown): ExtensionToHostMessage | undefined {
  if (isRecord(value) && value['type'] === 'ping') return { type: 'ping' };
  if (isRecord(value) && value['type'] === 'permission_request') return parsePermissionRequest(value);
  if (isRecord(value) && value['type'] === 'bidi_input_request') return parseBidiInputRequest(value);
  return parseToolResponse(value);
}
