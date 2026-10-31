import { FIND_ENTRY, type FindResult } from '../page/find-api';
import { READ_PAGE_SCRIPT } from '../page/read-page-api';
import type { ApprovalPrompt } from '../permissions/approval';
import type { ContentBlock } from '../protocol';
import { parseFindArgs } from './find-input';
import { readTabPage } from './page-script';
import { ToolError } from './tool-error';

function isResult(value: unknown): value is FindResult {
  if (typeof value !== 'object' || value === null) return false;
  const reply = value as Record<string, unknown>;
  if (reply.ok === false) return typeof reply.error === 'string';
  return reply.ok === true && typeof reply.text === 'string';
}

export async function findTool(args: Record<string, unknown>, prompt: ApprovalPrompt): Promise<ContentBlock[]> {
  const parsed = parseFindArgs(args);
  if (!parsed.ok) throw new ToolError(`Invalid find arguments: ${parsed.error}`);
  const { tabId, ...options } = parsed.value;
  // The find entry point lives in the read_page bundle, so refs from find work with read_page and back.
  const result = await readTabPage('find', tabId, prompt, {
    entry: FIND_ENTRY,
    file: READ_PAGE_SCRIPT,
    options,
    isResult,
  });
  if (!result.ok) throw new ToolError(result.error);
  return [{ type: 'text', text: result.text }];
}
