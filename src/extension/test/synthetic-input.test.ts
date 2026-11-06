// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RefRegistry } from '../page/ref-registry';
import { syntheticInput } from '../page/synthetic-input';
import type { Modifiers, SyntheticInputOptions, SyntheticKey } from '../page/synthetic-input-api';

const NONE: Modifiers = { ctrl: false, shift: false, alt: false, meta: false };

interface Seen {
  type: string;
  target: string;
  trusted: boolean;
  button?: number;
  buttons?: number;
  detail?: number;
  clientX?: number;
  clientY?: number;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  key?: string;
  inputType?: string;
  data?: string | null;
}

const EVENT_TYPES = [
  'pointerover',
  'mouseover',
  'pointermove',
  'mousemove',
  'pointerdown',
  'mousedown',
  'pointerup',
  'mouseup',
  'click',
  'dblclick',
  'contextmenu',
  'wheel',
  'keydown',
  'keyup',
  'beforeinput',
  'input',
];

function record(): Seen[] {
  const seen: Seen[] = [];
  for (const type of EVENT_TYPES) {
    document.addEventListener(
      type,
      (event) => {
        const entry: Seen = { type, target: (event.target as Element).id, trusted: event.isTrusted === true };
        if (event instanceof MouseEvent) {
          Object.assign(entry, {
            button: event.button,
            buttons: event.buttons,
            detail: event.detail,
            clientX: event.clientX,
            clientY: event.clientY,
            ctrlKey: event.ctrlKey,
            shiftKey: event.shiftKey,
          });
        }
        if (event instanceof KeyboardEvent) Object.assign(entry, { key: event.key, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey });
        if (event instanceof InputEvent) Object.assign(entry, { inputType: event.inputType, data: event.data });
        seen.push(entry);
      },
      { capture: true },
    );
  }
  return seen;
}

function at(element: Element | null): void {
  document.elementFromPoint = vi.fn(() => element);
}

function byId<T extends Element>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`no #${id}`);
  return element as unknown as T;
}

function run(options: SyntheticInputOptions, registry = new RefRegistry()) {
  return syntheticInput(registry, document, window, options);
}

