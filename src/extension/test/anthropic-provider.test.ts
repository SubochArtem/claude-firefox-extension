import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANTHROPIC_MESSAGES_URL, AnthropicProvider, DEFAULT_IDLE_TIMEOUT_MS } from '../chat/anthropic-provider';
import { ChatAbortError, ChatApiError } from '../chat/chat-errors';
import type { ChatTurnRequest } from '../chat/provider';
import type { AnthropicTool } from '../../shared/anthropic-tools';

const API_KEY = 'sk-ant-test-secret-key';

const TOOLS: AnthropicTool[] = [
  { name: 'navigate', description: 'Navigate', input_schema: { type: 'object', properties: { url: { type: 'string' } } } },
  { name: 'find', description: 'Find', input_schema: { type: 'object' } },
];

function request(overrides: Partial<ChatTurnRequest> = {}): ChatTurnRequest {
  return {
    model: 'claude-test',
    system: [
      { type: 'text', text: 'You are a browser agent.' },
      { type: 'text', text: 'Be brief.' },
    ],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    tools: TOOLS,
    maxTokens: 1024,
    ...overrides,
  };
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function messageStart(usage: Record<string, number> = { input_tokens: 10, output_tokens: 1 }): string {
  return sse('message_start', {
    type: 'message_start',
    message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-test', stop_reason: null, usage },
  });
}

const PING = sse('ping', { type: 'ping' });
const MESSAGE_STOP = sse('message_stop', { type: 'message_stop' });

function textBlock(index: number, deltas: string[]): string {
  return (
    sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }) +
    deltas.map((text) => sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } })).join('') +
    sse('content_block_stop', { type: 'content_block_stop', index })
  );
}

function toolBlock(index: number, id: string, name: string, parts: string[]): string {
  return (
    sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } }) +
    parts
      .map((partial_json) => sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } }))
      .join('') +
    sse('content_block_stop', { type: 'content_block_stop', index })
  );
}

function messageDelta(stop_reason: string, usage: Record<string, number> = { output_tokens: 42 }): string {
  return sse('message_delta', { type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage });
}

const TOOL_USE_STREAM =
  messageStart({ input_tokens: 100, output_tokens: 1, cache_creation_input_tokens: 50, cache_read_input_tokens: 20 }) +
  PING +
  textBlock(0, ['Let me ', 'open ', 'it — ✓ 日本']) +
  toolBlock(1, 'toolu_1', 'navigate', ['', '{"url": "https:', '//example.com', '"}']) +
  toolBlock(2, 'toolu_2', 'find', []) +
  messageDelta('tool_use', { output_tokens: 77 }) +
  MESSAGE_STOP;

const TOOL_USE_RESULT = {
  content: [
    { type: 'text', text: 'Let me open it — ✓ 日本' },
    { type: 'tool_use', id: 'toolu_1', name: 'navigate', input: { url: 'https://example.com' } },
    { type: 'tool_use', id: 'toolu_2', name: 'find', input: {} },
  ],
  stopReason: 'tool_use',
  usage: { inputTokens: 100, outputTokens: 77, cacheCreationInputTokens: 50, cacheReadInputTokens: 20 },
};

interface ControlledStream {
  stream: ReadableStream<Uint8Array>;
  push(text: string): void;
  pushBytes(bytes: Uint8Array): void;
  close(): void;
}

function controlledStream(): ControlledStream {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    push: (text) => controller.enqueue(new TextEncoder().encode(text)),
    pushBytes: (bytes) => controller.enqueue(bytes),
    close: () => controller.close(),
  };
}

function bytesStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function sseResponse(body: string | ReadableStream<Uint8Array>): Response {
  const stream = typeof body === 'string' ? bytesStream([new TextEncoder().encode(body)]) : body;
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function errorResponse(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function fetchReturning(response: Response): FetchMock {
  return vi.fn<typeof fetch>(async () => response);
}

function provider(fetchMock: FetchMock, idleTimeoutMs?: number): AnthropicProvider {
  return new AnthropicProvider({ apiKey: API_KEY, fetch: fetchMock, ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }) });
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AnthropicProvider request', () => {
  it('posts a streamed request with the headers the browser needs', async () => {
    const fetchMock = fetchReturning(sseResponse(messageStart() + textBlock(0, ['Hi']) + messageDelta('end_turn') + MESSAGE_STOP));
    await provider(fetchMock).streamTurn(request());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(ANTHROPIC_MESSAGES_URL);
    expect(ANTHROPIC_MESSAGES_URL).toBe('https://api.anthropic.com/v1/messages');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'anthropic-dangerous-direct-browser-access': 'true',
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends the model, max_tokens, messages and stream, with cache_control on the last tool and system block', async () => {
    const fetchMock = fetchReturning(sseResponse(messageStart() + messageDelta('end_turn') + MESSAGE_STOP));
    const req = request({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'find', input: { query: 'x' } }] },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: [
                { type: 'text', text: 'found' },
                { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
              ],
              is_error: false,
            },
          ],
        },
      ],
    });
    await provider(fetchMock).streamTurn(req);

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      model: 'claude-test',
      max_tokens: 1024,
      stream: true,
      system: [
        { type: 'text', text: 'You are a browser agent.' },
        { type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral' } },
      ],
      messages: req.messages,
      tools: [TOOLS[0], { ...TOOLS[1], cache_control: { type: 'ephemeral' } }],
    });
    expect(req.system[1]).not.toHaveProperty('cache_control');
    expect(TOOLS[1]).not.toHaveProperty('cache_control');
  });

  it('omits empty system and tools', async () => {
    const fetchMock = fetchReturning(sseResponse(messageStart() + messageDelta('end_turn') + MESSAGE_STOP));
    await provider(fetchMock).streamTurn(request({ system: [], tools: [] }));
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('system');
    expect(body).not.toHaveProperty('tools');
  });
});

