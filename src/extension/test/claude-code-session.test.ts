import { describe, expect, it, vi } from 'vitest';
import { type ChatChange, RESULT_LIMIT, SCREENSHOT_LABEL } from '../sidebar/chat-session';
import {
  chatErrorText,
  ClaudeCodeSession,
  DISCONNECTED_TEXT,
  REDUCED_TEXT,
  SESSION_ENDED_TEXT,
  toolName,
  toolResultText,
} from '../sidebar/claude-code-session';
import { CLAUDE_CODE_PORT } from '../sidebar/sidebar-constants';
import { createPort, type FakePort } from './browser-mock';

const SESSION = 'session-1';

function setup(options: { windowId?: () => Promise<number | undefined>; model?: () => Promise<string | undefined> } = {}) {
  const ports: FakePort[] = [];
  const changes: ChatChange[] = [];
  const connect = vi.fn(() => {
    const port = createPort(CLAUDE_CODE_PORT);
    ports.push(port);
    return port.port;
  });
  const session = new ClaudeCodeSession({
    connect,
    windowId: options.windowId ?? (async () => 7),
    model: options.model ?? (async () => 'claude-opus-5-5'),
    onChange: (change) => changes.push(change),
  });
  const port = () => {
    const last = ports.at(-1);
    if (last === undefined) throw new Error('no port was opened');
    return last;
  };
  const sent = () => (ports.at(-1)?.postMessage.mock.calls ?? []).map(([message]) => message as Record<string, unknown>);
  const emit = (message: Record<string, unknown>) => port().emitMessage(message);
  const event = (value: Record<string, unknown>, reduced = false) =>
    emit({ type: 'chat_event', sessionId: SESSION, event: value, ...(reduced ? { reduced: true } : {}) });
  // Sends a prompt, lets the start go out and answers it.
  const started = async (text = 'hello') => {
    session.send(text);
    await vi.waitFor(() => expect(sent().some((message) => message.type === 'chat_start')).toBe(true));
    const start = sent().find((message) => message.type === 'chat_start');
    emit({ type: 'chat_started', requestId: start?.requestId, sessionId: SESSION });
  };
  const view = () =>
    session.items.map((item) => {
      if (item.kind === 'tool') return { kind: 'tool', name: item.name, summary: item.summary, result: item.result };
      if (item.kind === 'notice') return { kind: 'notice', level: item.level, text: item.text };
      return { kind: item.kind, text: item.text };
    });
  return { session, ports, changes, connect, sent, emit, event, started, view };
}

function delta(text: string) {
  return { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } };
}

function messageStart(id: string) {
  return { type: 'stream_event', event: { type: 'message_start', message: { id } } };
}

function assistant(id: string | undefined, ...content: Record<string, unknown>[]) {
  return { type: 'assistant', message: { ...(id === undefined ? {} : { id }), role: 'assistant', content } };
}

function toolResult(toolUseId: string, content: unknown, isError = false) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] } };
}

const success = { type: 'result', subtype: 'success', is_error: false, result: 'done' };

describe('Claude Code session helpers', () => {
  it('strips the firefox MCP prefix from tool names', () => {
    expect(toolName('mcp__firefox__navigate')).toBe('navigate');
    expect(toolName('navigate')).toBe('navigate');
    expect(toolName('mcp__other__x')).toBe('mcp__other__x');
  });

  it('turns tool result content into text with screenshot labels and clips it', () => {
    expect(toolResultText('plain')).toBe('plain');
    expect(toolResultText([{ type: 'text', text: 'a' }, { type: 'image', source: {} }, { type: 'other' }])).toBe(`a\n${SCREENSHOT_LABEL}`);
    expect(toolResultText(undefined)).toBe('');
    expect(toolResultText('x'.repeat(RESULT_LIMIT + 5))).toBe(`${'x'.repeat(RESULT_LIMIT)}… (5 more characters)`);
  });

  it('adds hints to chat error codes', () => {
    expect(chatErrorText('not_logged_in', 'Not logged in.')).toBe('Not logged in. Run "claude" in a terminal and log in, or run "claude auth login".');
    expect(chatErrorText('claude_not_found', 'Not found.')).toContain('Install Claude Code');
    expect(chatErrorText('claude_too_old', 'Old.')).toContain('2.1.302');
    expect(chatErrorText('exited', 'Claude Code exited.')).toBe('Claude Code exited.');
  });
});

