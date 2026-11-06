// Installed by page/read-page.js next to the read_page entry point, so it resolves the same refs.
export const SYNTHETIC_INPUT_ENTRY = '__claudeFirefoxSyntheticInput';

export interface Modifiers {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

// CSS pixels relative to the viewport.
export interface PagePoint {
  x: number;
  y: number;
}

// key is a KeyboardEvent.key value such as "a", "Enter" or "ArrowLeft".
export interface SyntheticKey {
  key: string;
  modifiers: Modifiers;
}

// ref, when given, is the target instead of the element at point.
export type SyntheticInputOptions =
  | { kind: 'click'; point: PagePoint; ref?: string; button: 'left' | 'right'; clickCount: number; modifiers: Modifiers }
  | { kind: 'hover'; point: PagePoint; ref?: string }
  | { kind: 'drag'; start: PagePoint; end: PagePoint }
  | { kind: 'scroll'; point: PagePoint; deltaX: number; deltaY: number }
  | { kind: 'type'; text: string }
  | { kind: 'key'; keys: SyntheticKey[]; repeat: number };

export type SyntheticInputResult = { ok: true } | { ok: false; error: string };

export type SyntheticInputEntry = (options: SyntheticInputOptions) => SyntheticInputResult;
