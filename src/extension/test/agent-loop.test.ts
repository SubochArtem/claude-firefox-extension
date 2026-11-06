import { describe, expect, it, vi } from 'vitest';
import { ANTHROPIC_TOOLS } from '../../shared/anthropic-tools';
import {
  type AgentLoopEvents,
  type AgentLoopOptions,
  CANCELLED_TEXT,
  type ChatToolResult,
  DEFAULT_MAX_TURNS,
  IMAGE_PLACEHOLDER,
  runAgentLoop,
  trimOldImages,
} from '../chat/agent-loop';
import { ChatAbortError, ChatApiError } from '../chat/chat-errors';
import type {
  AssistantContentBlock,
  ChatMessage,
  ChatProvider,
  ChatStopReason,
  ChatTurnRequest,
  ChatTurnResult,
  ImageBlock,
  ToolResultBlock,
  ToolUseBlock,
} from '../chat/provider';

const USAGE = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

type ScriptedTurn = ((request: ChatTurnRequest) => Promise<ChatTurnResult>) | ChatTurnResult;

function turn(stopReason: ChatStopReason, ...content: AssistantContentBlock[]): ChatTurnResult {
  return { content, stopReason, usage: USAGE };
}

function text(value: string) {
  return { type: 'text' as const, text: value };
}

function toolUse(id: string, name = 'tabs_context', input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: 'tool_use', id, name, input };
}

function image(data: string): ImageBlock {
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } };
}

function scriptedProvider(turns: ScriptedTurn[]) {
  const requests: ChatTurnRequest[] = [];
  const provider: ChatProvider = {
    streamTurn: vi.fn(async (request: ChatTurnRequest) => {
      // Messages are copied as sent, the loop appends to the same history afterwards.
      requests.push({ ...request, messages: structuredClone(request.messages) });
      const next = turns.shift();
      if (next === undefined) throw new Error('no scripted turn left');
      return typeof next === 'function' ? next(request) : next;
    }),
  };
  return { provider, requests };
}

function okResult(value: string): ChatToolResult {
  return { content: [text(value)], isError: false };
}

function userMessage(value: string): ChatMessage {
  return { role: 'user', content: [text(value)] };
}

function run(provider: ChatProvider, overrides: Partial<AgentLoopOptions> = {}) {
  const history = overrides.history ?? [userMessage('hello')];
  const events: Required<AgentLoopEvents> = {
    onText: vi.fn(),
    onToolCall: vi.fn(),
    onToolResult: vi.fn(),
    onRetry: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
  };
  const executeTool = overrides.executeTool ?? vi.fn(async (call: ToolUseBlock) => okResult(`ran ${call.id}`));
  const sleep = overrides.sleep ?? vi.fn(async () => {});
  const signal = overrides.signal ?? new AbortController().signal;
  const promise = runAgentLoop({
    provider,
    executeTool,
    model: 'claude-sonnet-5-5',
    system: [text('system')],
    sleep,
    events,
    ...overrides,
    history,
    signal,
  });
  return { promise, history, events, executeTool, sleep };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function abortWith(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new ChatAbortError()), { once: true });
  });
}

