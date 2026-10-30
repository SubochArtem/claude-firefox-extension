import type { ContentBlock, ToolRequest, ToolResponse } from '../protocol';
import { navigate } from './navigate';
import { tabsContext } from './tabs-context';
import { ToolError } from './tool-error';

type ToolHandler = (args: Record<string, unknown>) => Promise<ContentBlock[]>;

const tools = new Map<string, ToolHandler>([
  ['tabs_context', tabsContext],
  ['navigate', navigate],
]);

function errorResponse(id: string, text: string): ToolResponse {
  return { type: 'tool_response', id, error: { content: [{ type: 'text', text }] } };
}

export async function executeTool(request: ToolRequest): Promise<ToolResponse> {
  const handler = tools.get(request.tool);
  if (!handler) return errorResponse(request.id, `Unknown tool: ${request.tool}`);
  try {
    const content = await handler(request.args);
    return { type: 'tool_response', id: request.id, result: { content } };
  } catch (error) {
    if (error instanceof ToolError) return errorResponse(request.id, error.message);
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(request.id, `Tool execution failed: ${message}`);
  }
}
