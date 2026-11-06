import { ANTHROPIC_TOOLS, type AnthropicTool } from '../../shared/anthropic-tools';
import { ChatAbortError, ChatApiError } from './chat-errors';
import type {
  ChatMessage,
  ChatProvider,
  ChatTurnResult,
  ImageBlock,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  UserContentBlock,
} from './provider';

export const DEFAULT_MAX_TURNS = 50;
export const DEFAULT_MAX_TOKENS = 8192;
export const MAX_RETRIES = 3;
export const RETRY_BASE_DELAY_MS = 1_000;
export const KEPT_IMAGE_RESULTS = 3;
export const CANCELLED_TEXT = 'cancelled by user';
export const IMAGE_PLACEHOLDER = '[earlier screenshot removed]';
const NOT_RUN_TEXT = 'The tool was not run: the response ended first';

// A tool's output as the sidebar receives it from the background script.
export interface ChatToolResult {
  content: (TextBlock | ImageBlock)[];
  isError: boolean;
}

export type ToolExecutor = (call: ToolUseBlock, signal: AbortSignal) => Promise<ChatToolResult>;
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export type AgentLoopOutcome =
  | { kind: 'end_turn' | 'max_tokens' | 'other' | 'turn_limit' | 'cancelled'; turns: number }
  | { kind: 'error'; turns: number; error: Error };

export interface RetryInfo {
  attempt: number;
  delayMs: number;
  error: ChatApiError;
}

export interface AgentLoopEvents {
  onText?: (delta: string) => void;
  onToolCall?: (call: ToolUseBlock) => void;
  onToolResult?: (result: ToolResultBlock) => void;
  // The partial text streamed by the failed attempt is not part of the history and should be dropped.
  onRetry?: (info: RetryInfo) => void;
  onDone?: (outcome: AgentLoopOutcome) => void;
  onError?: (error: Error) => void;
}

export interface AgentLoopOptions {
  provider: ChatProvider;
  executeTool: ToolExecutor;
  // Appended to in place: the assistant turns and the tool results of this run.
  history: ChatMessage[];
  model: string;
  system: TextBlock[];
  signal: AbortSignal;
  tools?: readonly AnthropicTool[];
  maxTokens?: number;
  maxTurns?: number;
  sleep?: Sleep;
  events?: AgentLoopEvents;
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ChatAbortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ChatAbortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// Resolves with undefined when the signal aborts first; the promise itself keeps running.
function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(undefined);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function trimResult(block: ToolResultBlock): ToolResultBlock {
  const content = block.content.map((part): TextBlock | ImageBlock =>
    part.type === 'image' ? { type: 'text', text: IMAGE_PLACEHOLDER } : part,
  );
  return { ...block, content };
}

const hasImage = (block: UserContentBlock): block is ToolResultBlock =>
  block.type === 'tool_result' && block.content.some((part) => part.type === 'image');

// Replaces the images of all but the `keep` most recent tool results that carry images with a text
// placeholder. Returns new message and block objects where something changed, the input is not modified.
export function trimOldImages(messages: readonly ChatMessage[], keep = KEPT_IMAGE_RESULTS): ChatMessage[] {
  let seen = 0;
  const trimmed = [...messages];
  for (let index = trimmed.length - 1; index >= 0; index -= 1) {
    const message = trimmed[index];
    if (message?.role !== 'user') continue;
    let changed = false;
    const content = [...message.content];
    for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = content[blockIndex];
      if (block === undefined || !hasImage(block)) continue;
      seen += 1;
      if (seen <= keep) continue;
      content[blockIndex] = trimResult(block);
      changed = true;
    }
    if (changed) trimmed[index] = { role: 'user', content };
  }
  return trimmed;
}