function key(name: string, modifiers: Partial<Modifiers> = {}): SyntheticKey {
  return { key: name, modifiers: { ...NONE, ...modifiers } };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('synthetic click', () => {
  it('dispatches the pointer and mouse sequence at the element under the point', () => {
    document.body.innerHTML = '<button id="b">Save</button>';
    at(byId('b'));
    const seen = record();
    expect(run({ kind: 'click', point: { x: 40, y: 12 }, button: 'left', clickCount: 1, modifiers: { ...NONE, ctrl: true } })).toEqual({
      ok: true,
    });
    expect(seen.map((event) => event.type)).toEqual([
      'pointerover',
      'mouseover',
      'pointermove',
      'mousemove',
      'pointerdown',
      'mousedown',
      'pointerup',
      'mouseup',
      'click',
    ]);
    expect(seen.every((event) => event.target === 'b' && !event.trusted)).toBe(true);
    const down = seen.find((event) => event.type === 'mousedown');
    expect(down).toMatchObject({ button: 0, buttons: 1, detail: 1, clientX: 40, clientY: 12, ctrlKey: true, shiftKey: false });
    expect(seen.find((event) => event.type === 'mouseup')).toMatchObject({ button: 0, buttons: 0 });
    expect(seen.find((event) => event.type === 'click')).toMatchObject({ button: 0, detail: 1, ctrlKey: true });
  });

  it('counts clicks in detail and fires dblclick after the second click', () => {
    document.body.innerHTML = '<p id="p">text</p>';
    at(byId('p'));
    const seen = record();
    run({ kind: 'click', point: { x: 1, y: 1 }, button: 'left', clickCount: 3, modifiers: NONE });
    expect(
      seen.filter((event) => event.type === 'click' || event.type === 'dblclick').map((event) => [event.type, event.detail]),
    ).toEqual([
      ['click', 1],
      ['click', 2],
      ['dblclick', 2],
      ['click', 3],
    ]);
  });

  it('fires contextmenu instead of click for the right button', () => {
    document.body.innerHTML = '<div id="d">menu</div>';
    at(byId('d'));
    const seen = record();
    run({ kind: 'click', point: { x: 5, y: 5 }, button: 'right', clickCount: 1, modifiers: NONE });
    expect(seen.map((event) => event.type).slice(4)).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'contextmenu']);
    expect(seen.find((event) => event.type === 'mousedown')).toMatchObject({ button: 2, buttons: 2 });
    expect(seen.find((event) => event.type === 'contextmenu')).toMatchObject({ button: 2 });
  });

  it('targets the ref element instead of the element under the point', () => {
    document.body.innerHTML = '<div id="cover"></div><button id="b">Go</button>';
    at(byId('cover'));
    const registry = new RefRegistry();
    const ref = registry.refFor(byId('b'));
    const seen = record();
    run({ kind: 'click', point: { x: 3, y: 4 }, ref, button: 'left', clickCount: 1, modifiers: NONE }, registry);
    expect(seen.find((event) => event.type === 'click')).toMatchObject({ target: 'b', clientX: 3, clientY: 4 });
    expect(document.elementFromPoint).not.toHaveBeenCalled();
  });

  it('focuses the focusable element that was clicked, including through a child', () => {
    document.body.innerHTML = '<input id="i"><button id="b"><span id="s">Go</span></button>';
    at(byId('i'));
    run({ kind: 'click', point: { x: 1, y: 1 }, button: 'left', clickCount: 1, modifiers: NONE });
    expect(document.activeElement?.id).toBe('i');
    at(byId('s'));
    run({ kind: 'click', point: { x: 1, y: 1 }, button: 'left', clickCount: 1, modifiers: NONE });
    expect(document.activeElement?.id).toBe('b');
  });

  it('runs the activation behavior of the click', () => {
    document.body.innerHTML = '<input id="c" type="checkbox">';
    at(byId('c'));
    run({ kind: 'click', point: { x: 1, y: 1 }, button: 'left', clickCount: 1, modifiers: NONE });
    expect(byId<HTMLInputElement>('c').checked).toBe(true);
  });

  it('fails for a stale ref and for a point with no element', () => {
    document.body.innerHTML = '<button id="b">Go</button>';
    expect(run({ kind: 'click', point: { x: 1, y: 1 }, ref: 'ref_9', button: 'left', clickCount: 1, modifiers: NONE })).toEqual({
      ok: false,
      error: 'ref_9 was not found in this page. Call read_page or find to get fresh element references.',
    });
    at(null);
    expect(run({ kind: 'click', point: { x: 5000, y: 1 }, button: 'left', clickCount: 1, modifiers: NONE })).toEqual({
      ok: false,
      error: 'There is no element at that point in the page. Take a new screenshot and try again.',
    });
  });
});

describe('synthetic hover and drag', () => {
  it('hovers with over and move events and no button', () => {
    document.body.innerHTML = '<a id="a" href="#x">menu</a>';
    at(byId('a'));
    const seen = record();
    expect(run({ kind: 'hover', point: { x: 7, y: 8 } })).toEqual({ ok: true });
    expect(seen.map((event) => event.type)).toEqual(['pointerover', 'mouseover', 'pointermove', 'mousemove']);
    expect(seen.find((event) => event.type === 'mousemove')).toMatchObject({ target: 'a', buttons: 0, clientX: 7, clientY: 8 });
  });

  it('presses at the start, moves with the button held and releases at the end', () => {
    document.body.innerHTML = '<div id="from"></div><div id="to"></div>';
    const from = byId('from');
    const to = byId('to');
    document.elementFromPoint = vi.fn((x: number) => (x < 50 ? from : to));
    const seen = record();
    expect(run({ kind: 'drag', start: { x: 10, y: 10 }, end: { x: 100, y: 10 } })).toEqual({ ok: true });
    const down = seen.find((event) => event.type === 'mousedown');
    const up = seen.find((event) => event.type === 'mouseup');
    expect(down).toMatchObject({ target: 'from', clientX: 10, buttons: 1 });
    expect(up).toMatchObject({ target: 'to', clientX: 100, buttons: 0 });
    const moves = seen.slice(seen.indexOf(down as Seen) + 1, seen.indexOf(up as Seen)).filter((event) => event.type === 'mousemove');
    expect(moves.length).toBeGreaterThan(1);
    expect(moves.every((event) => event.buttons === 1)).toBe(true);
    expect(moves.at(-1)).toMatchObject({ target: 'to', clientX: 100 });
  });
});

