import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { ChatStartError, prepareChatWorkDir, type ClaudeCommand } from '../claude-cli';
import { createChatSessions, MAX_CHAT_SESSIONS, type ChatSessions } from '../chat-sessions';
import type { ChatRequest, HostToExtensionMessage } from '../protocol';
import { tempDir, waitFor, within } from './helpers';

const isWindows = process.platform === 'win32';
const FAKE_CLAUDE = join(import.meta.dirname, 'fake-claude.mjs');
const MCP_CONFIG = '{"mcpServers":{"firefox":{"type":"stdio","command":"host","args":["--mcp"]}}}';

interface Harness {
  sessions: ChatSessions;
  sent: HostToExtensionMessage[];
  workDir: string;
  record: string;
  handle: (request: ChatRequest) => void;
  of: (sessionId: string, type?: string) => Record<string, unknown>[];
  events: (sessionId: string) => Record<string, unknown>[];
  runs: () => { argv: string[]; cwd: string; env: Record<string, string> }[];
}

async function harness({
  env = {},
  locate,
  closeGraceMs,
}: { env?: Record<string, string>; locate?: () => ClaudeCommand; closeGraceMs?: number } = {}): Promise<Harness> {
  const dir = await tempDir();
  const workDir = join(dir, 'chat');
  const record = join(dir, 'runs.jsonl');
  const sent: HostToExtensionMessage[] = [];
  const sessions = createChatSessions({
    send: (message) => {
      sent.push(message);
    },
    locate: locate ?? (() => ({ command: process.execPath, args: [FAKE_CLAUDE] })),
    env: { ...process.env, FAKE_CLAUDE_RECORD: record, ...env },
    workDir: () => prepareChatWorkDir(workDir),
    mcpConfig: MCP_CONFIG,
    ...(closeGraceMs === undefined ? {} : { closeGraceMs }),
  });
  onTestFinished(async () => {
    sessions.killAll();
    await waitFor(() => expect(sessions.size()).toBe(0));
  });
  const of = (sessionId: string, type?: string) =>
    (sent as unknown as Record<string, unknown>[]).filter(
      (message) => message['sessionId'] === sessionId && (type === undefined || message['type'] === type),
    );
  return {
    sessions,
    sent,
    workDir,
    record,
    handle: (request) => sessions.handle(request),
    of,
    events: (sessionId) => of(sessionId, 'chat_event').map((message) => message['event'] as Record<string, unknown>),
    runs: () =>
      readFileSync(record, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { argv: string[]; cwd: string; env: Record<string, string> }),
  };
}

function eventTypes(h: Harness, sessionId: string): string[] {
  return h.events(sessionId).map((event) => [event['type'], event['subtype']].filter(Boolean).join('/'));
}

async function started(h: Harness, sessionId = 's1', extra: Partial<ChatRequest> = {}): Promise<void> {
  h.handle({ type: 'chat_start', sessionId, ...extra } as ChatRequest);
  await waitFor(() => expect(eventTypes(h, sessionId)).toContain('system/init'));
}

