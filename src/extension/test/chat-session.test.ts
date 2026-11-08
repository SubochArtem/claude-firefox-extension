import { describe, expect, it, vi } from 'vitest';
import { type AgentLoopEvents, type ChatToolResult, MAX_RETRIES, runAgentLoop } from '../chat/agent-loop';
import { ChatAbortError, ChatApiError } from '../chat/chat-errors';
import type { AssistantContentBlock, ChatMessage, ChatStopReason, ChatTurnRequest, ChatTurnResult, ToolUseBlock } from '../chat/provider';
import {
  appendUserText,
  type ChatChange,
  type ChatItem,
  ChatSession,
  RESULT_LIMIT,
  resultText,
  SCREENSHOT_LABEL,
  SUMMARY_LIMIT,
  summarizeInput,
} from '../sidebar/chat-session';

const USAGE = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

type Step = (request: ChatTurnRequest) => Promise<ChatTurnResult>;

function turn(stopReason: ChatStopReason, ...content: AssistantContentBlock[]): ChatTurnResult {
  return { content, stopReason, usage: USAGE };
}

function text(value: string) {
  return { type: 'text' as const, text: value };
}

function toolUse(id: string, name: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: 'tool_use', id, name, input };
}

// Streams the text blocks of the turn as deltas, then returns it.
function streamed(result: ChatTurnResult): Step {
  return async (request) => {
    for (const block of result.content) if (block.type === 'text') request.onText?.(block.text);
    return result;
  };
}

function abortWith(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new ChatAbortError()), { once: true });
  });
}

interface SetupOptions {
  steps: Step[];
  tool?: (call: ToolUseBlock) => Promise<ChatToolResult>;
  maxTurns?: number;
}

function setup({ steps, tool, maxTurns }: SetupOptions) {
  const requests: ChatMessage[][] = [];
  const changes: ChatChange[] = [];
  const executeTool = vi.fn(tool ?? (async (call: ToolUseBlock) => ({ content: [text(`ran ${call.name}`)], isError: false })));
  const runLoop = vi.fn((history: ChatMessage[], signal: AbortSignal, events: AgentLoopEvents) =>
    runAgentLoop({
      provider: {
        streamTurn: async (request) => {
          requests.push(structuredClone(request.messages));
          const step = steps.shift();
          if (step === undefined) throw new Error('no scripted turn left');
          return step(request);
        },
      },
      executeTool,
      history,
      model: 'claude-sonnet-5-5',
      system: [],
      signal,
      events,
      sleep: async () => {},
      ...(maxTurns === undefined ? {} : { maxTurns }),
    }),
  );
  const session = new ChatSession(runLoop, (change) => changes.push(change));
  return { session, requests, changes, executeTool, runLoop };
}

const notices = (items: readonly ChatItem[]) => items.filter((item) => item.kind === 'notice');