describe('synthetic scroll', () => {
  function scroller(): HTMLElement {
    document.body.innerHTML = '<div id="box" style="overflow-y: auto; height: 100px"><p id="row">row</p></div>';
    const box = byId<HTMLElement>('box');
    Object.defineProperty(box, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(box, 'clientHeight', { configurable: true, value: 100 });
    at(byId('row'));
    return box;
  }

  it('dispatches a wheel event and scrolls the nearest scrollable ancestor', () => {
    const box = scroller();
    const seen = record();
    expect(run({ kind: 'scroll', point: { x: 10, y: 10 }, deltaX: 0, deltaY: 300 })).toEqual({ ok: true });
    expect(seen.map((event) => [event.type, event.target])).toEqual([['wheel', 'row']]);
    expect(box.scrollTop).toBe(300);
  });

  it('leaves the scrolling to the page when it cancels the wheel event', () => {
    const box = scroller();
    box.addEventListener('wheel', (event) => event.preventDefault());
    run({ kind: 'scroll', point: { x: 10, y: 10 }, deltaX: 0, deltaY: 300 });
    expect(box.scrollTop).toBe(0);
  });

  it('scrolls the window when no ancestor can scroll', () => {
    document.body.innerHTML = '<p id="p">text</p>';
    at(byId('p'));
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
    run({ kind: 'scroll', point: { x: 1, y: 1 }, deltaX: 0, deltaY: -200 });
    expect(scrollBy).toHaveBeenCalledWith({ left: 0, top: -200, behavior: 'instant' });
  });
});

describe('synthetic type', () => {
  it('inserts the text at the selection of the focused input with beforeinput and input events', () => {
    document.body.innerHTML = '<input id="i" value="helo world">';
    const input = byId<HTMLInputElement>('i');
    input.focus();
    input.setSelectionRange(3, 3);
    const seen = record();
    expect(run({ kind: 'type', text: 'l' })).toEqual({ ok: true });
    expect(input.value).toBe('hello world');
    expect(input.selectionStart).toBe(4);
    expect(seen).toEqual([
      { type: 'beforeinput', target: 'i', trusted: false, inputType: 'insertText', data: 'l' },
      { type: 'input', target: 'i', trusted: false, inputType: 'insertText', data: 'l' },
    ]);
  });

  it('replaces the selected text of a textarea, keeping line breaks', () => {
    document.body.innerHTML = '<textarea id="t">one two</textarea>';
    const area = byId<HTMLTextAreaElement>('t');
    area.focus();
    area.setSelectionRange(4, 7);
    const seen = record();
    run({ kind: 'type', text: 'a\nb' });
    expect(area.value).toBe('one a\nb');
    expect(seen.filter((event) => event.type === 'input').map((event) => event.inputType)).toEqual([
      'insertText',
      'insertLineBreak',
      'insertText',
    ]);
  });

  it('does not change the value when the page cancels beforeinput', () => {
    document.body.innerHTML = '<input id="i" value="x">';
    const input = byId<HTMLInputElement>('i');
    input.addEventListener('beforeinput', (event) => event.preventDefault());
    input.focus();
    run({ kind: 'type', text: 'y' });
    expect(input.value).toBe('x');
  });

  it('types into a contenteditable element through execCommand', () => {
    document.body.innerHTML = '<div id="e" contenteditable="true">x</div>';
    byId<HTMLElement>('e').focus();
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
    try {
      expect(run({ kind: 'type', text: 'hi' })).toEqual({ ok: true });
      expect(execCommand).toHaveBeenCalledWith('insertText', false, 'hi');
    } finally {
      delete (document as unknown as Record<string, unknown>)['execCommand'];
    }
  });

  it('presses Enter for line breaks, so a single-field form submits instead of getting a newline', () => {
    document.body.innerHTML = '<form id="f"><input id="i" name="q"></form>';
    const submitted = vi.fn((event: Event) => event.preventDefault());
    byId('f').addEventListener('submit', submitted);
    const input = byId<HTMLInputElement>('i');
    input.focus();
    const seen = record();
    expect(run({ kind: 'type', text: 'cats\r\n' })).toEqual({ ok: true });
    expect(input.value).toBe('cats');
    expect(submitted).toHaveBeenCalledTimes(1);
    expect(seen.filter((event) => event.type.startsWith('key')).map((event) => [event.type, event.key])).toEqual([
      ['keydown', 'Enter'],
      ['keyup', 'Enter'],
    ]);
  });

  it('presses Tab for tabs and types the rest into the next field', () => {
    document.body.innerHTML = '<input id="a"><input id="b">';
    byId<HTMLElement>('a').focus();
    expect(run({ kind: 'type', text: 'one\ttwo' })).toEqual({ ok: true });
    expect(byId<HTMLInputElement>('a').value).toBe('one');
    expect(byId<HTMLInputElement>('b').value).toBe('two');
    expect(document.activeElement?.id).toBe('b');
  });

  it('reports a partial result when a Tab moves the focus off editable elements', () => {
    document.body.innerHTML = '<input id="a"><button id="b">B</button>';
    byId<HTMLElement>('a').focus();
    expect(run({ kind: 'type', text: 'one\ttwo' })).toEqual({
      ok: false,
      error: 'The focus left the editable element, so the rest of the text was not typed. Click the text field and type the rest.',
    });
    expect(byId<HTMLInputElement>('a').value).toBe('one');
  });

  it('fails when nothing editable is focused', () => {
    document.body.innerHTML = '<button id="b">Go</button>';
    byId<HTMLElement>('b').focus();
    expect(run({ kind: 'type', text: 'a' })).toEqual({
      ok: false,
      error: 'No editable element is focused in the page, so nothing was typed. Click the text field first, then type.',
    });
  });
});

describe('synthetic key', () => {
  it('dispatches keydown and keyup on the focused element with modifier flags', () => {
    document.body.innerHTML = '<input id="i">';
    byId<HTMLElement>('i').focus();
    const seen = record();
    expect(run({ kind: 'key', keys: [key('Escape'), key('x', { ctrl: true })], repeat: 1 })).toEqual({ ok: true });
    expect(seen.map((event) => [event.type, event.target, event.key, event.ctrlKey])).toEqual([
      ['keydown', 'i', 'Escape', false],
      ['keyup', 'i', 'Escape', false],
      ['keydown', 'i', 'x', true],
      ['keyup', 'i', 'x', true],
    ]);
  });

  it('submits the form of a focused input on Enter', () => {
    document.body.innerHTML = '<form id="f"><input id="i" name="q"></form>';
    const submitted = vi.fn((event: Event) => event.preventDefault());
    byId('f').addEventListener('submit', submitted);
    byId<HTMLElement>('i').focus();
    run({ kind: 'key', keys: [key('Enter')], repeat: 1 });
    expect(submitted).toHaveBeenCalledTimes(1);
  });

  it('submits through the default button when the form has several fields', () => {
    document.body.innerHTML =
      '<form id="f"><input id="u" name="u"><input id="p" type="password"><button id="s">Sign in</button></form>';
    let submitter: HTMLElement | null = null;
    byId('f').addEventListener('submit', (event) => {
      event.preventDefault();
      submitter = (event as SubmitEvent).submitter;
    });
    byId<HTMLElement>('u').focus();
    run({ kind: 'key', keys: [key('Enter')], repeat: 1 });
    expect(submitter).toBe(byId('s'));
  });

  it('does not submit a form with several blocking fields and no submit button, or a disabled one', () => {
    document.body.innerHTML =
      '<form id="f"><input id="u"><input id="d" type="date"><input type="checkbox"></form>' +
      '<form id="g"><input id="v"><button id="s" disabled>Go</button></form>';
    const submitted = vi.fn((event: Event) => event.preventDefault());
    byId('f').addEventListener('submit', submitted);
    byId('g').addEventListener('submit', submitted);
    byId<HTMLElement>('u').focus();
    run({ kind: 'key', keys: [key('Enter')], repeat: 1 });
    byId<HTMLElement>('v').focus();
    run({ kind: 'key', keys: [key('Enter')], repeat: 1 });
    expect(submitted).not.toHaveBeenCalled();
  });

  it('submits a form with one blocking field next to other controls', () => {
    document.body.innerHTML = '<form id="f"><input id="i"><input type="checkbox"><select><option>a</option></select></form>';
    const submitted = vi.fn((event: Event) => event.preventDefault());
    byId('f').addEventListener('submit', submitted);
    byId<HTMLElement>('i').focus();
    run({ kind: 'key', keys: [key('Enter')], repeat: 1 });
    expect(submitted).toHaveBeenCalledTimes(1);
  });

  it('does not submit when the page cancels the keydown', () => {
    document.body.innerHTML = '<form id="f"><input id="i" name="q"></form>';
    const submitted = vi.fn((event: Event) => event.preventDefault());
    byId('f').addEventListener('submit', submitted);
    byId('i').addEventListener('keydown', (event) => event.preventDefault());
    byId<HTMLElement>('i').focus();
    run({ kind: 'key', keys: [key('Enter')], repeat: 1 });
    expect(submitted).not.toHaveBeenCalled();
  });

  it('deletes around the caret with Backspace and Delete, repeated', () => {
    document.body.innerHTML = '<input id="i" value="abcdef">';
    const input = byId<HTMLInputElement>('i');
    input.focus();
    input.setSelectionRange(4, 4);
    const seen = record();
    run({ kind: 'key', keys: [key('Backspace')], repeat: 2 });
    expect(input.value).toBe('abef');
    expect(seen.find((event) => event.type === 'beforeinput')).toMatchObject({ inputType: 'deleteContentBackward' });
    run({ kind: 'key', keys: [key('Delete')], repeat: 1 });
    expect(input.value).toBe('abf');
    expect(input.selectionStart).toBe(2);
  });

  it('moves the focus with Tab and Shift+Tab', () => {
    document.body.innerHTML = '<input id="a"><button id="b">B</button><input id="hidden" type="hidden"><textarea id="c"></textarea>';
    byId<HTMLElement>('a').focus();
    run({ kind: 'key', keys: [key('Tab')], repeat: 2 });
    expect(document.activeElement?.id).toBe('c');
    run({ kind: 'key', keys: [key('Tab', { shift: true })], repeat: 1 });
    expect(document.activeElement?.id).toBe('b');
  });

  it('selects all text of the focused field with ctrl+a', () => {
    document.body.innerHTML = '<input id="i" value="select me">';
    const input = byId<HTMLInputElement>('i');
    input.focus();
    input.setSelectionRange(2, 2);
    run({ kind: 'key', keys: [key('a', { ctrl: true })], repeat: 1 });
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 9]);
  });
});
