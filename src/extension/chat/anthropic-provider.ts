import { ChatAbortError, ChatApiError } from './chat-errors';
import type { AssistantContentBlock, ChatProvider, ChatStopReason, ChatTurnRequest, ChatTurnResult, ChatUsage } from './provider';
import { SseParser, type SseEvent } from './sse';

export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';
export const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

const RETRYABLE_ERROR_TYPES = new Set(['overloaded_error', 'api_error', 'rate_limit_error']);
const EPHEMERAL = { type: 'ephemeral' } as const;

export interface AnthropicProviderOptions {
  apiKey: string;
  fetch?: typeof fetch;
  idleTimeoutMs?: number;
}

type BlockState = { kind: 'text'; text: string } | { kind: 'tool_use'; id: string; name: string; json: string; input?: Record<string, unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withCacheControl<T extends object>(items: readonly T[]): T[] {
  return items.map((item, index) => (index === items.length - 1 ? { ...item, cache_control: EPHEMERAL } : item));
}

function isRetryable(status: number | undefined, errorType: string | undefined): boolean {
  if (status !== undefined && (status === 429 || status >= 500)) return true;
  return errorType !== undefined && RETRYABLE_ERROR_TYPES.has(errorType);
}

function apiError(body: unknown, status: number | undefined): ChatApiError {
  const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
  const errorType = typeof error?.type === 'string' ? error.type : undefined;
  const detail = typeof error?.message === 'string' && error.message !== '' ? error.message : 'no details';
  const label = ['Anthropic API error', status, errorType === undefined ? undefined : `(${errorType})`].filter((part) => part !== undefined).join(' ');
  return new ChatApiError(`${label}: ${detail}`, {
    ...(status === undefined ? {} : { status }),
    ...(errorType === undefined ? {} : { errorType }),
    retryable: isRetryable(status, errorType),
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function stopReasonOf(value: string | null): ChatStopReason {
  switch (value) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'tool_use':
    case 'max_tokens':
      return value;
    default:
      return 'other';
  }
}

function count(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

class TurnAssembler {
  private readonly blocks = new Map<number, BlockState>();
  private stopReason: string | null = null;
  private usage: ChatUsage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
  completed = false;

  constructor(private readonly onText: ((delta: string) => void) | undefined) {}

  handle(event: SseEvent): void {
    if (event.event === 'ping') return;
    const data = parseJson(event.data);
    if (event.event === 'error') throw apiError(data, undefined);
    if (!isRecord(data)) throw new ChatApiError('The Anthropic API sent an unreadable stream event', { retryable: false });
    switch (event.event) {
      case 'message_start':
        if (isRecord(data.message)) this.updateUsage(data.message.usage);
        break;
      case 'content_block_start':
        this.startBlock(data.index, data.content_block);
        break;
      case 'content_block_delta':
        this.applyDelta(data.index, data.delta);
        break;
      case 'content_block_stop': {
        const block = typeof data.index === 'number' ? this.blocks.get(data.index) : undefined;
        if (block?.kind === 'tool_use') block.input = parseToolInput(block.json);
        break;
      }
      case 'message_delta':
        if (isRecord(data.delta) && typeof data.delta.stop_reason === 'string') this.stopReason = data.delta.stop_reason;
        this.updateUsage(data.usage);
        break;
      case 'message_stop':
        this.completed = true;
        break;
    }
  }

  result(): ChatTurnResult {
    const content: AssistantContentBlock[] = [];
    for (const [, block] of [...this.blocks].sort(([a], [b]) => a - b)) {
      if (block.kind === 'text') {
        if (block.text !== '') content.push({ type: 'text', text: block.text });
      } else {
        const input = block.input ?? parseToolInput(block.json);
        if (input === undefined) throw this.invalidToolInput(block.name);
        content.push({ type: 'tool_use', id: block.id, name: block.name, input });
      }
    }
    return { content, stopReason: stopReasonOf(this.stopReason), usage: this.usage };
  }

  private invalidToolInput(name: string): ChatApiError {
    const cutOff = this.stopReason === 'max_tokens' ? ' (the response was cut off at max_tokens)' : '';
    return new ChatApiError(`The model sent invalid or truncated input for the tool ${name}${cutOff}`, { retryable: false });
  }

  private startBlock(index: unknown, block: unknown): void {
    if (typeof index !== 'number' || !isRecord(block)) return;
    if (block.type === 'text') {
      this.blocks.set(index, { kind: 'text', text: typeof block.text === 'string' ? block.text : '' });
    } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      this.blocks.set(index, { kind: 'tool_use', id: block.id, name: block.name, json: '' });
    }
  }

  private applyDelta(index: unknown, delta: unknown): void {
    const block = typeof index === 'number' ? this.blocks.get(index) : undefined;
    if (block === undefined || !isRecord(delta)) return;
    if (block.kind === 'text' && delta.type === 'text_delta' && typeof delta.text === 'string') {
      block.text += delta.text;
      this.onText?.(delta.text);
    } else if (block.kind === 'tool_use' && delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
      block.json += delta.partial_json;
    }
  }

  private updateUsage(usage: unknown): void {
    if (!isRecord(usage)) return;
    this.usage = {
      inputTokens: count(usage.input_tokens, this.usage.inputTokens),
      outputTokens: count(usage.output_tokens, this.usage.outputTokens),
      cacheCreationInputTokens: count(usage.cache_creation_input_tokens, this.usage.cacheCreationInputTokens),
      cacheReadInputTokens: count(usage.cache_read_input_tokens, this.usage.cacheReadInputTokens),
    };
  }
}

// Undefined for invalid JSON; the error is raised in result(), once the stop reason is known.
function parseToolInput(json: string): Record<string, unknown> | undefined {
  if (json.trim() === '') return {};
  const input = parseJson(json);
  return isRecord(input) ? input : undefined;
}

// Anthropic Messages API over fetch with a streamed response, callable from an extension page.
export class AnthropicProvider implements ChatProvider {
  private readonly apiKey: string;
  private readonly fetch: typeof fetch;
  private readonly idleTimeoutMs: number;

  constructor(options: AnthropicProviderOptions) {
    this.apiKey = options.apiKey;
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  async streamTurn(request: ChatTurnRequest): Promise<ChatTurnResult> {
    const userSignal = request.signal;
    if (userSignal?.aborted) throw new ChatAbortError();
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const resetWatchdog = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.idleTimeoutMs);
    };
    const onUserAbort = (): void => controller.abort();
    userSignal?.addEventListener('abort', onUserAbort, { once: true });
    resetWatchdog();
    try {
      const response = await this.fetch(ANTHROPIC_MESSAGES_URL, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(this.requestBody(request)),
        signal: controller.signal,
      });
      if (!response.ok) throw apiError(parseJson(await response.text().catch(() => '')), response.status);
      if (response.body === null) throw new ChatApiError('The Anthropic API sent an empty response', { retryable: true });
      return await readTurn(response.body, controller.signal, new TurnAssembler(request.onText), resetWatchdog);
    } catch (error) {
      if (timedOut) {
        throw new ChatApiError(`The Anthropic API sent nothing for ${Math.round(this.idleTimeoutMs / 1000)} s`, { retryable: true });
      }
      if (userSignal?.aborted) throw new ChatAbortError();
      if (error instanceof ChatApiError) throw this.redacted(error);
      throw new ChatApiError(this.redact(`Network error: ${errorText(error)}`), { retryable: true });
    } finally {
      clearTimeout(timer);
      userSignal?.removeEventListener('abort', onUserAbort);
    }
  }

  private requestBody(request: ChatTurnRequest): Record<string, unknown> {
    return {
      model: request.model,
      max_tokens: request.maxTokens,
      stream: true,
      ...(request.system.length > 0 ? { system: withCacheControl(request.system) } : {}),
      messages: request.messages,
      ...(request.tools.length > 0 ? { tools: withCacheControl(request.tools) } : {}),
    };
  }

  private redact(text: string): string {
    return this.apiKey === '' ? text : text.replaceAll(this.apiKey, '[REDACTED]');
  }

  private redacted(error: ChatApiError): ChatApiError {
    const message = this.redact(error.message);
    if (message === error.message) return error;
    return new ChatApiError(message, {
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.errorType === undefined ? {} : { errorType: error.errorType }),
      retryable: error.retryable,
    });
  }
}

async function readTurn(body: ReadableStream<Uint8Array>, signal: AbortSignal, turn: TurnAssembler, onEvent: () => void): Promise<ChatTurnResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  let finished = false;
  // A body that does not observe the fetch signal would otherwise keep a pending read alive after an abort.
  const cancel = (): void => void reader.cancel().catch(() => {});
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw new ChatAbortError();
      const { done, value } = await reader.read();
      const text = done ? decoder.decode() : decoder.decode(value, { stream: true });
      const events = parser.push(text);
      if (done) events.push(...parser.flush());
      for (const event of events) {
        if (signal.aborted) throw new ChatAbortError();
        onEvent();
        turn.handle(event);
      }
      if (done) break;
    }
    finished = true;
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!finished) cancel();
  }
  if (signal.aborted) throw new ChatAbortError();
  if (!turn.completed) throw new ChatApiError('The Anthropic API stream ended before the message was complete', { retryable: true });
  return turn.result();
}