describe('runAgentLoop', () => {
  it('ends after an end_turn and appends the assistant message', async () => {
    const { provider, requests } = scriptedProvider([turn('end_turn', text('Hi there'))]);
    const { promise, history, events } = run(provider);
    expect(await promise).toEqual({ kind: 'end_turn', turns: 1 });
    expect(history).toEqual([userMessage('hello'), { role: 'assistant', content: [text('Hi there')] }]);
    expect(events.onDone).toHaveBeenCalledWith({ kind: 'end_turn', turns: 1 });
    expect(events.onError).not.toHaveBeenCalled();
    expect(requests[0]).toMatchObject({ model: 'claude-sonnet-5-5', system: [text('system')], tools: ANTHROPIC_TOOLS });
  });

  it('passes text deltas to onText', async () => {
    const { provider } = scriptedProvider([
      async (request) => {
        request.onText?.('Hi');
        request.onText?.(' there');
        return turn('end_turn', text('Hi there'));
      },
    ]);
    const { promise, events } = run(provider);
    await promise;
    expect(vi.mocked(events.onText).mock.calls).toEqual([['Hi'], [' there']]);
  });

  it('runs tool calls in order and sends all their results in one user message', async () => {
    const { provider, requests } = scriptedProvider([
      turn('tool_use', text('Looking'), toolUse('a', 'tabs_context'), toolUse('b', 'navigate', { url: 'https://example.com/' })),
      turn('tool_use', toolUse('c')),
      turn('end_turn', text('Done')),
    ]);
    const { promise, history, executeTool, events } = run(provider);
    expect(await promise).toEqual({ kind: 'end_turn', turns: 3 });
    expect(vi.mocked(executeTool).mock.calls.map(([call]) => call.id)).toEqual(['a', 'b', 'c']);
    expect(vi.mocked(executeTool).mock.calls[1]?.[0]).toEqual(toolUse('b', 'navigate', { url: 'https://example.com/' }));
    expect(history[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: [text('ran a')] },
        { type: 'tool_result', tool_use_id: 'b', content: [text('ran b')] },
      ],
    });
    expect(history).toHaveLength(6);
    expect(requests[1]?.messages).toEqual(history.slice(0, 3));
    expect(events.onToolCall).toHaveBeenCalledTimes(3);
    expect(events.onToolResult).toHaveBeenCalledWith({ type: 'tool_result', tool_use_id: 'c', content: [text('ran c')] });
  });

  it('marks failed tools as errors and turns a thrown executor error into an error result', async () => {
    const { provider } = scriptedProvider([turn('tool_use', toolUse('a'), toolUse('b')), turn('end_turn', text('ok'))]);
    const executeTool = vi.fn(async (call: ToolUseBlock) => {
      if (call.id === 'a') return { content: [text('Unknown tool: x')], isError: true };
      throw new Error('port closed');
    });
    const { promise, history } = run(provider, { executeTool });
    await promise;
    expect(history[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: [text('Unknown tool: x')], is_error: true },
        { type: 'tool_result', tool_use_id: 'b', content: [text('Tool call failed: port closed')], is_error: true },
      ],
    });
  });

  it('reports max_tokens and closes a tool call left without a result', async () => {
    const { provider } = scriptedProvider([turn('max_tokens', text('partial'), toolUse('a'))]);
    const { promise, history, executeTool, events } = run(provider);
    expect(await promise).toEqual({ kind: 'max_tokens', turns: 1 });
    expect(executeTool).not.toHaveBeenCalled();
    expect(history.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'a', content: [text('The tool was not run: the response ended first')], is_error: true }],
    });
    expect(events.onDone).toHaveBeenCalledWith({ kind: 'max_tokens', turns: 1 });
  });

  it('stops on another stop reason', async () => {
    const { provider } = scriptedProvider([turn('other', text('refused'))]);
    const { promise } = run(provider);
    expect(await promise).toEqual({ kind: 'other', turns: 1 });
  });

  it('does not append an empty assistant message', async () => {
    const { provider } = scriptedProvider([turn('end_turn')]);
    const { promise, history } = run(provider);
    await promise;
    expect(history).toEqual([userMessage('hello')]);
  });

  it('stops at the turn cap with a valid history', async () => {
    const { provider } = scriptedProvider(Array.from({ length: 5 }, (_, index) => turn('tool_use', toolUse(`t${index}`))));
    const { promise, history, events } = run(provider, { maxTurns: 3 });
    expect(await promise).toEqual({ kind: 'turn_limit', turns: 3 });
    expect(provider.streamTurn).toHaveBeenCalledTimes(3);
    expect(history).toHaveLength(7);
    expect(history.at(-1)?.role).toBe('user');
    expect(events.onDone).toHaveBeenCalledWith({ kind: 'turn_limit', turns: 3 });
    expect(DEFAULT_MAX_TURNS).toBe(50);
  });

  it('cancels mid-stream without changing the history', async () => {
    const controller = new AbortController();
    const { provider } = scriptedProvider([
      async (request) => {
        queueMicrotask(() => controller.abort());
        return abortWith(request.signal as AbortSignal);
      },
    ]);
    const { promise, history, events } = run(provider, { signal: controller.signal });
    expect(await promise).toEqual({ kind: 'cancelled', turns: 1 });
    expect(history).toEqual([userMessage('hello')]);
    expect(events.onDone).toHaveBeenCalledWith({ kind: 'cancelled', turns: 1 });
    expect(events.onError).not.toHaveBeenCalled();
  });

  it('cancels mid-tool and closes the running and the remaining tool calls', async () => {
    const controller = new AbortController();
    const running = deferred<ChatToolResult>();
    const { provider } = scriptedProvider([turn('tool_use', toolUse('a'), toolUse('b'), toolUse('c'))]);
    const executeTool = vi.fn(async (call: ToolUseBlock) => {
      if (call.id === 'a') return okResult('ran a');
      queueMicrotask(() => controller.abort());
      return running.promise;
    });
    const { promise, history, events } = run(provider, { executeTool, signal: controller.signal });
    expect(await promise).toEqual({ kind: 'cancelled', turns: 1 });
    running.resolve(okResult('late'));
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(history.at(-1)).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: [text('ran a')] },
        { type: 'tool_result', tool_use_id: 'b', content: [text(CANCELLED_TEXT)], is_error: true },
        { type: 'tool_result', tool_use_id: 'c', content: [text(CANCELLED_TEXT)], is_error: true },
      ],
    });
    expect(CANCELLED_TEXT).toBe('cancelled by user');
    expect(events.onToolResult).toHaveBeenCalledTimes(3);
  });

  it('closes every tool call when the run was aborted as the turn finished', async () => {
    const controller = new AbortController();
    const { provider } = scriptedProvider([
      async () => {
        controller.abort();
        return turn('tool_use', toolUse('a'));
      },
    ]);
    const { promise, history, executeTool } = run(provider, { signal: controller.signal });
    expect(await promise).toEqual({ kind: 'cancelled', turns: 1 });
    expect(executeTool).not.toHaveBeenCalled();
    expect(history.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'a', content: [text(CANCELLED_TEXT)], is_error: true }],
    });
  });

  it('retries a retryable API error with exponential backoff, then succeeds', async () => {
    const overloaded = new ChatApiError('overloaded', { status: 529, retryable: true });
    const { provider } = scriptedProvider([
      async () => {
        throw overloaded;
      },
      async () => {
        throw overloaded;
      },
      turn('end_turn', text('ok')),
    ]);
    const { promise, sleep, events } = run(provider);
    expect(await promise).toEqual({ kind: 'end_turn', turns: 1 });
    expect(vi.mocked(sleep).mock.calls.map(([ms]) => ms)).toEqual([1000, 2000]);
    expect(vi.mocked(events.onRetry).mock.calls).toEqual([
      [{ attempt: 1, delayMs: 1000, error: overloaded }],
      [{ attempt: 2, delayMs: 2000, error: overloaded }],
    ]);
  });

  it('gives up after three retries', async () => {
    const errors = Array.from({ length: 4 }, (_, index) => new ChatApiError(`busy ${index}`, { status: 500, retryable: true }));
    const { provider } = scriptedProvider(
      errors.map((error) => async () => {
        throw error;
      }),
    );
    const { promise, sleep, events } = run(provider);
    expect(await promise).toEqual({ kind: 'error', turns: 1, error: errors[3] });
    expect(provider.streamTurn).toHaveBeenCalledTimes(4);
    expect(vi.mocked(sleep).mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 4000]);
    expect(events.onError).toHaveBeenCalledWith(errors[3]);
    expect(events.onDone).not.toHaveBeenCalled();
  });

  it('does not retry a non-retryable error', async () => {
    const invalid = new ChatApiError('bad key', { status: 401, retryable: false });
    const { provider } = scriptedProvider([
      async () => {
        throw invalid;
      },
    ]);
    const { promise, sleep, events } = run(provider);
    expect(await promise).toEqual({ kind: 'error', turns: 1, error: invalid });
    expect(sleep).not.toHaveBeenCalled();
    expect(events.onRetry).not.toHaveBeenCalled();
  });

  it('cancels when aborted during the backoff', async () => {
    const controller = new AbortController();
    const { provider } = scriptedProvider([
      async () => {
        throw new ChatApiError('busy', { status: 503, retryable: true });
      },
    ]);
    const sleep = vi.fn(async () => {
      controller.abort();
      throw new ChatAbortError();
    });
    const { promise } = run(provider, { sleep, signal: controller.signal });
    expect(await promise).toEqual({ kind: 'cancelled', turns: 1 });
    expect(provider.streamTurn).toHaveBeenCalledTimes(1);
  });

  it('sends only the three most recent screenshots without changing the stored history', async () => {
    const screenshot = (id: string): ChatToolResult => ({ content: [text(`shot ${id}`), image(id)], isError: false });
    const { provider, requests } = scriptedProvider([
      ...['a', 'b', 'c', 'd'].map((id) => turn('tool_use', toolUse(id, 'computer'))),
      turn('end_turn', text('done')),
    ]);
    const executeTool = vi.fn(async (call: ToolUseBlock) => screenshot(call.id));
    const { promise, history } = run(provider, { executeTool });
    await promise;
    const sent = requests[4]?.messages ?? [];
    const results = sent.flatMap((message) =>
      message.role === 'user' ? message.content.filter((block): block is ToolResultBlock => block.type === 'tool_result') : [],
    );
    expect(results.map((result) => result.content)).toEqual([
      [text('shot a'), text(IMAGE_PLACEHOLDER)],
      [text('shot b'), image('b')],
      [text('shot c'), image('c')],
      [text('shot d'), image('d')],
    ]);
    expect(history[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: [text('shot a'), image('a')] }] });
  });
});

