import type { ApprovalPrompt } from '../permissions/approval';
import type { ClientApprovals } from '../permissions/client-prompt';
import { approvalPromptFor } from '../permissions/site-access';
import type { ContentBlock, ToolRequest, ToolResponse } from '../protocol';
import { computer } from './computer';
import { findTool } from './find';
import { navigate } from './navigate';
import { getPageText } from './page-text';
import { readPage } from './read-page';
import { tabsClose, tabsCreate } from './tabs';
import { tabsContext } from './tabs-context';
import { ToolError } from './tool-error';

type ToolHandler = (args: Record<string, unknown>, prompt: ApprovalPrompt) => Promise<ContentBlock[]>;

const tools = new Map<string, ToolHandler>([
  ['tabs_context', tabsContext],
  ['navigate', navigate],
  ['tabs_create', tabsCreate],
  ['tabs_close', tabsClose],
  ['computer', computer],
  ['read_page', readPage],
  ['get_page_text', getPageText],
  ['find', findTool],
]);

function errorResponse(id: string, text: string): ToolResponse {
  return { type: 'tool_response', id, error: { content: [{ type: 'text', text }] } };
}

export async function executeTool(request: ToolRequest, clientApprovals?: ClientApprovals): Promise<ToolResponse> {
  const handler = tools.get(request.tool);
  if (!handler) return errorResponse(request.id, `Unknown tool: ${request.tool}`);
  try {
    const prompt = approvalPromptFor(
      clientApprovals && { viaClient: request.approvalViaClient === true, clientPrompt: clientApprovals.promptFor(request.id) },
    );
    const content = await handler(request.args, prompt);
    return { type: 'tool_response', id: request.id, result: { content } };
  } catch (error) {
    if (error instanceof ToolError) return errorResponse(request.id, error.message);
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(request.id, `Tool execution failed: ${message}`);
  }
}
