import { MAX_ENTRY_CHARS } from './console-capture-api';

const MAX_DEPTH = 2;
const MAX_ITEMS = 20;
const MAX_STACK_LINES = 10;
const MAX_ATTRIBUTE_CHARS = 80;
const NODE_ATTRIBUTES = ['id', 'class', 'name', 'type', 'role', 'href', 'src'];
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const SPECIFIER = /%[sdifoOc%]/g;

interface State {
  used: number;
  ancestors: Set<object>;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function isInstance(value: object, name: string): boolean {
  const constructor = (globalThis as unknown as Record<string, unknown>)[name];
  return typeof constructor === 'function' && value instanceof constructor;
}

function isError(value: object): boolean {
  return isInstance(value, 'Error') || Object.prototype.toString.call(value) === '[object Error]';
}

function errorHeader(error: Error): string {
  const name = typeof error.name === 'string' && error.name !== '' ? error.name : 'Error';
  return `${name}: ${String(error.message)}`;
}

function errorWithStack(error: Error): string {
  const header = errorHeader(error);
  const frames = (typeof error.stack === 'string' ? error.stack.split('\n') : [])
    .map((line) => line.trim())
    .filter((line) => line !== '' && line !== header);
  const lines = frames.slice(0, MAX_STACK_LINES).map((line) => `    ${line.startsWith('at ') ? line : `at ${line}`}`);
  if (frames.length > MAX_STACK_LINES) lines.push(`    … ${frames.length - MAX_STACK_LINES} more frames`);
  return [header, ...lines].join('\n');
}

function describeNode(node: Node): string {
  if (node.nodeType === 1) {
    const element = node as Element;
    const attributes = NODE_ATTRIBUTES.flatMap((name) => {
      const value = element.getAttribute(name);
      return value === null ? [] : [` ${name}=${JSON.stringify(clip(value, MAX_ATTRIBUTE_CHARS))}`];
    });
    return `<${element.localName}${attributes.join('')}>`;
  }
  if (node.nodeType === 3) {
    return `#text ${JSON.stringify(clip((node.nodeValue ?? '').replace(/\s+/g, ' ').trim(), MAX_ATTRIBUTE_CHARS))}`;
  }
  if (node.nodeType === 8) return `<!--${clip(node.nodeValue ?? '', MAX_ATTRIBUTE_CHARS)}-->`;
  return `#${node.nodeName.replace(/^#/, '').toLowerCase()}`;
}

function more(total: number): string {
  return `… ${total - MAX_ITEMS} more`;
}

function list(open: string, close: string, items: string[], total: number): string {
  const shown = total > items.length ? [...items, more(total)] : items;
  return `${open}${shown.join(', ')}${close}`;
}

function describeContainer(value: object, state: State, depth: number): string {
  const describeItem = (item: unknown) => describe(item, state, depth + 1);
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return '[…]';
    const items: string[] = [];
    for (let index = 0; index < Math.min(value.length, MAX_ITEMS) && state.used <= MAX_ENTRY_CHARS; index++) {
      items.push(describeItem(value[index]));
    }
    return list('[', ']', items, value.length);
  }
  if (isInstance(value, 'Map') || isInstance(value, 'Set')) {
    const isMap = isInstance(value, 'Map');
    const collection = value as Map<unknown, unknown> | Set<unknown>;
    const prefix = `${isMap ? 'Map' : 'Set'}(${collection.size}) `;
    if (depth >= MAX_DEPTH) return `${prefix}{…}`;
    const items: string[] = [];
    for (const [key, item] of collection.entries()) {
      if (items.length >= MAX_ITEMS || state.used > MAX_ENTRY_CHARS) break;
      items.push(isMap ? `${describeItem(key)} => ${describeItem(item)}` : describeItem(item));
    }
    return list(`${prefix}{`, '}', items, collection.size);
  }
  if (depth >= MAX_DEPTH) return '{…}';
  const keys = Object.keys(value);
  const items: string[] = [];
  for (const key of keys.slice(0, MAX_ITEMS)) {
    if (state.used > MAX_ENTRY_CHARS) break;
    let item: string;
    try {
      item = describeItem((value as Record<string, unknown>)[key]);
    } catch {
      item = '[getter threw]';
    }
    items.push(`${IDENTIFIER.test(key) ? key : JSON.stringify(key)}: ${item}`);
  }
  return list('{', '}', items, keys.length);
}

function describeObject(value: object, state: State, depth: number): string {
  if (isError(value)) return depth === 0 ? errorWithStack(value as Error) : errorHeader(value as Error);
  if (isInstance(value, 'Node')) return describeNode(value as Node);
  if (isInstance(value, 'Date')) {
    const time = (value as Date).getTime();
    return Number.isNaN(time) ? 'Invalid Date' : (value as Date).toISOString();
  }
  if (isInstance(value, 'RegExp')) return String(value);
  if (state.ancestors.has(value)) return '[Circular]';
  state.ancestors.add(value);
  try {
    return describeContainer(value, state, depth);
  } finally {
    state.ancestors.delete(value);
  }
}

function describe(value: unknown, state: State, depth: number): string {
  let text: string;
  try {
    switch (typeof value) {
      case 'string': {
        const clipped = value.slice(0, MAX_ENTRY_CHARS + 1);
        text = depth === 0 ? clipped : JSON.stringify(clipped);
        break;
      }
      case 'bigint':
        text = `${value}n`;
        break;
      case 'symbol':
        text = value.toString();
        break;
      case 'function':
        text = value.name === '' ? '[Function]' : `[Function ${value.name}]`;
        break;
      case 'object':
        text = value === null ? 'null' : describeObject(value, state, depth);
        break;
      default:
        text = String(value);
    }
  } catch {
    text = typeof value === 'object' ? '[object]' : `[${typeof value}]`;
  }
  state.used += text.length;
  return text;
}

function newState(): State {
  return { used: 0, ancestors: new Set() };
}

export function describeConsoleValue(value: unknown): string {
  return clip(describe(value, newState(), 0), MAX_ENTRY_CHARS);
}

function substitute(format: string, args: unknown[], state: State): string {
  return format.replace(SPECIFIER, (specifier) => {
    if (specifier === '%%') return '%';
    if (args.length === 0) return specifier;
    const arg = args.shift();
    switch (specifier) {
      case '%c':
        return '';
      case '%d':
      case '%i':
        return String(typeof arg === 'number' ? Math.trunc(arg) : Number.parseInt(String(arg), 10));
      case '%f':
        return String(typeof arg === 'number' ? arg : Number.parseFloat(String(arg)));
      case '%s':
        return describe(arg, state, 0);
      default:
        return typeof arg === 'string' ? JSON.stringify(arg.slice(0, MAX_ENTRY_CHARS)) : describe(arg, state, 0);
    }
  });
}

// The text of a console call: printf-style specifiers of a leading string are applied, the remaining
// arguments are described compactly and joined with spaces, capped at MAX_ENTRY_CHARS.
export function formatConsoleArgs(args: readonly unknown[]): string {
  const state = newState();
  const rest = [...args];
  const parts: string[] = [];
  const [first] = rest;
  if (typeof first === 'string' && first.includes('%')) {
    rest.shift();
    try {
      parts.push(substitute(first, rest, state));
    } catch {
      parts.push(first);
    }
  }
  for (const arg of rest) {
    if (state.used > MAX_ENTRY_CHARS) break;
    parts.push(describe(arg, state, 0));
  }
  return clip(parts.join(' '), MAX_ENTRY_CHARS);
}
