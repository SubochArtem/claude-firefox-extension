// Name of the entry point that page/console-capture.js installs in the page's MAIN world, where the page
// can see and replace it; its content is page-controlled anyway.
export const CONSOLE_ENTRY = '__claudeFirefoxConsole';
export const CONSOLE_SCRIPT = 'page/console-capture.js';

export const CONSOLE_LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const;
export type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];

export const MAX_CONSOLE_ENTRIES = 10_000;
export const MAX_ENTRY_CHARS = 2_000;

export interface ConsoleEntry {
  level: ConsoleLevel;
  text: string;
  time: number;
  url: string;
}

export interface ConsoleFilter {
  onlyErrors: boolean;
  pattern?: string;
  limit: number;
}

export interface ConsoleReadOptions extends ConsoleFilter {
  clear: boolean;
}

// matched: entries passing the filter; total: entries in the buffer; dropped: entries pushed out of the
// full buffer since capture started or was last cleared; since: when that was.
export interface ConsoleReadResult {
  ok: true;
  entries: ConsoleEntry[];
  matched: number;
  total: number;
  dropped: number;
  since: number;
}

export type ConsoleEntryPoint = (options: ConsoleReadOptions) => ConsoleReadResult;
