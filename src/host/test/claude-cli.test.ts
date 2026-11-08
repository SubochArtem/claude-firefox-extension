import { chmodSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_PATH_ENV,
  ChatStartError,
  chatWorkDir,
  checkClaude,
  claudeChatArgs,
  claudeEnv,
  isSupportedClaudeVersion,
  locateClaude,
  mcpServerConfig,
  parseClaudeVersion,
  prepareChatWorkDir,
} from '../claude-cli';
import { tempDir } from './helpers';

const isWindows = process.platform === 'win32';
const FAKE_CLAUDE = join(import.meta.dirname, 'fake-claude.mjs');
const fakeCommand = { command: process.execPath, args: [FAKE_CLAUDE] };

function locateWith(platform: NodeJS.Platform, env: Record<string, string>, existing: string[], home = '/home/u') {
  const files = new Set(existing);
  return locateClaude({ platform, env, home, isExecutable: (path) => files.has(path) });
}

function startError(run: () => unknown): ChatStartError {
  try {
    run();
  } catch (error) {
    if (error instanceof ChatStartError) return error;
    throw error;
  }
  throw new Error('expected a ChatStartError');
}

async function startErrorOf(promise: Promise<unknown>): Promise<ChatStartError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ChatStartError) return error;
    throw error;
  }
  throw new Error('expected a ChatStartError');
}

describe('locateClaude', () => {
  it('prefers the explicit path from the environment', () => {
    const env = { [CLAUDE_PATH_ENV]: '/opt/claude/bin/claude', PATH: '/usr/bin' };
    expect(locateWith('linux', env, ['/opt/claude/bin/claude', '/usr/bin/claude'])).toEqual({
      command: '/opt/claude/bin/claude',
      args: [],
    });
  });

  it('refuses an explicit path that is not an executable instead of searching further', () => {
    const env = { [CLAUDE_PATH_ENV]: '/nowhere/claude', PATH: '/usr/bin' };
    const error = startError(() => locateWith('linux', env, ['/usr/bin/claude']));
    expect(error.code).toBe('claude_not_found');
    expect(error.message).toContain('/nowhere/claude');
  });

  it('refuses a relative explicit path', () => {
    const error = startError(() => locateWith('linux', { [CLAUDE_PATH_ENV]: 'bin/claude' }, ['bin/claude']));
    expect(error.code).toBe('claude_not_found');
    expect(error.message).toContain('absolute');
  });

  it('searches PATH in order and skips relative entries', () => {
    const env = { PATH: 'bin:/a:/b' };
    expect(locateWith('linux', env, ['bin/claude', '/b/claude', '/a/claude']).command).toBe('/a/claude');
    expect(locateWith('linux', env, ['bin/claude', '/b/claude']).command).toBe('/b/claude');
  });

  it('falls back to the known install locations when PATH is minimal', () => {
    const env = { PATH: '/usr/bin:/bin' };
    expect(locateWith('linux', env, ['/home/u/.local/bin/claude', '/usr/local/bin/claude']).command).toBe(
      '/home/u/.local/bin/claude',
    );
    expect(locateWith('darwin', env, ['/opt/homebrew/bin/claude']).command).toBe('/opt/homebrew/bin/claude');
    expect(locateWith('linux', {}, ['/usr/bin/claude']).command).toBe('/usr/bin/claude');
  });

  it('reports every place it looked when claude is missing', () => {
    const error = startError(() => locateWith('linux', { PATH: '/x' }, []));
    expect(error.code).toBe('claude_not_found');
    expect(error.message).toContain('/x/claude');
    expect(error.message).toContain('/home/u/.local/bin/claude');
    expect(error.message).toContain(CLAUDE_PATH_ENV);
  });

  it('looks only for claude.exe on Windows, with a case-insensitive Path', () => {
    const home = 'C:\\Users\\u';
    const env = { Path: 'C:\\npm;C:\\tools', USERPROFILE: home };
    expect(locateWith('win32', env, ['C:\\npm\\claude.cmd', 'C:\\tools\\claude.exe'], home).command).toBe('C:\\tools\\claude.exe');
    expect(locateWith('win32', env, ['C:\\npm\\claude.cmd', win32.join(home, '.local', 'bin', 'claude.exe')], home).command).toBe(
      'C:\\Users\\u\\.local\\bin\\claude.exe',
    );
  });

  it('refuses a .cmd shim as the explicit path on Windows', () => {
    const env = { [CLAUDE_PATH_ENV]: 'C:\\npm\\claude.cmd' };
    const error = startError(() => locateWith('win32', env, ['C:\\npm\\claude.cmd'], 'C:\\Users\\u'));
    expect(error.code).toBe('claude_not_found');
    expect(error.message).toContain('claude.exe');
  });

  it.skipIf(isWindows)('checks the executable bit by default', async () => {
    const dir = await tempDir();
    const plain = posix.join(dir, 'plain');
    const runnable = posix.join(dir, 'runnable');
    mkdirSync(plain);
    mkdirSync(runnable);
    writeFileSync(posix.join(plain, 'claude'), '#!/bin/sh\n');
    writeFileSync(posix.join(runnable, 'claude'), '#!/bin/sh\n');
    chmodSync(posix.join(runnable, 'claude'), 0o755);
    mkdirSync(posix.join(dir, 'dir', 'claude'), { recursive: true });
    const env = { PATH: `${plain}:${posix.join(dir, 'dir')}:${runnable}` };
    expect(locateClaude({ platform: 'linux', env, home: dir }).command).toBe(posix.join(runnable, 'claude'));
  });
});