describe('chat sessions', () => {
  it('runs a turn and forwards the stream-json events, ignoring non-JSON lines', async () => {
    const h = await harness();
    await started(h);
    h.handle({ type: 'chat_send', sessionId: 's1', content: 'hello' });
    await waitFor(() => expect(eventTypes(h, 's1')).toContain('result/success'));
    expect(eventTypes(h, 's1')).toEqual(['system/init', 'stream_event', 'stream_event', 'assistant', 'result/success']);
    expect(h.events('s1')[2]).toMatchObject({ event: { delta: { text: 'echo: hello' } } });
    expect(h.of('s1', 'chat_error')).toEqual([]);
  });

  it('starts claude with the chat argv in the working directory and checks it first', async () => {
    const h = await harness();
    await started(h, 's1', { model: 'claude-haiku-5-5', appendSystemPrompt: 'Be brief.' });
    const runs = h.runs();
    expect(runs.map((run) => run.argv.slice(0, 2))).toEqual([['--version'], ['auth', 'status'], ['-p', '--input-format']]);
    expect(runs[1]?.argv).toEqual(['auth', 'status', '--json']);
    expect(runs[2]?.argv).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--strict-mcp-config',
      '--mcp-config',
      MCP_CONFIG,
      '--tools',
      '',
      '--allowedTools',
      'mcp__firefox__*',
      '--permission-mode',
      'dontAsk',
      '--no-session-persistence',
      '--model=claude-haiku-5-5',
      '--append-system-prompt=Be brief.',
    ]);
    expect(realpathSync(runs[2]?.cwd ?? '')).toBe(realpathSync(h.workDir));
  });

  it('strips API credentials and provider switches from every claude run', async () => {
    const h = await harness({
      env: { ANTHROPIC_API_KEY: 'sk-x', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CODE_USE_BEDROCK: '1', KEEP_ME: 'yes' },
    });
    await started(h);
    for (const run of h.runs()) {
      expect(Object.keys(run.env)).not.toContain('ANTHROPIC_API_KEY');
      expect(Object.keys(run.env)).not.toContain('ANTHROPIC_AUTH_TOKEN');
      expect(Object.keys(run.env)).not.toContain('CLAUDE_CODE_USE_BEDROCK');
      expect(run.env['KEEP_ME']).toBe('yes');
    }
  });

  it('sends content blocks as the user message', async () => {
    const h = await harness();
    await started(h);
    h.handle({
      type: 'chat_send',
      sessionId: 's1',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } },
      ],
    });
    await waitFor(() => expect(eventTypes(h, 's1')).toContain('result/success'));
    expect(h.events('s1')[2]).toMatchObject({ event: { delta: { text: 'echo: look' } } });
  });

  it('queues messages sent while the session is starting', async () => {
    const h = await harness();
    h.handle({ type: 'chat_start', sessionId: 's1' });
    h.handle({ type: 'chat_send', sessionId: 's1', content: 'early' });
    await waitFor(() => expect(eventTypes(h, 's1')).toContain('result/success'));
    expect(h.events('s1')[2]).toMatchObject({ event: { delta: { text: 'echo: early' } } });
  });

  it('interrupts a running turn, which still ends with a result', async () => {
    const h = await harness();
    await started(h);
    h.handle({ type: 'chat_send', sessionId: 's1', content: 'hang' });
    await waitFor(() => expect(eventTypes(h, 's1')).toHaveLength(3));
    h.handle({ type: 'chat_interrupt', sessionId: 's1' });
    await waitFor(() => expect(eventTypes(h, 's1')).toContain('result/error_during_execution'));
    expect(eventTypes(h, 's1')).not.toContain('control_response');
  });

  it('answers control requests from claude with an error instead of forwarding them', async () => {
    const h = await harness();
    await started(h);
    h.handle({ type: 'chat_send', sessionId: 's1', content: 'ask' });
    await waitFor(() => expect(eventTypes(h, 's1')).toContain('system/fake_control_response'));
    expect(eventTypes(h, 's1')).not.toContain('control_request');
    const answer = h.events('s1').find((event) => event['subtype'] === 'fake_control_response');
    expect(answer?.['response']).toMatchObject({ subtype: 'error', request_id: 'cli-1' });
  });

  it('reduces an oversize event below the native messaging limit', async () => {
    const h = await harness();
    await started(h);
    h.handle({ type: 'chat_send', sessionId: 's1', content: 'big image' });
    await waitFor(() => expect(eventTypes(h, 's1')).toContain('result/success'));
    const user = h.of('s1', 'chat_event').find((message) => (message['event'] as { type: string }).type === 'user');
    expect(user?.['reduced']).toBe(true);
    expect(JSON.stringify(user)).toContain('[image omitted: too large to forward]');
    expect(Buffer.byteLength(JSON.stringify(user))).toBeLessThan(1024 * 1024);
  });

  it('closes a session by ending its input', async () => {
    const h = await harness();
    await started(h);
    h.handle({ type: 'chat_close', sessionId: 's1' });
    await waitFor(() => expect(h.of('s1', 'chat_closed')).toHaveLength(1));
    expect(h.of('s1', 'chat_error')).toEqual([]);
    expect(h.sessions.size()).toBe(0);
  });

  it.skipIf(isWindows)('kills a session that does not exit after its input ends', async () => {
    const h = await harness({ env: { FAKE_CLAUDE_MODE: 'stubborn' }, closeGraceMs: 100 });
    await started(h);
    h.handle({ type: 'chat_close', sessionId: 's1' });
    await within(
      waitFor(() => expect(h.of('s1', 'chat_closed')).toHaveLength(1)),
      3_000,
      'kill the stubborn session',
    );
    expect(h.of('s1', 'chat_error')).toEqual([]);
  });

  it('ignores messages and interrupts for a session that is closing', async () => {
    const h = await harness({ env: { FAKE_CLAUDE_MODE: 'stubborn' }, closeGraceMs: 100 });
    await started(h);
    h.handle({ type: 'chat_close', sessionId: 's1' });
    h.handle({ type: 'chat_send', sessionId: 's1', content: 'too late' });
    h.handle({ type: 'chat_interrupt', sessionId: 's1' });
    h.handle({ type: 'chat_close', sessionId: 's1' });
    await waitFor(() => expect(h.of('s1', 'chat_closed')).toHaveLength(1));
    expect(h.of('s1', 'chat_error')).toEqual([]);
    expect(eventTypes(h, 's1')).toEqual(['system/init']);
  });

  it('closes a session that is still starting at once', async () => {
    const h = await harness();
    h.handle({ type: 'chat_start', sessionId: 's1' });
    h.handle({ type: 'chat_close', sessionId: 's1' });
    expect(h.of('s1')).toEqual([{ type: 'chat_closed', sessionId: 's1' }]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(h.of('s1')).toEqual([{ type: 'chat_closed', sessionId: 's1' }]);
    expect(h.sessions.size()).toBe(0);
  });

  it('reports an unexpected exit with the stderr tail', async () => {
    const h = await harness({ env: { FAKE_CLAUDE_MODE: 'crash' } });
    h.handle({ type: 'chat_start', sessionId: 's1' });
    await waitFor(() => expect(h.of('s1', 'chat_closed')).toHaveLength(1));
    expect(h.of('s1', 'chat_error')).toEqual([
      { type: 'chat_error', sessionId: 's1', code: 'exited', message: expect.stringContaining('fatal: something broke') },
    ]);
    expect(h.of('s1', 'chat_error')[0]?.['message']).toContain('code 3');
  });

  it('refuses to start when Claude Code is not logged in', async () => {
    const h = await harness({ env: { FAKE_CLAUDE_LOGGED_IN: 'false' } });
    h.handle({ type: 'chat_start', sessionId: 's1' });
    await waitFor(() => expect(h.of('s1', 'chat_closed')).toHaveLength(1));
    expect(h.of('s1', 'chat_error')).toEqual([
      { type: 'chat_error', sessionId: 's1', code: 'not_logged_in', message: expect.any(String) },
    ]);
    expect(h.runs().map((run) => run.argv[0])).toEqual(['--version', 'auth']);
  });

  it('refuses a claude that is too old', async () => {
    const h = await harness({ env: { FAKE_CLAUDE_VERSION: '2.1.100 (Claude Code)' } });
    h.handle({ type: 'chat_start', sessionId: 's1' });
    await waitFor(() => expect(h.of('s1', 'chat_closed')).toHaveLength(1));
    expect(h.of('s1', 'chat_error')[0]).toMatchObject({ code: 'claude_too_old' });
  });

  it('reports a missing claude', async () => {
    const h = await harness({
      locate: () => {
        throw new ChatStartError('claude_not_found', 'Claude Code was not found');
      },
    });
    h.handle({ type: 'chat_start', sessionId: 's1' });
    await waitFor(() => expect(h.of('s1', 'chat_closed')).toHaveLength(1));
    expect(h.of('s1')).toEqual([
      { type: 'chat_error', sessionId: 's1', code: 'claude_not_found', message: 'Claude Code was not found' },
      { type: 'chat_closed', sessionId: 's1' },
    ]);
  });

  it('caps the number of concurrent sessions', async () => {
    const h = await harness();
    for (let i = 0; i < MAX_CHAT_SESSIONS; i++) h.handle({ type: 'chat_start', sessionId: `s${i}` });
    h.handle({ type: 'chat_start', sessionId: 'extra' });
    expect(h.of('extra')).toEqual([
      { type: 'chat_error', sessionId: 'extra', code: 'too_many_sessions', message: expect.any(String) },
      { type: 'chat_closed', sessionId: 'extra' },
    ]);
    expect(h.sessions.size()).toBe(MAX_CHAT_SESSIONS);
  });

  it('refuses a duplicate session id without touching the running session', async () => {
    const h = await harness();
    await started(h);
    h.handle({ type: 'chat_start', sessionId: 's1' });
    expect(h.of('s1', 'chat_error')).toEqual([
      { type: 'chat_error', sessionId: 's1', code: 'invalid_request', message: expect.stringContaining('already') },
    ]);
    expect(h.of('s1', 'chat_closed')).toEqual([]);
    h.handle({ type: 'chat_send', sessionId: 's1', content: 'still here' });
    await waitFor(() => expect(eventTypes(h, 's1')).toContain('result/success'));
  });

  it('answers requests for unknown sessions', async () => {
    const h = await harness();
    h.handle({ type: 'chat_send', sessionId: 'nope', content: 'x' });
    h.handle({ type: 'chat_interrupt', sessionId: 'nope' });
    h.handle({ type: 'chat_close', sessionId: 'nope' });
    expect(h.of('nope')).toEqual([
      { type: 'chat_error', sessionId: 'nope', code: 'unknown_session', message: expect.any(String) },
      { type: 'chat_error', sessionId: 'nope', code: 'unknown_session', message: expect.any(String) },
      { type: 'chat_closed', sessionId: 'nope' },
    ]);
  });

  it('closeAll ends every session without reporting errors', async () => {
    const h = await harness();
    await started(h, 'a');
    await started(h, 'b');
    h.sessions.closeAll();
    await waitFor(() => expect(h.sessions.size()).toBe(0));
    expect(h.of('a', 'chat_error')).toEqual([]);
    expect(h.of('b', 'chat_error')).toEqual([]);
  });

  it.skipIf(isWindows)('closeAll kills a session that ignores the end of its input and SIGTERM', async () => {
    const h = await harness({ env: { FAKE_CLAUDE_MODE: 'stubborn' }, closeGraceMs: 100 });
    await started(h);
    h.sessions.closeAll();
    await within(
      waitFor(() => expect(h.sessions.size()).toBe(0)),
      3_000,
      'kill the stubborn session',
    );
    expect(h.of('s1', 'chat_closed')).toEqual([]);
  });
});
