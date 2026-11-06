// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installConsoleCapture, type CaptureScope } from '../page/console-buffer';
import {
  CONSOLE_ENTRY,
  CONSOLE_LEVELS,
  type ConsoleEntryPoint,
  type ConsoleReadOptions,
  MAX_CONSOLE_ENTRIES,
} from '../page/console-capture-api';

const READ_ALL: ConsoleReadOptions = { onlyErrors: false, limit: 1000, clear: false };

let originals: Record<string, ReturnType<typeof vi.fn>>;
let target: EventTarget;
let scope: CaptureScope;
let clock: number;

function entryOf(on: CaptureScope = scope): ConsoleEntryPoint {
  const entry = (on as unknown as Record<string, unknown>)[CONSOLE_ENTRY];
  if (typeof entry !== 'function') throw new Error('entry point not installed');
  return entry as ConsoleEntryPoint;
}

function rejection(reason: unknown): Event {
  const event = new Event('unhandledrejection');
  Object.defineProperty(event, 'reason', { value: reason });
  return event;
}

beforeEach(() => {
  originals = Object.fromEntries(CONSOLE_LEVELS.map((level) => [level, vi.fn(() => `${level} result`)]));
  target = new EventTarget();
  clock = 1_000;
  scope = {
    console: { ...originals } as unknown as Console,
    location: { href: 'https://example.com/app' } as Location,
    addEventListener: target.addEventListener.bind(target) as Window['addEventListener'],
  };
  installConsoleCapture(scope, () => clock++);
});

