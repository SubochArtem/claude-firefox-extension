import { describe, expect, it } from 'vitest';
import {
  isPageZoomShortcut,
  KEY_VALUES,
  parseKeyText,
  parseModifiers,
  reloadShortcut,
  typedKeyValues,
} from '../tools/input-keys';

const { CONTROL, SHIFT, ALT, META, ENTER, TAB, BACKSPACE, DELETE, ESCAPE } = KEY_VALUES;

describe('KEY_VALUES', () => {
  it('uses the WebDriver key codepoints', () => {
    expect(KEY_VALUES).toEqual({
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
    });
  });
});

describe('parseKeyText', () => {
  it('parses a single named key', () => {
    expect(parseKeyText('Enter')).toEqual({ ok: true, value: [{ modifiers: [], key: ENTER }] });
  });

  it.each([
    ['enter', ''],
    ['return', ''],
    ['kp_enter', ''],
    ['tab', ''],
    ['backspace', ''],
    ['delete', ''],
    ['del', ''],
    ['escape', ''],
    ['esc', ''],
    ['space', ' '],
    ['up', ''],
    ['arrowup', ''],
    ['down', ''],
    ['arrowdown', ''],
    ['left', ''],
    ['arrowleft', ''],
    ['right', ''],
    ['arrowright', ''],
    ['home', ''],
    ['end', ''],
    ['pageup', ''],
    ['pagedown', ''],
    ['insert', ''],
    ['f1', ''],
    ['f5', ''],
    ['f12', ''],
    ['ctrl', ''],
    ['control', ''],
    ['shift', ''],
    ['alt', ''],
    ['option', ''],
    ['meta', ''],
    ['cmd', ''],
    ['command', ''],
    ['super', ''],
    ['win', ''],
    ['windows', ''],
  ])('maps %s', (name, value) => {
    expect(parseKeyText(name)).toEqual({ ok: true, value: [{ modifiers: [], key: value }] });
    expect(parseKeyText(name.toUpperCase())).toEqual({ ok: true, value: [{ modifiers: [], key: value }] });
  });

  it('keeps the case of a lone character', () => {
    expect(parseKeyText('A')).toEqual({ ok: true, value: [{ modifiers: [], key: 'A' }] });
    expect(parseKeyText('a')).toEqual({ ok: true, value: [{ modifiers: [], key: 'a' }] });
    expect(parseKeyText('+')).toEqual({ ok: true, value: [{ modifiers: [], key: '+' }] });
  });

  it('accepts a non-ASCII character, including a surrogate pair', () => {
    expect(parseKeyText('é')).toEqual({ ok: true, value: [{ modifiers: [], key: 'é' }] });
    expect(parseKeyText('😀')).toEqual({ ok: true, value: [{ modifiers: [], key: '😀' }] });
  });

  it('parses a chord with modifiers in order', () => {
    expect(parseKeyText('ctrl+shift+t')).toEqual({ ok: true, value: [{ modifiers: [CONTROL, SHIFT], key: 't' }] });
  });

  it('lowercases a character inside a chord', () => {
    expect(parseKeyText('Ctrl+Shift+T')).toEqual({ ok: true, value: [{ modifiers: [CONTROL, SHIFT], key: 't' }] });
  });

  it('parses modifier aliases and a named key in a chord', () => {
    expect(parseKeyText('cmd+option+Delete')).toEqual({ ok: true, value: [{ modifiers: [META, ALT], key: DELETE }] });
  });

  it('parses a chord ending in a plus key', () => {
    expect(parseKeyText('ctrl++')).toEqual({ ok: true, value: [{ modifiers: [CONTROL], key: '+' }] });
  });

  it('parses several space-separated tokens', () => {
    expect(parseKeyText('  Escape   ctrl+a  Backspace ')).toEqual({
      ok: true,
      value: [
        { modifiers: [], key: ESCAPE },
        { modifiers: [CONTROL], key: 'a' },
        { modifiers: [], key: BACKSPACE },
      ],
    });
  });

  it('accepts a modifier as the key of a chord', () => {
    expect(parseKeyText('ctrl+shift')).toEqual({ ok: true, value: [{ modifiers: [CONTROL], key: SHIFT }] });
  });

  it('rejects empty text', () => {
    expect(parseKeyText('')).toEqual({ ok: false, error: 'key text must not be empty' });
    expect(parseKeyText('   ')).toEqual({ ok: false, error: 'key text must not be empty' });
  });

  it('rejects an unknown key name', () => {
    expect(parseKeyText('ctrl+foo')).toEqual({ ok: false, error: 'Unknown key "foo" in "ctrl+foo"' });
    expect(parseKeyText('enter f13')).toEqual({ ok: false, error: 'Unknown key "f13" in "f13"' });
  });

  it('rejects an unknown modifier', () => {
    expect(parseKeyText('hyper+a')).toEqual({ ok: false, error: 'Unknown modifier "hyper" in "hyper+a"' });
    expect(parseKeyText('a+b')).toEqual({ ok: false, error: 'Unknown modifier "a" in "a+b"' });
  });

  it('rejects an empty chord part', () => {
    expect(parseKeyText('ctrl++a')).toEqual({ ok: false, error: 'Empty key name in "ctrl++a"' });
    expect(parseKeyText('+a')).toEqual({ ok: false, error: 'Empty key name in "+a"' });
  });

  it('rejects a bare ++ token', () => {
    expect(parseKeyText('++')).toEqual({ ok: false, error: 'Empty key name in "++"' });
  });

  it('presses a repeated modifier once', () => {
    expect(parseKeyText('ctrl+ctrl+a')).toEqual({ ok: true, value: [{ modifiers: [CONTROL], key: 'a' }] });
    expect(parseKeyText('ctrl+control+shift+a')).toEqual({
      ok: true,
      value: [{ modifiers: [CONTROL, SHIFT], key: 'a' }],
    });
  });
});

