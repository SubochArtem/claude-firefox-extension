import { READ_PAGE_ENTRY, READ_PAGE_SCRIPT, type ReadPageOptions, type ReadPageResult } from '../page/read-page-api';
import type { ApprovalPrompt } from '../permissions/approval';
import type { ContentBlock } from '../protocol';
import { readTabPage } from './page-script';
import { parseReadPageArgs } from './read-page-input';
import { ToolError } from './tool-error';

function isResult(value: unknown): value is ReadPageResult {
  if (typeof value !== 'object' || value === null) return false;
  const reply = value as Record<string, unknown>;
  if (reply.ok === false) return typeof reply.error === 'string';
  const viewport = reply.viewport as Record<string, unknown> | undefined;
  return (
    reply.ok === true &&
    typeof reply.tree === 'string' &&
    typeof viewport?.width === 'number' &&
    typeof viewport.height === 'number'
  );
}

function emptyTreeText(options: ReadPageOptions): string {
  return options.filter === 'interactive'
    ? 'No visible interactive elements found on the page. Try filter "all".'
    : 'No visible elements found on the page; it may be empty or still loading.';
}

export async function readPage(args: Record<string, unknown>, prompt: ApprovalPrompt): Promise<ContentBlock[]> {
  const parsed = parseReadPageArgs(args);
  if (!parsed.ok) throw new ToolError(`Invalid read_page arguments: ${parsed.error}`);
  const { tabId, ...options } = parsed.value;
  const result = await readTabPage('read_page', tabId, prompt, {
    entry: READ_PAGE_ENTRY,
    file: READ_PAGE_SCRIPT,
    options,
    isResult,
  });
  if (!result.ok) throw new ToolError(result.error);

  const tree = result.tree === '' ? emptyTreeText(options) : result.tree;
  return [{ type: 'text', text: `${tree}\n\nViewport: ${result.viewport.width}x${result.viewport.height}` }];
}
