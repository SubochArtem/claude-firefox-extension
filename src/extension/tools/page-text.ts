import { collapseWhitespace } from '../page/accessible-name';
import { PAGE_TEXT_ENTRY, PAGE_TEXT_SCRIPT, type PageTextResult } from '../page/page-text-api';
import type { ApprovalPrompt } from '../permissions/approval';
import type { ContentBlock } from '../protocol';
import { readTabPage } from './page-script';
import { parsePageTextArgs } from './page-text-input';
import { ToolError } from './tool-error';

const MAX_TITLE_LENGTH = 200;

function clipTitle(raw: string): string {
  const title = collapseWhitespace(raw);
  return title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH)}...` : title;
}

function isResult(value: unknown): value is PageTextResult {
  if (typeof value !== 'object' || value === null) return false;
  const reply = value as Record<string, unknown>;
  if (reply.ok === false) return typeof reply.error === 'string';
  return (
    reply.ok === true &&
    typeof reply.title === 'string' &&
    typeof reply.url === 'string' &&
    typeof reply.source === 'string' &&
    typeof reply.text === 'string'
  );
}

export async function getPageText(args: Record<string, unknown>, prompt: ApprovalPrompt): Promise<ContentBlock[]> {
  const parsed = parsePageTextArgs(args);
  if (!parsed.ok) throw new ToolError(`Invalid get_page_text arguments: ${parsed.error}`);
  const { tabId, ...options } = parsed.value;
  const result = await readTabPage('get_page_text', tabId, prompt, {
    entry: PAGE_TEXT_ENTRY,
    file: PAGE_TEXT_SCRIPT,
    options,
    isResult,
  });
  if (!result.ok) throw new ToolError(result.error);

  const text = `Title: ${clipTitle(result.title)}\nURL: ${result.url}\nSource element: ${result.source}\n---\n${result.text}`;
  return [{ type: 'text', text }];
}
