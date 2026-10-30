export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type NavigateTarget = { kind: 'url'; url: string } | { kind: 'back' } | { kind: 'forward' };

export interface NavigateArgs {
  tabId: number;
  target: NavigateTarget;
}

export interface TabsCreateArgs {
  url?: string;
}

export interface TabsCloseArgs {
  tabId: number;
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:/i;
const HOST_PORT_SUFFIX = /^\d+(?:[/?#]|$)/;
const MAX_ECHOED_LENGTH = 200;

export function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeControlCharacters(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function echoInput(text: string): string {
  const capped = text.length > MAX_ECHOED_LENGTH ? `${text.slice(0, MAX_ECHOED_LENGTH)}…` : text;
  return escapeControlCharacters(capped);
}

function historyKeyword(input: string): 'back' | 'forward' | undefined {
  const keyword = input.toLowerCase();
  return keyword === 'back' || keyword === 'forward' ? keyword : undefined;
}

export function parseTabId(value: unknown): ParseResult<number> {
  if (value === undefined) return { ok: false, error: 'Missing required parameter tabId (integer)' };
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { ok: false, error: `tabId must be an integer, received ${describe(value)}` };
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    return { ok: false, error: `tabId must be a positive safe integer, received ${describe(value)}` };
  }
  return { ok: true, value };
}

function parseUrlString(value: unknown): ParseResult<string> {
  if (typeof value !== 'string') return { ok: false, error: `url must be a string, received ${describe(value)}` };
  const trimmed = value.trim();
  if (trimmed === '') return { ok: false, error: 'url must not be empty' };
  return { ok: true, value: trimmed };
}

function normalizeUrl(input: string): ParseResult<string> {
  // The WHATWG parser silently drops tabs and newlines inside a URL, so "java\tscript:" would become
  // "javascript:" and "https://exa\nmple.com" a different host than the one shown; reject them all.
  if (CONTROL_CHARACTERS.test(input)) return { ok: false, error: `Invalid URL: ${echoInput(input)}` };

  // "localhost:3000" and "example.com:8080/path" look like a scheme to the URL parser; a colon followed
  // only by digits up to the end, "/", "?" or "#" is read as host:port and gets https:// instead.
  let candidate = input;
  const scheme = SCHEME_PREFIX.exec(input)?.[0];
  if (scheme === undefined || HOST_PORT_SUFFIX.test(input.slice(scheme.length))) {
    candidate = `https://${input}`;
  } else if (!ALLOWED_PROTOCOLS.has(scheme.toLowerCase())) {
    const shown = echoInput(scheme.toLowerCase());
    return { ok: false, error: `Unsupported URL scheme "${shown}"; only http and https URLs are allowed` };
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, error: `Invalid URL: ${echoInput(input)}` };
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { ok: false, error: `Unsupported URL scheme "${url.protocol}"; only http and https URLs are allowed` };
  }
  // Userinfo lets a URL show a trusted name before the real host ("https://good.com:80@evil.com").
  if (url.username !== '' || url.password !== '') {
    return { ok: false, error: 'URLs with a username or password are not allowed' };
  }
  return { ok: true, value: url.href };
}

export function parseNavigateArgs(args: unknown): ParseResult<NavigateArgs> {
  if (!isRecord(args)) {
    return { ok: false, error: `Expected an object with tabId and url parameters, received ${describe(args)}` };
  }
  const tabId = parseTabId(args.tabId);
  if (!tabId.ok) return tabId;
  if (args.url === undefined) return { ok: false, error: 'Missing required parameter url (string)' };
  const input = parseUrlString(args.url);
  if (!input.ok) return input;

  const keyword = historyKeyword(input.value);
  if (keyword !== undefined) return { ok: true, value: { tabId: tabId.value, target: { kind: keyword } } };

  const url = normalizeUrl(input.value);
  if (!url.ok) return url;
  return { ok: true, value: { tabId: tabId.value, target: { kind: 'url', url: url.value } } };
}

export function parseTabsCreateArgs(args: unknown): ParseResult<TabsCreateArgs> {
  if (args === undefined) return { ok: true, value: {} };
  if (!isRecord(args)) {
    return { ok: false, error: `Expected an object with an optional url parameter, received ${describe(args)}` };
  }
  if (args.url === undefined) return { ok: true, value: {} };
  const input = parseUrlString(args.url);
  if (!input.ok) return input;
  if (historyKeyword(input.value) !== undefined) {
    return { ok: false, error: 'back and forward are only valid for navigate' };
  }

  const url = normalizeUrl(input.value);
  if (!url.ok) return url;
  return { ok: true, value: { url: url.value } };
}

export function parseTabsCloseArgs(args: unknown): ParseResult<TabsCloseArgs> {
  if (!isRecord(args)) {
    return { ok: false, error: `Expected an object with a tabId integer parameter, received ${describe(args)}` };
  }
  const tabId = parseTabId(args.tabId);
  if (!tabId.ok) return tabId;
  return { ok: true, value: { tabId: tabId.value } };
}
