import { describe, isRecord, type ParseResult, parseTabId } from './navigation-input';
import { echo } from './read-page-input';

export const MAX_CODE_LENGTH = 100_000;
export const JAVASCRIPT_ACTION = 'javascript_exec';

export interface JavascriptArgs {
  text: string;
  tabId?: number;
}

const PARAMETERS = ['action', 'text', 'tabId'];

function parseCode(value: unknown): ParseResult<string> {
  if (value === undefined) return { ok: false, error: 'Missing required parameter text (the JavaScript code to run)' };
  if (typeof value !== 'string') return { ok: false, error: `text must be a string, received ${describe(value)}` };
  if (value.trim() === '') return { ok: false, error: 'text must not be empty' };
  if (value.length > MAX_CODE_LENGTH) {
    return { ok: false, error: `text must be at most ${MAX_CODE_LENGTH} characters, received ${value.length}` };
  }
  return { ok: true, value };
}

export function parseJavascriptArgs(args: unknown): ParseResult<JavascriptArgs> {
  if (!isRecord(args)) {
    return { ok: false, error: `Expected an object with action and text parameters, received ${describe(args)}` };
  }
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || PARAMETERS.includes(key)) continue;
    return { ok: false, error: `Unknown parameter ${echo(key)}; allowed: ${PARAMETERS.join(', ')}` };
  }
  if (args.action === undefined) return { ok: false, error: `Missing required parameter action: "${JAVASCRIPT_ACTION}"` };
  if (args.action !== JAVASCRIPT_ACTION) {
    return { ok: false, error: `action must be "${JAVASCRIPT_ACTION}", received ${echo(args.action)}` };
  }
  const text = parseCode(args.text);
  if (!text.ok) return text;
  const tabId = args.tabId === undefined ? undefined : parseTabId(args.tabId);
  if (tabId && !tabId.ok) return tabId;

  const value: JavascriptArgs = { text: text.value };
  if (tabId) value.tabId = tabId.value;
  return { ok: true, value };
}
