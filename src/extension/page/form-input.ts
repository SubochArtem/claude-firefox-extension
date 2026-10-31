import { collapseWhitespace, formatText, isSensitive } from './accessible-name';
import { inputType } from './element-role';
import type { FormInputOptions, FormInputResult, FormValue } from './form-input-api';
import type { RefRegistry } from './ref-registry';

export const MAX_LISTED_OPTIONS = 20;
const MAX_OPTION_TEXT_LENGTH = 50;
const REDACTED = '[redacted]';

const UNSUPPORTED_INPUT_TYPES = new Set(['file', 'hidden', 'button', 'submit', 'reset', 'image']);
const CARET_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'password']);
const VALUE_INPUT_TYPES = new Set([
  ...CARET_INPUT_TYPES,
  'email',
  'color',
  'date',
  'time',
  'datetime-local',
  'month',
  'week',
]);
// The browser silently turns a malformed value of these types into "" (or #000000 for color).
const VALUE_FORMATS: Readonly<Record<string, string>> = {
  color: '#rrggbb',
  date: 'YYYY-MM-DD',
  time: 'HH:MM or HH:MM:SS',
  'datetime-local': 'YYYY-MM-DDTHH:MM',
  month: 'YYYY-MM',
  week: 'YYYY-Www',
};
const EDITABLE_VALUES = new Set(['', 'true', 'plaintext-only']);

type Prepared = { ok: true; apply: () => FormInputResult } | { ok: false; error: string };

function refError(ref: string, reason: string): FormInputResult {
  return { ok: false, error: `${ref} ${reason}. Call read_page or find to get fresh element references.` };
}

function done(text: string): FormInputResult {
  return { ok: true, text };
}

function unsupported(name: string): Prepared {
  return { ok: false, error: `Element type "${formatText(name)}" is not a supported form input` };
}

function received(value: FormValue): string {
  return typeof value === 'string' ? `"${formatText(value)}"` : String(value);
}

function shown(text: string, sensitive: boolean): string {
  return sensitive ? REDACTED : `"${formatText(text)}"`;
}

// The prototype setter skips own-property setters that frameworks such as React put on the element
// to track its value, so they see the change when the input event arrives.
function setNative(element: Element, prototype: object, property: string, value: unknown): void {
  const setter = Object.getOwnPropertyDescriptor(prototype, property)?.set;
  if (setter) setter.call(element, value);
  else (element as unknown as Record<string, unknown>)[property] = value;
}

function dispatch(element: Element, withChange: boolean): void {
  element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  if (withChange) element.dispatchEvent(new Event('change', { bubbles: true }));
}

function moveCaretToEnd(element: HTMLInputElement | HTMLTextAreaElement): void {
  try {
    element.setSelectionRange(element.value.length, element.value.length);
  } catch {
    // Some input types do not support a selection.
  }
}

function parseBoolean(value: FormValue): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function parseNumber(value: FormValue): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function optionText(option: HTMLOptionElement): string {
  return collapseWhitespace(option.textContent ?? '');
}

function describeOption(option: HTMLOptionElement): string {
  const text = optionText(option);
  const label = `"${formatText(text, MAX_OPTION_TEXT_LENGTH)}"`;
  return option.value === text ? label : `${label} (value "${formatText(option.value, MAX_OPTION_TEXT_LENGTH)}")`;
}

function prepareSelect(select: HTMLSelectElement, value: FormValue, sensitive: boolean): Prepared {
  const wanted = String(value);
  const text = collapseWhitespace(wanted);
  const options = Array.from(select.options);
  const index = options.findIndex((option) => option.value === wanted || optionText(option) === text);
  if (index === -1) {
    if (sensitive) {
      return { ok: false, error: `No option matches ${received(value)}. Available options: ${REDACTED}` };
    }
    const listed = options.slice(0, MAX_LISTED_OPTIONS).map(describeOption).join(', ');
    const rest = options.length - MAX_LISTED_OPTIONS;
    const more = rest > 0 ? ` and ${rest} more` : '';
    return { ok: false, error: `No option matches ${received(value)}. Available options: ${listed}${more}` };
  }
  return {
    ok: true,
    apply: () => {
      const previous = options[select.selectedIndex];
      setNative(select, HTMLSelectElement.prototype, 'selectedIndex', index);
      dispatch(select, true);
      const chosen = options[index] as HTMLOptionElement;
      const before = shown(previous ? optionText(previous) : '', sensitive);
      return done(`Selected option ${shown(optionText(chosen), sensitive)} (previous: ${before})`);
    },
  };
}

function prepareCheckbox(input: HTMLInputElement, value: FormValue): Prepared {
  const checked = parseBoolean(value);
  if (checked === undefined) {
    return { ok: false, error: `A checkbox needs a boolean value (true or false), received ${received(value)}` };
  }
  return {
    ok: true,
    apply: () => {
      const previous = input.checked;
      setNative(input, HTMLInputElement.prototype, 'checked', checked);
      dispatch(input, true);
      const state = (on: boolean): string => (on ? 'checked' : 'unchecked');
      return done(`Checkbox ${state(checked)} (previous: ${state(previous)})`);
    },
  };
}

function prepareRadio(input: HTMLInputElement, value: FormValue): Prepared {
  if (parseBoolean(value) === false) {
    return {
      ok: false,
      error: 'A radio button cannot be unselected; select another radio button of its group instead',
    };
  }
  return {
    ok: true,
    apply: () => {
      const previous = input.checked;
      setNative(input, HTMLInputElement.prototype, 'checked', true);
      dispatch(input, true);
      return done(`Radio button selected (previous: ${previous ? 'selected' : 'unselected'})`);
    },
  };
}

