import type { ClaudeCodeStatusReply, SidebarChatMessage } from '../chat/claude-code-relay';
import type { TextBlock } from '../chat/provider';
import { type AssistantItem, type ChatChange, type ChatItem, resultText, SCREENSHOT_LABEL, summarizeInput } from './chat-session';

export const MCP_TOOL_PREFIX = 'mcp__firefox__';
export const SESSION_ENDED_TEXT = 'The Claude Code session ended. The next prompt starts a new session without the earlier messages.';
export const DISCONNECTED_TEXT =
  'The connection to the extension background was lost, so the Claude Code session ended. The next prompt starts a new session without the earlier messages.';
export const REDUCED_TEXT = 'Part of a Claude Code message was too large for the sidebar and was shortened.';

const ERROR_HINTS: Record<string, string> = {
  not_logged_in: 'Run "claude" in a terminal and log in, or run "claude auth login".',
  claude_not_found: 'Install Claude Code, or set CLAUDE_FIREFOX_CLAUDE_PATH in the environment Firefox starts with.',
  claude_too_old: 'Update Claude Code to 2.1.302 or newer.',
  too_many_sessions: 'Close the sidebar chat in another window, then try again.',
  host_disconnected: 'Check that the native host is installed, then try again.',
};

/** The parts of runtime.Port the session uses. */
export type ChatPort = Pick<browser.runtime.Port, 'postMessage' | 'disconnect' | 'onMessage' | 'onDisconnect'>;

export interface ClaudeCodeSessionOptions {
  /** Opens a port to the background's Claude Code relay. */
  connect: () => ChatPort;
  /** The sidebar's window, whose active tab the session starts on. */
  windowId: () => Promise<number | undefined>;
  model: () => Promise<string | undefined>;
  onChange: (change: ChatChange) => void;
}

interface PendingStatus {
  resolve: (reply: ClaudeCodeStatusReply) => void;
  reject: (error: Error) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function toolName(name: string): string {
  return name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name;
}

export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return resultText([{ type: 'text', text: content }]);
  const parts: TextBlock[] = [];
  for (const block of records(content)) {
    if (block.type === 'image') parts.push({ type: 'text', text: SCREENSHOT_LABEL });
    else if (block.type === 'text' && typeof block.text === 'string') parts.push({ type: 'text', text: block.text });
  }
  return resultText(parts);
}

export function chatErrorText(code: string, message: string): string {
  const hint = ERROR_HINTS[code];
  return hint === undefined ? message : `${message} ${hint}`;
}

function resultNotice(event: Record<string, unknown>, interrupted: boolean): { level: 'info' | 'error'; text: string } | undefined {
  const { subtype, result } = event;
  if (event.is_error !== true && subtype === 'success') return undefined;
  if (interrupted) return { level: 'info', text: 'Stopped.' };
  if (typeof result === 'string' && result.trim() !== '') return { level: 'error', text: `Claude Code: ${result.trim()}` };
  return { level: 'error', text: `The turn ended with an error (${typeof subtype === 'string' ? subtype : 'unknown'}).` };
}

/**
 * The sidebar's conversation with local Claude Code through the background relay. No browser.* calls:
 * the page supplies the port and the window, and renders the changes it is notified about.
 *
 * One claude session per conversation, started on the first prompt. A lost port (the background
 * unloaded or reloaded) ends the session; nothing is resent, and the next action opens a new port.
 */
export class ClaudeCodeSession {
  private readonly list: ChatItem[] = [];
  private nextId = 1;
  private nextRequest = 1;
  private connection: ChatPort | undefined;
  private sessionId: string | undefined;
  private startRequestId: string | undefined;
  private queued: string | undefined;
  private turnRunning = false;
  private interrupted = false;
  private initSeen = false;
  private streaming: AssistantItem | undefined;
  private streamMessageId: string | undefined;
  private readonly streamedMessages = new Set<string>();
  private streamedWithoutId = false;
  private readonly pendingStatus = new Map<string, PendingStatus>();
  // Bumped by newChat, so async work of the previous conversation is dropped.
  private epoch = 0;

  constructor(private readonly options: ClaudeCodeSessionOptions) {}

  get items(): readonly ChatItem[] {
    return this.list;
  }

  get running(): boolean {
    return this.turnRunning;
  }

  /** False when nothing was sent (blank text or a turn in progress). */
  send(input: string): boolean {
    const text = input.trim();
    if (text === '' || this.turnRunning) return false;
    this.setRunning(true);
    this.interrupted = false;
    this.endStreaming();
    this.add({ id: 0, kind: 'user', text });
    if (this.sessionId !== undefined) {
      this.post({ type: 'chat_send', sessionId: this.sessionId, content: text });
      return true;
    }
    this.queued = text;
    if (this.startRequestId === undefined) void this.start();
    return true;
  }