describe('parseModifiers', () => {
  it('returns no modifiers for an empty string', () => {
    expect(parseModifiers('')).toEqual({ ok: true, value: [] });
    expect(parseModifiers('  ')).toEqual({ ok: true, value: [] });
  });

  it('parses modifiers in order with aliases, case-insensitive', () => {
    expect(parseModifiers('Ctrl+shift')).toEqual({ ok: true, value: [CONTROL, SHIFT] });
    expect(parseModifiers('command+option+control')).toEqual({ ok: true, value: [META, ALT, CONTROL] });
    expect(parseModifiers(' win + alt ')).toEqual({ ok: true, value: [META, ALT] });
  });

  it('rejects an unknown modifier', () => {
    expect(parseModifiers('ctrl+a')).toEqual({ ok: false, error: 'Unknown modifier "a" in "ctrl+a"' });
  });

  it('rejects an empty part', () => {
    expect(parseModifiers('ctrl+')).toEqual({ ok: false, error: 'Empty modifier name in "ctrl+"' });
  });

  it('returns a repeated modifier once', () => {
    expect(parseModifiers('ctrl+ctrl')).toEqual({ ok: true, value: [CONTROL] });
    expect(parseModifiers('cmd+shift+meta')).toEqual({ ok: true, value: [META, SHIFT] });
  });
});

describe('typedKeyValues', () => {
  it('splits text into characters', () => {
    expect(typedKeyValues('Hi!')).toEqual(['H', 'i', '!']);
  });

  it('keeps non-ASCII characters and surrogate pairs whole', () => {
    expect(typedKeyValues('é日😀')).toEqual(['é', '日', '😀']);
  });

  it('keeps grapheme clusters whole', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    const flag = '\u{1F1FA}\u{1F1F8}';
    const decomposedE = 'e\u0301';
    expect(typedKeyValues(`a${family}b`)).toEqual(['a', family, 'b']);
    expect(typedKeyValues(`${flag}${flag}`)).toEqual([flag, flag]);
    expect(typedKeyValues(`${decomposedE}x`)).toEqual([decomposedE, 'x']);
  });

  it('drops private use characters so typed text never presses a special key', () => {
    expect(typedKeyValues('a\uE009b')).toEqual(['a', 'b']);
    expect(typedKeyValues('\uE000\uE007\uF8FF')).toEqual([]);
    expect(typedKeyValues('\uDFFF\uF900')).toEqual(['\uDFFF', '\uF900']);
  });

  it('maps line breaks to one Enter each', () => {
    expect(typedKeyValues('a\nb\r\nc\rd')).toEqual(['a', ENTER, 'b', ENTER, 'c', ENTER, 'd']);
    expect(typedKeyValues('\r\n\r\n')).toEqual([ENTER, ENTER]);
    expect(typedKeyValues('\n\r')).toEqual([ENTER, ENTER]);
  });

  it('maps a tab to Tab', () => {
    expect(typedKeyValues('a\tb')).toEqual(['a', TAB, 'b']);
  });

  it('returns nothing for empty text', () => {
    expect(typedKeyValues('')).toEqual([]);
  });
});

describe('isPageZoomShortcut', () => {
  it.each([
    'ctrl++',
    'ctrl+plus',
    'ctrl+=',
    'ctrl+-',
    'ctrl+minus',
    'ctrl+0',
    'ctrl+shift+=',
    'ctrl+shift+plus',
    'Control+Plus',
    'cmd+=',
    'meta+-',
    'command+0',
    'super+plus',
    'win+minus',
    'shift+ctrl+-',
    'a ctrl+0',
  ])('flags %s', (text) => {
    expect(isPageZoomShortcut(text)).toBe(true);
  });

  it.each(['ctrl+a', 'shift+=', '+', '=', '0', 'ctrl+1', 'alt+-', 'ctrl+alt+0', 'ctrl', 'plus', '', 'ctrl+f5'])(
    'does not flag %s',
    (text) => {
      expect(isPageZoomShortcut(text)).toBe(false);
    },
  );
});

describe('reloadShortcut', () => {
  it.each([
    ['ctrl+r', 'reload'],
    ['Ctrl+R', 'reload'],
    ['control+r', 'reload'],
    ['cmd+r', 'reload'],
    ['meta+r', 'reload'],
    ['command+r', 'reload'],
    ['f5', 'reload'],
    ['F5', 'reload'],
    [' f5 ', 'reload'],
    ['ctrl+shift+r', 'hard'],
    ['shift+ctrl+r', 'hard'],
    ['cmd+shift+R', 'hard'],
    ['ctrl+f5', 'hard'],
    ['shift+f5', 'hard'],
  ] as const)('maps %s to %s', (text, kind) => {
    expect(reloadShortcut(text)).toBe(kind);
  });

  it.each(['r', 'shift+r', 'alt+r', 'ctrl+alt+r', 'ctrl+shift+f5', 'alt+f5', 'f5 f5', 'ctrl+r a', 'ctrl+t', '', 'f4'])(
    'returns undefined for %s',
    (text) => {
      expect(reloadShortcut(text)).toBeUndefined();
    },
  );
});
