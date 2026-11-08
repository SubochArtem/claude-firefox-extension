import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { posix, win32 } from 'node:path';
import { envValue, installPaths, type Env, type HostSource } from './install/paths';
import type { ChatErrorCode } from './protocol';

export const CLAUDE_PATH_ENV = 'CLAUDE_FIREFOX_CLAUDE_PATH';
const MIN_VERSION = [2, 1, 302] as const;
const CHECK_TIMEOUT_MS = 15_000;
const CHECK_MAX_OUTPUT_BYTES = 1024 * 1024;
// Only the user's Claude subscription may pay for the sidebar: these would switch Claude Code to an
// API key, a token or a cloud provider.
const DROPPED_ENV = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
const DROPPED_ENV_PREFIX = 'CLAUDE_CODE_USE_';
const SUBSCRIPTION_AUTH_METHOD = 'claude.ai';

export class ChatStartError extends Error {
  constructor(
    readonly code: ChatErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** The program to spawn and the arguments that come before claude's own. */
export interface ClaudeCommand {
  command: string;
  args: readonly string[];
}

export interface LocateOptions {
  platform: NodeJS.Platform;
  env: Env;
  home: string;
  isExecutable?: (path: string) => boolean;
}

function defaultIsExecutable(platform: NodeJS.Platform): (path: string) => boolean {
  return (path) => {
    try {
      if (!statSync(path).isFile()) return false;
      if (platform !== 'win32') accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
}

// Firefox starts native hosts with a minimal PATH, so the usual install locations are tried after it.
// Relative PATH entries would resolve against the host's working directory and are skipped. On
// Windows only claude.exe counts: npm's claude.cmd shim would need cmd.exe and its quoting rules.
export function locateClaude({ platform, env, home, isExecutable = defaultIsExecutable(platform) }: LocateOptions): ClaudeCommand {
  const path = platform === 'win32' ? win32 : posix;
  const explicit = envValue(env, CLAUDE_PATH_ENV);
  if (explicit !== undefined) {
    if (!path.isAbsolute(explicit)) {
      throw new ChatStartError('claude_not_found', `${CLAUDE_PATH_ENV} must be an absolute path, received "${explicit}".`);
    }
    if (platform === 'win32' && !explicit.toLowerCase().endsWith('.exe')) {
      throw new ChatStartError('claude_not_found', `${CLAUDE_PATH_ENV} must name claude.exe, received "${explicit}".`);
    }
    if (!isExecutable(explicit)) {
      throw new ChatStartError('claude_not_found', `${CLAUDE_PATH_ENV} points to ${explicit}, which is not an executable file.`);
    }
    return { command: explicit, args: [] };
  }
  const name = platform === 'win32' ? 'claude.exe' : 'claude';
  const pathEntries = (envValue(env, 'PATH') ?? '').split(platform === 'win32' ? ';' : ':');
  const candidates = pathEntries.filter((entry) => entry !== '' && path.isAbsolute(entry)).map((entry) => path.join(entry, name));
  if (platform === 'win32') {
    candidates.push(win32.join(envValue(env, 'USERPROFILE') ?? home, '.local', 'bin', name));
  } else {
    candidates.push(
      posix.join(home, '.local/bin/claude'),
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      '/usr/bin/claude',
    );
  }
  const found = candidates.find((candidate) => isExecutable(candidate));
  if (found !== undefined) return { command: found, args: [] };
  throw new ChatStartError(
    'claude_not_found',
    `Claude Code was not found. Looked in: ${[...new Set(candidates)].join(', ')}. Install Claude Code or set ${CLAUDE_PATH_ENV} in Firefox's environment to the claude executable.`,
  );
}

export function parseClaudeVersion(text: string): number[] | undefined {
  const match = /^\s*(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

export function isSupportedClaudeVersion(version: readonly number[]): boolean {
  for (let i = 0; i < MIN_VERSION.length; i++) {
    const part = version[i] ?? 0;
    if (part !== MIN_VERSION[i]) return part > MIN_VERSION[i]!;
  }
  return true;
}

export function claudeEnv(env: Env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    if (value === undefined || DROPPED_ENV.has(upper) || upper.startsWith(DROPPED_ENV_PREFIX)) continue;
    result[key] = value;
  }
  return result;
}

/** One MCP server, `firefox`, running this same host as the MCP server. */
export function mcpServerConfig(source: HostSource): string {
  const server =
    source.kind === 'binary'
      ? { type: 'stdio', command: source.executable, args: ['--mcp'] }
      : { type: 'stdio', command: source.nodePath, args: [source.entry, '--mcp'] };
  return JSON.stringify({ mcpServers: { firefox: server } });
}

// Never --bare: it skips the subscription login. The model and the prompt use the option=value form,
// so a value starting with '-' cannot be read as another option.
export function claudeChatArgs({
  mcpConfig,
  model,
  appendSystemPrompt,
}: {
  mcpConfig: string;
  model?: string;
  appendSystemPrompt?: string;
}): string[] {
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfig,
    '--tools',
    '',
    '--allowedTools',
    'mcp__firefox__*',
    '--permission-mode',
    'dontAsk',
    '--no-session-persistence',
  ];
  if (model !== undefined) args.push(`--model=${model}`);
  if (appendSystemPrompt !== undefined) args.push(`--append-system-prompt=${appendSystemPrompt}`);
  return args;
}

interface CommandOutput {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runClaude(claude: ClaudeCommand, args: string[], env: Record<string, string>): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    execFile(
      claude.command,
      [...claude.args, ...args],
      { env, timeout: CHECK_TIMEOUT_MS, maxBuffer: CHECK_MAX_OUTPUT_BYTES, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error && typeof error.code === 'string') {
          reject(new ChatStartError('spawn_failed', `Could not run ${claude.command} ${args.join(' ')}: ${error.message}`));
          return;
        }
        if (error?.killed) {
          reject(new ChatStartError('spawn_failed', `${claude.command} ${args.join(' ')} did not finish in time.`));
          return;
        }
        resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
      },
    );
  });
}

/** Checks the version and that Claude Code is logged in with the environment the session will get. */
export async function checkClaude(claude: ClaudeCommand, env: Env): Promise<void> {
  const childEnv = claudeEnv(env);
  const versionOutput = await runClaude(claude, ['--version'], childEnv);
  const version = parseClaudeVersion(versionOutput.stdout);
  const required = MIN_VERSION.join('.');
  if (!version) {
    throw new ChatStartError(
      'claude_too_old',
      `Could not read the Claude Code version from "${versionOutput.stdout.trim().slice(0, 200)}". Claude Code ${required} or newer is required.`,
    );
  }
  if (!isSupportedClaudeVersion(version)) {
    throw new ChatStartError(
      'claude_too_old',
      `Claude Code ${version.join('.')} is too old; ${required} or newer is required. Update it with "claude update".`,
    );
  }
  const auth = await runClaude(claude, ['auth', 'status', '--json'], childEnv);
  let subscription = false;
  try {
    const status: unknown = JSON.parse(auth.stdout);
    if (typeof status === 'object' && status !== null) {
      const { loggedIn, authMethod } = status as Record<string, unknown>;
      // Older CLIs do not report authMethod; their login is accepted as it is.
      subscription = loggedIn === true && (authMethod === undefined || authMethod === SUBSCRIPTION_AUTH_METHOD);
    }
  } catch {
    subscription = false;
  }
  if (!subscription) {
    throw new ChatStartError(
      'not_logged_in',
      'Claude Code is not logged in with a Claude subscription. Run "claude auth login" in a terminal, then start the chat again. API keys and cloud providers are not used for the sidebar.',
    );
  }
}

export function chatWorkDir(platform: NodeJS.Platform, env: Env, home: string): string {
  const { dir } = installPaths(platform, env, home);
  return platform === 'win32' ? win32.join(dir, 'chat') : posix.join(dir, 'chat');
}

// claude runs in an empty directory of its own, so no project's CLAUDE.md, settings or files are
// picked up. On Windows the directory inherits the hardened ACL of the install directory.
export async function prepareChatWorkDir(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return dir;
  const stats = await lstat(dir);
  const refuse = (reason: string): never => {
    throw new Error(`Refusing to use the chat working directory ${dir}: ${reason}`);
  };
  if (stats.isSymbolicLink()) refuse('it is a symbolic link');
  if (!stats.isDirectory()) refuse('it is not a directory');
  if (stats.uid !== userInfo().uid) refuse(`it is owned by uid ${stats.uid}, not by the current user`);
  if ((stats.mode & 0o077) !== 0) await chmod(dir, 0o700);
  return dir;
}