describe('installConsoleCapture', () => {
  it('installs itself on the page global when the bundle loads', async () => {
    await import('../page/console-capture');
    const entry = (globalThis as unknown as Record<string, unknown>)[CONSOLE_ENTRY] as ConsoleEntryPoint;
    expect(typeof entry).toBe('function');
    console.info('from the page');
    expect(entry(READ_ALL).entries.map(({ level, text }) => ({ level, text }))).toEqual([{ level: 'info', text: 'from the page' }]);
  });

  it('records every console level with its text, time and page URL', () => {
    scope.console.log('Loaded', 3, 'items');
    scope.console.info('info');
    scope.console.warn('careful');
    scope.console.error('broken', { code: 500 });
    scope.console.debug('details');
    expect(entryOf()(READ_ALL)).toEqual({
      ok: true,
      entries: [
        { level: 'log', text: 'Loaded 3 items', time: 1_001, url: 'https://example.com/app' },
        { level: 'info', text: 'info', time: 1_002, url: 'https://example.com/app' },
        { level: 'warn', text: 'careful', time: 1_003, url: 'https://example.com/app' },
        { level: 'error', text: 'broken {code: 500}', time: 1_004, url: 'https://example.com/app' },
        { level: 'debug', text: 'details', time: 1_005, url: 'https://example.com/app' },
      ],
      matched: 5,
      total: 5,
      dropped: 0,
      since: 1_000,
    });
  });

  it('calls through to the original console with the same this and arguments', () => {
    const value = { a: 1 };
    const result = scope.console.log('text', value);
    expect(result).toBe('log result');
    expect(originals.log).toHaveBeenCalledWith('text', value);
    expect(originals.log?.mock.contexts[0]).toBe(scope.console);
  });

  it('still calls the original when recording fails', () => {
    Object.defineProperty(scope.location, 'href', {
      get() {
        throw new Error('location is gone');
      },
    });
    expect(scope.console.error('lost')).toBe('error result');
    expect(originals.error).toHaveBeenCalledWith('lost');
    expect(entryOf()(READ_ALL).total).toBe(0);
  });

  it('records the URL at the time of the call', () => {
    scope.console.log('first');
    (scope.location as { href: string }).href = 'https://example.com/app#/settings';
    scope.console.log('second');
    expect(entryOf()(READ_ALL).entries.map((entry) => entry.url)).toEqual([
      'https://example.com/app',
      'https://example.com/app#/settings',
    ]);
  });

  it('records uncaught errors as errors', () => {
    const error = new TypeError('x is undefined');
    error.stack = 'run@https://example.com/app.js:3:7\n';
    target.dispatchEvent(new ErrorEvent('error', { error, message: 'TypeError: x is undefined', filename: 'https://example.com/app.js', lineno: 3, colno: 7 }));
    target.dispatchEvent(new ErrorEvent('error', { message: 'Script error.', filename: '', lineno: 0, colno: 0 }));
    target.dispatchEvent(new ErrorEvent('error', { message: 'Uncaught boom', filename: 'https://cdn.example/lib.js', lineno: 1, colno: 2 }));
    expect(entryOf()(READ_ALL).entries.map(({ level, text }) => ({ level, text }))).toEqual([
      { level: 'error', text: 'Uncaught TypeError: x is undefined\n    at run@https://example.com/app.js:3:7' },
      { level: 'error', text: 'Uncaught Script error.' },
      { level: 'error', text: 'Uncaught boom (https://cdn.example/lib.js:1:2)' },
    ]);
  });

  it('ignores error events that are not script errors', () => {
    target.dispatchEvent(new Event('error'));
    expect(entryOf()(READ_ALL).total).toBe(0);
  });

  it('records unhandled promise rejections as errors', () => {
    target.dispatchEvent(rejection(new Error('fetch failed')));
    target.dispatchEvent(rejection('plain reason'));
    expect(entryOf()(READ_ALL).entries.map(({ level, text }) => ({ level, text }))).toEqual([
      { level: 'error', text: expect.stringMatching(/^Uncaught \(in promise\) Error: fetch failed/) },
      { level: 'error', text: 'Uncaught (in promise) plain reason' },
    ]);
  });

  it('does not record console calls made while describing an argument', () => {
    const noisy = {
      get value() {
        scope.console.log('from a getter');
        return 1;
      },
    };
    scope.console.log(noisy);
    expect(entryOf()(READ_ALL).entries.map((entry) => entry.text)).toEqual(['{value: 1}']);
    expect(originals.log).toHaveBeenCalledWith('from a getter');
  });

  it('keeps the last entries up to the cap and counts the dropped ones', () => {
    for (let index = 0; index < MAX_CONSOLE_ENTRIES + 3; index++) scope.console.log(`message ${index}`);
    const result = entryOf()({ onlyErrors: false, limit: 2, clear: false });
    expect(result.total).toBe(MAX_CONSOLE_ENTRIES);
    expect(result.dropped).toBe(3);
    expect(result.matched).toBe(MAX_CONSOLE_ENTRIES);
    expect(result.entries.map((entry) => entry.text)).toEqual([
      `message ${MAX_CONSOLE_ENTRIES + 1}`,
      `message ${MAX_CONSOLE_ENTRIES + 2}`,
    ]);
    expect(entryOf()({ onlyErrors: false, limit: 1000, pattern: '^message 2$', clear: false }).matched).toBe(0);
  });

  it('filters with onlyErrors, pattern and limit', () => {
    scope.console.log('request started');
    scope.console.error('request failed');
    scope.console.warn('slow request');
    expect(entryOf()({ onlyErrors: true, limit: 10, clear: false }).entries.map((entry) => entry.text)).toEqual(['request failed']);
    const byPattern = entryOf()({ onlyErrors: false, pattern: 'start|slow', limit: 1, clear: false });
    expect(byPattern.entries.map((entry) => entry.text)).toEqual(['slow request']);
    expect(byPattern.matched).toBe(2);
    expect(byPattern.total).toBe(3);
  });

  it('clears the buffer after reading when asked', () => {
    for (let index = 0; index < MAX_CONSOLE_ENTRIES + 1; index++) scope.console.log('x');
    clock = 5_000;
    const read = entryOf()({ onlyErrors: true, limit: 10, clear: true });
    expect(read).toMatchObject({ entries: [], total: MAX_CONSOLE_ENTRIES, dropped: 1, since: 1_000 });
    expect(entryOf()(READ_ALL)).toMatchObject({ entries: [], total: 0, dropped: 0, since: 5_000 });
    scope.console.log('after');
    expect(entryOf()(READ_ALL).entries.map((entry) => entry.text)).toEqual(['after']);
  });

  it('returns copies that later calls do not change', () => {
    scope.console.log('one');
    const first = entryOf()(READ_ALL);
    scope.console.log('two');
    expect(first.entries).toHaveLength(1);
  });

  it('installs once per page', () => {
    const entry = entryOf();
    const wrapped = scope.console.log;
    installConsoleCapture(scope, () => clock++);
    expect(entryOf()).toBe(entry);
    expect(scope.console.log).toBe(wrapped);
    scope.console.log('once');
    expect(originals.log).toHaveBeenCalledTimes(1);
    expect(entry(READ_ALL).total).toBe(1);
  });

  it('hides the entry point from enumeration', () => {
    expect(Object.keys(scope)).not.toContain(CONSOLE_ENTRY);
  });

  it('skips console methods the page removed', () => {
    const partial: CaptureScope = {
      console: { log: vi.fn() } as unknown as Console,
      location: { href: 'https://example.com/' } as Location,
      addEventListener: target.addEventListener.bind(target) as Window['addEventListener'],
    };
    installConsoleCapture(partial, () => 1);
    partial.console.log('kept');
    expect(entryOf(partial)(READ_ALL).entries.map((entry) => entry.text)).toEqual(['kept']);
    expect(partial.console.error).toBeUndefined();
  });
});
