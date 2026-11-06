import * as z from 'zod/v4';
import { TOOL_DEFINITIONS, type ToolDefinition } from './tool-definitions';

// A tool in the Anthropic Messages API request format.
export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: { type: 'object'; [key: string]: unknown };
}

function toAnthropicTool(tool: ToolDefinition): AnthropicTool {
  const schema = z.toJSONSchema(tool.inputSchema, { target: 'draft-7', io: 'input' });
  if (schema.type !== 'object') throw new Error(`Input schema of ${tool.name} is not an object schema`);
  return { name: tool.name, description: tool.description, input_schema: { ...schema, type: 'object' } };
}

// The extension build evaluates this module and inlines the result (scripts/build-time-modules.mjs),
// so zod is not shipped; the options match the JSON Schema the MCP SDK lists for the same tools.
export const ANTHROPIC_TOOLS: readonly AnthropicTool[] = TOOL_DEFINITIONS.map(toAnthropicTool);
