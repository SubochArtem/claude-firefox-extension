import {
  BIDI_COMMAND_TIMEOUT_MS,
  BIDI_CONNECT_TIMEOUT_MS,
  BidiCommandError,
  BidiError,
  type BidiConnection,
  connectBidi,
} from './bidi-client';
import { isRecord, type BidiInputRequest, type TabMarker } from './protocol';

const LOG = '[bidi-input]';

export interface BidiInputTimeouts {
  connect: number;
  command: number;
  evaluate: number;
  actions: number;
}

export const DEFAULT_BIDI_INPUT_TIMEOUTS: BidiInputTimeouts = {
  connect: BIDI_CONNECT_TIMEOUT_MS,
  command: BIDI_COMMAND_TIMEOUT_MS,
  evaluate: 3_000,
  actions: 20_000,
};

// Cleanup after an abort must fit in the host's shutdown wait.
export const BIDI_ABORT_CLEANUP_TIMEOUT_MS = 1_000;

interface TopContext {
  context: string;
  url: string;
}

function sessionFailure(error: unknown): BidiError {
  if (!(error instanceof BidiCommandError)) return error instanceof BidiError ? error : new BidiError(String(error));
  return new BidiError(
    `Firefox refused a new WebDriver BiDi session (${error.code}${error.detail ? `: ${error.detail}` : ''}). Firefox allows one WebDriver session at a time, so another WebDriver BiDi or Marionette client is probably connected (test automation such as Selenium, geckodriver, Playwright or Puppeteer). Close it and try again.`,
  );
}

function parseTree(result: unknown): TopContext[] {
  const contexts = isRecord(result) ? result['contexts'] : undefined;
  if (!Array.isArray(contexts)) throw new BidiError('Firefox returned a malformed WebDriver BiDi browsing context tree');
  return contexts.flatMap((entry) =>
    isRecord(entry) && typeof entry['context'] === 'string'
      ? [{ context: entry['context'], url: typeof entry['url'] === 'string' ? entry['url'] : '' }]
      : [],
  );
}

function markerExpression(marker: TabMarker): string {
  return `window[${JSON.stringify(marker.name)}] === ${JSON.stringify(marker.value)}`;
}

function isTrue(result: unknown): boolean {
  if (!isRecord(result) || result['type'] !== 'success') return false;
  const value = result['result'];
  return isRecord(value) && value['type'] === 'boolean' && value['value'] === true;
}

async function markedContexts(
  connection: BidiConnection,
  contexts: TopContext[],
  marker: TabMarker,
  timeoutMs: number,
): Promise<{ matches: string[]; failures: number }> {
  const expression = markerExpression(marker);
  const results = await Promise.all(
    contexts.map(({ context }) =>
      connection
        .command('script.evaluate', { expression, target: { context }, awaitPromise: false, resultOwnership: 'none' }, timeoutMs)
        .then(
          (result) => ({ context, matched: isTrue(result), failed: false }),
          () => ({ context, matched: false, failed: true }),
        ),
    ),
  );
  return {
    matches: results.filter((result) => result.matched).map((result) => result.context),
    failures: results.filter((result) => result.failed).length,
  };
}

// BiDi context ids are unrelated to tabs.Tab.id. The marker is set in the page's main world because
// script.evaluate without a sandbox runs there; an isolated-world expando would be invisible to it.
// Only contexts showing the tab's URL are checked, so a page that copies the marker elsewhere can only
// redirect input into another window with the same URL, which is within the same site permission.
export async function findMarkedContext(
  connection: BidiConnection,
  marker: TabMarker,
  url: string,
  timeouts: BidiInputTimeouts = DEFAULT_BIDI_INPUT_TIMEOUTS,
): Promise<string> {
  const contexts = parseTree(await connection.command('browsingContext.getTree', { maxDepth: 0 }, timeouts.command));
  const candidates = contexts.filter((context) => context.url === url);
  if (candidates.length === 0) {
    throw new BidiError(
      "Could not find the tab in WebDriver BiDi: no top-level browsing context shows the tab's URL. The tab may have navigated or closed; try again.",
    );
  }
  const { matches, failures } = await markedContexts(connection, candidates, marker, timeouts.evaluate);
  if (matches.length === 1 && matches[0] !== undefined) return matches[0];
  if (matches.length > 1) {
    throw new BidiError(
      `Could not identify the tab in WebDriver BiDi: ${matches.length} browsing contexts carry the tab's marker. Try again.`,
    );
  }
  const unanswered = failures > 0 ? ` (${failures} of ${candidates.length} checked contexts did not answer)` : '';
  throw new BidiError(
    `Could not find the tab in WebDriver BiDi: no browsing context carries the tab's marker${unanswered}. The tab may have navigated or closed; try again.`,
  );
}

