import {
  type ChatClosed,
  type ChatContentBlock,
  type ChatEvent,
  type ChatHostMessage,
  type ChatStatus,
  type HostChatRequest,
  isChatSessionId,
} from '../protocol';
import { CLAUDE_CODE_PORT } from '../sidebar/sidebar-constants';
import { type BoundTab, buildClaudeCodeSystemPrompt } from './system-prompt';

export type { HostChatRequest };

// The host checks the version and the login with two claude runs of up to 15 s each.
export const STATUS_TIMEOUT_MS = 40_000;
const MAX_MODEL_LENGTH = 128;
// Must match CHAT_MODEL in host/protocol.ts.
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/;
const HOST_NOT_CONNECTED = 'The native host is not connected, so Claude Code cannot be started.';

/** hostConnected without a status: the host did not answer in time (a host older than this extension). */
export type ClaudeCodeStatusReply = { hostConnected: false } | { hostConnected: true; status?: ChatStatus };

/** Messages from the sidebar on its CLAUDE_CODE_PORT port. */
export type SidebarChatMessage =
  | { type: 'chat_start'; requestId: string; windowId: number; model?: string }
  | { type: 'chat_send'; sessionId: string; content: string | ChatContentBlock[] }
  | { type: 'chat_interrupt'; sessionId: string }
  | { type: 'chat_close'; sessionId: string }
  | { type: 'chat_status'; requestId: string };

/**
 * Messages to the sidebar. Every chat_started session ends with one chat_closed; chat_error codes are
 * the host's, plus unknown_session for a session this port does not own and host_disconnected.
 */
export type RelayChatMessage =
  | { type: 'chat_started'; requestId: string; sessionId: string; tab?: BoundTab }
  | { type: 'chat_start_error'; requestId: string; message: string }
  | ChatEvent
  | { type: 'chat_error'; sessionId: string; code: string; message: string }
  | ChatClosed
  | { type: 'chat_status'; requestId: string; reply: ClaudeCodeStatusReply };

export interface ClaudeCodeRelayOptions {
  /** False when the native host is not connected. */
  sendToHost: (message: HostChatRequest) => boolean;
  sidebarUrl: string;
  extensionId: string;
  activeTab: (windowId: number) => Promise<BoundTab | undefined>;
  /** runtime.PlatformOs */
  platform: () => Promise<string>;
  now?: () => Date;
  newSessionId?: () => string;
}

export interface ClaudeCodeRelay {
  connect: (port: browser.runtime.Port) => void;
  handleHostMessage: (message: ChatHostMessage) => void;
  hostDisconnected: () => void;
  status: () => Promise<ClaudeCodeStatusReply>;
}

interface SidebarConnection {
  port: browser.runtime.Port;
  open: boolean;
  sessions: Set<string>;
}

interface PendingStatus {
  resolve: (reply: ClaudeCodeStatusReply) => void;
  timer: ReturnType<typeof setTimeout>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isModelName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_MODEL_LENGTH && MODEL_NAME.test(value);
}

/**
 * Relays Claude Code chat sessions between sidebar ports and the native host. The background creates
 * every session id and remembers the port that started it, so a session's events reach only that port
 * and only that port can send to, interrupt or close it.
 *
 * Nothing here survives the event page: if Firefox unloads it, the sidebar ports disconnect and the
 * native port closes, which makes the host end every session.
 */
