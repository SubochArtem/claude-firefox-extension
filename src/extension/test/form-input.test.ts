// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FormInputResult, FormValue } from '../page/form-input-api';
import { MAX_LISTED_OPTIONS, setFormValue } from '../page/form-input';
import { RefRegistry } from '../page/ref-registry';

interface Setup {
  registry: RefRegistry;
  element: Element;
  ref: string;
}

function setup(html: string, selector = '[data-target]'): Setup {
  document.body.innerHTML = html;
  const element = document.querySelector(selector);
  if (!element) throw new Error(`no element for ${selector}`);
  const registry = new RefRegistry();
  return { registry, element, ref: registry.refFor(element) };
}

function run(html: string, value: FormValue, selector?: string): FormInputResult & { element: Element } {
  const { registry, element, ref } = setup(html, selector);
  return { ...setFormValue(registry, { ref, value }), element };
}

function text(html: string, value: FormValue, selector?: string): string {
  const result = run(html, value, selector);
  if (!result.ok) throw new Error(result.error);
  return result.text;
}

function failure(html: string, value: FormValue, selector?: string): string {
  const result = run(html, value, selector);
  if (result.ok) throw new Error(`expected an error, got ${result.text}`);
  return result.error;
}

function recordEvents(element: Element): string[] {
  const events: string[] = [];
  for (const type of ['input', 'change']) {
    document.body.addEventListener(type, (event) => {
      if (event.target === element) events.push(`${type}:${event.bubbles ? 'bubbles' : 'flat'}`);
    });
  }
  return events;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('refs', () => {
  it('names an unknown ref', () => {
    const registry = new RefRegistry();
    expect(setFormValue(registry, { ref: 'ref_9', value: 'x' })).toEqual({
      ok: false,
      error: 'ref_9 was not found in this page. Call read_page or find to get fresh element references.',
    });
  });

  it('names a ref whose element is gone', () => {
    const { registry, element, ref } = setup('<input data-target>');
    element.remove();
    expect(setFormValue(registry, { ref, value: 'x' })).toEqual({
      ok: false,
      error: `${ref} no longer exists in the page. Call read_page or find to get fresh element references.`,
    });
  });
});

describe('disabled and read-only fields', () => {
  it.each([
    ['<input data-target disabled value="old">', 'disabled'],
    ['<input data-target type="checkbox" disabled>', 'disabled'],
    ['<select data-target disabled><option>old</option><option>new</option></select>', 'disabled'],
    ['<textarea data-target disabled>old</textarea>', 'disabled'],
    ['<input data-target readonly value="old">', 'read-only'],
    ['<input data-target type="number" readonly value="1">', 'read-only'],
    ['<textarea data-target readonly>old</textarea>', 'read-only'],
  ])('refuses %s before any side effect', (html, state) => {
    const { registry, element, ref } = setup(html);
    const before = (element as HTMLInputElement).value;
    const events = recordEvents(element);
    const scroll = vi.spyOn(element, 'scrollIntoView');
    const value = (element as HTMLInputElement).type === 'checkbox' ? true : 'new';
    expect(setFormValue(registry, { ref, value })).toEqual({ ok: false, error: `${ref} is ${state} and cannot be changed` });
    expect((element as HTMLInputElement).value).toBe(before);
    expect((element as HTMLInputElement).checked ?? false).toBe(false);
    expect(events).toEqual([]);
    expect(scroll).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(element);
  });

  it('refuses a field disabled by its context', () => {
    const { registry, element, ref } = setup('<input data-target value="old">');
    vi.spyOn(element, 'matches').mockImplementation((selector) => selector === ':disabled');
    expect(setFormValue(registry, { ref, value: 'new' })).toEqual({ ok: false, error: `${ref} is disabled and cannot be changed` });
    expect((element as HTMLInputElement).value).toBe('old');
  });

  it('allows a select with a readonly attribute, which the browser ignores', () => {
    expect(text('<select data-target readonly><option>A</option><option>B</option></select>', 'B')).toBe(
      'Selected option "B" (previous: "A")',
    );
  });
});

describe('scroll and focus', () => {
  it('scrolls the element into view, centred and instant, and focuses it', () => {
    const { registry, element, ref } = setup('<input data-target>');
    const scroll = vi.spyOn(element, 'scrollIntoView');
    expect(setFormValue(registry, { ref, value: 'x' }).ok).toBe(true);
    expect(scroll).toHaveBeenCalledWith({ behavior: 'instant', block: 'center', inline: 'center' });
    expect(document.activeElement).toBe(element);
  });
});

describe('text inputs', () => {
  it('sets the value of a text input and reports the previous value', () => {
    const result = run('<input data-target value="old">', 'new value');
    expect(result).toMatchObject({ ok: true, text: 'Set text value to "new value" (previous: "old")' });
    expect((result.element as HTMLInputElement).value).toBe('new value');
  });

  it.each(['email', 'search', 'url', 'tel'])('sets a %s input', (type) => {
    const result = run(`<input data-target type="${type}">`, 'abc');
    expect(result).toMatchObject({ ok: true, text: `Set ${type} value to "abc" (previous: "")` });
    expect((result.element as HTMLInputElement).value).toBe('abc');
  });

  it.each([
    ['date', '2026-10-31'],
    ['time', '13:45'],
    ['datetime-local', '2026-10-31T13:45'],
    ['month', '2026-10'],
    ['week', '2026-W44'],
  ])('sets a %s input', (type, value) => {
    const result = run(`<input data-target type="${type}">`, value);
    expect(result).toMatchObject({ ok: true, text: `Set ${type} value to "${value}" (previous: "")` });
    expect((result.element as HTMLInputElement).value).toBe(value);
  });

  it('sets a color input', () => {
    expect(text('<input data-target type="color" value="#112233">', '#AABBCC')).toBe(
      'Set color value to "#AABBCC" (previous: "#112233")',
    );
  });

  it.each([
    ['date', '2026-01-02', '31.10.2026', 'YYYY-MM-DD'],
    ['time', '08:00', 'noon', 'HH:MM or HH:MM:SS'],
    ['datetime-local', '2026-01-02T08:00', '2026-10-31', 'YYYY-MM-DDTHH:MM'],
    ['month', '2026-01', 'October', 'YYYY-MM'],
    ['week', '2026-W01', '44', 'YYYY-Www'],
    ['color', '#112233', 'red', '#rrggbb'],
  ])('rejects a malformed %s value, keeps the old value and sends no events', (type, before, value, format) => {
    const { registry, element, ref } = setup(`<input data-target type="${type}" value="${before}">`);
    const events = recordEvents(element);
    expect(setFormValue(registry, { ref, value })).toEqual({
      ok: false,
      error: `Value "${value}" is not a valid ${type} value; expected ${format}`,
    });
    expect((element as HTMLInputElement).value).toBe(before);
    expect(events).toEqual([]);
  });

  it('stringifies numbers and booleans', () => {
    expect(text('<input data-target>', 42)).toBe('Set text value to "42" (previous: "")');
    expect(text('<input data-target>', true)).toBe('Set text value to "true" (previous: "")');
  });

  it('moves the caret to the end of a text input', () => {
    const element = run('<input data-target>', 'hello').element as HTMLInputElement;
    expect(element.selectionStart).toBe(5);
    expect(element.selectionEnd).toBe(5);
  });

  it('sets a textarea and moves the caret to the end', () => {
    const result = run('<textarea data-target>old</textarea>', 'line 1\nline 2');
    expect(result).toMatchObject({ ok: true, text: 'Set textarea value to "line 1 line 2" (previous: "old")' });
    const element = result.element as HTMLTextAreaElement;
    expect(element.value).toBe('line 1\nline 2');
    expect(element.selectionStart).toBe(13);
  });

  it('clips long values in the result', () => {
    const output = text('<input data-target>', 'a'.repeat(300));
    expect(output).toBe(`Set text value to "${'a'.repeat(100)}..." (previous: "")`);
  });

  it('escapes quotes in the result', () => {
    expect(text('<input data-target>', 'say "hi"')).toBe('Set text value to "say \\"hi\\"" (previous: "")');
  });
});

describe('native setters and events', () => {
  it('sets the value through the prototype setter, then dispatches bubbling input and change', () => {
    const { registry, element, ref } = setup('<input data-target value="old">');
    const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (!native?.get || !native.set) throw new Error('no native value accessor');
    let ownSetterCalls = 0;
    const seen: string[] = [];
    Object.defineProperty(element, 'value', {
      configurable: true,
      get(this: HTMLInputElement) {
        return native.get?.call(this);
      },
      set(this: HTMLInputElement, next: string) {
        ownSetterCalls += 1;
        native.set?.call(this, next);
      },
    });
    for (const type of ['input', 'change']) {
      document.body.addEventListener(type, (event) => {
        if (event.target === element) seen.push(`${type}:${event.bubbles}:${(element as HTMLInputElement).value}`);
      });
    }
    expect(setFormValue(registry, { ref, value: 'new' }).ok).toBe(true);
    expect(ownSetterCalls).toBe(0);
    expect(seen).toEqual(['input:true:new', 'change:true:new']);
  });

  it('sets checked through the prototype setter', () => {
    const { registry, element, ref } = setup('<input data-target type="checkbox">');
    const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
    if (!native?.get || !native.set) throw new Error('no native checked accessor');
    let ownSetterCalls = 0;
    Object.defineProperty(element, 'checked', {
      configurable: true,
      get(this: HTMLInputElement) {
        return native.get?.call(this);
      },
      set(this: HTMLInputElement, next: boolean) {
        ownSetterCalls += 1;
        native.set?.call(this, next);
      },
    });
    const events = recordEvents(element);
    expect(setFormValue(registry, { ref, value: true }).ok).toBe(true);
    expect(ownSetterCalls).toBe(0);
    expect((element as HTMLInputElement).checked).toBe(true);
    expect(events).toEqual(['input:bubbles', 'change:bubbles']);
  });

  it('dispatches input and change for a textarea and a select', () => {
    const area = setup('<textarea data-target></textarea>');
    const areaEvents = recordEvents(area.element);
    setFormValue(area.registry, { ref: area.ref, value: 'x' });
    expect(areaEvents).toEqual(['input:bubbles', 'change:bubbles']);

    const select = setup('<select data-target><option>A</option><option>B</option></select>');
    const selectEvents = recordEvents(select.element);
    setFormValue(select.registry, { ref: select.ref, value: 'B' });
    expect(selectEvents).toEqual(['input:bubbles', 'change:bubbles']);
  });

  it('does not dispatch events when the value is rejected', () => {
    const { registry, element, ref } = setup('<input data-target type="checkbox">');
    const events = recordEvents(element);
    expect(setFormValue(registry, { ref, value: 'yes' }).ok).toBe(false);
    expect(events).toEqual([]);
  });
});

describe('select', () => {
  const SELECT =
    '<select data-target><option value="">Choose</option><option value="de">Germany</option><option value="fr">France</option></select>';

  it('picks an option by value', () => {
    const result = run(SELECT, 'fr');
    expect(result).toMatchObject({ ok: true, text: 'Selected option "France" (previous: "Choose")' });
    expect((result.element as HTMLSelectElement).value).toBe('fr');
  });

  it('picks an option by visible text', () => {
    const result = run(SELECT, 'Germany');
    expect(result).toMatchObject({ ok: true, text: 'Selected option "Germany" (previous: "Choose")' });
    expect((result.element as HTMLSelectElement).value).toBe('de');
  });

  it('picks the first matching option, even when a later option shares its value', () => {
    const result = run(
      '<select data-target><option value="a">One</option><option value="b">x</option><option value="b">Two</option></select>',
      'Two',
    );
    expect(result).toMatchObject({ ok: true, text: 'Selected option "Two" (previous: "One")' });
    expect((result.element as HTMLSelectElement).selectedIndex).toBe(2);
  });

  it('collapses whitespace in option text', () => {
    expect(text('<select data-target><option>A</option><option>  New\n York </option></select>', 'New York')).toBe(
      'Selected option "New York" (previous: "A")',
    );
  });

  it('lists the available options when nothing matches', () => {
    expect(failure(SELECT, 'Spain')).toBe(
      'No option matches "Spain". Available options: "Choose" (value ""), "Germany" (value "de"), "France" (value "fr")',
    );
  });

  it('lists an option once when its value equals its text', () => {
    expect(failure('<select data-target><option>A</option><option>B</option></select>', 'C')).toBe(
      'No option matches "C". Available options: "A", "B"',
    );
  });

  it('clips the list of available options', () => {
    const options = Array.from({ length: MAX_LISTED_OPTIONS + 5 }, (_, i) => `<option>Option ${i}</option>`).join('');
    const error = failure(`<select data-target>${options}</select>`, 'none');
    expect(error).toMatch(/^No option matches "none". Available options: "Option 0", /);
    expect(error).toContain(`"Option ${MAX_LISTED_OPTIONS - 1}"`);
    expect(error).not.toContain(`"Option ${MAX_LISTED_OPTIONS}"`);
    expect(error).toMatch(/ and 5 more$/);
  });

  it('does not list the options of a sensitive select', () => {
    expect(
      failure('<select data-target autocomplete="cc-exp"><option value="01">January</option><option>02</option></select>', '13'),
    ).toBe('No option matches "13". Available options: [redacted]');
  });

  it('matches numbers as strings', () => {
    expect(text('<select data-target><option>1</option><option>2</option></select>', 2)).toBe(
      'Selected option "2" (previous: "1")',
    );
  });
});

describe('checkbox', () => {
  it('checks and unchecks', () => {
    const checked = run('<input data-target type="checkbox">', true);
    expect(checked).toMatchObject({ ok: true, text: 'Checkbox checked (previous: unchecked)' });
    expect((checked.element as HTMLInputElement).checked).toBe(true);
    const unchecked = run('<input data-target type="checkbox" checked>', false);
    expect(unchecked).toMatchObject({ ok: true, text: 'Checkbox unchecked (previous: checked)' });
    expect((unchecked.element as HTMLInputElement).checked).toBe(false);
  });

  it('accepts the strings "true" and "false"', () => {
    expect(text('<input data-target type="checkbox">', 'true')).toBe('Checkbox checked (previous: unchecked)');
    expect(text('<input data-target type="checkbox" checked>', 'false')).toBe('Checkbox unchecked (previous: checked)');
  });

  it.each(['yes', 1, 'on'])('rejects the value %j', (value) => {
    expect(failure('<input data-target type="checkbox">', value)).toMatch(
      /^A checkbox needs a boolean value \(true or false\), received /,
    );
  });
});

describe('radio', () => {
  it('selects a radio button', () => {
    const result = run('<input type="radio" name="a" checked><input data-target type="radio" name="a">', true);
    expect(result).toMatchObject({ ok: true, text: 'Radio button selected (previous: unselected)' });
    expect((result.element as HTMLInputElement).checked).toBe(true);
    expect((document.querySelector('input') as HTMLInputElement).checked).toBe(false);
  });

  it.each([false, 'false'])('refuses to unselect a radio button with %j', (value) => {
    expect(failure('<input data-target type="radio" checked>', value)).toBe(
      'A radio button cannot be unselected; select another radio button of its group instead',
    );
  });

  it('reports an already selected radio button', () => {
    expect(text('<input data-target type="radio" checked>', 'yes')).toBe('Radio button selected (previous: selected)');
  });
});

describe('number and range', () => {
  it('sets a number input from a number or a numeric string', () => {
    const result = run('<input data-target type="number" value="1">', 2.5);
    expect(result).toMatchObject({ ok: true, text: 'Set number value to "2.5" (previous: "1")' });
    expect((result.element as HTMLInputElement).value).toBe('2.5');
    expect(text('<input data-target type="number">', ' 7 ')).toBe('Set number value to "7" (previous: "")');
  });

  it.each(['abc', '', true])('rejects the non-numeric value %j', (value) => {
    expect(failure('<input data-target type="number">', value)).toMatch(/^A number input needs a numeric value, received /);
    expect(failure('<input data-target type="range">', value)).toMatch(/^A range input needs a numeric value, received /);
  });

  it('sets a range input within its bounds', () => {
    const result = run('<input data-target type="range" min="0" max="10" value="2">', 7);
    expect(result).toMatchObject({ ok: true, text: 'Set range value to "7" (previous: "2")' });
    expect((result.element as HTMLInputElement).value).toBe('7');
  });

  it('reports the value the browser keeps after rounding to the step', () => {
    const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (!native?.set) throw new Error('no native value setter');
    const nativeSet = native.set;
    // happy-dom does not apply the step; Firefox rounds a range value to the nearest step.
    vi.spyOn(HTMLInputElement.prototype, 'value', 'set').mockImplementation(function (this: HTMLInputElement, next) {
      const step = Number(this.getAttribute('step'));
      nativeSet.call(this, this.type === 'range' && step > 0 ? String(Math.round(Number(next) / step) * step) : next);
    });
    const result = run('<input data-target type="range" min="0" max="10" step="5" value="0">', 7);
    expect(result).toMatchObject({ ok: true, text: 'Set range value to "5" (previous: "0")' });
    expect((result.element as HTMLInputElement).value).toBe('5');
  });

  it('reports min and max for a value out of range', () => {
    expect(failure('<input data-target type="range" min="0" max="10">', 11)).toBe(
      'Value 11 is out of range for this range input (min 0, max 10)',
    );
    expect(failure('<input data-target type="range">', -1)).toBe(
      'Value -1 is out of range for this range input (min 0, max 100)',
    );
  });
});

describe('contenteditable', () => {
  it('replaces the text and dispatches input', () => {
    const { registry, element, ref } = setup('<div data-target contenteditable="true"><b>old</b> text</div>');
    const events = recordEvents(element);
    expect(setFormValue(registry, { ref, value: 'new text' })).toEqual({
      ok: true,
      text: 'Set editable content to "new text" (previous: "old text")',
    });
    expect(element.textContent).toBe('new text');
    expect(element.children).toHaveLength(0);
    expect(events).toEqual(['input:bubbles']);
  });

  it('accepts the plaintext-only and empty attribute forms', () => {
    expect(text('<p data-target contenteditable="plaintext-only">a</p>', 'b')).toBe(
      'Set editable content to "b" (previous: "a")',
    );
    expect(text('<p data-target contenteditable>a</p>', 'b')).toBe('Set editable content to "b" (previous: "a")');
  });

  it('does not treat contenteditable="false" as editable', () => {
    expect(failure('<div data-target contenteditable="false">a</div>', 'b')).toBe(
      'Element type "div" is not a supported form input',
    );
  });
});

describe('unsupported elements', () => {
  it.each(['file', 'hidden', 'button', 'submit', 'reset', 'image'])('rejects an input of type %s', (type) => {
    expect(failure(`<input data-target type="${type}">`, 'x')).toBe(`Element type "${type}" is not a supported form input`);
  });

  it.each([
    ['<button data-target>Go</button>', 'button'],
    ['<div data-target>x</div>', 'div'],
    ['<a data-target href="/">x</a>', 'a'],
  ])('rejects %s', (html, name) => {
    expect(failure(html, 'x')).toBe(`Element type "${name}" is not a supported form input`);
  });
});

describe('sensitive fields', () => {
  it('redacts the old and new value of a password field', () => {
    const result = run('<input data-target type="password" value="hunter2">', 'secret');
    expect(result).toMatchObject({ ok: true, text: 'Set password value to [redacted] (previous: [redacted])' });
    expect((result.element as HTMLInputElement).value).toBe('secret');
  });

  it.each(['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc', 'cc-exp'])(
    'redacts a field with autocomplete %s',
    (autocomplete) => {
      expect(text(`<input data-target autocomplete="${autocomplete}" value="old">`, 'new')).toBe(
        'Set text value to [redacted] (previous: [redacted])',
      );
    },
  );

  it('redacts a sensitive select', () => {
    expect(
      text('<select data-target autocomplete="cc-exp"><option>01</option><option>02</option></select>', '02'),
    ).toBe('Selected option [redacted] (previous: [redacted])');
  });

  it('redacts a sensitive textarea', () => {
    expect(text('<textarea data-target autocomplete="one-time-code">1</textarea>', '2')).toBe(
      'Set textarea value to [redacted] (previous: [redacted])',
    );
  });
});