function errorResult(call: ToolUseBlock, text: string): ToolResultBlock {
  return { type: 'tool_result', tool_use_id: call.id, content: [{ type: 'text', text }], is_error: true };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

// A throwing UI callback must not break the run: a tool_use left without its tool_result would make
// every later request of the conversation invalid.
function guarded<A extends unknown[]>(callback: ((...args: A) => void) | undefined): (...args: A) => void {
  return (...args: A) => {
    try {
      callback?.(...args);
    } catch (error) {
      console.error('Chat UI callback failed', error);
    }
  };
}

function guardEvents(events: AgentLoopEvents = {}): Required<AgentLoopEvents> {
  return {
    onText: guarded(events.onText),
    onToolCall: guarded(events.onToolCall),
    onToolResult: guarded(events.onToolResult),
    onRetry: guarded(events.onRetry),
    onDone: guarded(events.onDone),
    onError: guarded(events.onError),
  };
}

class AgentRun {
  private readonly events: Required<AgentLoopEvents>;
  private readonly sleep: Sleep;

  constructor(
    private readonly options: AgentLoopOptions,
    events: Required<AgentLoopEvents>,
  ) {
    this.events = events;
    this.sleep = options.sleep ?? abortableSleep;
  }

  async requestTurn(): Promise<ChatTurnResult> {
    const { provider, model, system, history, signal } = this.options;
    for (let attempt = 0; ; attempt += 1) {
      if (signal.aborted) throw new ChatAbortError();
      try {
        return await provider.streamTurn({
          model,
          system,
          messages: trimOldImages(history),
          tools: this.options.tools ?? ANTHROPIC_TOOLS,
          maxTokens: this.options.maxTokens ?? DEFAULT_MAX_TOKENS,
          signal,
          ...(this.options.events?.onText ? { onText: this.events.onText } : {}),
        });
      } catch (error) {
        if (signal.aborted) throw new ChatAbortError();
        if (!(error instanceof ChatApiError) || !error.retryable || attempt >= MAX_RETRIES) throw error;
        const delayMs = RETRY_BASE_DELAY_MS * 2 ** attempt;
        this.events.onRetry({ attempt: attempt + 1, delayMs, error });
        await this.sleep(delayMs, signal);
      }
    }
  }

  async runTool(call: ToolUseBlock): Promise<ToolResultBlock | undefined> {
    const { executeTool, signal } = this.options;
    let result: ChatToolResult | undefined;
    try {
      result = await unlessAborted(executeTool(call, signal), signal);
    } catch (error) {
      return errorResult(call, `Tool call failed: ${asError(error).message}`);
    }
    if (result === undefined) return undefined;
    return { type: 'tool_result', tool_use_id: call.id, content: result.content, ...(result.isError ? { is_error: true } : {}) };
  }

  // Runs the calls in order and appends one user message with a result for each, so the history stays
  // valid: calls that did not run because of an abort get a "cancelled by user" error result.
  async runTools(calls: ToolUseBlock[]): Promise<void> {
    const { history, signal } = this.options;
    const results: ToolResultBlock[] = [];
    for (const call of calls) {
      if (signal.aborted) break;
      this.events.onToolCall(call);
      const result = await this.runTool(call);
      if (result === undefined) break;
      results.push(result);
      this.events.onToolResult(result);
    }
    this.closeCalls(calls.slice(results.length), CANCELLED_TEXT, results);
    history.push({ role: 'user', content: results });
  }

  closeCalls(calls: ToolUseBlock[], text: string, results: ToolResultBlock[]): void {
    for (const call of calls) {
      const result = errorResult(call, text);
      results.push(result);
      this.events.onToolResult(result);
    }
  }

  async run(): Promise<AgentLoopOutcome> {
    const { history, signal } = this.options;
    const maxTurns = this.options.maxTurns ?? DEFAULT_MAX_TURNS;
    let turns = 0;
    try {
      while (turns < maxTurns) {
        turns += 1;
        const result = await this.requestTurn();
        if (result.content.length > 0) history.push({ role: 'assistant', content: result.content });
        const calls = result.content.filter((block): block is ToolUseBlock => block.type === 'tool_use');
        if (result.stopReason === 'tool_use' && calls.length > 0) {
          await this.runTools(calls);
          if (signal.aborted) return { kind: 'cancelled', turns };
          continue;
        }
        if (calls.length > 0) {
          const results: ToolResultBlock[] = [];
          this.closeCalls(calls, NOT_RUN_TEXT, results);
          history.push({ role: 'user', content: results });
        }
        return { kind: result.stopReason === 'tool_use' ? 'other' : result.stopReason, turns };
      }
      return { kind: 'turn_limit', turns };
    } catch (error) {
      if (error instanceof ChatAbortError || signal.aborted) return { kind: 'cancelled', turns };
      return { kind: 'error', turns, error: asError(error) };
    }
  }
}

// Runs model turns and tool calls until the model ends its turn, the run is cancelled, fails or hits
// the turn cap. Never rejects: the outcome is returned and reported through onDone or onError.
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopOutcome> {
  const events = guardEvents(options.events);
  const outcome = await new AgentRun(options, events).run();
  if (outcome.kind === 'error') events.onError(outcome.error);
  else events.onDone(outcome);
  return outcome;
}
