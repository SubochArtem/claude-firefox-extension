import { type AgentLoopEvents, type AgentLoopOutcome, MAX_RETRIES, type RetryInfo } from '../chat/agent-loop';
import { ChatApiError } from '../chat/chat-errors';
import type { ChatMessage, ImageBlock, TextBlock, ToolResultBlock, ToolUseBlock } from '../chat/provider';

export const SUMMARY_LIMIT = 120;
export const RESULT_LIMIT = 2_000;
export const SCREENSHOT_LABEL = '[screenshot]';

export interface ToolResultView {
  text: string;
  isError: boolean;
}

export interface AssistantItem {
  id: number;
  kind: 'assistant';
  text: string;
}

export type ChatItem =
  | { id: number; kind: 'user'; text: string }
  | AssistantItem
  | { id: number; kind: 'tool'; toolUseId: string; name: string; summary: string; result?: ToolResultView }
  | { id: number; kind: 'notice'; level: 'info' | 'error'; text: string };

export type ChatChange = { type: 'add' | 'update' | 'remove'; item: ChatItem } | { type: 'clear' } | { type: 'running'; running: boolean };

// Runs the agent loop on the history; the caller supplies the provider, model, system prompt and tools.
export type RunLoop = (history: ChatMessage[], signal: AbortSignal, events: AgentLoopEvents) => Promise<AgentLoopOutcome>;

// The API rejects two user messages in a row, so a prompt after a cancel (tool results) or a failed
// request (the previous prompt) joins the trailing user message.
export function appendUserText(history: ChatMessage[], text: string): void {
  const last = history.at(-1);
  if (last?.role === 'user') last.content.push({ type: 'text', text });
  else history.push({ role: 'user', content: [{ type: 'text', text }] });
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function clipSummary(value: string): string {
  return value.length > SUMMARY_LIMIT ? `${value.slice(0, SUMMARY_LIMIT)}…` : value;
}

export function summarizeInput(input: Record<string, unknown>): string {
  const parts = Object.entries(input).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  return clipSummary(oneLine(parts.join(', ')));
}

export function resultText(content: readonly (TextBlock | ImageBlock)[]): string {
  const text = content.map((part) => (part.type === 'image' ? SCREENSHOT_LABEL : part.text)).join('\n');
  if (text.length <= RESULT_LIMIT) return text;
  return `${text.slice(0, RESULT_LIMIT)}… (${text.length - RESULT_LIMIT} more characters)`;
}

function errorText(error: Error): string {
  const authentication = error instanceof ChatApiError && (error.status === 401 || error.errorType === 'authentication_error');
  return authentication ? `${error.message}. Check the API key in the options page.` : error.message;
}

function outcomeNotice(outcome: AgentLoopOutcome): { level: 'info' | 'error'; text: string } | undefined {
  switch (outcome.kind) {
    case 'end_turn':
      return undefined;
    case 'cancelled':
      return { level: 'info', text: 'Stopped.' };
    case 'max_tokens':
      return { level: 'error', text: 'The response hit the output token limit and was cut off.' };
    case 'turn_limit':
      return { level: 'error', text: `Stopped after ${outcome.turns} turns: the turn limit was reached.` };
    case 'other':
      return { level: 'error', text: 'The response ended early (stop reason: other).' };
    case 'error':
      return { level: 'error', text: errorText(outcome.error) };
  }
}

function retryText({ attempt, delayMs, error }: RetryInfo): string {
  return `Retrying in ${delayMs / 1000} s (attempt ${attempt} of ${MAX_RETRIES}): ${error.message}`;
}

// The sidebar's conversation: history, running state and the list of items the page shows.
// No browser.* calls; the page renders the changes it is notified about.
export class ChatSession {
  readonly history: ChatMessage[] = [];
  private readonly list: ChatItem[] = [];
  private nextId = 1;
  private controller: AbortController | undefined;
  private streaming: AssistantItem | undefined;

  constructor(
    private readonly runLoop: RunLoop,
    private readonly onChange: (change: ChatChange) => void,
  ) {}

  get items(): readonly ChatItem[] {
    return this.list;
  }

  get running(): boolean {
    return this.controller !== undefined;
  }

  // Resolves when the run is over; false when nothing was sent (blank text or a run in progress).
  async send(input: string): Promise<boolean> {
    const text = input.trim();
    if (text === '' || this.running) return false;
    const controller = new AbortController();
    this.controller = controller;
    this.streaming = undefined;
    this.onChange({ type: 'running', running: true });
    this.add({ id: 0, kind: 'user', text });
    appendUserText(this.history, text);
    try {
      const outcome = await this.runLoop(this.history, controller.signal, this.events());
      this.showOutcome(outcome);
    } catch (error) {
      this.showOutcome({ kind: 'error', turns: 0, error: error instanceof Error ? error : new Error(String(error)) });
    } finally {
      this.controller = undefined;
      this.streaming = undefined;
      this.onChange({ type: 'running', running: false });
    }
    return true;
  }

  stop(): void {
    this.controller?.abort();
  }

  newChat(): boolean {
    if (this.running) return false;
    this.history.length = 0;
    this.list.length = 0;
    this.onChange({ type: 'clear' });
    return true;
  }

  private events(): AgentLoopEvents {
    return {
      onText: (delta) => this.appendText(delta),
      onToolCall: (call) => this.addToolCall(call),
      onToolResult: (result) => this.setToolResult(result),
      onRetry: (info) => {
        if (this.streaming !== undefined) this.remove(this.streaming);
        this.streaming = undefined;
        this.add({ id: 0, kind: 'notice', level: 'info', text: retryText(info) });
      },
    };
  }

  private showOutcome(outcome: AgentLoopOutcome): void {
    const notice = outcomeNotice(outcome);
    if (notice !== undefined) this.add({ id: 0, kind: 'notice', ...notice });
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

  private addToolCall(call: ToolUseBlock): void {
    this.streaming = undefined;
    this.add({ id: 0, kind: 'tool', toolUseId: call.id, name: call.name, summary: summarizeInput(call.input) });
  }

  // Results of calls that never started (cancelled or cut off) have no item and are not shown.
  private setToolResult(result: ToolResultBlock): void {
    const item = this.list.find((entry) => entry.kind === 'tool' && entry.toolUseId === result.tool_use_id);
    if (item?.kind !== 'tool') return;
    item.result = { text: resultText(result.content), isError: result.is_error === true };
    this.onChange({ type: 'update', item });
  }

  private add(item: ChatItem): void {
    item.id = this.nextId;
    this.nextId += 1;
    this.list.push(item);
    this.onChange({ type: 'add', item });
  }

  private remove(item: ChatItem): void {
    const index = this.list.indexOf(item);
    if (index === -1) return;
    this.list.splice(index, 1);
    this.onChange({ type: 'remove', item });
  }
}
