import type { ApprovalPrompt } from '../permissions/approval';
import type { ContentBlock } from '../protocol';
import { parseNetworkArgs } from './network-input';
import { formatNetworkReport } from './network-output';
import { NETWORK_ACCESS, NETWORK_TOOL, readNetworkCapture } from './network-tracking';
import { openTabPage } from './page-script';
import { ToolError } from './tool-error';

export async function readNetworkRequests(args: Record<string, unknown>, prompt: ApprovalPrompt): Promise<ContentBlock[]> {
  const parsed = parseNetworkArgs(args);
  if (!parsed.ok) throw new ToolError(`Invalid read_network_requests arguments: ${parsed.error}`);
  const { tabId, ...options } = parsed.value;
  const tab = await openTabPage(NETWORK_TOOL, tabId, prompt, NETWORK_ACCESS);
  const { url, started, cleared, result } = await readNetworkCapture(tab.tabId, tab.host, options);
  const text = formatNetworkReport({ tabId: tab.tabId, url, started, args: { ...parsed.value, clear: cleared }, result });
  const notCleared = options.clear && !cleared ? '\nThe list could not be cleared: storing the emptied list failed; it is kept.' : '';
  return [{ type: 'text', text: `${text}${notCleared}` }];
}
