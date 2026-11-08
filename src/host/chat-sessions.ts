import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chatEventMessage, createLineReader, parseClaudeLine } from './chat-events';
import { ChatStartError, checkClaude, claudeChatArgs, claudeEnv, type ClaudeCommand } from './claude-cli';
import type { Env } from './install/paths';
import type { ChatContentBlock, ChatErrorCode, ChatRequest, ChatStart, HostToExtensionMessage } from './protocol';

const LOG = '[chat]';
export const MAX_CHAT_SESSIONS = 4;
const CLOSE_GRACE_MS = 3_000;
const STDERR_TAIL_CHARS = 2_000;

export interface ChatSessionsOptions {
  send: (message: HostToExtensionMessage) => void;
  /** Throws ChatStartError when claude cannot be found. */
  locate: () => ClaudeCommand;
  env: Env;
  workDir: () => Promise<string>;
  mcpConfig: string;
  /** How long a closed session may take to exit after its input ends, and again after SIGTERM. */
  closeGraceMs?: number;
}

export interface ChatSessions {
  handle: (request: ChatRequest) => void;
  /** Ends every session without further messages to the extension (the native port is gone). */
  closeAll: () => void;
  /** Kills every session process at once; safe in a process 'exit' handler. */
  killAll: () => void;
  size: () => number;
}

interface Session {
  id: string;
  child?: ChildProcessWithoutNullStreams;
  queued: string[];
  closing: boolean;
  finished: boolean;
  stderrTail: string;
  nextControlId: number;
  killTimer?: NodeJS.Timeout;
}

function userLine(content: string | ChatContentBlock[]): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null })}\n`;
}

export function createChatSessions(options: ChatSessionsOptions): ChatSessions {
  const { send, locate, env, workDir, mcpConfig, closeGraceMs = CLOSE_GRACE_MS } = options;
  const sessions = new Map<string, Session>();
  let silent = false;

  const emit = (message: HostToExtensionMessage): void => {
    if (!silent) send(message);
  };
  const error = (sessionId: string, code: ChatErrorCode, message: string): void => {
    emit({ type: 'chat_error', sessionId, code, message });
  };

  // Every session that was accepted ends here exactly once.
  const finish = (session: Session): void => {
    if (session.finished) return;
    session.finished = true;
    clearTimeout(session.killTimer);
    if (sessions.get(session.id) === session) sessions.delete(session.id);
    emit({ type: 'chat_closed', sessionId: session.id });
  };

  const write = (session: Session, line: string): void => {
    if (session.child) session.child.stdin.write(line);
    else session.queued.push(line);
  };

  const handleEvent = (session: Session, event: Record<string, unknown>): void => {
    // Interrupt acknowledgements belong to the host. With --permission-mode dontAsk claude should
    // never ask, but a request left unanswered would hang the turn, so it is refused.
    if (event['type'] === 'control_response') return;
    if (event['type'] === 'control_request') {
      const requestId = event['request_id'];
      console.error(`${LOG} session ${session.id}: refused a control request from claude`);
      if (typeof requestId === 'string') {
        write(session, `${JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: 'Not supported by the Firefox sidebar' } })}\n`);
      }
      return;
    }
    emit(chatEventMessage(session.id, event));
  };

  const spawnSession = (session: Session, claude: ClaudeCommand, cwd: string, request: ChatStart): void => {
    const args = claudeChatArgs({
      mcpConfig,
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.appendSystemPrompt === undefined ? {} : { appendSystemPrompt: request.appendSystemPrompt }),
    });
    const child = spawn(claude.command, [...claude.args, ...args], { cwd, env: claudeEnv(env), windowsHide: true });
    session.child = child;
    child.stdin.on('error', (cause) => console.error(`${LOG} session ${session.id} stdin error: ${cause.message}`));
    const read = createLineReader((line) => {
      const event = parseClaudeLine(line);
      if (event) handleEvent(session, event);
    });
    child.stdout.on('data', read);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      session.stderrTail = (session.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.on('error', (cause) => {
      if (session.finished) return;
      if (child.pid === undefined) {
        error(session.id, 'spawn_failed', `Could not start ${claude.command}: ${cause.message}`);
        finish(session);
      } else {
        console.error(`${LOG} session ${session.id} process error: ${cause.message}`);
      }
    });
    child.on('close', (code, signal) => {
      if (session.finished) return;
      if (!session.closing) {
        const status = signal === null ? `code ${String(code)}` : `signal ${signal}`;
        const tail = session.stderrTail.trim();
        error(session.id, 'exited', `Claude Code exited unexpectedly (${status})${tail === '' ? '.' : `:\n${tail}`}`);
      }
      finish(session);
    });
    for (const line of session.queued.splice(0)) child.stdin.write(line);
    if (session.closing) child.stdin.end();
  };

  const start = async (session: Session, request: ChatStart): Promise<void> => {
    try {
      const claude = locate();
      await checkClaude(claude, env);
      const cwd = await workDir();
      if (session.finished) return;
      spawnSession(session, claude, cwd, request);
    } catch (cause) {
      if (session.finished) return;
      if (cause instanceof ChatStartError) error(session.id, cause.code, cause.message);
      else error(session.id, 'spawn_failed', `Could not start Claude Code: ${cause instanceof Error ? cause.message : String(cause)}`);
      finish(session);
    }
  };

  const killLater = (session: Session, child: ChildProcessWithoutNullStreams): void => {
    session.killTimer = setTimeout(() => {
      child.kill('SIGTERM');
      session.killTimer = setTimeout(() => child.kill('SIGKILL'), closeGraceMs);
      session.killTimer.unref();
    }, closeGraceMs);
    session.killTimer.unref();
  };

  const handle = (request: ChatRequest): void => {
    const { sessionId } = request;
    const session = sessions.get(sessionId);
    if (request.type === 'chat_start') {
      if (session) {
        error(sessionId, 'invalid_request', `Chat session ${sessionId} already exists`);
        return;
      }
      if (sessions.size >= MAX_CHAT_SESSIONS) {
        error(sessionId, 'too_many_sessions', `At most ${MAX_CHAT_SESSIONS} chat sessions can run at once`);
        emit({ type: 'chat_closed', sessionId });
        return;
      }
      const created: Session = { id: sessionId, queued: [], closing: false, finished: false, stderrTail: '', nextControlId: 1 };
      sessions.set(sessionId, created);
      void start(created, request);
      return;
    }
    if (!session) {
      if (request.type === 'chat_close') emit({ type: 'chat_closed', sessionId });
      else error(sessionId, 'unknown_session', `There is no chat session ${sessionId}`);
      return;
    }
    if (request.type === 'chat_send') {
      write(session, userLine(request.content));
      return;
    }
    if (request.type === 'chat_interrupt') {
      // A turn can only run once the process exists; queued messages have not started one yet.
      if (!session.child) return;
      const requestId = `interrupt-${session.nextControlId++}`;
      write(session, `${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } })}\n`);
      return;
    }
    if (session.closing) return;
    session.closing = true;
    const { child } = session;
    if (!child) {
      finish(session);
      return;
    }
    child.stdin.end();
    killLater(session, child);
  };

  return {
    handle,
    closeAll: () => {
      silent = true;
      for (const session of sessions.values()) {
        session.closing = true;
        if (!session.child) {
          finish(session);
          continue;
        }
        session.child.stdin.end();
        session.child.kill('SIGTERM');
      }
    },
    killAll: () => {
      silent = true;
      for (const session of sessions.values()) {
        session.closing = true;
        if (session.child) session.child.kill('SIGKILL');
        else finish(session);
      }
    },
    size: () => sessions.size,
  };
}