export function createClaudeCodeRelay(options: ClaudeCodeRelayOptions): ClaudeCodeRelay {
  const { sendToHost, sidebarUrl, extensionId, activeTab, platform } = options;
  const now = options.now ?? (() => new Date());
  const newSessionId = options.newSessionId ?? (() => crypto.randomUUID());
  const sessions = new Map<string, SidebarConnection>();
  const pendingStatus = new Map<string, PendingStatus>();
  let statusCount = 0;

  const post = (connection: SidebarConnection, message: RelayChatMessage): void => {
    if (!connection.open) return;
    try {
      connection.port.postMessage(message);
    } catch {
      // The sidebar closed between its disconnect and this message; its onDisconnect cleans up.
    }
  };

  const status = (): Promise<ClaudeCodeStatusReply> => {
    statusCount += 1;
    const requestId = `chat-status-${statusCount}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingStatus.delete(requestId);
        resolve({ hostConnected: true });
      }, STATUS_TIMEOUT_MS);
      pendingStatus.set(requestId, { resolve, timer });
      if (!sendToHost({ type: 'chat_status_request', requestId })) {
        clearTimeout(timer);
        pendingStatus.delete(requestId);
        resolve({ hostConnected: false });
      }
    });
  };

  const start = async (connection: SidebarConnection, requestId: string, message: Record<string, unknown>): Promise<void> => {
    const { windowId, model } = message;
    if (typeof windowId !== 'number' || !Number.isInteger(windowId)) {
      post(connection, { type: 'chat_start_error', requestId, message: 'The chat start needs the integer id of the sidebar window.' });
      return;
    }
    if (model !== undefined && !isModelName(model)) {
      post(connection, { type: 'chat_start_error', requestId, message: 'The model name is not valid.' });
      return;
    }
    const [tab, platformOs] = await Promise.all([activeTab(windowId).catch(() => undefined), platform().catch(() => 'unknown')]);
    if (!connection.open) return;
    const sessionId = newSessionId();
    const appendSystemPrompt = buildClaudeCodeSystemPrompt({ now: now(), platform: platformOs, ...(tab ? { tab } : {}) });
    sessions.set(sessionId, connection);
    connection.sessions.add(sessionId);
    if (!sendToHost({ type: 'chat_start', sessionId, ...(model === undefined ? {} : { model }), appendSystemPrompt })) {
      sessions.delete(sessionId);
      connection.sessions.delete(sessionId);
      post(connection, { type: 'chat_start_error', requestId, message: HOST_NOT_CONNECTED });
      return;
    }
    post(connection, { type: 'chat_started', requestId, sessionId, ...(tab ? { tab } : {}) });
  };

  const forward = (connection: SidebarConnection, message: Record<string, unknown>): void => {
    const { type, sessionId } = message;
    if (!isChatSessionId(sessionId)) return;
    if (sessions.get(sessionId) !== connection) {
      post(connection, { type: 'chat_error', sessionId, code: 'unknown_session', message: `There is no chat session ${sessionId} in this sidebar.` });
      return;
    }
    if (type === 'chat_send') {
      const { content } = message;
      if (typeof content !== 'string' && !Array.isArray(content)) return;
      sendToHost({ type, sessionId, content: content as string | ChatContentBlock[] });
    } else if (type === 'chat_interrupt' || type === 'chat_close') {
      sendToHost({ type, sessionId });
    }
  };

  const handleSidebarMessage = (connection: SidebarConnection, message: unknown): void => {
    if (!isRecord(message)) return;
    const { type, requestId } = message;
    if (type === 'chat_start') {
      if (typeof requestId === 'string') void start(connection, requestId, message);
      return;
    }
    if (type === 'chat_status') {
      if (typeof requestId !== 'string') return;
      void status().then((reply) => post(connection, { type: 'chat_status', requestId, reply }));
      return;
    }
    if (type === 'chat_send' || type === 'chat_interrupt' || type === 'chat_close') forward(connection, message);
  };

  const connect = (port: browser.runtime.Port): void => {
    if (port.name !== CLAUDE_CODE_PORT) return;
    const { sender } = port;
    if (sender?.id !== extensionId || sender.url !== sidebarUrl) {
      port.disconnect();
      return;
    }
    const connection: SidebarConnection = { port, open: true, sessions: new Set() };
    port.onMessage.addListener((message: unknown) => handleSidebarMessage(connection, message));
    port.onDisconnect.addListener(() => {
      connection.open = false;
      for (const sessionId of connection.sessions) {
        sessions.delete(sessionId);
        sendToHost({ type: 'chat_close', sessionId });
      }
      connection.sessions.clear();
    });
  };

  const handleHostMessage = (message: ChatHostMessage): void => {
    if (message.type === 'chat_status_response') {
      const pending = pendingStatus.get(message.requestId);
      if (!pending) return;
      pendingStatus.delete(message.requestId);
      clearTimeout(pending.timer);
      const { type: _type, requestId: _requestId, ...hostStatus } = message;
      pending.resolve({ hostConnected: true, status: hostStatus });
      return;
    }
    const connection = sessions.get(message.sessionId);
    if (!connection) return;
    if (message.type === 'chat_closed') {
      sessions.delete(message.sessionId);
      connection.sessions.delete(message.sessionId);
    }
    post(connection, message);
  };

  const hostDisconnected = (): void => {
    for (const [sessionId, connection] of sessions) {
      connection.sessions.delete(sessionId);
      post(connection, {
        type: 'chat_error',
        sessionId,
        code: 'host_disconnected',
        message: 'The native host disconnected, so the Claude Code session ended.',
      });
      post(connection, { type: 'chat_closed', sessionId });
    }
    sessions.clear();
    for (const pending of pendingStatus.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ hostConnected: false });
    }
    pendingStatus.clear();
  };

  return { connect, handleHostMessage, hostDisconnected, status };
}