describe('claude version', () => {
  it('parses the --version output', () => {
    expect(parseClaudeVersion('2.1.316 (Claude Code)\n')).toEqual([2, 1, 316]);
    expect(parseClaudeVersion('  10.0.1\n')).toEqual([10, 0, 1]);
    expect(parseClaudeVersion('Claude Code')).toBeUndefined();
    expect(parseClaudeVersion('')).toBeUndefined();
  });

  it('requires at least 2.1.302', () => {
    expect(isSupportedClaudeVersion([2, 1, 302])).toBe(true);
    expect(isSupportedClaudeVersion([2, 1, 316])).toBe(true);
    expect(isSupportedClaudeVersion([2, 2, 0])).toBe(true);
    expect(isSupportedClaudeVersion([3, 0, 0])).toBe(true);
    expect(isSupportedClaudeVersion([2, 1, 301])).toBe(false);
    expect(isSupportedClaudeVersion([2, 0, 999])).toBe(false);
    expect(isSupportedClaudeVersion([1, 9, 999])).toBe(false);
  });
});

describe('claudeEnv', () => {
  it('drops API credentials and provider switches and keeps the rest', () => {
    const env = claudeEnv({
      HOME: '/home/u',
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-1',
      anthropic_auth_token: 'tok',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      Claude_Code_Use_Foundry: '1',
      CLAUDE_CODE_OTHER: 'kept',
      ANTHROPIC_MODEL: 'kept',
      CLAUDE_FIREFOX_CHAT_TOKEN: 'inherited',
      EMPTY: undefined,
    });
    expect(env).toEqual({ HOME: '/home/u', PATH: '/usr/bin', CLAUDE_CODE_OTHER: 'kept', ANTHROPIC_MODEL: 'kept' });
  });
});