  /** Interrupts the running turn; it ends when claude reports its result. */
  stop(): void {
    if (!this.turnRunning) return;
    if (this.sessionId === undefined) {
      this.queued = undefined;
      this.endTurn({ level: 'info', text: 'Stopped.' });
      return;
    }
    this.interrupted = true;
    this.post({ type: 'chat_interrupt', sessionId: this.sessionId });
  }

  /** Closes the session and clears the conversation; the next prompt starts a new session. */
  newChat(): void {
    this.epoch += 1;
    if (this.sessionId !== undefined && this.connection !== undefined) this.post({ type: 'chat_close', sessionId: this.sessionId });
    this.resetSession();
    this.list.length = 0;
    this.onChange({ type: 'clear' });
    if (this.turnRunning) this.setRunning(false);
  }

  status(): Promise<ClaudeCodeStatusReply> {
    const requestId = `status-${this.nextRequest++}`;
    return new Promise((resolve, reject) => {
      this.pendingStatus.set(requestId, { resolve, reject });
      this.post({ type: 'chat_status', requestId });
    });
  }

  private async start(): Promise<void> {
    const epoch = this.epoch;
    const requestId = `start-${this.nextRequest++}`;
    this.startRequestId = requestId;
    let windowId: number | undefined;
    let model: string | undefined;
    try {
      [windowId, model] = await Promise.all([this.options.windowId(), this.options.model()]);
    } catch (error) {
      windowId = undefined;
      if (epoch === this.epoch && this.startRequestId === requestId) {
        this.startRequestId = undefined;
        this.queued = undefined;
        this.endTurn({ level: 'error', text: `Could not start Claude Code: ${error instanceof Error ? error.message : String(error)}` });
      }
      return;
    }
    if (epoch !== this.epoch || this.startRequestId !== requestId) return;
    if (windowId === undefined) {
      this.startRequestId = undefined;
      this.queued = undefined;
      this.endTurn({ level: 'error', text: 'Could not start Claude Code: the sidebar window was not found.' });
      return;
    }
    this.post({ type: 'chat_start', requestId, windowId, ...(model === undefined ? {} : { model }) });
  }

  private port(): ChatPort {
    if (this.connection !== undefined) return this.connection;
    const port = this.options.connect();
    this.connection = port;
    port.onMessage.addListener((message: unknown) => {
      if (this.connection === port) this.handleMessage(message);
    });
    port.onDisconnect.addListener(() => {
      if (this.connection === port) this.disconnected();
    });
    return port;
  }

  private post(message: SidebarChatMessage): void {
    try {
      this.port().postMessage(message);
    } catch {
      // The port closed before its onDisconnect ran.
      this.disconnected();
    }
  }

  private disconnected(): void {
    this.connection = undefined;
    const hadSession = this.sessionId !== undefined || this.startRequestId !== undefined;
    this.resetSession();
    for (const pending of this.pendingStatus.values()) pending.reject(new Error('The connection to the extension background was lost.'));
    this.pendingStatus.clear();
    if (this.turnRunning) this.endTurn({ level: 'error', text: DISCONNECTED_TEXT });
    else if (hadSession) this.add({ id: 0, kind: 'notice', level: 'info', text: DISCONNECTED_TEXT });
  }

  private resetSession(): void {
    this.sessionId = undefined;
    this.startRequestId = undefined;
    this.queued = undefined;
    this.initSeen = false;
    this.endStreaming();
  }

  private handleMessage(message: unknown): void {
    if (!isRecord(message)) return;
    const { type, requestId, sessionId } = message;
    if (type === 'chat_status' && typeof requestId === 'string') {
      const pending = this.pendingStatus.get(requestId);
      if (pending === undefined) return;
      this.pendingStatus.delete(requestId);
      pending.resolve(message.reply as ClaudeCodeStatusReply);
      return;
    }
    if (type === 'chat_started' && typeof requestId === 'string' && typeof sessionId === 'string') {
      this.started(requestId, sessionId);
      return;
    }
    if (type === 'chat_start_error' && requestId === this.startRequestId && requestId !== undefined) {
      this.startRequestId = undefined;
      this.queued = undefined;
      this.endTurn({ level: 'error', text: `Could not start Claude Code: ${String(message.message)}` });
      return;
    }
    const current = this.sessionId;
    if (current === undefined || sessionId !== current) return;
    if (type === 'chat_event' && isRecord(message.event)) {
      if (message.reduced === true) this.add({ id: 0, kind: 'notice', level: 'info', text: REDUCED_TEXT });
      this.handleEvent(message.event);
    } else if (type === 'chat_error') {
      // Every error ends the session here; closing an already closed one is harmless.
      this.post({ type: 'chat_close', sessionId: current });
      this.resetSession();
      this.endTurn({ level: 'error', text: chatErrorText(String(message.code), String(message.message)) }, true);
    } else if (type === 'chat_closed') {
      this.resetSession();
      this.endTurn({ level: 'info', text: SESSION_ENDED_TEXT }, true);
    }
  }