describe('AnthropicProvider stream', () => {
  it('assembles a full tool-use turn and reports text deltas', async () => {
    const onText = vi.fn();
    const result = await provider(fetchReturning(sseResponse(TOOL_USE_STREAM))).streamTurn(request({ onText }));
    expect(result).toEqual(TOOL_USE_RESULT);
    expect(onText.mock.calls.map(([delta]) => delta as string)).toEqual(['Let me ', 'open ', 'it — ✓ 日本']);
  });

  it('gives the same result for every split of the byte stream, including inside multi-byte characters', async () => {
    const bytes = new TextEncoder().encode(TOOL_USE_STREAM);
    const multiByteStart = bytes.findIndex((byte) => byte >= 0x80);
    const splits = new Set<number>([1, multiByteStart + 1, multiByteStart + 2]);
    for (let i = 0; i < bytes.length; i += 7) splits.add(i);
    for (const split of splits) {
      const stream = bytesStream([bytes.slice(0, split), bytes.slice(split)]);
      const result = await provider(fetchReturning(sseResponse(stream))).streamTurn(request());
      expect(result, `split at ${split}`).toEqual(TOOL_USE_RESULT);
    }
  });

  it('handles a stream delivered one byte at a time', async () => {
    const bytes = new TextEncoder().encode(TOOL_USE_STREAM);
    const chunks = Array.from(bytes, (byte) => new Uint8Array([byte]));
    const result = await provider(fetchReturning(sseResponse(bytesStream(chunks)))).streamTurn(request());
    expect(result).toEqual(TOOL_USE_RESULT);
  });

  it('ignores thinking blocks, signature deltas, unknown blocks, deltas and events', async () => {
    const body =
      messageStart() +
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }) +
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }) +
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }) +
      sse('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'x' } }) +
      sse('content_block_stop', { type: 'content_block_stop', index: 1 }) +
      sse('content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } }) +
      sse('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'citations_delta', citation: {} } }) +
      sse('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Done' } }) +
      sse('content_block_stop', { type: 'content_block_stop', index: 2 }) +
      sse('future_event', { type: 'future_event' }) +
      messageDelta('end_turn') +
      MESSAGE_STOP;
    const onText = vi.fn();
    const result = await provider(fetchReturning(sseResponse(body))).streamTurn(request({ onText }));
    expect(result.content).toEqual([{ type: 'text', text: 'Done' }]);
    expect(onText).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe('end_turn');
  });

  it('drops empty text blocks', async () => {
    const body = messageStart() + textBlock(0, []) + toolBlock(1, 'toolu_1', 'find', ['{}']) + messageDelta('tool_use') + MESSAGE_STOP;
    const result = await provider(fetchReturning(sseResponse(body))).streamTurn(request());
    expect(result.content).toEqual([{ type: 'tool_use', id: 'toolu_1', name: 'find', input: {} }]);
  });

  it('keeps the message_start usage when message_delta omits fields', async () => {
    const body = messageStart({ input_tokens: 5, output_tokens: 1 }) + messageDelta('max_tokens', { output_tokens: 9 }) + MESSAGE_STOP;
    const result = await provider(fetchReturning(sseResponse(body))).streamTurn(request());
    expect(result).toEqual({ content: [], stopReason: 'max_tokens', usage: { inputTokens: 5, outputTokens: 9, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } });
  });

  it('rejects tool input that is not a JSON object', async () => {
    for (const parts of [['{"url": '], ['[1, 2]']]) {
      const body = messageStart() + toolBlock(0, 'toolu_1', 'navigate', parts) + messageDelta('tool_use') + MESSAGE_STOP;
      const error = await caught(provider(fetchReturning(sseResponse(body))).streamTurn(request()));
      expect(error).toBeInstanceOf(ChatApiError);
      expect((error as ChatApiError).retryable).toBe(false);
      expect((error as ChatApiError).message).toBe('The model sent invalid or truncated input for the tool navigate');
    }
  });

  it('names the max_tokens cut-off when truncated tool input ends the turn', async () => {
    const body = messageStart() + toolBlock(0, 'toolu_1', 'navigate', ['{"url": ']) + messageDelta('max_tokens') + MESSAGE_STOP;
    const error = await caught(provider(fetchReturning(sseResponse(body))).streamTurn(request()));
    expect(error).toBeInstanceOf(ChatApiError);
    expect((error as ChatApiError).message).toBe('The model sent invalid or truncated input for the tool navigate (the response was cut off at max_tokens)');
  });

  it('completes a turn whose stream ends on a CR line ending', async () => {
    const body = (messageStart() + textBlock(0, ['Hi']) + messageDelta('end_turn') + MESSAGE_STOP).replaceAll('\n', '\r');
    const result = await provider(fetchReturning(sseResponse(body))).streamTurn(request());
    expect(result.content).toEqual([{ type: 'text', text: 'Hi' }]);
  });

  it('normalizes stop reasons', async () => {
    const cases: [string, string][] = [
      ['end_turn', 'end_turn'],
      ['stop_sequence', 'end_turn'],
      ['tool_use', 'tool_use'],
      ['max_tokens', 'max_tokens'],
      ['refusal', 'other'],
      ['pause_turn', 'other'],
      ['something_new', 'other'],
    ];
    for (const [raw, expected] of cases) {
      const body = messageStart() + messageDelta(raw) + MESSAGE_STOP;
      const result = await provider(fetchReturning(sseResponse(body))).streamTurn(request());
      expect(result.stopReason).toBe(expected);
    }
    const noReason = await provider(fetchReturning(sseResponse(messageStart() + MESSAGE_STOP))).streamTurn(request());
    expect(noReason.stopReason).toBe('other');
  });

  it('reports a stream that ends before message_stop as retryable', async () => {
    const body = messageStart() + textBlock(0, ['partial']);
    const error = await caught(provider(fetchReturning(sseResponse(body))).streamTurn(request()));
    expect(error).toBeInstanceOf(ChatApiError);
    expect((error as ChatApiError).retryable).toBe(true);
    expect((error as ChatApiError).status).toBeUndefined();
  });

  it('reports a response without a body as retryable', async () => {
    const response = new Response(null, { status: 200 });
    const error = await caught(provider(fetchReturning(response)).streamTurn(request()));
    expect(error).toBeInstanceOf(ChatApiError);
    expect((error as ChatApiError).retryable).toBe(true);
  });
});