async function cleanUp(connection: BidiConnection, method: string, params: Record<string, unknown>, timeoutMs: number) {
  try {
    await connection.command(method, params, timeoutMs);
  } catch (error) {
    console.error(`${LOG} ${method} failed:`, error instanceof Error ? error.message : String(error));
  }
}

function abortError(): BidiError {
  return new BidiError('The input request was stopped because the native host is shutting down');
}

// Only one WebDriver BiDi session may exist at a time, and a connection closed without session.end
// leaves Firefox unable to start another session until it restarts, so every request runs in its own
// short session that is always ended before the socket closes. An abort rejects the command in flight
// without closing the socket, so the cleanup still runs.
export async function runBidiInput(
  request: Pick<BidiInputRequest, 'marker' | 'url' | 'actions'>,
  port: number,
  timeouts: BidiInputTimeouts = DEFAULT_BIDI_INPUT_TIMEOUTS,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw abortError();
  const connection = await connectBidi(port, timeouts.connect);
  const onAbort = () => connection.cancelPending(abortError());
  signal?.addEventListener('abort', onAbort, { once: true });
  const checkAborted = () => {
    if (signal?.aborted) throw abortError();
  };
  let sessionMayExist = false;
  let context: string | undefined;
  try {
    checkAborted();
    sessionMayExist = true;
    try {
      await connection.command('session.new', { capabilities: {} }, timeouts.command);
    } catch (error) {
      if (error instanceof BidiCommandError) sessionMayExist = false;
      if (signal?.aborted) throw abortError();
      throw sessionFailure(error);
    }
    checkAborted();
    context = await findMarkedContext(connection, request.marker, request.url, timeouts);
    checkAborted();
    await connection.command('input.performActions', { context, actions: request.actions }, timeouts.actions);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    const cleanupMs = signal?.aborted ? Math.min(timeouts.command, BIDI_ABORT_CLEANUP_TIMEOUT_MS) : timeouts.command;
    if (context !== undefined) await cleanUp(connection, 'input.releaseActions', { context }, cleanupMs);
    if (sessionMayExist) await cleanUp(connection, 'session.end', {}, cleanupMs);
    connection.close();
  }
}

export interface SerialQueueLimits {
  // Tasks queued or running; a task beyond it is refused at once.
  maxLength: number;
  // A task that waited longer than this is skipped when its turn comes.
  maxWaitMs: number;
}

export interface SerialQueue {
  run<T>(task: () => Promise<T>): Promise<T>;
}

export function createSerialQueue(
  limits: SerialQueueLimits = { maxLength: Number.POSITIVE_INFINITY, maxWaitMs: Number.POSITIVE_INFINITY },
): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  let length = 0;
  return {
    run(task) {
      if (length >= limits.maxLength) {
        return Promise.reject(
          new BidiError(`Too many input requests are waiting for WebDriver BiDi (${length}). Wait for them to finish and try again.`),
        );
      }
      length++;
      const queuedAt = Date.now();
      const start = () => {
        if (Date.now() - queuedAt > limits.maxWaitMs) {
          return Promise.reject(
            new BidiError('The input request waited too long for WebDriver BiDi behind other input requests. Try again.'),
          );
        }
        return task();
      };
      const result = tail.then(start, start).finally(() => {
        length--;
      });
      tail = result.catch(() => undefined);
      return result;
    },
  };
}
