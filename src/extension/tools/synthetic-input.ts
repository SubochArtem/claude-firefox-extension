import { READ_PAGE_SCRIPT } from '../page/read-page-api';
import {
  type Modifiers,
  SYNTHETIC_INPUT_ENTRY,
  type SyntheticInputOptions,
  type SyntheticInputResult,
  type SyntheticKey,
} from '../page/synthetic-input-api';
import { F1_CODEPOINT, FUNCTION_KEY_COUNT, KEY_VALUES, parseKeyText } from './input-keys';
import type { ParseResult } from './navigation-input';
import { changeTabPage, type OpenTab, type PageAccess, requireSameSite } from './page-script';
import { ToolError } from './tool-error';

const TOOL = 'computer';

const DOM_KEYS: Readonly<Record<string, string>> = {
  [KEY_VALUES.CONTROL]: 'Control',
  [KEY_VALUES.SHIFT]: 'Shift',
  [KEY_VALUES.ALT]: 'Alt',
  [KEY_VALUES.META]: 'Meta',
  [KEY_VALUES.ENTER]: 'Enter',
  [KEY_VALUES.TAB]: 'Tab',
  [KEY_VALUES.BACKSPACE]: 'Backspace',
  [KEY_VALUES.DELETE]: 'Delete',
  [KEY_VALUES.ESCAPE]: 'Escape',
  [KEY_VALUES.ARROW_UP]: 'ArrowUp',
  [KEY_VALUES.ARROW_DOWN]: 'ArrowDown',
  [KEY_VALUES.ARROW_LEFT]: 'ArrowLeft',
  [KEY_VALUES.ARROW_RIGHT]: 'ArrowRight',
  [KEY_VALUES.HOME]: 'Home',
  [KEY_VALUES.END]: 'End',
  [KEY_VALUES.PAGE_UP]: 'PageUp',
  [KEY_VALUES.PAGE_DOWN]: 'PageDown',
  [KEY_VALUES.INSERT]: 'Insert',
  ...Object.fromEntries(
    Array.from({ length: FUNCTION_KEY_COUNT }, (_, i) => [String.fromCharCode(F1_CODEPOINT + i), `F${i + 1}`]),
  ),
};

export function fallbackWarning(cause: string): string {
  return `Warning: WebDriver BiDi is unavailable, so the input was sent as synthetic DOM events, which some pages ignore. For real input, start Firefox with --remote-debugging-port. Cause: ${cause}`;
}

// values are WebDriver key values of modifiers, as returned by parseModifiers and parseKeyText.
export function modifierFlags(values: readonly string[]): Modifiers {
  return {
    ctrl: values.includes(KEY_VALUES.CONTROL),
    shift: values.includes(KEY_VALUES.SHIFT),
    alt: values.includes(KEY_VALUES.ALT),
    meta: values.includes(KEY_VALUES.META),
  };
}

export function syntheticKeys(text: string): ParseResult<SyntheticKey[]> {
  const chords = parseKeyText(text);
  if (!chords.ok) return chords;
  return {
    ok: true,
    value: chords.value.map(({ key, modifiers }) => ({ key: DOM_KEYS[key] ?? key, modifiers: modifierFlags(modifiers) })),
  };
}

function isResult(value: unknown): value is SyntheticInputResult {
  if (typeof value !== 'object' || value === null) return false;
  const reply = value as Record<string, unknown>;
  return reply.ok === true || (reply.ok === false && typeof reply.error === 'string');
}

// The fallback input runs in the page's isolated world through the read_page bundle, so ref targets
// resolve against the same registry; the tab must still be on the approved host.
export async function runSyntheticInput(tab: OpenTab, access: PageAccess, options: SyntheticInputOptions): Promise<void> {
  const url = await requireSameSite(TOOL, tab.tabId, tab.host, access);
  const script = { entry: SYNTHETIC_INPUT_ENTRY, file: READ_PAGE_SCRIPT, options, isResult };
  const result = await changeTabPage(TOOL, { ...tab, url }, script, access);
  if (!result.ok) throw new ToolError(result.error);
}
