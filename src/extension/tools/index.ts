import type { ApprovalPrompt } from '../permissions/approval';
import type { ClientApprovals } from '../permissions/client-prompt';
import { approvalPromptFor } from '../permissions/site-access';
import type { ContentBlock, ToolRequest, ToolResponse } from '../protocol';
import type { BidiEvaluateChannel } from './bidi-evaluate';
import type { BidiInputChannel } from './bidi-input';
import { computer } from './computer';
import { readConsoleMessages } from './console';
import { findTool } from './find';
import { formInputTool } from './form-input';
import { javascriptTool } from './javascript';
import { navigate } from './navigate';
import { readNetworkRequests } from './network';
import { getPageText } from './page-text';
import { readPage } from './read-page';
import { resizeWindow } from './resize-window';
import { tabsClose, tabsCreate } from './tabs';
import { tabsContext } from './tabs-context';
import { ToolError } from './tool-error';

// Where a call comes from: chatSessionId names the sidebar Claude Code session that made it.
export interface ToolContext {
  chatSessionId?: string;
}

type ToolHandler = (
  args: Record<string, unknown>,
  prompt: ApprovalPrompt,
  input?: BidiInputChannel,
  evaluate?: BidiEvaluateChannel,
  context?: ToolContext,
) => Promise<ContentBlock[]>;

const tools = new Map<string, ToolHandler>([
  ['tabs_context', tabsContext],
  ['navigate', navigate],
  ['tabs_create', tabsCreate],
  ['tabs_close', tabsClose],
  ['computer', computer],
  ['read_page', readPage],
  ['get_page_text', getPageText],
  ['find', findTool],
  ['form_input', formInputTool],
  ['resize_window', resizeWindow],
  ['javascript_tool', javascriptTool],
  ['read_console_messages', readConsoleMessages],
  ['read_network_requests', readNetworkRequests],
]);

function errorResponse(id: string, text: string): ToolResponse {
  return { type: 'tool_response', id, error: { content: [{ type: 'text', text }] } };
}

export async function executeTool(
  request: ToolRequest,
  clientApprovals?: ClientApprovals,
  bidiInput?: BidiInputChannel,
  bidiEvaluate?: BidiEvaluateChannel,
): Promise<ToolResponse> {
  const handler = tools.get(request.tool);
  if (!handler) return errorResponse(request.id, `Unknown tool: ${request.tool}`);
  try {
    const { chatSessionId } = request;
    // A sidebar Claude Code session runs headless, so nobody could answer a question in its client.
    const viaClient = request.approvalViaClient === true && chatSessionId === undefined;
    const prompt = approvalPromptFor(
      clientApprovals && viaClient ? { viaClient, clientPrompt: clientApprovals.promptFor(request.id) } : undefined,
    );
    const context: ToolContext = chatSessionId === undefined ? {} : { chatSessionId };
    const content = await handler(request.args, prompt, bidiInput, bidiEvaluate, context);
    return { type: 'tool_response', id: request.id, result: { content } };
  } catch (error) {
    if (error instanceof ToolError) return errorResponse(request.id, error.message);
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(request.id, `Tool execution failed: ${message}`);
  }
}