describe('claude chat arguments', () => {
  // The session token stays off every command line: claude expands the reference from its own environment.
  const TOKEN_ENV = { CLAUDE_FIREFOX_CHAT_TOKEN: '${CLAUDE_FIREFOX_CHAT_TOKEN}' };

  it('runs the binary itself as the MCP server', () => {
    expect(JSON.parse(mcpServerConfig({ kind: 'binary', executable: '/x/claude-firefox-host' }))).toEqual({
      mcpServers: { firefox: { type: 'stdio', command: '/x/claude-firefox-host', args: ['--mcp'], env: TOKEN_ENV } },
    });
  });

  it('runs a development build with node', () => {
    expect(JSON.parse(mcpServerConfig({ kind: 'node', nodePath: '/usr/bin/node', entry: '/src/dist/host/index.js' }))).toEqual({
      mcpServers: { firefox: { type: 'stdio', command: '/usr/bin/node', args: ['/src/dist/host/index.js', '--mcp'], env: TOKEN_ENV } },
    });
  });

  it('builds the stream-json argv with only the firefox tools', () => {
    const args = claudeChatArgs({ mcpConfig: '{"mcpServers":{}}' });
    expect(args).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--tools',
      '',
      '--allowedTools',
      'mcp__firefox__*',
      '--permission-mode',
      'dontAsk',
      '--no-session-persistence',
    ]);
    expect(args).not.toContain('--bare');
  });

  it('passes the model and the appended system prompt as single option=value arguments', () => {
    const args = claudeChatArgs({ mcpConfig: '{}', model: 'claude-opus-5-5', appendSystemPrompt: '- starts with a dash' });
    expect(args.slice(-2)).toEqual(['--model=claude-opus-5-5', '--append-system-prompt=- starts with a dash']);
  });
});

describe('checkClaude', () => {
  it('passes a supported, logged-in claude', async () => {
    await expect(checkClaude(fakeCommand, { ...process.env })).resolves.toBeUndefined();
  });

  it('refuses a claude older than 2.1.302', async () => {
    const error = await startErrorOf(checkClaude(fakeCommand, { ...process.env, FAKE_CLAUDE_VERSION: '2.1.301 (Claude Code)' }));
    expect(error.code).toBe('claude_too_old');
    expect(error.message).toContain('2.1.301');
    expect(error.message).toContain('2.1.302');
  });

  it('refuses an unreadable version', async () => {
    const error = await startErrorOf(checkClaude(fakeCommand, { ...process.env, FAKE_CLAUDE_VERSION: 'nonsense' }));
    expect(error.code).toBe('claude_too_old');
  });

  it('refuses when Claude Code is not logged in', async () => {
    const error = await startErrorOf(checkClaude(fakeCommand, { ...process.env, FAKE_CLAUDE_LOGGED_IN: 'false' }));
    expect(error.code).toBe('not_logged_in');
    expect(error.message).toContain('claude auth login');
  });

  it.each(['apiKey', 'oauth_token', 'third_party'])('refuses a login with the auth method %s', async (authMethod) => {
    const error = await startErrorOf(checkClaude(fakeCommand, { ...process.env, FAKE_CLAUDE_AUTH_METHOD: authMethod }));
    expect(error.code).toBe('not_logged_in');
  });

  it('accepts a login without an auth method from an older claude', async () => {
    await expect(checkClaude(fakeCommand, { ...process.env, FAKE_CLAUDE_AUTH_METHOD: 'absent' })).resolves.toBeUndefined();
  });

  it('reports a command that cannot be started', async () => {
    const error = await startErrorOf(checkClaude({ command: join(await tempDir(), 'missing'), args: [] }, { ...process.env }));
    expect(error.code).toBe('spawn_failed');
  });
});

describe('chat working directory', () => {
  it('lives in the per-user install directory', () => {
    expect(chatWorkDir('linux', { XDG_DATA_HOME: '/d' }, '/home/u')).toBe('/d/claude-firefox-extension/chat');
    expect(chatWorkDir('darwin', {}, '/Users/u')).toBe('/Users/u/Library/Application Support/claude-firefox-extension/chat');
    expect(chatWorkDir('win32', { LOCALAPPDATA: 'C:\\L' }, 'C:\\Users\\u')).toBe('C:\\L\\claude-firefox-extension\\chat');
  });

  it('is created and kept private', async () => {
    const dir = join(await tempDir(), 'app', 'chat');
    expect(await prepareChatWorkDir(dir)).toBe(dir);
    expect(statSync(dir).isDirectory()).toBe(true);
    if (!isWindows) {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      chmodSync(dir, 0o755);
      await prepareChatWorkDir(dir);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
  });

  it.skipIf(isWindows)('refuses a symbolic link', async () => {
    const base = await tempDir();
    mkdirSync(join(base, 'real'));
    symlinkSync(join(base, 'real'), join(base, 'chat'));
    await expect(prepareChatWorkDir(join(base, 'chat'))).rejects.toThrow(/symbolic link/);
  });
});
