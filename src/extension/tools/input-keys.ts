import type { ParseResult } from './navigation-input';

export const KEY_VALUES = {
  CONTROL: '',
  SHIFT: '',
  ALT: '',
  META: '',
  ENTER: '',
  TAB: '',
  BACKSPACE: '',
  DELETE: '',
  ESCAPE: '',
  ARROW_UP: '',
  ARROW_DOWN: '',
  ARROW_LEFT: '',
  ARROW_RIGHT: '',
  HOME: '',
  END: '',
  PAGE_UP: '',
  PAGE_DOWN: '',
  INSERT: '',
} as const;

const F1_CODEPOINT = 0xe031;
const FUNCTION_KEY_COUNT = 12;

const MODIFIERS: Readonly<Record<string, string>> = {
  ctrl: KEY_VALUES.CONTROL,
  control: KEY_VALUES.CONTROL,
  shift: KEY_VALUES.SHIFT,
  alt: KEY_VALUES.ALT,
  option: KEY_VALUES.ALT,
  meta: KEY_VALUES.META,
  cmd: KEY_VALUES.META,
  command: KEY_VALUES.META,
  super: KEY_VALUES.META,
  win: KEY_VALUES.META,
  windows: KEY_VALUES.META,
};

const NAMED_KEYS: Readonly<Record<string, string>> = {
  ...MODIFIERS,
  enter: KEY_VALUES.ENTER,
  return: KEY_VALUES.ENTER,
  kp_enter: KEY_VALUES.ENTER,
  tab: KEY_VALUES.TAB,
  backspace: KEY_VALUES.BACKSPACE,
  delete: KEY_VALUES.DELETE,
  del: KEY_VALUES.DELETE,
  escape: KEY_VALUES.ESCAPE,
  esc: KEY_VALUES.ESCAPE,
  space: ' ',
  up: KEY_VALUES.ARROW_UP,
  arrowup: KEY_VALUES.ARROW_UP,
  down: KEY_VALUES.ARROW_DOWN,
  arrowdown: KEY_VALUES.ARROW_DOWN,
  left: KEY_VALUES.ARROW_LEFT,
  arrowleft: KEY_VALUES.ARROW_LEFT,
  right: KEY_VALUES.ARROW_RIGHT,
  arrowright: KEY_VALUES.ARROW_RIGHT,
  home: KEY_VALUES.HOME,
  end: KEY_VALUES.END,
  pageup: KEY_VALUES.PAGE_UP,
  pagedown: KEY_VALUES.PAGE_DOWN,
  insert: KEY_VALUES.INSERT,
  ...Object.fromEntries(
    Array.from({ length: FUNCTION_KEY_COUNT }, (_, i) => [`f${i + 1}`, String.fromCharCode(F1_CODEPOINT + i)]),
  ),
};

const ZOOM_KEYS: ReadonlySet<string> = new Set(['+', '=', '-', '0', 'plus', 'minus']);

export interface KeyChord {
  modifiers: string[];
  key: string;
}

interface ChordParts {
  modifierNames: string[];
  keyName: string;
}

function isSingleCharacter(text: string): boolean {
  return Array.from(text).length === 1;
}

function quote(text: string): string {
  return JSON.stringify(text);
}

function tokenize(text: string): string[] {
  return text.split(/\s+/).filter((token) => token !== '');
}

function splitChord(token: string): ParseResult<ChordParts> {
  if (isSingleCharacter(token)) return { ok: true, value: { modifierNames: [], keyName: token } };
  const parts = token.length > 2 && token.endsWith('++') ? [...token.slice(0, -2).split('+'), '+'] : token.split('+');
  if (parts.some((part) => part === '')) return { ok: false, error: `Empty key name in ${quote(token)}` };
  return { ok: true, value: { modifierNames: parts.slice(0, -1), keyName: parts[parts.length - 1] ?? '' } };
}

function modifierValue(name: string, source: string): ParseResult<string> {
  const value = MODIFIERS[name.toLowerCase()];
  if (value === undefined) return { ok: false, error: `Unknown modifier ${quote(name)} in ${quote(source)}` };
  return { ok: true, value };
}

