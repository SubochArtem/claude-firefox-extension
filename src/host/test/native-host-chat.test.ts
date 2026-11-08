import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLAUDE_PATH_ENV, chatWorkDir } from '../claude-cli';
import {
  childEnv,
  connectChatClient,
  connectClient,
  hostEnv,
  startHost,
  tempDir,
  textResult,
  waitFor,
  type FakeExtension,
} from './helpers';

const FAKE_CLAUDE = join(import.meta.dirname, 'fake-claude.mjs');

function chatMessages(host: FakeExtension, type: string): Record<string, unknown>[] {
  return (host.received as Record<string, unknown>[]).filter((message) => message['type'] === type);
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Firefox starts the host with a minimal environment, so the fake claude is found through the
// explicit path variable; a shell wrapper stands in for the claude executable.
async function hostWithFakeClaude(): Promise<{ host: FakeExtension; workDir: string; record: string }> {
  const dir = await tempDir();
  const runtimeDir = join(dir, 'run');
  const wrapper = join(dir, 'claude');
  const record = join(dir, 'runs.jsonl');
  writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_CLAUDE}' "$@"\n`);
  chmodSync(wrapper, 0o755);
  const overrides = { [CLAUDE_PATH_ENV]: wrapper, FAKE_CLAUDE_RECORD: record, HOME: dir, XDG_DATA_HOME: join(dir, 'data') };
  const env = childEnv(overrides, hostEnv(runtimeDir));
  mkdirSync(runtimeDir, { mode: 0o700 });
  const workDir = chatWorkDir(process.platform, overrides, dir);
  return { host: await startHost(runtimeDir, { env }), workDir, record };
}

interface ChatRun {
  argv: string[];
  pid: number;
  env: Record<string, string>;
}

function chatRuns(record: string): ChatRun[] {
  return readFileSync(record, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as ChatRun)
    .filter((run) => run.argv[0] === '-p');
}

async function startedSession(host: FakeExtension, record: string, sessionId: string): Promise<string> {
  host.send({ type: 'chat_start', sessionId });
  await waitFor(() => expect(chatRuns(record)).toHaveLength(Number(sessionId.slice(1))));
  return chatRuns(record).at(-1)?.env['CLAUDE_FIREFOX_CHAT_TOKEN'] ?? '';
}

