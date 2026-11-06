// value: the completion value of the code as a WebDriver BiDi RemoteValue-like tree, formatted by the
// extension with the host's formatter; exception: the thrown value as text; blocked: eval is refused by
// the page (Content Security Policy), the code did not run.
export type MainWorldEvalResult =
  | { kind: 'value'; value: unknown }
  | { kind: 'exception'; text: string }
  | { kind: 'blocked'; text: string };

// Fallback for javascript_tool when WebDriver BiDi is unavailable. Injected with scripting.executeScript in
// the page's MAIN world, so it is serialized from its source: it must not use anything outside its body.
export async function evaluateInMainWorld(code: string): Promise<MainWorldEvalResult> {
  // Mirrors the host's script.evaluate serialization (maxObjectDepth 4, no DOM children).
  const MAX_DEPTH = 4;
  // The formatter caps its output at 50,000 characters; every rendered value takes at least 3 of them,
  // so values past this many would be cut anyway.
  const MAX_VALUES = 20_000;
  // One character past the formatter's cap, so its truncation note still appears.
  const MAX_STRING = 50_001;
  const MAX_NODE_TEXT = 1_000;
  const MAX_STACK_LINES = 20;
  const MAX_EXCEPTION_CHARS = 10_000;
  const NODE_ATTRIBUTES = ['id', 'class', 'name', 'type', 'role', 'href', 'src'];
  const ASYNC_ONLY_SYNTAX = /await is only valid in async functions|return not in function|illegal return statement/i;

  const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

  const errorText = (error: unknown): string => {
    try {
      if (typeof error === 'object' && error !== null && typeof (error as Error).message === 'string') {
        const { name, message, stack } = error as Error;
        const header = `${typeof name === 'string' && name !== '' ? name : 'Error'}: ${message}`;
        const frames = typeof stack === 'string' ? stack.split('\n').filter((line) => line.trim() !== '') : [];
        const lines = [header, ...frames.slice(0, MAX_STACK_LINES).map((line) => `    at ${line.trim()}`)];
        if (frames.length > MAX_STACK_LINES) lines.push(`    … ${frames.length - MAX_STACK_LINES} more frames`);
        return clip(lines.join('\n'), MAX_EXCEPTION_CHARS);
      }
      return clip(`Uncaught ${typeof error === 'string' ? JSON.stringify(error) : String(error)}`, MAX_EXCEPTION_CHARS);
    } catch {
      return 'Uncaught exception';
    }
  };

  const isAsyncOnlySyntax = (error: unknown): boolean =>
    typeof error === 'object' &&
    error !== null &&
    (error as Error).name === 'SyntaxError' &&
    ASYNC_ONLY_SYNTAX.test(String((error as Error).message));

  let budget = MAX_VALUES;
  let nextId = 1;
  const ids = new Map<object, string>();

  const isInstance = (value: object, name: string): boolean => {
    const constructor = (globalThis as unknown as Record<string, unknown>)[name];
    return typeof constructor === 'function' && value instanceof constructor;
  };

  const describeNode = (node: Node): Record<string, unknown> => {
    const properties: Record<string, unknown> = { nodeType: node.nodeType };
    if (node.nodeType === 1) {
      const element = node as Element;
      properties.localName = element.localName;
      const attributes: Record<string, string> = {};
      for (const name of NODE_ATTRIBUTES) {
        const attribute = element.getAttribute(name);
        if (attribute !== null) attributes[name] = clip(attribute, MAX_NODE_TEXT);
      }
      properties.attributes = attributes;
    } else if (node.nodeType === 3 || node.nodeType === 8) {
      properties.nodeValue = clip(node.nodeValue ?? '', MAX_NODE_TEXT);
    } else if (node.nodeType === 11 && typeof (node as ShadowRoot).mode === 'string') {
      properties.mode = (node as ShadowRoot).mode;
    }
    return { type: 'node', value: properties };
  };

  const containerType = (value: object): string | undefined => {
    if (Array.isArray(value)) return 'array';
    if (isInstance(value, 'Map')) return 'map';
    if (isInstance(value, 'Set')) return 'set';
    if (isInstance(value, 'NodeList')) return 'nodelist';
    if (isInstance(value, 'HTMLCollection')) return 'htmlcollection';
    return undefined;
  };

  const opaqueType = (value: object): string | undefined => {
    if (value === globalThis || isInstance(value, 'Window')) return 'window';
    if (isInstance(value, 'Promise')) return 'promise';
    if (isInstance(value, 'WeakMap')) return 'weakmap';
    if (isInstance(value, 'WeakSet')) return 'weakset';
    if (isInstance(value, 'ArrayBuffer')) return 'arraybuffer';
    if (ArrayBuffer.isView(value)) return 'typedarray';
    if (Object.prototype.toString.call(value) === '[object Generator]') return 'generator';
    return undefined;
  };

  const serialize = (value: unknown, depth: number): unknown => {
    budget--;
    switch (typeof value) {
      case 'undefined':
        return { type: 'undefined' };
      case 'string':
        return { type: 'string', value: value.slice(0, MAX_STRING) };
      case 'number':
        return { type: 'number', value: Object.is(value, -0) ? '-0' : Number.isFinite(value) ? value : String(value) };
      case 'boolean':
        return { type: 'boolean', value };
      case 'bigint':
        return { type: 'bigint', value: String(value) };
      case 'symbol':
        return { type: 'symbol' };
      case 'function':
        return { type: 'function' };
    }
    if (value === null) return { type: 'null' };
    const object = value as object;
    try {
      if (isInstance(object, 'Node')) return describeNode(object as Node);
      if (isInstance(object, 'Error')) {
        const error = object as Error;
        return {
          type: 'object',
          value: [
            ['name', { type: 'string', value: String(error.name) }],
            ['message', { type: 'string', value: clip(String(error.message), MAX_STRING) }],
          ],
        };
      }
      if (isInstance(object, 'Date')) {
        const time = (object as Date).getTime();
        return { type: 'date', value: Number.isNaN(time) ? 'Invalid Date' : (object as Date).toISOString() };
      }
      if (isInstance(object, 'RegExp')) {
        return { type: 'regexp', value: { pattern: (object as RegExp).source, flags: (object as RegExp).flags } };
      }
      const opaque = opaqueType(object);
      if (opaque) return { type: opaque };
      const type = containerType(object) ?? 'object';
      // Past the depth limit a container has no value, like a BiDi value cut by maxObjectDepth.
      if (depth >= MAX_DEPTH) return { type };
      const seen = ids.get(object);
      if (seen !== undefined) return { type, internalId: seen };
      const internalId = String(nextId++);
      ids.set(object, internalId);
      const items: unknown[] = [];
      const property = (key: string): unknown => {
        try {
          return serialize((object as Record<string, unknown>)[key], depth + 1);
        } catch (error) {
          return { type: 'string', value: `[getter threw: ${clip(errorText(error).split('\n')[0] ?? '', 200)}]` };
        }
      };
      if (type === 'map') {
        for (const [key, entry] of object as Map<unknown, unknown>) {
          if (budget <= 0) break;
          items.push([serialize(key, depth + 1), serialize(entry, depth + 1)]);
        }
      } else if (type === 'set') {
        for (const entry of object as Set<unknown>) {
          if (budget <= 0) break;
          items.push(serialize(entry, depth + 1));
        }
      } else if (type === 'object') {
        for (const key of Object.keys(object)) {
          if (budget <= 0) break;
          items.push([key, property(key)]);
        }
      } else {
        const list = object as ArrayLike<unknown>;
        for (let index = 0; index < list.length && budget > 0; index++) items.push(serialize(list[index], depth + 1));
      }
      return { type, value: items, internalId };
    } catch {
      return { type: 'object' };
    }
  };

  const indirectEval = globalThis.eval;
  // eval of a constant first: under a Content Security Policy without 'unsafe-eval' it throws before the
  // code has run, so a refusal is told apart from an EvalError the code itself throws.
  try {
    indirectEval('0');
  } catch (error) {
    return { kind: 'blocked', text: errorText(error) };
  }

  let completion: unknown;
  try {
    try {
      completion = indirectEval(code);
    } catch (error) {
      // Top-level await and return only parse in a function body, so the script failed to parse and did not
      // run. A SyntaxError with the same text thrown at run time (code calling eval) is indistinguishable here
      // and runs the code a second time; accepted for this fallback.
      if (!isAsyncOnlySyntax(error)) throw error;
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (body: string) => () => Promise<unknown>;
      completion = new AsyncFunction(code)();
    }
    completion = await completion;
  } catch (error) {
    return { kind: 'exception', text: errorText(error) };
  }
  return { kind: 'value', value: serialize(completion, 0) };
}