describe('AnthropicProvider errors', () => {
  it.each([
    [400, 'invalid_request_error', false],
    [401, 'authentication_error', false],
    [403, 'permission_error', false],
    [404, 'not_found_error', false],
    [413, 'request_too_large', false],
    [429, 'rate_limit_error', true],
    [500, 'api_error', true],
    [503, 'api_error', true],
    [529, 'overloaded_error', true],
  ])('maps HTTP %i %s (retryable %s)', async (status, type, retryable) => {
    const response = errorResponse(status, { type: 'error', error: { type, message: `problem ${status}` } });
    const error = await caught(provider(fetchReturning(response)).streamTurn(request()));
    expect(error).toBeInstanceOf(ChatApiError);
    const apiError = error as ChatApiError;
    expect(apiError.status).toBe(status);
    expect(apiError.errorType).toBe(type);
    expect(apiError.retryable).toBe(retryable);
    expect(apiError.message).toContain(`problem ${status}`);
    expect(apiError.message).toContain(String(status));
  });

  it('handles an error body that is not JSON', async () => {
    const error = await caught(provider(fetchReturning(errorResponse(502, '<html>Bad gateway</html>'))).streamTurn(request()));
    expect(error).toBeInstanceOf(ChatApiError);
    expect((error as ChatApiError).status).toBe(502);
    expect((error as ChatApiError).errorType).toBeUndefined();
    expect((error as ChatApiError).retryable).toBe(true);
  });

  it.each([
    ['overloaded_error', true],
    ['api_error', true],
    ['rate_limit_error', true],
    ['invalid_request_error', false],
  ])('maps an SSE error event of type %s (retryable %s)', async (type, retryable) => {
    const body = messageStart() + textBlock(0, ['Hi']) + sse('error', { type: 'error', error: { type, message: 'Stream failed' } });
    const error = await caught(provider(fetchReturning(sseResponse(body))).streamTurn(request()));
    expect(error).toBeInstanceOf(ChatApiError);
    const apiError = error as ChatApiError;
    expect(apiError.status).toBeUndefined();
    expect(apiError.errorType).toBe(type);
    expect(apiError.retryable).toBe(retryable);
    expect(apiError.message).toContain('Stream failed');
  });

  it('reports a network failure as retryable', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new TypeError('NetworkError when attempting to fetch resource.');
    });
    const error = await caught(provider(fetchMock).streamTurn(request()));
    expect(error).toBeInstanceOf(ChatApiError);
    expect((error as ChatApiError).retryable).toBe(true);
    expect((error as ChatApiError).status).toBeUndefined();
  });

  it('reports a failure while reading the body as retryable', async () => {
    let fail!: (reason: unknown) => void;
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(messageStart()));
        fail = (reason) => controller.error(reason);
      },
    });
    const promise = caught(provider(fetchReturning(sseResponse(failing))).streamTurn(request()));
    await Promise.resolve();
    fail(new TypeError('Error in body stream'));
    const error = await promise;
    expect(error).toBeInstanceOf(ChatApiError);
    expect((error as ChatApiError).retryable).toBe(true);
  });

  it('never puts the API key into error messages', async () => {
    const response = errorResponse(401, { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${API_KEY}` } });
    const error = await caught(provider(fetchReturning(response)).streamTurn(request()));
    expect((error as Error).message).not.toContain(API_KEY);

    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new TypeError(`failed with ${API_KEY}`);
    });
    const networkError = await caught(provider(fetchMock).streamTurn(request()));
    expect((networkError as Error).message).not.toContain(API_KEY);

    const body = messageStart() + sse('error', { type: 'error', error: { type: 'api_error', message: `key ${API_KEY}` } });
    const streamError = await caught(provider(fetchReturning(sseResponse(body))).streamTurn(request()));
    expect((streamError as Error).message).not.toContain(API_KEY);
  });
});

function abortableFetch(response: () => Response | Promise<Response>): FetchMock {
  return vi.fn<typeof fetch>(
    (_url, init) =>
      new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        const onAbort = (): void => reject(new DOMException('The operation was aborted.', 'AbortError'));
        if (signal?.aborted) return onAbort();
        signal?.addEventListener('abort', onAbort, { once: true });
        void Promise.resolve(response()).then(resolve, reject);
      }),
  );
}

function never(): Promise<Response> {
  return new Promise<Response>(() => {});
}

describe('AnthropicProvider abort', () => {
  it('rejects at once with an abort error when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = fetchReturning(sseResponse(TOOL_USE_STREAM));
    const error = await caught(provider(fetchMock).streamTurn(request({ signal: controller.signal })));
    expect(error).toBeInstanceOf(ChatAbortError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('raises an abort error when aborted before the response arrives', async () => {
    const controller = new AbortController();
    const promise = caught(provider(abortableFetch(never)).streamTurn(request({ signal: controller.signal })));
    controller.abort();
    expect(await promise).toBeInstanceOf(ChatAbortError);
  });

  it('raises an abort error when aborted during the stream', async () => {
    const controller = new AbortController();
    const stream = controlledStream();
    const onText = vi.fn(() => controller.abort());
    const promise = caught(provider(abortableFetch(() => sseResponse(stream.stream))).streamTurn(request({ signal: controller.signal, onText })));
    stream.push(messageStart() + textBlock(0, ['Hi']));
    const error = await promise;
    expect(error).toBeInstanceOf(ChatAbortError);
    expect(error).not.toBeInstanceOf(ChatApiError);
  });
});

describe('AnthropicProvider idle watchdog', () => {
  it('uses a 60 second default', () => {
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBe(60_000);
  });

  it('aborts a stream without events for the idle timeout as a retryable error', async () => {
    vi.useFakeTimers();
    const stream = controlledStream();
    const promise = caught(provider(abortableFetch(() => sseResponse(stream.stream))).streamTurn(request()));
    stream.push(messageStart());
    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_TIMEOUT_MS - 1);
    let settled = false;
    void promise.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await promise;
    expect(error).toBeInstanceOf(ChatApiError);
    expect((error as ChatApiError).retryable).toBe(true);
    expect(error).not.toBeInstanceOf(ChatAbortError);
  });

  it('counts pings as activity', async () => {
    vi.useFakeTimers();
    const stream = controlledStream();
    let settled = false;
    const promise = caught(provider(abortableFetch(() => sseResponse(stream.stream)), 1000).streamTurn(request()));
    void promise.then(() => (settled = true));
    stream.push(messageStart());
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(900);
      stream.push(PING);
    }
    await vi.advanceTimersByTimeAsync(900);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(await promise).toBeInstanceOf(ChatApiError);
  });

  it('applies while waiting for the response', async () => {
    vi.useFakeTimers();
    const promise = caught(provider(abortableFetch(never), 500).streamTurn(request()));
    await vi.advanceTimersByTimeAsync(500);
    const error = await promise;
    expect(error).toBeInstanceOf(ChatApiError);
    expect((error as ChatApiError).retryable).toBe(true);
  });

  it('does not count bytes that do not complete an event', async () => {
    vi.useFakeTimers();
    const stream = controlledStream();
    const promise = caught(provider(abortableFetch(() => sseResponse(stream.stream)), 1000).streamTurn(request()));
    stream.push(messageStart());
    await vi.advanceTimersByTimeAsync(600);
    stream.push('event: pi');
    await vi.advanceTimersByTimeAsync(400);
    expect(await promise).toBeInstanceOf(ChatApiError);
  });

  it('stops the watchdog after the turn completes', async () => {
    vi.useFakeTimers();
    await provider(fetchReturning(sseResponse(TOOL_USE_STREAM))).streamTurn(request());
    expect(vi.getTimerCount()).toBe(0);
  });
});
