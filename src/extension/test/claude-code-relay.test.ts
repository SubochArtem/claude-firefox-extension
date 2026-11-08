import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ClaudeCodeRelay,
  createClaudeCodeRelay,
  type HostChatRequest,
  STATUS_TIMEOUT_MS,
} from '../chat/claude-code-relay';
import type { BoundTab } from '../chat/system-prompt';
import { MAX_CHAT_SYSTEM_PROMPT_LENGTH } from '../protocol';
import { CLAUDE_CODE_PORT, SIDEBAR_PAGE } from '../sidebar/sidebar-constants';
import { createPort, EXTENSION_ID, EXTENSION_ORIGIN, type FakePort } from './browser-mock';

const SIDEBAR_URL = `${EXTENSION_ORIGIN}/${SIDEBAR_PAGE}`;
const SIDEBAR_SENDER = { id: EXTENSION_ID, url: SIDEBAR_URL } as browser.runtime.MessageSender;
const TAB: BoundTab = { id: 7, url: 'https://example.com/page', title: 'Example page' };

let sent: HostChatRequest[];
let connected: boolean;
let tabs: Map<number, BoundTab>;
let ids: number;
let relay: ClaudeCodeRelay;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function sidebarPort(): FakePort {
  const fake = createPort(CLAUDE_CODE_PORT, SIDEBAR_SENDER);
  relay.connect(fake.port);
  return fake;
}

function posted(fake: FakePort): Record<string, unknown>[] {
  return fake.postMessage.mock.calls.map((call) => call[0] as Record<string, unknown>);
}

async function startSession(fake: FakePort, windowId = 1, requestId = 'r1'): Promise<string> {
  fake.emitMessage({ type: 'chat_start', requestId, windowId });
  await flush();
  const started = posted(fake).find((message) => message['type'] === 'chat_started' && message['requestId'] === requestId);
  if (!started) throw new Error('the session did not start');
  return started['sessionId'] as string;
}