function parseToken(token: string): ParseResult<KeyChord> {
  const split = splitChord(token);
  if (!split.ok) return split;
  const { modifierNames, keyName } = split.value;
  const modifiers: string[] = [];
  for (const name of modifierNames) {
    const modifier = modifierValue(name, token);
    if (!modifier.ok) return modifier;
    if (!modifiers.includes(modifier.value)) modifiers.push(modifier.value);
  }
  if (isSingleCharacter(keyName)) {
    return { ok: true, value: { modifiers, key: modifierNames.length === 0 ? keyName : keyName.toLowerCase() } };
  }
  const key = NAMED_KEYS[keyName.toLowerCase()];
  if (key === undefined) return { ok: false, error: `Unknown key ${quote(keyName)} in ${quote(token)}` };
  return { ok: true, value: { modifiers, key } };
}

export function parseKeyText(text: string): ParseResult<KeyChord[]> {
  const tokens = tokenize(text);
  if (tokens.length === 0) return { ok: false, error: 'key text must not be empty' };
  const chords: KeyChord[] = [];
  for (const token of tokens) {
    const chord = parseToken(token);
    if (!chord.ok) return chord;
    chords.push(chord.value);
  }
  return { ok: true, value: chords };
}

export function parseModifiers(text: string): ParseResult<string[]> {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, value: [] };
  const modifiers: string[] = [];
  for (const part of trimmed.split('+').map((name) => name.trim())) {
    if (part === '') return { ok: false, error: `Empty modifier name in ${quote(text)}` };
    const modifier = modifierValue(part, text);
    if (!modifier.ok) return modifier;
    if (!modifiers.includes(modifier.value)) modifiers.push(modifier.value);
  }
  return { ok: true, value: modifiers };
}

// WebDriver special keys live in the private use area, so typed text must not carry any of its code points.
const PRIVATE_USE_AREA = /[\uE000-\uF8FF]/g;

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function typedKeyValues(text: string): string[] {
  const values: string[] = [];
  for (const { segment } of graphemes.segment(text.replace(PRIVATE_USE_AREA, ''))) {
    if (segment === '\r\n' || segment === '\r' || segment === '\n') values.push(KEY_VALUES.ENTER);
    else if (segment === '\t') values.push(KEY_VALUES.TAB);
    else values.push(segment);
  }
  return values;
}

interface ShortcutChord {
  modifiers: ReadonlySet<string>;
  key: string;
}

function shortcutChord(token: string): ShortcutChord | undefined {
  const split = splitChord(token);
  if (!split.ok) return undefined;
  const modifiers = new Set<string>();
  for (const name of split.value.modifierNames) {
    const modifier = MODIFIERS[name.toLowerCase()];
    if (modifier === undefined) return undefined;
    modifiers.add(modifier);
  }
  return { modifiers, key: split.value.keyName.toLowerCase() };
}

function hasExactly(modifiers: ReadonlySet<string>, expected: readonly string[]): boolean {
  return modifiers.size === expected.length && expected.every((modifier) => modifiers.has(modifier));
}

export function isPageZoomShortcut(text: string): boolean {
  const { CONTROL, META, SHIFT } = KEY_VALUES;
  return tokenize(text).some((token) => {
    const chord = shortcutChord(token);
    if (chord === undefined || !ZOOM_KEYS.has(chord.key)) return false;
    const { modifiers } = chord;
    if (!modifiers.has(CONTROL) && !modifiers.has(META)) return false;
    return [...modifiers].every((modifier) => modifier === CONTROL || modifier === META || modifier === SHIFT);
  });
}

export function reloadShortcut(text: string): 'reload' | 'hard' | undefined {
  const { CONTROL, META, SHIFT } = KEY_VALUES;
  const tokens = tokenize(text);
  if (tokens.length !== 1 || tokens[0] === undefined) return undefined;
  const chord = shortcutChord(tokens[0]);
  if (chord === undefined) return undefined;
  const { modifiers, key } = chord;
  if (key === 'r') {
    if (hasExactly(modifiers, [CONTROL]) || hasExactly(modifiers, [META])) return 'reload';
    if (hasExactly(modifiers, [CONTROL, SHIFT]) || hasExactly(modifiers, [META, SHIFT])) return 'hard';
    return undefined;
  }
  if (key === 'f5') {
    if (modifiers.size === 0) return 'reload';
    if (hasExactly(modifiers, [CONTROL]) || hasExactly(modifiers, [SHIFT])) return 'hard';
  }
  return undefined;
}