describe('ChatSession', () => {
  it('shows the user message, streamed text, tool calls with results and the final text', async () => {
    const { session, changes } = setup({
      steps: [
        streamed(turn('tool_use', text('Looking'), toolUse('a', 'navigate', { url: 'https://example.com/', tabId: 3 }))),
        streamed(turn('end_turn', text('Done **now**'))),
      ],
    });
    expect(await session.send('Open example')).toBe(true);
    expect(session.items).toEqual([
      { id: expect.any(Number), kind: 'user', text: 'Open example' },
      { id: expect.any(Number), kind: 'assistant', text: 'Looking' },
      {
        id: expect.any(Number),
        kind: 'tool',
        toolUseId: 'a',
        name: 'navigate',
        summary: 'url: https://example.com/, tabId: 3',
        result: { text: 'ran navigate', isError: false },
      },
      { id: expect.any(Number), kind: 'assistant', text: 'Done **now**' },
    ]);
    expect(session.history.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(session.running).toBe(false);
    expect(changes[0]).toEqual({ type: 'running', running: true });
    expect(changes.at(-1)).toEqual({ type: 'running', running: false });
  });

  it('updates the assistant item on each streamed delta', async () => {
    const { session, changes } = setup({
      steps: [
        async (request) => {
          request.onText?.('Hel');
          request.onText?.('lo');
          return turn('end_turn', text('Hello'));
        },
      ],
    });
    await session.send('hi');
    const assistantChanges = changes.filter((change) => 'item' in change && change.item.kind === 'assistant');
    expect(assistantChanges.map((change) => change.type)).toEqual(['add', 'update']);
    expect(session.items.at(-1)).toMatchObject({ kind: 'assistant', text: 'Hello' });
  });

  it('ignores blank text and sends trimmed text', async () => {
    const { session, runLoop } = setup({ steps: [streamed(turn('end_turn', text('ok')))] });
    expect(await session.send('  \n ')).toBe(false);
    expect(runLoop).not.toHaveBeenCalled();
    await session.send('  hello \n');
    expect(session.history[0]).toEqual({ role: 'user', content: [text('hello')] });
  });

  it('ignores a send while running', async () => {
    const { session, runLoop } = setup({ steps: [async (request) => abortWith(request.signal)] });
    const first = session.send('one');
    expect(session.running).toBe(true);
    expect(await session.send('two')).toBe(false);
    session.stop();
    await first;
    expect(runLoop).toHaveBeenCalledTimes(1);
  });

  it('stop aborts the run and shows a stopped note', async () => {
    const { session } = setup({ steps: [async (request) => abortWith(request.signal)] });
    const sent = session.send('wait');
    session.stop();
    await sent;
    expect(session.running).toBe(false);
    expect(notices(session.items)).toEqual([{ id: expect.any(Number), kind: 'notice', level: 'info', text: 'Stopped.' }]);
  });

  it('merges the next prompt into a history that ends with tool results after a stop', async () => {
    let stop = () => {};
    const { session, requests } = setup({
      steps: [streamed(turn('tool_use', toolUse('a', 'tabs_context'))), streamed(turn('end_turn', text('ok')))],
      tool: async () => {
        stop();
        return { content: [text('late')], isError: false };
      },
    });
    stop = () => session.stop();
    await session.send('first');
    expect(session.history.at(-1)).toMatchObject({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a' }] });
    await session.send('second');
    expect(requests[1]?.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(requests[1]?.[2]?.content).toEqual([expect.objectContaining({ type: 'tool_result' }), text('second')]);
  });

  it('merges the next prompt into the user message of a failed request', async () => {
    const { session, requests } = setup({
      steps: [
        async () => {
          throw new ChatApiError('Anthropic API error 400 (invalid_request_error): bad', { status: 400, errorType: 'invalid_request_error', retryable: false });
        },
        streamed(turn('end_turn', text('ok'))),
      ],
    });
    await session.send('first');
    await session.send('second');
    expect(requests[1]).toEqual([{ role: 'user', content: [text('first'), text('second')] }]);
  });

  it('new chat clears the history and the items, but not while running', async () => {
    const { session, changes } = setup({ steps: [async (request) => abortWith(request.signal)] });
    const sent = session.send('one');
    expect(session.newChat()).toBe(false);
    expect(session.items).not.toEqual([]);
    session.stop();
    await sent;
    expect(session.newChat()).toBe(true);
    expect(session.items).toEqual([]);
    expect(session.history).toEqual([]);
    expect(changes.at(-1)).toEqual({ type: 'clear' });
  });

  it('drops the partial text of a failed attempt on retry and notes the retry', async () => {
    const overloaded = new ChatApiError('Anthropic API error 529 (overloaded_error): busy', { status: 529, errorType: 'overloaded_error', retryable: true });
    const { session, changes } = setup({
      steps: [
        async (request) => {
          request.onText?.('partial');
          throw overloaded;
        },
        streamed(turn('end_turn', text('final'))),
      ],
    });
    await session.send('hi');
    const texts = session.items.flatMap((item) => (item.kind === 'assistant' ? [item.text] : []));
    expect(texts).toEqual(['final']);
    expect(changes.some((change) => change.type === 'remove' && change.item.kind === 'assistant')).toBe(true);
    expect(notices(session.items)).toEqual([
      { id: expect.any(Number), kind: 'notice', level: 'info', text: `Retrying in 1 s (attempt 1 of ${MAX_RETRIES}): ${overloaded.message}` },
    ]);
  });

  it('shows an API error as an error line', async () => {
    const { session } = setup({
      steps: [
        async () => {
          throw new ChatApiError('Anthropic API error 400 (invalid_request_error): bad', { status: 400, errorType: 'invalid_request_error', retryable: false });
        },
      ],
    });
    await session.send('hi');
    expect(notices(session.items)).toEqual([
      { id: expect.any(Number), kind: 'notice', level: 'error', text: 'Anthropic API error 400 (invalid_request_error): bad' },
    ]);
  });

  it('points to the options page on an authentication error', async () => {
    const { session } = setup({
      steps: [
        async () => {
          throw new ChatApiError('Anthropic API error 401 (authentication_error): invalid x-api-key', { status: 401, errorType: 'authentication_error', retryable: false });
        },
      ],
    });
    await session.send('hi');
    expect(notices(session.items)[0]).toMatchObject({ level: 'error', text: expect.stringContaining('Check the API key in the options page.') });
  });

  it('shows an error line when the response hits max_tokens', async () => {
    const { session } = setup({ steps: [streamed(turn('max_tokens', text('cut')))] });
    await session.send('hi');
    expect(notices(session.items)).toEqual([
      { id: expect.any(Number), kind: 'notice', level: 'error', text: 'The response hit the output token limit and was cut off.' },
    ]);
  });

  it('shows an error line at the turn cap', async () => {
    const { session } = setup({ steps: [streamed(turn('tool_use', toolUse('a', 'tabs_context')))], maxTurns: 1 });
    await session.send('hi');
    expect(notices(session.items)).toEqual([
      { id: expect.any(Number), kind: 'notice', level: 'error', text: 'Stopped after 1 turns: the turn limit was reached.' },
    ]);
  });

  it('shows an error line for another stop reason', async () => {
    const { session } = setup({ steps: [streamed(turn('other', text('hm')))] });
    await session.send('hi');
    expect(notices(session.items)[0]).toMatchObject({ level: 'error', text: 'The response ended early (stop reason: other).' });
  });

  it('shows an error line when the run cannot start', async () => {
    const changes: ChatChange[] = [];
    const session = new ChatSession(async () => {
      throw new Error('No API key is saved.');
    }, (change) => changes.push(change));
    await session.send('hi');
    expect(session.running).toBe(false);
    expect(notices(session.items)).toEqual([{ id: expect.any(Number), kind: 'notice', level: 'error', text: 'No API key is saved.' }]);
    expect(session.history).toEqual([{ role: 'user', content: [text('hi')] }]);
  });

  it('shows image results as a screenshot label and error results as errors', async () => {
    const { session } = setup({
      steps: [streamed(turn('tool_use', toolUse('a', 'computer', { action: 'screenshot' }), toolUse('b', 'navigate'))), streamed(turn('end_turn'))],
      tool: async (call) =>
        call.name === 'computer'
          ? { content: [text('Took a screenshot'), { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }], isError: false }
          : { content: [text('Invalid url')], isError: true },
    });
    await session.send('look');
    const tools = session.items.filter((item) => item.kind === 'tool');
    expect(tools.map((item) => item.result)).toEqual([
      { text: `Took a screenshot\n${SCREENSHOT_LABEL}`, isError: false },
      { text: 'Invalid url', isError: true },
    ]);
  });
});

describe('appendUserText', () => {
  it('adds a user message after an assistant message or to an empty history', () => {
    const history: ChatMessage[] = [];
    appendUserText(history, 'one');
    history.push({ role: 'assistant', content: [text('reply')] });
    appendUserText(history, 'two');
    expect(history).toEqual([
      { role: 'user', content: [text('one')] },
      { role: 'assistant', content: [text('reply')] },
      { role: 'user', content: [text('two')] },
    ]);
  });

  it('appends a text block to a trailing user message', () => {
    const history: ChatMessage[] = [
      { role: 'assistant', content: [toolUse('a', 'tabs_context')] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: [text('cancelled by user')], is_error: true }] },
    ];
    appendUserText(history, 'next');
    expect(history).toHaveLength(2);
    expect(history[1]?.content.at(-1)).toEqual(text('next'));
  });
});

describe('summarizeInput', () => {
  it('lists the input on one line with strings unquoted', () => {
    expect(summarizeInput({ action: 'left_click', coordinate: [10, 20], text: 'a\nb' })).toBe('action: left_click, coordinate: [10,20], text: a b');
  });

  it('is empty for an empty input', () => {
    expect(summarizeInput({})).toBe('');
  });

  it('clips long input', () => {
    const summary = summarizeInput({ code: 'x'.repeat(1000) });
    expect(summary.length).toBe(SUMMARY_LIMIT + 1);
    expect(summary.endsWith('…')).toBe(true);
  });
});

describe('resultText', () => {
  it('clips long results with the number of characters left out', () => {
    const value = resultText([text('y'.repeat(RESULT_LIMIT + 50))]);
    expect(value).toBe(`${'y'.repeat(RESULT_LIMIT)}… (50 more characters)`);
  });
});
