import type { AnthropicTool } from '../../shared/anthropic-tools';

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string };
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: (TextBlock | ImageBlock)[];
  is_error?: boolean;
}

export type UserContentBlock = TextBlock | ImageBlock | ToolResultBlock;
export type AssistantContentBlock = TextBlock | ToolUseBlock;

export type ChatMessage = { role: 'user'; content: UserContentBlock[] } | { role: 'assistant'; content: AssistantContentBlock[] };

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface ChatTurnRequest {
  model: string;
  system: TextBlock[];
  messages: ChatMessage[];
  tools: readonly AnthropicTool[];
  maxTokens: number;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
}

// Provider-neutral stop reason; each provider maps its own values onto it.
export type ChatStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'other';

export interface ChatTurnResult {
  content: AssistantContentBlock[];
  stopReason: ChatStopReason;
  usage: ChatUsage;
}

// One streamed model turn. Rejects with ChatApiError or ChatAbortError.
export interface ChatProvider {
  streamTurn(request: ChatTurnRequest): Promise<ChatTurnResult>;
}
