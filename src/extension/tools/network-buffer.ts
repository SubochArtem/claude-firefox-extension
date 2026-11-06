export const MAX_NETWORK_ENTRIES = 1000;
const MAX_METHOD_CHARS = 32;
const MAX_TYPE_CHARS = 32;
const MAX_ERROR_CHARS = 200;

// One request seen through webRequest. The url is stored already redacted. A request without end is pending;
// a finished one has either a status, an error, or redirected when the same request id started again.
export interface NetworkEntry {
  requestId: string;
  url: string;
  method: string;
  type: string;
  start: number;
  end?: number;
  status?: number;
  error?: string;
  redirected?: true;
}

// Requests of one tab while its top frame stays on host.
export interface NetworkCapture {
  host: string;
  since: number;
  dropped: number;
  entries: NetworkEntry[];
}

export interface RequestStart {
  requestId: string;
  url: string;
  method: string;
  type: string;
  timeStamp: number;
}

export interface RequestCompletion {
  requestId: string;
  statusCode: number;
  timeStamp: number;
}

export interface RequestFailure {
  requestId: string;
  error: string;
  timeStamp: number;
}

export interface NetworkSelection {
  entries: NetworkEntry[];
  matched: number;
  total: number;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function newCapture(host: string, since: number): NetworkCapture {
  return { host, since, dropped: 0, entries: [] };
}

function pendingEntry(capture: NetworkCapture, requestId: string): NetworkEntry | undefined {
  for (let index = capture.entries.length - 1; index >= 0; index -= 1) {
    const entry = capture.entries[index];
    if (entry?.requestId === requestId) return entry.end === undefined ? entry : undefined;
  }
  return undefined;
}

// Firefox keeps the request id across redirects and fires onBeforeRequest again for the new url.
export function addRequest(capture: NetworkCapture, details: RequestStart): void {
  const previous = pendingEntry(capture, details.requestId);
  if (previous) {
    previous.end = details.timeStamp;
    previous.redirected = true;
  }
  capture.entries.push({
    requestId: details.requestId,
    url: details.url,
    method: clip(details.method, MAX_METHOD_CHARS),
    type: clip(details.type, MAX_TYPE_CHARS),
    start: details.timeStamp,
  });
  if (capture.entries.length > MAX_NETWORK_ENTRIES) {
    const excess = capture.entries.length - MAX_NETWORK_ENTRIES;
    capture.entries.splice(0, excess);
    capture.dropped += excess;
  }
}

// Both return false when the request was not seen starting or has already finished.
export function completeRequest(capture: NetworkCapture, details: RequestCompletion): boolean {
  const entry = pendingEntry(capture, details.requestId);
  if (!entry) return false;
  entry.end = details.timeStamp;
  entry.status = details.statusCode;
  return true;
}

export function failRequest(capture: NetworkCapture, details: RequestFailure): boolean {
  const entry = pendingEntry(capture, details.requestId);
  if (!entry) return false;
  entry.end = details.timeStamp;
  entry.error = clip(details.error.replace(/\s+/g, ' ').trim(), MAX_ERROR_CHARS);
  return true;
}

export function selectRequests(capture: NetworkCapture, options: { urlPattern?: string; limit: number }): NetworkSelection {
  const needle = options.urlPattern?.toLowerCase();
  const matching = needle === undefined ? capture.entries : capture.entries.filter((entry) => entry.url.toLowerCase().includes(needle));
  return { entries: matching.slice(-options.limit), matched: matching.length, total: capture.entries.length };
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === 'number';
}

function isEntry(value: unknown): value is NetworkEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.requestId === 'string' &&
    typeof entry.url === 'string' &&
    typeof entry.method === 'string' &&
    typeof entry.type === 'string' &&
    typeof entry.start === 'number' &&
    isOptionalNumber(entry.end) &&
    isOptionalNumber(entry.status) &&
    (entry.error === undefined || typeof entry.error === 'string') &&
    (entry.redirected === undefined || entry.redirected === true)
  );
}

export function isNetworkCapture(value: unknown): value is NetworkCapture {
  if (typeof value !== 'object' || value === null) return false;
  const capture = value as Record<string, unknown>;
  return (
    typeof capture.host === 'string' &&
    typeof capture.since === 'number' &&
    Number.isSafeInteger(capture.dropped) &&
    (capture.dropped as number) >= 0 &&
    Array.isArray(capture.entries) &&
    capture.entries.length <= MAX_NETWORK_ENTRIES &&
    capture.entries.every(isEntry)
  );
}