  private started(requestId: string, sessionId: string): void {
    if (requestId !== this.startRequestId) {
      // A start of a conversation that was cleared meanwhile.
      this.post({ type: 'chat_close', sessionId });
      return;
    }
    this.startRequestId = undefined;
    this.sessionId = sessionId;
    const text = this.queued;
    this.queued = undefined;
    if (text !== undefined) this.post({ type: 'chat_send', sessionId, content: text });
  }

  private handleEvent(event: Record<string, unknown>): void {
    switch (event.type) {
      case 'system':
        if (event.subtype === 'init' && !this.initSeen) {
          this.initSeen = true;
          const model = typeof event.model === 'string' ? ` (${event.model})` : '';
          this.add({ id: 0, kind: 'notice', level: 'info', text: `Claude Code session started${model}.` });
        }
        return;
      case 'stream_event':
        if (isRecord(event.event)) this.handleStreamEvent(event.event);
        return;
      case 'assistant':
        if (isRecord(event.message)) this.handleAssistant(event.message);
        return;
      case 'user':
        if (isRecord(event.message)) this.handleUser(event.message);
        return;
      case 'result':
        this.endStreaming();
        this.endTurn(resultNotice(event, this.interrupted));
        return;
    }
  }

  private handleStreamEvent(event: Record<string, unknown>): void {
    if (event.type === 'message_start') {
      this.endStreaming();
      const id = isRecord(event.message) ? event.message.id : undefined;
      this.streamMessageId = typeof id === 'string' ? id : undefined;
      return;
    }
    if (event.type === 'content_block_start') {
      this.streaming = undefined;
      return;
    }
    if (event.type !== 'content_block_delta' || !isRecord(event.delta)) return;
    const { delta } = event;
    if (delta.type !== 'text_delta' || typeof delta.text !== 'string' || delta.text === '') return;
    if (this.streamMessageId === undefined) this.streamedWithoutId = true;
    else this.streamedMessages.add(this.streamMessageId);
    this.appendText(delta.text);
  }

  // With partial messages the text already arrived as deltas; the full message only adds what was not streamed.
  private handleAssistant(message: Record<string, unknown>): void {
    const streamed = typeof message.id === 'string' ? this.streamedMessages.has(message.id) : this.streamedWithoutId;
    for (const block of records(message.content)) {
      if (block.type === 'text' && typeof block.text === 'string') {
        if (streamed || block.text.trim() === '') continue;
        this.endStreaming();
        this.add({ id: 0, kind: 'assistant', text: block.text });
      } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        this.addToolCall(block.id, block.name, isRecord(block.input) ? block.input : {});
      }
    }
  }

  private handleUser(message: Record<string, unknown>): void {
    for (const block of records(message.content)) {
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      const item = this.list.find((entry) => entry.kind === 'tool' && entry.toolUseId === block.tool_use_id);
      if (item?.kind !== 'tool') continue;
      item.result = { text: toolResultText(block.content), isError: block.is_error === true };
      this.onChange({ type: 'update', item });
    }
  }

  private addToolCall(id: string, name: string, input: Record<string, unknown>): void {
    this.streaming = undefined;
    if (this.list.some((entry) => entry.kind === 'tool' && entry.toolUseId === id)) return;
    this.add({ id: 0, kind: 'tool', toolUseId: id, name: toolName(name), summary: summarizeInput(input) });
  }

  private appendText(delta: string): void {
    if (this.streaming === undefined) {
      this.streaming = { id: 0, kind: 'assistant', text: delta };
      this.add(this.streaming);
      return;
    }
    this.streaming.text += delta;
    this.onChange({ type: 'update', item: this.streaming });
  }

  private endStreaming(): void {
    this.streaming = undefined;
    this.streamMessageId = undefined;
    this.streamedMessages.clear();
    this.streamedWithoutId = false;
  }

  // A notice for an ended session is shown even between turns, so the user learns it is gone.
  private endTurn(notice: { level: 'info' | 'error'; text: string } | undefined, always = false): void {
    const wasRunning = this.turnRunning;
    if (notice !== undefined && (wasRunning || always)) this.add({ id: 0, kind: 'notice', ...notice });
    this.interrupted = false;
    if (wasRunning) this.setRunning(false);
  }

  private setRunning(running: boolean): void {
    this.turnRunning = running;
    this.onChange({ type: 'running', running });
  }

  private onChange(change: ChatChange): void {
    this.options.onChange(change);
  }

  private add(item: ChatItem): void {
    item.id = this.nextId;
    this.nextId += 1;
    this.list.push(item);
    this.onChange({ type: 'add', item });
  }
}