function attributeNumber(element: Element, name: string, fallback: number): number {
  const number = Number.parseFloat(element.getAttribute(name) ?? '');
  return Number.isFinite(number) ? number : fallback;
}

function setInputValue(
  input: HTMLInputElement,
  type: string,
  next: string,
  sensitive: boolean,
  reportActual = false,
): FormInputResult {
  const previous = input.value;
  setNative(input, HTMLInputElement.prototype, 'value', next);
  const format = VALUE_FORMATS[type];
  if (format !== undefined && input.value.toLowerCase() !== next.toLowerCase()) {
    setNative(input, HTMLInputElement.prototype, 'value', previous);
    return { ok: false, error: `Value ${shown(next, sensitive)} is not a valid ${type} value; expected ${format}` };
  }
  if (CARET_INPUT_TYPES.has(type)) moveCaretToEnd(input);
  dispatch(input, true);
  const result = reportActual ? input.value : next;
  return done(`Set ${type} value to ${shown(result, sensitive)} (previous: ${shown(previous, sensitive)})`);
}

function prepareNumber(input: HTMLInputElement, type: string, value: FormValue, sensitive: boolean): Prepared {
  const number = parseNumber(value);
  if (number === undefined) return { ok: false, error: `A ${type} input needs a numeric value, received ${received(value)}` };
  if (type === 'range') {
    const min = attributeNumber(input, 'min', 0);
    const max = attributeNumber(input, 'max', 100);
    if (number < min || number > max) {
      return { ok: false, error: `Value ${number} is out of range for this range input (min ${min}, max ${max})` };
    }
  }
  // The browser rounds a range value to its step, so the result reports what the input actually holds.
  return { ok: true, apply: () => setInputValue(input, type, String(number), sensitive, true) };
}

function prepareInput(input: HTMLInputElement, value: FormValue, sensitive: boolean): Prepared {
  const type = inputType(input);
  if (UNSUPPORTED_INPUT_TYPES.has(type)) return unsupported(type);
  if (type === 'checkbox') return prepareCheckbox(input, value);
  if (type === 'radio') return prepareRadio(input, value);
  if (type === 'number' || type === 'range') return prepareNumber(input, type, value, sensitive);
  // Unknown types behave as text inputs in the browser.
  const shownType = VALUE_INPUT_TYPES.has(type) ? type : 'text';
  return { ok: true, apply: () => setInputValue(input, shownType, String(value), sensitive) };
}

function prepareTextarea(textarea: HTMLTextAreaElement, value: FormValue, sensitive: boolean): Prepared {
  const next = String(value);
  return {
    ok: true,
    apply: () => {
      const previous = textarea.value;
      setNative(textarea, HTMLTextAreaElement.prototype, 'value', next);
      moveCaretToEnd(textarea);
      dispatch(textarea, true);
      return done(`Set textarea value to ${shown(next, sensitive)} (previous: ${shown(previous, sensitive)})`);
    },
  };
}

function isEditable(element: Element): boolean {
  const root = element.closest('[contenteditable]');
  return root !== null && EDITABLE_VALUES.has((root.getAttribute('contenteditable') ?? '').trim().toLowerCase());
}

function prepareEditable(element: Element, value: FormValue, sensitive: boolean): Prepared {
  const next = String(value);
  return {
    ok: true,
    apply: () => {
      const previous = element.textContent ?? '';
      element.textContent = next;
      dispatch(element, false);
      return done(`Set editable content to ${shown(next, sensitive)} (previous: ${shown(previous, sensitive)})`);
    },
  };
}

function prepare(element: Element, value: FormValue): Prepared {
  const sensitive = isSensitive(element);
  switch (element.localName) {
    case 'input':
      return prepareInput(element as HTMLInputElement, value, sensitive);
    case 'select':
      return prepareSelect(element as HTMLSelectElement, value, sensitive);
    case 'textarea':
      return prepareTextarea(element as HTMLTextAreaElement, value, sensitive);
    default:
      return isEditable(element) ? prepareEditable(element, value, sensitive) : unsupported(element.localName);
  }
}

// Refused before any side effect: the user could not change these fields either.
function lockedReason(element: Element): string | undefined {
  if (element.localName !== 'input' && element.localName !== 'select' && element.localName !== 'textarea') {
    return undefined;
  }
  const field = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  if (field.disabled || element.matches(':disabled')) return 'disabled';
  if (!(field instanceof HTMLSelectElement) && field.readOnly) return 'read-only';
  return undefined;
}

function bringIntoView(element: Element): void {
  element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
  if (typeof (element as HTMLElement).focus === 'function') (element as HTMLElement).focus({ preventScroll: true });
}

export function setFormValue(registry: RefRegistry, options: FormInputOptions): FormInputResult {
  const resolution = registry.resolve(options.ref);
  if (resolution.status === 'not-found') return refError(options.ref, 'was not found in this page');
  if (resolution.status === 'gone') return refError(options.ref, 'no longer exists in the page');
  const locked = lockedReason(resolution.element);
  if (locked) return { ok: false, error: `${options.ref} is ${locked} and cannot be changed` };
  const prepared = prepare(resolution.element, options.value);
  if (!prepared.ok) return prepared;
  bringIntoView(resolution.element);
  return prepared.apply();
}