describe('trimOldImages', () => {
  const result = (id: string, ...content: ToolResultBlock['content']): ToolResultBlock => ({ type: 'tool_result', tool_use_id: id, content });

  it('keeps images of the most recent tool results that carry them and reuses untouched messages', () => {
    const textOnly: ChatMessage = { role: 'user', content: [result('t', text('no image'))] };
    const messages: ChatMessage[] = [
      { role: 'user', content: [text('look'), image('user')] },
      { role: 'user', content: [result('a', image('a1'), image('a2')), result('b', image('b'))] },
      textOnly,
      { role: 'user', content: [result('c', image('c'))] },
      { role: 'user', content: [result('d', image('d'))] },
    ];
    const trimmed = trimOldImages(messages, 3);
    expect(trimmed[0]).toBe(messages[0]);
    expect(trimmed[1]).toEqual({
      role: 'user',
      content: [result('a', text(IMAGE_PLACEHOLDER), text(IMAGE_PLACEHOLDER)), result('b', image('b'))],
    });
    expect(trimmed[2]).toBe(textOnly);
    expect(trimmed[3]).toBe(messages[3]);
    expect(messages[1]).toEqual({ role: 'user', content: [result('a', image('a1'), image('a2')), result('b', image('b'))] });
    expect(IMAGE_PLACEHOLDER).toBe('[earlier screenshot removed]');
  });

  it('returns the same messages when nothing needs trimming', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: [result('a', image('a'))] }];
    expect(trimOldImages(messages, 3)).toEqual(messages);
    expect(trimOldImages(messages, 3)[0]).toBe(messages[0]);
  });
});
