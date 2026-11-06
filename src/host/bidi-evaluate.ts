import { BidiError, type BidiConnection } from './bidi-client';
import { DEFAULT_BIDI_SESSION_TIMEOUTS, runInMarkedTab, type BidiSessionTimeouts } from './bidi-session';
import { isRecord, type BidiEvaluateRequest } from './protocol';

export interface BidiEvaluateTimeouts extends BidiSessionTimeouts {
  // Shared by the first run and the async re-run of the code.
  script: number;
}

export const DEFAULT_BIDI_EVALUATE_TIMEOUTS: BidiEvaluateTimeouts = { ...DEFAULT_BIDI_SESSION_TIMEOUTS, script: 30_000 };

export const EVALUATE_SERIALIZATION = { maxObjectDepth: 4, maxDomDepth: 0, includeShadowTree: 'none' };
const MAX_EXCEPTION_CHARS = 10_000;
const MAX_STACK_FRAMES = 20;

// Top-level await and return are syntax errors in a script. A parse failure has no call frames, which
// tells it apart from a SyntaxError with the same text thrown at run time (eval, new Function).
const ASYNC_ONLY_SYNTAX = /^SyntaxError: (await is only valid in async functions|return not in function|illegal return statement)/i;

export type EvaluateOutcome = { value: unknown } | { exception: string };

export function asyncWrapped(code: string): string {
  // The newline before the closing brace keeps a trailing line comment from swallowing it.
  return `(async () => {\n${code}\n})()`;
}

function scriptTimeout(timeoutMs: number): BidiError {
  return new BidiError(
    `The script did not finish within ${timeoutMs / 1000} s. WebDriver BiDi cannot stop a running script, so it may still be running in the page.`,
  );
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function frameText(frame: unknown): string {
  const entry = isRecord(frame) ? frame : {};
  const name = typeof entry['functionName'] === 'string' && entry['functionName'] !== '' ? entry['functionName'] : '<anonymous>';
  const url = typeof entry['url'] === 'string' && entry['url'] !== '' ? entry['url'] : '<script>';
  const line = typeof entry['lineNumber'] === 'number' ? entry['lineNumber'] + 1 : 0;
  const column = typeof entry['columnNumber'] === 'number' ? entry['columnNumber'] + 1 : 0;
  return `    at ${name} (${url}:${line}:${column})`;
}

export function exceptionText(details: Record<string, unknown>): string {
  const text = typeof details['text'] === 'string' && details['text'] !== '' ? details['text'] : 'Uncaught exception';
  const stack = isRecord(details['stackTrace']) ? details['stackTrace']['callFrames'] : undefined;
  const frames = Array.isArray(stack) ? stack : [];
  const lines = [text, ...frames.slice(0, MAX_STACK_FRAMES).map(frameText)];
  if (frames.length > MAX_STACK_FRAMES) lines.push(`    … ${frames.length - MAX_STACK_FRAMES} more frames`);
  return clip(lines.join('\n'), MAX_EXCEPTION_CHARS);
}

function isAsyncOnlyParseError(details: Record<string, unknown>): boolean {
  const stack = isRecord(details['stackTrace']) ? details['stackTrace']['callFrames'] : undefined;
  return typeof details['text'] === 'string' && ASYNC_ONLY_SYNTAX.test(details['text']) && Array.isArray(stack) && stack.length === 0;
}

type EvaluateResult = { type: 'success'; value: unknown } | { type: 'exception'; details: Record<string, unknown> };

function parseResult(result: unknown): EvaluateResult {
  if (isRecord(result) && result['type'] === 'success' && 'result' in result) return { type: 'success', value: result['result'] };
  if (isRecord(result) && result['type'] === 'exception' && isRecord(result['exceptionDetails'])) {
    return { type: 'exception', details: result['exceptionDetails'] };
  }
  throw new BidiError('Firefox returned a malformed WebDriver BiDi script.evaluate result');
}

// script.evaluate has no timeout of its own and a running page script cannot be interrupted over
// WebDriver BiDi, so the host only stops waiting; session.end follows and the script may keep running.
async function evaluate(connection: BidiConnection, context: string, expression: string, deadline: number, limitMs: number) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(scriptTimeout(limitMs)), Math.max(0, deadline - Date.now()));
  });
  const command = connection.command(
    'script.evaluate',
    { expression, target: { context }, awaitPromise: true, resultOwnership: 'none', serializationOptions: EVALUATE_SERIALIZATION },
    limitMs + 60_000,
  );
  command.catch(() => undefined);
  try {
    return parseResult(await Promise.race([command, timeout]));
  } finally {
    clearTimeout(timer);
  }
}

// Runs the code as a script first, so the completion value of its last statement is the result; code
// that only parses inside an async function (top-level await or return) is run again wrapped in one.
export async function runBidiEvaluate(
  request: Pick<BidiEvaluateRequest, 'marker' | 'url' | 'code'>,
  port: number,
  timeouts: BidiEvaluateTimeouts = DEFAULT_BIDI_EVALUATE_TIMEOUTS,
  signal?: AbortSignal,
): Promise<EvaluateOutcome> {
  return runInMarkedTab(request, port, timeouts, signal, async (connection, context) => {
    const deadline = Date.now() + timeouts.script;
    let result = await evaluate(connection, context, request.code, deadline, timeouts.script);
    if (result.type === 'exception' && isAsyncOnlyParseError(result.details)) {
      result = await evaluate(connection, context, asyncWrapped(request.code), deadline, timeouts.script);
    }
    return result.type === 'success' ? { value: result.value } : { exception: exceptionText(result.details) };
  });
}