describe('Claude Code session lifecycle', () => {
  it('opens no port and starts no session before the first prompt', () => {
    const { connect } = setup();
    expect(connect).not.toHaveBeenCalled();
  });

  it('starts lazily in the sidebar window with the model and sends the queued prompt once started', async () => {
    const { session, sent, emit, view } = setup();
    expect(session.send('  hello  ')).toBe(true);
    expect(session.running).toBe(true);
    expect(view()).toEqual([{ kind: 'user', text: 'hello' }]);
    await vi.waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toEqual({ type: 'chat_start', requestId: expect.any(String), windowId: 7, model: 'claude-opus-5-5' });
    emit({ type: 'chat_started', requestId: sent()[0]?.requestId, sessionId: SESSION });
    expect(sent()[1]).toEqual({ type: 'chat_send', sessionId: SESSION, content: 'hello' });
  });

  it('refuses blank prompts and prompts during a turn', async () => {
    const { session, started, sent } = setup();
    expect(session.send('   ')).toBe(false);
    await started();
    expect(session.send('again')).toBe(false);
    expect(sent().filter((message) => message.type === 'chat_send')).toHaveLength(1);
  });

  it('keeps one session for the conversation', async () => {
    const { session, started, event, sent } = setup();
    await started('first');
    event(success);
    expect(session.running).toBe(false);
    expect(session.send('second')).toBe(true);
    expect(sent().filter((message) => message.type === 'chat_start')).toHaveLength(1);
    expect(sent().at(-1)).toEqual({ type: 'chat_send', sessionId: SESSION, content: 'second' });
  });

  it('ends the turn with an error note on chat_start_error', async () => {
    const { session, sent, emit, view } = setup();
    session.send('hello');
    await vi.waitFor(() => expect(sent()).toHaveLength(1));
    emit({ type: 'chat_start_error', requestId: sent()[0]?.requestId, message: 'The native host is not connected.' });
    expect(session.running).toBe(false);
    expect(view().at(-1)).toEqual({ kind: 'notice', level: 'error', text: 'Could not start Claude Code: The native host is not connected.' });
    session.send('again');
    await vi.waitFor(() => expect(sent().filter((message) => message.type === 'chat_start')).toHaveLength(2));
  });

  it('ends the turn when the sidebar window is unknown', async () => {
    const { session, sent, view } = setup({ windowId: async () => undefined });
    session.send('hello');
    await vi.waitFor(() => expect(session.running).toBe(false));
    expect(sent()).toEqual([]);
    expect(view().at(-1)).toEqual({ kind: 'notice', level: 'error', text: 'Could not start Claude Code: the sidebar window was not found.' });
  });

  it('omits the model when there is none', async () => {
    const { session, sent } = setup({ model: async () => undefined });
    session.send('hello');
    await vi.waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).not.toHaveProperty('model');
  });

  it('Stop sends chat_interrupt and the turn ends on the result', async () => {
    const { session, started, event, sent, view } = setup();
    await started();
    session.stop();
    expect(sent().at(-1)).toEqual({ type: 'chat_interrupt', sessionId: SESSION });
    expect(session.running).toBe(true);
    event({ type: 'result', subtype: 'error_during_execution', is_error: true });
    expect(session.running).toBe(false);
    expect(view().at(-1)).toEqual({ kind: 'notice', level: 'info', text: 'Stopped.' });
  });

  it('Stop before the session started drops the queued prompt and keeps the session for the next one', async () => {
    const { session, sent, emit, view } = setup();
    session.send('hello');
    await vi.waitFor(() => expect(sent()).toHaveLength(1));
    session.stop();
    expect(session.running).toBe(false);
    expect(view().at(-1)).toEqual({ kind: 'notice', level: 'info', text: 'Stopped.' });
    emit({ type: 'chat_started', requestId: sent()[0]?.requestId, sessionId: SESSION });
    expect(sent()).toHaveLength(1);
    session.send('next');
    expect(sent().at(-1)).toEqual({ type: 'chat_send', sessionId: SESSION, content: 'next' });
  });

  it('New chat closes the session, clears the view and starts a new session on the next prompt', async () => {
    const { session, started, event, sent, changes, emit } = setup();
    await started();
    event(success);
    session.newChat();
    expect(sent().at(-1)).toEqual({ type: 'chat_close', sessionId: SESSION });
    expect(changes.at(-1)).toEqual({ type: 'clear' });
    expect(session.items).toEqual([]);
    emit({ type: 'chat_closed', sessionId: SESSION });
    expect(session.items).toEqual([]);
    session.send('fresh');
    await vi.waitFor(() => expect(sent().filter((message) => message.type === 'chat_start')).toHaveLength(2));
  });

  it('New chat during a start closes the session that starts afterwards', async () => {
    const { session, sent, emit } = setup();
    session.send('hello');
    await vi.waitFor(() => expect(sent()).toHaveLength(1));
    session.newChat();
    expect(session.running).toBe(false);
    emit({ type: 'chat_started', requestId: sent()[0]?.requestId, sessionId: SESSION });
    expect(sent().at(-1)).toEqual({ type: 'chat_close', sessionId: SESSION });
    expect(sent().some((message) => message.type === 'chat_send')).toBe(false);
  });

  it('New chat before the start went out sends no start', async () => {
    let resolveWindow: (id: number) => void = () => undefined;
    const { session, connect } = setup({ windowId: () => new Promise((resolve) => (resolveWindow = resolve)) });
    session.send('hello');
    session.newChat();
    resolveWindow(7);
    await Promise.resolve();
    await Promise.resolve();
    expect(connect).not.toHaveBeenCalled();
  });

  it('a port disconnect ends the session with a note, resends nothing and reconnects on the next prompt', async () => {
    const { session, started, ports, sent, view, connect } = setup();
    await started();
    ports[0]?.emitDisconnect();
    expect(session.running).toBe(false);
    expect(view().at(-1)).toEqual({ kind: 'notice', level: 'error', text: DISCONNECTED_TEXT });
    expect(connect).toHaveBeenCalledTimes(1);
    session.send('next');
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toMatchObject({ type: 'chat_start' });
    expect(ports[0]?.postMessage.mock.calls.filter(([message]) => (message as { type: string }).type === 'chat_send')).toHaveLength(1);
  });

  it('a disconnect between turns notes the ended session; without a session it is silent', async () => {
    const idle = setup();
    idle.session.status().catch(() => undefined);
    idle.ports[0]?.emitDisconnect();
    expect(idle.session.items).toEqual([]);

    const { started, event, ports, view } = setup();
    await started();
    event(success);
    ports[0]?.emitDisconnect();
    expect(view().at(-1)).toEqual({ kind: 'notice', level: 'info', text: DISCONNECTED_TEXT });
  });

  it('ignores messages of an old port and of other sessions', async () => {
    const { session, started, ports, event, emit } = setup();
    await started();
    emit({ type: 'chat_event', sessionId: 'other', event: delta('x') });
    expect(session.items).toHaveLength(1);
    ports[0]?.emitDisconnect();
    const count = session.items.length;
    event(delta('late'));
    expect(session.items).toHaveLength(count);
  });

  it('asks the status over the port and rejects pending checks on disconnect', async () => {
    const { session, sent, emit, ports } = setup();
    const reply = session.status();
    const request = sent()[0];
    expect(request).toEqual({ type: 'chat_status', requestId: expect.any(String) });
    emit({ type: 'chat_status', requestId: request?.requestId, reply: { hostConnected: false } });
    await expect(reply).resolves.toEqual({ hostConnected: false });
    const lost = session.status();
    ports[0]?.emitDisconnect();
    await expect(lost).rejects.toThrow('connection to the extension background was lost');
  });

  it('treats a port that throws on postMessage as disconnected', async () => {
    const { session, started, ports, view } = setup();
    await started();
    ports[0]?.postMessage.mockImplementation(() => {
      throw new Error('Attempt to postMessage on disconnected port');
    });
    session.stop();
    expect(session.running).toBe(false);
    expect(view().at(-1)).toEqual({ kind: 'notice', level: 'error', text: DISCONNECTED_TEXT });
  });
});