beforeEach(() => {
  sent = [];
  connected = true;
  tabs = new Map([[1, TAB]]);
  ids = 0;
  relay = createClaudeCodeRelay({
    sendToHost: (message) => {
      if (!connected) return false;
      sent.push(message);
      return true;
    },
    sidebarUrl: SIDEBAR_URL,
    extensionId: EXTENSION_ID,
    activeTab: async (windowId) => tabs.get(windowId),
    platform: async () => 'linux',
    now: () => new Date(2026, 10, 8, 12, 0),
    newSessionId: () => `session-${++ids}`,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('sidebar ports', () => {
  it('ignores ports with another name', () => {
    const fake = createPort('other', SIDEBAR_SENDER);
    relay.connect(fake.port);
    fake.emitMessage({ type: 'chat_start', requestId: 'r1', windowId: 1 });
    expect(fake.disconnect).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it.each<[string, Partial<browser.runtime.MessageSender> | undefined]>([
    ['another extension', { id: 'other@example', url: SIDEBAR_URL }],
    ['another page of this extension', { id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}/options/options.html` }],
    ['a content script', { id: EXTENSION_ID, url: 'https://example.com/', tab: { id: 3 } as browser.tabs.Tab }],
    ['an unknown sender', undefined],
  ])('disconnects a port from %s and relays nothing', async (_label, sender) => {
    const fake = createPort(CLAUDE_CODE_PORT, sender as browser.runtime.MessageSender | undefined);
    relay.connect(fake.port);
    fake.emitMessage({ type: 'chat_start', requestId: 'r1', windowId: 1 });
    fake.emitMessage({ type: 'chat_status', requestId: 's1' });
    await flush();
    expect(fake.disconnect).toHaveBeenCalledOnce();
    expect(fake.postMessage).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });
});

describe('starting a session', () => {
  it('creates a session id, starts it in the host with the bound tab and reports it to the sidebar', async () => {
    const fake = sidebarPort();
    const sessionId = await startSession(fake);
    expect(sessionId).toBe('session-1');
    expect(sent).toHaveLength(1);
    const start = sent[0] as { type: string; sessionId: string; appendSystemPrompt: string };
    expect(start.type).toBe('chat_start');
    expect(start.sessionId).toBe(sessionId);
    expect(start.appendSystemPrompt).toContain('Tab id: 7');
    expect(start.appendSystemPrompt).toContain('https://example.com/page');
    expect(posted(fake)).toEqual([{ type: 'chat_started', requestId: 'r1', sessionId, tab: TAB }]);
  });

  it('passes a valid model on', async () => {
    const fake = sidebarPort();
    fake.emitMessage({ type: 'chat_start', requestId: 'r1', windowId: 1, model: 'claude-opus-5-5[1m]' });
    await flush();
    expect(sent[0]).toMatchObject({ type: 'chat_start', model: 'claude-opus-5-5[1m]' });
  });

  it('starts without a bound tab when the window has no active tab', async () => {
    const fake = sidebarPort();
    const sessionId = await startSession(fake, 99);
    expect((sent[0] as { appendSystemPrompt: string }).appendSystemPrompt).toMatch(/no tab is bound/i);
    expect(posted(fake)).toEqual([{ type: 'chat_started', requestId: 'r1', sessionId }]);
  });

  it('uses the default random session id format', async () => {
    const randomRelay = createClaudeCodeRelay({
      sendToHost: (message) => {
        sent.push(message);
        return true;
      },
      sidebarUrl: SIDEBAR_URL,
      extensionId: EXTENSION_ID,
      activeTab: async () => undefined,
      platform: async () => 'linux',
    });
    const fake = createPort(CLAUDE_CODE_PORT, SIDEBAR_SENDER);
    randomRelay.connect(fake.port);
    fake.emitMessage({ type: 'chat_start', requestId: 'a', windowId: 1 });
    fake.emitMessage({ type: 'chat_start', requestId: 'b', windowId: 1 });
    await flush();
    const sessionIds = sent.map((message) => message.type === 'chat_start' && message.sessionId);
    expect(sessionIds).toHaveLength(2);
    for (const sessionId of sessionIds) expect(sessionId).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(sessionIds[0]).not.toBe(sessionIds[1]);
  });

  it.each([
    ['a missing window id', { type: 'chat_start', requestId: 'r1' }],
    ['a fractional window id', { type: 'chat_start', requestId: 'r1', windowId: 1.5 }],
    ['a model starting with a dash', { type: 'chat_start', requestId: 'r1', windowId: 1, model: '--bare' }],
    ['a model with spaces', { type: 'chat_start', requestId: 'r1', windowId: 1, model: 'a b' }],
    ['a too long model', { type: 'chat_start', requestId: 'r1', windowId: 1, model: 'm'.repeat(129) }],
  ])('refuses a start with %s', async (_label, message) => {
    const fake = sidebarPort();
    fake.emitMessage(message);
    await flush();
    expect(sent).toEqual([]);
    expect(posted(fake)).toEqual([{ type: 'chat_start_error', requestId: 'r1', message: expect.any(String) }]);
  });

  it('ignores a start without a request id', async () => {
    const fake = sidebarPort();
    fake.emitMessage({ type: 'chat_start', windowId: 1 });
    await flush();
    expect(sent).toEqual([]);
    expect(fake.postMessage).not.toHaveBeenCalled();
  });

  it('reports a start while the native host is not connected', async () => {
    connected = false;
    const fake = sidebarPort();
    fake.emitMessage({ type: 'chat_start', requestId: 'r1', windowId: 1 });
    await flush();
    expect(posted(fake)).toEqual([{ type: 'chat_start_error', requestId: 'r1', message: expect.stringMatching(/native host/i) }]);
  });

  it('does not start a session for a sidebar that disconnected while the tab was looked up', async () => {
    const fake = sidebarPort();
    fake.emitMessage({ type: 'chat_start', requestId: 'r1', windowId: 1 });
    fake.emitDisconnect();
    await flush();
    expect(sent).toEqual([]);
    expect(fake.postMessage).not.toHaveBeenCalled();
  });
});

describe('routing', () => {
  it('forwards send, interrupt and close of an owned session to the host', async () => {
    const fake = sidebarPort();
    const sessionId = await startSession(fake);
    fake.emitMessage({ type: 'chat_send', sessionId, content: 'hello' });
    fake.emitMessage({ type: 'chat_interrupt', sessionId });
    fake.emitMessage({ type: 'chat_close', sessionId });
    expect(sent.slice(1)).toEqual([
      { type: 'chat_send', sessionId, content: 'hello' },
      { type: 'chat_interrupt', sessionId },
      { type: 'chat_close', sessionId },
    ]);
  });

  it('routes host events only to the port that owns the session', async () => {
    const first = sidebarPort();
    const second = sidebarPort();
    const firstSession = await startSession(first, 1, 'a');
    const secondSession = await startSession(second, 1, 'b');
    first.postMessage.mockClear();
    second.postMessage.mockClear();
    const event = { type: 'chat_event' as const, sessionId: firstSession, event: { type: 'assistant' } };
    relay.handleHostMessage(event);
    relay.handleHostMessage({ type: 'chat_error', sessionId: secondSession, code: 'exited', message: 'gone' });
    expect(posted(first)).toEqual([event]);
    expect(posted(second)).toEqual([{ type: 'chat_error', sessionId: secondSession, code: 'exited', message: 'gone' }]);
  });

  it('refuses requests for a session owned by another port', async () => {
    const owner = sidebarPort();
    const intruder = sidebarPort();
    const sessionId = await startSession(owner);
    sent = [];
    for (const type of ['chat_send', 'chat_interrupt', 'chat_close']) {
      intruder.emitMessage({ type, sessionId, content: 'x' });
    }
    expect(sent).toEqual([]);
    expect(posted(intruder)).toEqual(
      Array.from({ length: 3 }, () => ({ type: 'chat_error', sessionId, code: 'unknown_session', message: expect.any(String) })),
    );
  });

  it('forgets a session after chat_closed and drops later events for it', async () => {
    const fake = sidebarPort();
    const sessionId = await startSession(fake);
    relay.handleHostMessage({ type: 'chat_closed', sessionId });
    relay.handleHostMessage({ type: 'chat_event', sessionId, event: { type: 'late' } });
    expect(posted(fake).slice(1)).toEqual([{ type: 'chat_closed', sessionId }]);
    fake.emitMessage({ type: 'chat_send', sessionId, content: 'again' });
    expect(sent.filter((message) => message.type === 'chat_send')).toEqual([]);
  });

  it('drops host events for unknown sessions', () => {
    const fake = sidebarPort();
    relay.handleHostMessage({ type: 'chat_event', sessionId: 'nobody', event: { type: 'x' } });
    expect(fake.postMessage).not.toHaveBeenCalled();
  });

  it('ignores malformed sidebar messages', async () => {
    const fake = sidebarPort();
    const sessionId = await startSession(fake);
    sent = [];
    for (const message of [null, 'text', { type: 'chat_send', sessionId: 'bad id', content: 'x' }, { type: 'chat_resume', sessionId }]) {
      fake.emitMessage(message);
    }
    expect(sent).toEqual([]);
  });
});

describe('disconnects', () => {
  it('closes every session of a sidebar port when it disconnects and keeps the others', async () => {
    const first = sidebarPort();
    const second = sidebarPort();
    const a = await startSession(first, 1, 'a');
    const b = await startSession(first, 1, 'b');
    const c = await startSession(second, 1, 'c');
    sent = [];
    first.emitDisconnect();
    expect(sent).toEqual([
      { type: 'chat_close', sessionId: a },
      { type: 'chat_close', sessionId: b },
    ]);
    second.postMessage.mockClear();
    relay.handleHostMessage({ type: 'chat_event', sessionId: c, event: { type: 'x' } });
    relay.handleHostMessage({ type: 'chat_closed', sessionId: a });
    expect(posted(second)).toEqual([{ type: 'chat_event', sessionId: c, event: { type: 'x' } }]);
    expect(first.postMessage).toHaveBeenCalledTimes(2);
  });

  it('ends every session with an error and chat_closed when the native host disconnects', async () => {
    const first = sidebarPort();
    const second = sidebarPort();
    const a = await startSession(first, 1, 'a');
    const b = await startSession(second, 1, 'b');
    first.postMessage.mockClear();
    second.postMessage.mockClear();
    relay.hostDisconnected();
    expect(posted(first)).toEqual([
      { type: 'chat_error', sessionId: a, code: 'host_disconnected', message: expect.any(String) },
      { type: 'chat_closed', sessionId: a },
    ]);
    expect(posted(second)).toEqual([
      { type: 'chat_error', sessionId: b, code: 'host_disconnected', message: expect.any(String) },
      { type: 'chat_closed', sessionId: b },
    ]);
    sent = [];
    first.emitMessage({ type: 'chat_send', sessionId: a, content: 'x' });
    expect(sent).toEqual([]);
  });

  it('does not throw when posting to a port that is already gone', async () => {
    const fake = sidebarPort();
    const sessionId = await startSession(fake);
    fake.postMessage.mockImplementation(() => {
      throw new Error('Attempt to postMessage on disconnected port');
    });
    expect(() => relay.handleHostMessage({ type: 'chat_event', sessionId, event: { type: 'x' } })).not.toThrow();
  });
});

describe('status', () => {
  it('asks the host and returns its answer', async () => {
    const reply = relay.status();
    expect(sent).toEqual([{ type: 'chat_status_request', requestId: expect.any(String) }]);
    const { requestId } = sent[0] as { requestId: string };
    const status = { found: true, path: '/usr/bin/claude', version: '2.1.316', versionOk: true, loggedIn: true, authMethod: 'claude.ai', ready: true };
    relay.handleHostMessage({ type: 'chat_status_response', requestId, ...status });
    expect(await reply).toEqual({ hostConnected: true, status });
  });

  it('answers a status request from the sidebar port', async () => {
    const fake = sidebarPort();
    fake.emitMessage({ type: 'chat_status', requestId: 'q1' });
    const { requestId } = sent[0] as { requestId: string };
    relay.handleHostMessage({ type: 'chat_status_response', requestId, found: false, ready: false, error: 'not found' });
    await flush();
    expect(posted(fake)).toEqual([
      { type: 'chat_status', requestId: 'q1', reply: { hostConnected: true, status: { found: false, ready: false, error: 'not found' } } },
    ]);
  });

  it('reports a host that is not connected', async () => {
    connected = false;
    expect(await relay.status()).toEqual({ hostConnected: false });
  });

  it('reports the host as not connected when it disconnects before answering', async () => {
    const reply = relay.status();
    relay.hostDisconnected();
    expect(await reply).toEqual({ hostConnected: false });
  });

  it('gives up on a host that never answers, such as an older one', async () => {
    vi.useFakeTimers();
    const reply = relay.status();
    await vi.advanceTimersByTimeAsync(STATUS_TIMEOUT_MS);
    expect(await reply).toEqual({ hostConnected: true });
  });

  it('ignores a response for an unknown request', () => {
    expect(() => relay.handleHostMessage({ type: 'chat_status_response', requestId: 'nobody', found: false, ready: false })).not.toThrow();
  });
});

describe('system prompt of a session', () => {
  it('stays within the host limit for a huge tab URL and title', async () => {
    tabs.set(1, { id: 1, url: `https://example.com/${'u'.repeat(50_000)}`, title: 't'.repeat(50_000) });
    const fake = sidebarPort();
    await startSession(fake);
    const prompt = (sent[0] as { appendSystemPrompt: string }).appendSystemPrompt;
    expect(prompt.length).toBeLessThanOrEqual(MAX_CHAT_SYSTEM_PROMPT_LENGTH);
    expect(prompt).toContain('Tab id: 1');
  });
});
