import { isRecord } from './protocol';

export const MAX_FORMATTED_CHARS = 50_000;
const MAX_INLINE_CHARS = 80;
const MAX_NODE_TEXT_CHARS = 80;
const MAX_NESTING = 64;
const INDENT = '  ';
const REDACTED = '[REDACTED]';
const NODE_ATTRIBUTES = ['id', 'class', 'name', 'type', 'role', 'href', 'src'];

// Best-effort redaction: it catches the common shapes of credentials in returned data (values under
// such keys, bare JWTs), not secrets in arbitrary text, and it also hides harmless keys like "author".
const SENSITIVE_KEY = /password|passwd|secret|token|api[_-]?key|auth|credential|private[_-]?key|access[_-]?key|bearer|session|cookie/i;
const JWT = /^eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*$/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

interface State {
  used: number;
  // internalIds that occur without a value, i.e. as a repeated or circular reference.
  referenced: Set<string>;
  labels: Map<string, number>;
}

function overBudget(state: State): boolean {
  return state.used > MAX_FORMATTED_CHARS;
}

function leaf(state: State, text: string): string {
  state.used += text.length;
  return text;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function isJwt(text: string): boolean {
  return JWT.test(text.trim());
}

function quote(text: string): string {
  return isJwt(text) ? REDACTED : JSON.stringify(text);
}

function children(value: Record<string, unknown>): unknown[] {
  const list = value['value'];
  if (!Array.isArray(list)) return [];
  if (value['type'] === 'object' || value['type'] === 'map') {
    return list.flatMap((entry) => (Array.isArray(entry) ? [entry[0], entry[1]] : []));
  }
  return list;
}

function collectReferences(value: unknown, referenced: Set<string>, depth: number): void {
  if (!isRecord(value) || depth > MAX_NESTING) return;
  const id = value['internalId'];
  if (typeof id === 'string' && !('value' in value)) referenced.add(id);
  for (const child of children(value)) collectReferences(child, referenced, depth + 1);
}

function label(state: State, id: string): number {
  let number = state.labels.get(id);
  if (number === undefined) {
    number = state.labels.size + 1;
    state.labels.set(id, number);
  }
  return number;
}

function container(state: State, open: string, close: string, items: string[]): string {
  if (items.length === 0) return `${open}${close}`;
  const inline = `${open}${items.join(', ')}${close}`;
  if (inline.length <= MAX_INLINE_CHARS && !inline.includes('\n')) return inline;
  const body = items.map((item) => INDENT + item.replaceAll('\n', `\n${INDENT}`)).join(',\n');
  return `${open}\n${body}\n${close}`;
}

function renderList(state: State, list: unknown[], depth: number): string[] {
  const items: string[] = [];
  for (const item of list) {
    if (overBudget(state)) {
      items.push('…');
      break;
    }
    items.push(render(state, item, depth + 1));
  }
  return items;
}

function keyText(key: unknown, state: State, depth: number, quoteIdentifiers: boolean): { text: string; sensitive: boolean } {
  const raw = typeof key === 'string' ? key : isRecord(key) && key['type'] === 'string' && typeof key['value'] === 'string' ? key['value'] : undefined;
  if (raw === undefined) return { text: render(state, key, depth + 1), sensitive: false };
  const text = !quoteIdentifiers && IDENTIFIER.test(raw) ? raw : JSON.stringify(raw);
  return { text: leaf(state, text), sensitive: SENSITIVE_KEY.test(raw) };
}

function renderEntries(state: State, list: unknown[], depth: number, separator: string, quoteIdentifiers: boolean): string[] {
  const items: string[] = [];
  for (const entry of list) {
    if (overBudget(state)) {
      items.push('…');
      break;
    }
    if (!Array.isArray(entry)) continue;
    const key = keyText(entry[0], state, depth, quoteIdentifiers);
    const value = key.sensitive ? leaf(state, REDACTED) : render(state, entry[1], depth + 1);
    items.push(`${key.text}${separator}${value}`);
  }
  return items;
}

function renderNode(value: Record<string, unknown>): string {
  const properties = value['value'];
  if (!isRecord(properties)) return '<node>';
  const text = (raw: unknown) => clip(typeof raw === 'string' ? raw : '', MAX_NODE_TEXT_CHARS);
  switch (properties['nodeType']) {
    case 1: {
      const name = typeof properties['localName'] === 'string' ? properties['localName'] : 'element';
      const attributes = isRecord(properties['attributes']) ? properties['attributes'] : {};
      const shown = NODE_ATTRIBUTES.flatMap((attribute) => {
        const attributeValue = attributes[attribute];
        return typeof attributeValue === 'string' ? [` ${attribute}=${JSON.stringify(text(attributeValue))}`] : [];
      });
      return `<${name}${shown.join('')}>`;
    }
    case 2:
      return '#attribute';
    case 3:
      return `#text ${JSON.stringify(text(String(properties['nodeValue'] ?? '').replace(/\s+/g, ' ').trim()))}`;
    case 4:
      return '#cdata-section';
    case 8:
      return `<!--${text(properties['nodeValue'])}-->`;
    case 9:
      return '#document';
    case 10:
      return '<!DOCTYPE>';
    case 11:
      return typeof properties['mode'] === 'string' ? `#shadow-root (${properties['mode']})` : '#document-fragment';
    default:
      return '<node>';
  }
}

const CONTAINER_NAMES: Record<string, string> = {
  array: 'Array',
  object: 'Object',
  map: 'Map',
  set: 'Set',
  nodelist: 'NodeList',
  htmlcollection: 'HTMLCollection',
};

const OPAQUE_NAMES: Record<string, string> = {
  window: 'Window',
  function: 'Function',
  promise: 'Promise',
  error: 'Error',
  weakmap: 'WeakMap',
  weakset: 'WeakSet',
  generator: 'Generator',
  proxy: 'Proxy',
  typedarray: 'TypedArray',
  arraybuffer: 'ArrayBuffer',
};

function renderContainer(state: State, value: Record<string, unknown>, type: string, depth: number): string {
  const list = value['value'];
  const id = value['internalId'];
  if (!Array.isArray(list)) {
    if (typeof id === 'string') return leaf(state, `[Ref *${label(state, id)}]`);
    return leaf(state, `[${CONTAINER_NAMES[type] ?? type}]`);
  }
  const prefix = typeof id === 'string' && state.referenced.has(id) ? `<ref *${label(state, id)}> ` : '';
  switch (type) {
    case 'array':
      return prefix + container(state, '[', ']', renderList(state, list, depth));
    case 'set':
      return prefix + container(state, `Set(${list.length}) {`, '}', renderList(state, list, depth));
    case 'nodelist':
    case 'htmlcollection':
      return prefix + container(state, `${CONTAINER_NAMES[type]}(${list.length}) [`, ']', renderList(state, list, depth));
    case 'map':
      return prefix + container(state, `Map(${list.length}) {`, '}', renderEntries(state, list, depth, ' => ', true));
    default:
      return prefix + container(state, '{', '}', renderEntries(state, list, depth, ': ', false));
  }
}

function render(state: State, value: unknown, depth: number): string {
  if (depth > MAX_NESTING) return leaf(state, '…');
  if (!isRecord(value) || typeof value['type'] !== 'string') return leaf(state, '[unrecognized value]');
  const type = value['type'];
  const raw = value['value'];
  switch (type) {
    case 'undefined':
    case 'null':
      return leaf(state, type);
    case 'string': {
      // Past the remaining budget the text is cut anyway; clipping first avoids copying a huge string.
      const text = String(raw).slice(0, Math.max(0, MAX_FORMATTED_CHARS - state.used) + 1);
      return leaf(state, depth === 0 && !isJwt(text) ? text : quote(text));
    }
    case 'number':
    case 'boolean':
      return leaf(state, String(raw));
    case 'bigint':
      return leaf(state, `${String(raw)}n`);
    case 'symbol':
      return leaf(state, 'Symbol()');
    case 'date':
      return leaf(state, `Date(${String(raw)})`);
    case 'regexp': {
      const pattern = isRecord(raw) && typeof raw['pattern'] === 'string' ? raw['pattern'] : '';
      const flags = isRecord(raw) && typeof raw['flags'] === 'string' ? raw['flags'] : '';
      return leaf(state, `/${pattern}/${flags}`);
    }
    case 'node':
      return leaf(state, renderNode(value));
    default:
      if (type in CONTAINER_NAMES) return renderContainer(state, value, type, depth);
      return leaf(state, `[${OPAQUE_NAMES[type] ?? type}]`);
  }
}

// Formats a WebDriver BiDi RemoteValue as readable text, capped at MAX_FORMATTED_CHARS.
export function formatRemoteValue(value: unknown): string {
  const referenced = new Set<string>();
  collectReferences(value, referenced, 0);
  const text = render({ used: 0, referenced, labels: new Map() }, value, 0);
  if (text.length <= MAX_FORMATTED_CHARS) return text;
  let end = MAX_FORMATTED_CHARS;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end)}\n[Output truncated at ${MAX_FORMATTED_CHARS} characters]`;
}