describe('Claude Code events in the view', () => {
  it('notes the first system/init only', async () => {
    const { started, event, view } = setup();
    await started();
    event({ type: 'system', subtype: 'init', model: 'claude-opus-5-5' });
    event({ type: 'system', subtype: 'init', model: 'claude-opus-5-5' });
    expect(view().filter((item) => item.kind === 'notice')).toEqual([
      { kind: 'notice', level: 'info', text: 'Claude Code session started (claude-opus-5-5).' },
    ]);
  });

  it('streams text deltas into one assistant item and does not repeat it from the full message', async () => {
    const { started, event, view, changes } = setup();
    await started();
    event(messageStart('msg_1'));
    event(delta('Hel'));
    event(delta('lo'));
    expect(changes.at(-1)).toMatchObject({ type: 'update', item: { kind: 'assistant', text: 'Hello' } });
    event(assistant('msg_1', { type: 'text', text: 'Hello' }));
    event(success);
    expect(view()).toEqual([
      { kind: 'user', text: 'hello' },
      { kind: 'assistant', text: 'Hello' },
    ]);
  });

  it('does not repeat streamed text of a message without an id', async () => {
    const { started, event, view } = setup();
    await started();
    event(delta('Hi'));
    event(assistant(undefined, { type: 'text', text: 'Hi' }));
    expect(view().filter((item) => item.kind === 'assistant')).toEqual([{ kind: 'assistant', text: 'Hi' }]);
  });

  it('shows the text of a full message that was not streamed', async () => {
    const { started, event, view } = setup();
    await started();
    event(assistant('msg_1', { type: 'text', text: 'Whole answer' }));
    expect(view().at(-1)).toEqual({ kind: 'assistant', text: 'Whole answer' });
  });

  it('shows tool calls without the MCP prefix, clipped input and their results', async () => {
    const { started, event, view } = setup();
    await started();
    event(messageStart('msg_1'));
    event(delta('Opening.'));
    event({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use' } } });
    event(assistant('msg_1', { type: 'text', text: 'Opening.' }));
    event(assistant('msg_1', { type: 'tool_use', id: 'toolu_1', name: 'mcp__firefox__navigate', input: { url: 'https://example.com', tabId: 3 } }));
    event(assistant('msg_1', { type: 'tool_use', id: 'toolu_1', name: 'mcp__firefox__navigate', input: {} }));
    event(assistant('msg_1', { type: 'tool_use', id: 'toolu_2', name: 'mcp__firefox__computer', input: { text: 'x'.repeat(500) } }));
    event(toolResult('toolu_1', [{ type: 'text', text: 'Navigated' }]));
    event(toolResult('toolu_2', [{ type: 'image', source: {} }], true));
    event(toolResult('unknown', 'ignored'));
    event(messageStart('msg_2'));
    event(delta('Done.'));
    event(success);
    expect(view()).toEqual([
      { kind: 'user', text: 'hello' },
      { kind: 'assistant', text: 'Opening.' },
      { kind: 'tool', name: 'navigate', summary: 'url: https://example.com, tabId: 3', result: { text: 'Navigated', isError: false } },
      { kind: 'tool', name: 'computer', summary: expect.stringMatching(/^text: x+…$/), result: { text: SCREENSHOT_LABEL, isError: true } },
      { kind: 'assistant', text: 'Done.' },
    ]);
  });

  it('ends the turn on a successful result without a note', async () => {
    const { session, started, event, view, changes } = setup();
    await started();
    event(success);
    expect(session.running).toBe(false);
    expect(changes.at(-1)).toEqual({ type: 'running', running: false });
    expect(view().filter((item) => item.kind === 'notice')).toEqual([]);
  });

  it.each([
    [{ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 529 overloaded' }, 'Claude Code: API Error: 529 overloaded'],
    [{ type: 'result', subtype: 'error_max_turns', is_error: true }, 'The turn ended with an error (error_max_turns).'],
    [{ type: 'result', is_error: true }, 'The turn ended with an error (unknown).'],
  ])('shows an error note for the result %o', async (result, text) => {
    const { session, started, event, view } = setup();
    await started();
    event(result);
    expect(session.running).toBe(false);
    expect(view().at(-1)).toEqual({ kind: 'notice', level: 'error', text });
  });

  it('notes a reduced event and still renders what is left of it', async () => {
    const { started, event, view } = setup();
    await started();
    event(assistant('msg_1', { type: 'tool_use', id: 'toolu_1', name: 'mcp__firefox__computer', input: { action: 'screenshot' } }));
    event(toolResult('toolu_1', [{ type: 'text', text: '[tool result omitted: too large to forward]' }]), true);
    event({ type: 'user' }, true);
    expect(view().slice(-3)).toEqual([
      { kind: 'tool', name: 'computer', summary: 'action: screenshot', result: { text: '[tool result omitted: too large to forward]', isError: false } },
      { kind: 'notice', level: 'info', text: REDUCED_TEXT },
      { kind: 'notice', level: 'info', text: REDUCED_TEXT },
    ]);
  });

  it('shows chat_error as a readable note, ends the turn and closes the session', async () => {
    const { session, started, emit, sent, view } = setup();
    await started();
    emit({ type: 'chat_error', sessionId: SESSION, code: 'not_logged_in', message: 'Claude Code is not logged in.' });
    expect(session.running).toBe(false);
    expect(view().at(-1)).toEqual({
      kind: 'notice',
      level: 'error',
      text: 'Claude Code is not logged in. Run "claude" in a terminal and log in, or run "claude auth login".',
    });
    expect(sent().at(-1)).toEqual({ type: 'chat_close', sessionId: SESSION });
    emit({ type: 'chat_closed', sessionId: SESSION });
    expect(view().filter((item) => item.kind === 'notice')).toHaveLength(1);
    session.send('again');
    await vi.waitFor(() => expect(sent().filter((message) => message.type === 'chat_start')).toHaveLength(2));
  });

  it('notes a session closed by the host', async () => {
    const { session, started, emit, view } = setup();
    await started();
    emit({ type: 'chat_closed', sessionId: SESSION });
    expect(session.running).toBe(false);
    expect(view().at(-1)).toEqual({ kind: 'notice', level: 'info', text: SESSION_ENDED_TEXT });
  });
});
