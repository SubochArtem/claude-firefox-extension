import { MAX_OUTGOING_BYTES } from './native-messaging';
import { isRecord, type ChatEvent } from './protocol';

const NEWLINE = 0x0a;
// A single stream-json line can carry several screenshots; anything longer is dropped, not buffered.
export const MAX_CLAUDE_LINE_BYTES = 64 * 1024 * 1024;
const IMAGE_MARKER = '[image omitted: too large to forward]';
const TOOL_RESULT_MARKER = '[tool result omitted: too large to forward]';
const CLIP_MARKER = '[clipped: too large to forward]';
const LARGE_TOOL_RESULT_CHARS = 1_000;
const CLIP_STEPS = [65_536, 8_192, 1_024, 128];
const SUMMARY_FIELDS = ['subtype', 'session_id', 'uuid', 'parent_tool_use_id'];

/** Splits a byte stream into lines without '\r\n' endings; empty lines are skipped. */
export function createLineReader(onLine: (line: string) => void, maxLineBytes = MAX_CLAUDE_LINE_BYTES): (chunk: Buffer) => void {
  let parts: Buffer[] = [];
  let partsBytes = 0;
  let skipping = false;
  return (chunk) => {
    let start = 0;
    let newline = chunk.indexOf(NEWLINE);
    while (newline !== -1) {
      if (skipping || partsBytes + newline - start > maxLineBytes) {
        if (!skipping) console.error(`[chat] dropped a claude output line over ${maxLineBytes} bytes`);
      } else {
        parts.push(chunk.subarray(start, newline));
        const line = Buffer.concat(parts).toString('utf8').replace(/\r$/, '');
        if (line.trim() !== '') onLine(line);
      }
      parts = [];
      partsBytes = 0;
      skipping = false;
      start = newline + 1;
      newline = chunk.indexOf(NEWLINE, start);
    }
    if (start >= chunk.length || skipping) return;
    partsBytes += chunk.length - start;
    if (partsBytes > maxLineBytes) {
      console.error(`[chat] dropped a claude output line over ${maxLineBytes} bytes`);
      parts = [];
      partsBytes = 0;
      skipping = true;
      return;
    }
    parts.push(chunk.subarray(start));
  };
}

/** A stream-json event, or undefined for anything else claude prints. */
export function parseClaudeLine(line: string): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  return isRecord(value) && typeof value['type'] === 'string' ? value : undefined;
}

function size(message: unknown): number {
  return Buffer.byteLength(JSON.stringify(message), 'utf8');
}

function mapDeep(value: unknown, map: (value: unknown) => unknown): unknown {
  const mapped = map(value);
  if (mapped !== value) return mapped;
  if (Array.isArray(value)) return value.map((item) => mapDeep(item, map));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapDeep(item, map)]));
  return value;
}

function withoutImages(value: unknown): unknown {
  return isRecord(value) && value['type'] === 'image' ? { type: 'text', text: IMAGE_MARKER } : value;
}

function withoutLargeToolResults(value: unknown): unknown {
  if (!isRecord(value) || value['type'] !== 'tool_result') return value;
  if (JSON.stringify(value['content'] ?? '').length <= LARGE_TOOL_RESULT_CHARS) return value;
  return { ...value, content: [{ type: 'text', text: TOOL_RESULT_MARKER }] };
}

function clipStrings(limit: number): (value: unknown) => unknown {
  return (value) => (typeof value === 'string' && value.length > limit ? `${value.slice(0, limit)}${CLIP_MARKER}` : value);
}

function summary(event: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { type: event['type'] };
  for (const field of SUMMARY_FIELDS) {
    const value = event[field];
    if (value === null || (typeof value === 'string' && value.length <= 200)) result[field] = value;
  }
  return result;
}

// Firefox drops the native host when one message exceeds 1 MB, so an event that does not fit is
// reduced step by step (images, then large tool results, then long strings, then a bare summary)
// instead of being split or dropped.
export function chatEventMessage(sessionId: string, event: Record<string, unknown>, maxBytes = MAX_OUTGOING_BYTES): ChatEvent {
  const message: ChatEvent = { type: 'chat_event', sessionId, event };
  if (size(message) <= maxBytes) return message;
  const steps: ((value: unknown) => unknown)[] = [withoutImages, withoutLargeToolResults, ...CLIP_STEPS.map(clipStrings)];
  let reduced: unknown = event;
  for (const step of steps) {
    reduced = mapDeep(reduced, step);
    const candidate: ChatEvent = { type: 'chat_event', sessionId, event: reduced as Record<string, unknown>, reduced: true };
    if (size(candidate) <= maxBytes) return candidate;
  }
  return { type: 'chat_event', sessionId, event: summary(event), reduced: true };
}
