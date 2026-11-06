import {
  CONSOLE_ENTRY,
  CONSOLE_LEVELS,
  CONSOLE_SCRIPT,
  type ConsoleReadOptions,
  MAX_ENTRY_CHARS,
  type ConsoleReadResult,
} from '../page/console-capture-api';
import type { ApprovalPrompt } from '../permissions/approval';
import type { ContentBlock } from '../protocol';
import { parseConsoleArgs } from './console-input';
import { formatConsoleReport } from './console-output';
import { trackConsole } from './console-tracking';
import { isRecord } from './navigation-input';
import { openTabPage, type PageAccess, type PageScript, runOnTabPage } from './page-script';
import { ToolError } from './tool-error';

const TOOL = 'read_console_messages';

export function consolePageChangedMessage(tool: string, tabId: number, host: string): string {
  return `Cannot read console messages of tab ${tabId}: the page navigated away from ${host} to another site, so nothing was read. Call ${tool} again to read the console of the tab's current page; a page on another site needs its own permission.`;
}

export const CONSOLE_ACCESS: PageAccess = {
  action: 'read_console_messages',
  label: { verb: 'read console messages', target: 'read console messages of' },
  pageChanged: consolePageChangedMessage,
};

// The capture clips text to MAX_ENTRY_CHARS plus an ellipsis; longer text means the page replaced the entry point.
function isEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    (CONSOLE_LEVELS as readonly unknown[]).includes(value.level) &&
    typeof value.text === 'string' &&
    value.text.length <= MAX_ENTRY_CHARS + 1 &&
    typeof value.time === 'number' &&
    typeof value.url === 'string'
  );
}

function isReadResult(limit: number) {
  return (value: unknown): value is ConsoleReadResult =>
    isRecord(value) &&
    value.ok === true &&
    Array.isArray(value.entries) &&
    value.entries.length <= limit &&
    value.entries.every(isEntry) &&
    [value.matched, value.total, value.dropped, value.since].every((count) => typeof count === 'number');
}

function consoleScript(options: ConsoleReadOptions): PageScript<ConsoleReadOptions, ConsoleReadResult> {
  return { entry: CONSOLE_ENTRY, file: CONSOLE_SCRIPT, options, isResult: isReadResult(options.limit), world: 'MAIN' };
}

export async function readConsoleMessages(args: Record<string, unknown>, prompt: ApprovalPrompt): Promise<ContentBlock[]> {
  const parsed = parseConsoleArgs(args);
  if (!parsed.ok) throw new ToolError(`Invalid read_console_messages arguments: ${parsed.error}`);
  const { tabId, ...options } = parsed.value;
  const tab = await openTabPage(TOOL, tabId, prompt, CONSOLE_ACCESS);
  const started = await trackConsole(tab.tabId, tab.url);
  const result = await runOnTabPage(TOOL, tab, consoleScript(options), CONSOLE_ACCESS);
  return [{ type: 'text', text: formatConsoleReport({ tabId: tab.tabId, url: tab.url, started, args: parsed.value, result }) }];
}
