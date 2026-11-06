import { describeConsoleValue, formatConsoleArgs } from './console-args';
import {
  CONSOLE_ENTRY,
  CONSOLE_LEVELS,
  type ConsoleEntry,
  type ConsoleEntryPoint,
  type ConsoleLevel,
  MAX_CONSOLE_ENTRIES,
  MAX_ENTRY_CHARS,
} from './console-capture-api';
import { selectConsoleEntries } from './console-filter';

export interface CaptureScope {
  console: Console;
  location: Location;
  addEventListener: Window['addEventListener'];
}

function uncaughtErrorText(event: ErrorEvent): string {
  if (typeof event.error === 'object' && event.error !== null) return `Uncaught ${describeConsoleValue(event.error)}`;
  const message = String(event.message);
  const text = message.startsWith('Uncaught') ? message : `Uncaught ${message}`;
  return event.filename ? `${text} (${event.filename}:${event.lineno}:${event.colno})` : text;
}

function clip(text: string): string {
  return text.length > MAX_ENTRY_CHARS ? `${text.slice(0, MAX_ENTRY_CHARS)}…` : text;
}

// Runs in the page's MAIN world: wraps the console methods (calling through to the originals) and records
// uncaught errors and unhandled rejections in a ring buffer kept in this closure, once per document.
export function installConsoleCapture(scope: CaptureScope, now: () => number = Date.now): void {
  const global = scope as unknown as Record<string, unknown>;
  if (typeof global[CONSOLE_ENTRY] === 'function') return;
  const buffer: ConsoleEntry[] = [];
  let dropped = 0;
  let since = now();
  // Set while a call is recorded, so console calls from getters of a described argument are not recorded.
  let busy = false;

  const capture = (level: ConsoleLevel, text: () => string): void => {
    if (busy) return;
    busy = true;
    try {
      buffer.push({ level, text: clip(text()), time: now(), url: String(scope.location.href) });
      if (buffer.length > MAX_CONSOLE_ENTRIES) {
        const excess = buffer.length - MAX_CONSOLE_ENTRIES;
        buffer.splice(0, excess);
        dropped += excess;
      }
    } catch {
      // A value that cannot be described must not break the page's console call.
    } finally {
      busy = false;
    }
  };

  const console = scope.console as unknown as Record<string, unknown>;
  for (const level of CONSOLE_LEVELS) {
    const original = console[level];
    if (typeof original !== 'function') continue;
    console[level] = function (this: unknown, ...args: unknown[]): unknown {
      capture(level, () => formatConsoleArgs(args));
      return (original as (...args: unknown[]) => unknown).apply(this, args);
    };
  }

  scope.addEventListener('error', (event) => {
    if (typeof (event as Partial<ErrorEvent>).message !== 'string') return;
    capture('error', () => uncaughtErrorText(event as ErrorEvent));
  });
  scope.addEventListener('unhandledrejection', (event) => {
    capture('error', () => `Uncaught (in promise) ${describeConsoleValue((event as PromiseRejectionEvent).reason)}`);
  });

  const entry: ConsoleEntryPoint = (options) => {
    const selection = selectConsoleEntries(buffer, options);
    const result = { ok: true as const, ...selection, total: buffer.length, dropped, since };
    if (options.clear) {
      buffer.length = 0;
      dropped = 0;
      since = now();
    }
    return result;
  };
  Object.defineProperty(scope, CONSOLE_ENTRY, { value: entry, enumerable: false, configurable: false, writable: false });
}
