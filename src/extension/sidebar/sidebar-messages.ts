import type { ChatToolResult } from '../chat/agent-loop';
import type { ImageBlock, TextBlock } from '../chat/provider';
import type { ContentBlock, ToolResponse } from '../protocol';
import { executeTool } from '../tools';
import type { BidiEvaluateChannel } from '../tools/bidi-evaluate';
import type { BidiInputChannel } from '../tools/bidi-input';
import { isRecord } from '../tools/navigation-input';

export const SIDEBAR_PAGE = 'sidebar/sidebar.html';
export const CHAT_TOOL_CALL_MESSAGE = 'chat_tool_call';

export interface BidiChannels {
  input?: BidiInputChannel | undefined;
  evaluate?: BidiEvaluateChannel | undefined;
}

const IMAGE_TYPES = new Set<string>(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

let callCount = 0;

function errorResult(text: string): ChatToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function toChatBlock(block: ContentBlock): TextBlock | ImageBlock {
  if (block.type === 'text') return block;
  if (!IMAGE_TYPES.has(block.mimeType)) return { type: 'text', text: `[image of unsupported type ${block.mimeType}]` };
  const mediaType = block.mimeType as ImageBlock['source']['media_type'];
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: block.data } };
}

function toChatResult(response: ToolResponse): ChatToolResult {
  const output = 'result' in response ? response.result : response.error;
  return { content: output.content.map(toChatBlock), isError: !('result' in response) };
}

// Tool calls of the sidebar chat's agent loop run here through the same registry as the native port.
// No approval choice is passed, so site permissions are asked in the popup prompt: the sidebar has no
// MCP client to ask through. `channels` returns the native port's current BiDi channels, if connected.
export function createSidebarMessageHandler(channels: () => BidiChannels) {
  return (message: unknown, sender: browser.runtime.MessageSender): Promise<ChatToolResult> | undefined => {
    if (!isRecord(message) || message.type !== CHAT_TOOL_CALL_MESSAGE) return undefined;
    const fromSidebar = sender.id === browser.runtime.id && sender.url === browser.runtime.getURL(SIDEBAR_PAGE);
    if (!fromSidebar) return Promise.resolve(errorResult('Tool calls are accepted only from the sidebar chat'));
    if (typeof message.name !== 'string') return Promise.resolve(errorResult('Invalid tool call: the tool name must be a string'));
    if (!isRecord(message.input)) return Promise.resolve(errorResult('Invalid tool call: the input must be an object'));
    callCount += 1;
    const { input, evaluate } = channels();
    const request = { type: 'tool_request' as const, id: `sidebar:${callCount}`, tool: message.name, args: message.input };
    return executeTool(request, undefined, input, evaluate).then(toChatResult);
  };
}
