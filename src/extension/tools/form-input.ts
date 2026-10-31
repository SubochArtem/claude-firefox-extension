import { FORM_INPUT_ENTRY, type FormInputResult } from '../page/form-input-api';
import { READ_PAGE_SCRIPT } from '../page/read-page-api';
import type { ApprovalPrompt } from '../permissions/approval';
import type { ContentBlock } from '../protocol';
import { parseFormInputArgs } from './form-input-input';
import { type PageAccess, readTabPage } from './page-script';
import { ToolError } from './tool-error';

export function formInputPageChangedMessage(tool: string, tabId: number, host: string): string {
  return `Cannot edit tab ${tabId}: the page navigated away from ${host} to another site, so the result is withheld. Check the tab's current page with read_page or find before calling ${tool} again; a page on another site needs its own permission.`;
}

const ACCESS: PageAccess = {
  action: 'type',
  label: { verb: 'set a form value', target: 'edit' },
  pageChanged: formInputPageChangedMessage,
};

function isResult(value: unknown): value is FormInputResult {
  if (typeof value !== 'object' || value === null) return false;
  const reply = value as Record<string, unknown>;
  if (reply.ok === false) return typeof reply.error === 'string';
  return reply.ok === true && typeof reply.text === 'string';
}

export async function formInputTool(args: Record<string, unknown>, prompt: ApprovalPrompt): Promise<ContentBlock[]> {
  const parsed = parseFormInputArgs(args);
  if (!parsed.ok) throw new ToolError(`Invalid form_input arguments: ${parsed.error}`);
  const { tabId, ...options } = parsed.value;
  // The form_input entry point lives in the read_page bundle, so it resolves the refs of read_page and find.
  const result = await readTabPage(
    'form_input',
    tabId,
    prompt,
    { entry: FORM_INPUT_ENTRY, file: READ_PAGE_SCRIPT, options, isResult },
    ACCESS,
  );
  if (!result.ok) throw new ToolError(result.error);
  return [{ type: 'text', text: result.text }];
}
