import { describe, expect, it } from 'vitest';
import { ANTHROPIC_TOOLS } from '../anthropic-tools';
import { TOOL_DEFINITIONS } from '../tool-definitions';

describe('ANTHROPIC_TOOLS', () => {
  it('covers exactly the shared tool definitions, in order, with unique names', () => {
    const names = ANTHROPIC_TOOLS.map((tool) => tool.name);
    expect(names).toEqual(TOOL_DEFINITIONS.map((tool) => tool.name));
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps each description', () => {
    for (const [index, tool] of ANTHROPIC_TOOLS.entries()) {
      expect(tool.description).toBe(TOOL_DEFINITIONS[index]?.description);
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it('gives each tool an object JSON Schema with properties', () => {
    for (const tool of ANTHROPIC_TOOLS) {
      expect(tool.input_schema.type).toBe('object');
      expect(tool.input_schema.properties).toBeTypeOf('object');
    }
  });

  it('is plain JSON data', () => {
    expect(JSON.parse(JSON.stringify(ANTHROPIC_TOOLS))).toEqual(ANTHROPIC_TOOLS);
  });

  it('describes required arguments and strict objects like the zod schemas', () => {
    const computer = ANTHROPIC_TOOLS.find((tool) => tool.name === 'computer');
    expect(computer?.input_schema).toMatchObject({ required: ['action'], additionalProperties: false });
    const tabsContext = ANTHROPIC_TOOLS.find((tool) => tool.name === 'tabs_context');
    expect(tabsContext?.input_schema).toMatchObject({ type: 'object', properties: {} });
  });
});