describe.skipIf(process.platform === 'win32')('native host chat sessions', () => {
  it('runs a session through native messaging in the private working directory', async () => {
    const { host, workDir, record } = await hostWithFakeClaude();
    host.send({ type: 'chat_start', sessionId: 's1' });
    host.send({ type: 'chat_send', sessionId: 's1', content: 'hello' });
    await waitFor(() =>
      expect(chatMessages(host, 'chat_event').map((message) => (message['event'] as { type: string }).type)).toContain('result'),
    );
    const runs = readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { argv: string[]; cwd: string });
    const chat = runs.find((run) => run.argv[0] === '-p');
    expect(existsSync(workDir)).toBe(true);
    expect(realpathSync(chat?.cwd ?? '')).toBe(realpathSync(workDir));
    const config = JSON.parse(chat?.argv[chat.argv.indexOf('--mcp-config') + 1] ?? '{}') as {
      mcpServers: { firefox: { command: string; args: string[] } };
    };
    expect(config.mcpServers.firefox.command).toBe(process.execPath);
    expect(config.mcpServers.firefox.args.at(-1)).toBe('--mcp');
  });

  it('answers a malformed chat request that names a valid session id', async () => {
    const { host } = await hostWithFakeClaude();
    host.send({ type: 'chat_send', sessionId: 's1', content: 42 });
    host.send({ type: 'chat_send', sessionId: 'bad id!', content: 'x' });
    host.send({ type: 'ping' });
    await waitFor(() => expect(host.received).toContainEqual({ type: 'pong' }));
    await waitFor(() =>
      expect(chatMessages(host, 'chat_error')).toEqual([
        { type: 'chat_error', sessionId: 's1', code: 'invalid_request', message: 'The extension sent an invalid chat request' },
      ]),
    );
  });

  it('ends the sessions when the native port closes', async () => {
    const { host, record } = await hostWithFakeClaude();
    host.send({ type: 'chat_start', sessionId: 's1' });
    await waitFor(() => expect(chatMessages(host, 'chat_event')).not.toHaveLength(0));
    const runs = readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { argv: string[]; pid: number });
    const pid = runs.find((run) => run.argv[0] === '-p')?.pid;
    expect(pid).toBeTypeOf('number');
    expect(isRunning(pid ?? 0)).toBe(true);
    host.child.stdin.end();
    expect(await host.exited).toBe(0);
    await waitFor(() => expect(isRunning(pid ?? 0)).toBe(false));
  });
  it('tags the tool requests of a chat session client with its session id and leaves other clients untagged', async () => {
    const { host, record } = await hostWithFakeClaude();
    const first = await startedSession(host, record, 's1');
    const second = await startedSession(host, record, 's2');
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);

    const chat = await connectChatClient(host, second);
    chat.send({ type: 'tool_request', id: '1', tool: 'navigate', args: {}, approvalViaClient: true, chatSessionId: 's1' });
    expect(await host.nextRequest()).toEqual({
      type: 'tool_request',
      id: expect.stringMatching(/^\d+:1$/),
      tool: 'navigate',
      args: {},
      chatSessionId: 's2',
    });

    const normal = await connectClient(host);
    normal.send({ type: 'tool_request', id: '2', tool: 'navigate', args: {}, approvalViaClient: true, chatSessionId: 's1' });
    expect(await host.nextRequest()).toEqual({
      type: 'tool_request',
      id: expect.stringMatching(/^\d+:2$/),
      tool: 'navigate',
      args: {},
      approvalViaClient: true,
    });

    const unknown = await connectChatClient(host, '55'.repeat(32));
    unknown.send({ type: 'tool_request', id: '3', tool: 'navigate', args: {} });
    expect(await host.nextRequest()).toEqual({ type: 'tool_request', id: expect.stringMatching(/^\d+:3$/), tool: 'navigate', args: {} });
  });

  it('denies a permission request for a chat session call without asking its client', async () => {
    const { host, record } = await hostWithFakeClaude();
    const token = await startedSession(host, record, 's1');
    const chat = await connectChatClient(host, token);
    chat.send({ type: 'tool_request', id: '1', tool: 'navigate', args: {} });
    const request = await host.nextRequest();
    host.send({
      type: 'permission_request',
      requestId: 'req-1',
      callId: request['id'],
      host: 'example.com',
      tool: 'navigate',
      action: 'navigate',
      canIncludeSubdomains: true,
    });
    await waitFor(() =>
      expect(chatMessages(host, 'permission_response')).toEqual([
        { type: 'permission_response', requestId: 'req-1', answer: 'deny', includeSubdomains: false },
      ]),
    );
    host.send(textResult(request['id'], 'done'));
    expect(await chat.nextLine()).toEqual(textResult('1', 'done'));
    expect(chat.lines).toEqual([textResult('1', 'done')]);
  });

  it('treats the token of a closed session as unknown', async () => {
    const { host, record } = await hostWithFakeClaude();
    const token = await startedSession(host, record, 's1');
    const early = await connectChatClient(host, token);
    host.send({ type: 'chat_close', sessionId: 's1' });
    await waitFor(() => expect(chatMessages(host, 'chat_closed')).toHaveLength(1));

    const late = await connectChatClient(host, token);
    late.send({ type: 'tool_request', id: '1', tool: 'navigate', args: {} });
    expect(await host.nextRequest()).toEqual({ type: 'tool_request', id: expect.stringMatching(/^\d+:1$/), tool: 'navigate', args: {} });
    early.send({ type: 'tool_request', id: '2', tool: 'navigate', args: {} });
    expect(await host.nextRequest()).toEqual({ type: 'tool_request', id: expect.stringMatching(/^\d+:2$/), tool: 'navigate', args: {} });
  });
});
