import { setNative } from './form-input';
import type { RefRegistry } from './ref-registry';
import type { Modifiers, PagePoint, SyntheticInputOptions, SyntheticInputResult, SyntheticKey } from './synthetic-input-api';

const DRAG_STEPS = 5;
const NO_MODIFIERS: Modifiers = { ctrl: false, shift: false, alt: false, meta: false };
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'password', 'email', 'number']);
const BLOCKS_IMPLICIT_SUBMISSION = new Set([
  ...TEXT_INPUT_TYPES,
  'date',
  'month',
  'week',
  'time',
  'datetime-local',
]);
const SCROLLABLE_OVERFLOW = new Set(['auto', 'scroll', 'overlay']);
const TAB_STOPS = 'a[href], area[href], button, input, select, textarea, iframe, summary, [tabindex], [contenteditable]';
const BUTTON_IDS = { left: 0, right: 2 } as const;
const BUTTON_MASKS = { left: 1, right: 2 } as const;

type Button = keyof typeof BUTTON_IDS;
type TextField = HTMLInputElement | HTMLTextAreaElement;
type Target = { ok: true; element: Element } | { ok: false; error: string };

const OK: SyntheticInputResult = { ok: true };

function elementAt(doc: Document, point: PagePoint): Element | null {
  let element = doc.elementFromPoint(point.x, point.y);
  while (element?.shadowRoot && typeof element.shadowRoot.elementFromPoint === 'function') {
    const inner = element.shadowRoot.elementFromPoint(point.x, point.y);
    if (!inner || inner === element) break;
    element = inner;
  }
  return element;
}

function deepActiveElement(doc: Document): Element | null {
  let active = doc.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

function target(registry: RefRegistry, doc: Document, point: PagePoint, ref: string | undefined): Target {
  if (ref === undefined) {
    const element = elementAt(doc, point);
    if (element) return { ok: true, element };
    return { ok: false, error: 'There is no element at that point in the page. Take a new screenshot and try again.' };
  }
  const resolution = registry.resolve(ref);
  if (resolution.status === 'found') return { ok: true, element: resolution.element };
  const reason = resolution.status === 'gone' ? 'no longer exists in the page' : 'was not found in this page';
  return { ok: false, error: `${ref} ${reason}. Call read_page or find to get fresh element references.` };
}

function modifierInit(modifiers: Modifiers): EventModifierInit {
  return { ctrlKey: modifiers.ctrl, shiftKey: modifiers.shift, altKey: modifiers.alt, metaKey: modifiers.meta };
}

function mouseInit(view: Window, point: PagePoint, modifiers: Modifiers, button: number, buttons: number, detail: number): MouseEventInit {
  return {
    bubbles: true,
    cancelable: true,
    composed: true,
    view,
    clientX: point.x,
    clientY: point.y,
    button,
    buttons,
    detail,
    ...modifierInit(modifiers),
  };
}

// Dispatches pointer<type> and mouse<type>; the result tells whether the mouse event was not cancelled.
function pointerPair(element: Element, type: string, init: MouseEventInit): boolean {
  element.dispatchEvent(new PointerEvent(`pointer${type}`, { ...init, detail: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
  return element.dispatchEvent(new MouseEvent(`mouse${type}`, init));
}

function mouse(element: Element, type: string, init: MouseEventInit): void {
  element.dispatchEvent(new MouseEvent(type, init));
}

function moveOver(view: Window, element: Element, point: PagePoint, buttons = 0): void {
  const init = mouseInit(view, point, NO_MODIFIERS, 0, buttons, 0);
  pointerPair(element, 'over', init);
  pointerPair(element, 'move', init);
}

function isDisabled(element: Element): boolean {
  return (element as Element & { disabled?: unknown }).disabled === true;
}

// The focus a real mousedown gives: the nearest focusable ancestor, or none.
function focusFromPointer(doc: Document, element: Element): void {
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (!(node instanceof HTMLElement) || isDisabled(node)) continue;
    if (node.tabIndex >= 0 || node.hasAttribute('tabindex') || node.isContentEditable) {
      node.focus();
      return;
    }
  }
  const active = deepActiveElement(doc);
  if (active instanceof HTMLElement) active.blur();
}

function textField(element: Element | null): TextField | undefined {
  if (element instanceof HTMLTextAreaElement) return element;
  if (element instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(element.type)) return element;
  return undefined;
}

function click(doc: Document, view: Window, element: Element, point: PagePoint, button: Button, count: number, modifiers: Modifiers) {
  moveOver(view, element, point);
  const id = BUTTON_IDS[button];
  for (let detail = 1; detail <= count; detail++) {
    if (pointerPair(element, 'down', mouseInit(view, point, modifiers, id, BUTTON_MASKS[button], detail)) && detail === 1) {
      focusFromPointer(doc, element);
    }
    const released = mouseInit(view, point, modifiers, id, 0, detail);
    pointerPair(element, 'up', released);
    if (button === 'right') {
      mouse(element, 'contextmenu', released);
      continue;
    }
    mouse(element, 'click', released);
    if (detail === 2) mouse(element, 'dblclick', released);
  }
  if (count === 3) textField(element)?.select();
}

function drag(doc: Document, view: Window, start: PagePoint, end: PagePoint): SyntheticInputResult {
  const from = elementAt(doc, start);
  if (!from) return { ok: false, error: 'There is no element at the drag start in the page. Take a new screenshot and try again.' };
  moveOver(view, from, start);
  if (pointerPair(from, 'down', mouseInit(view, start, NO_MODIFIERS, 0, 1, 1))) focusFromPointer(doc, from);
  let current = from;
  for (let step = 1; step <= DRAG_STEPS; step++) {
    const fraction = step / DRAG_STEPS;
    const point = { x: start.x + (end.x - start.x) * fraction, y: start.y + (end.y - start.y) * fraction };
    current = elementAt(doc, point) ?? current;
    pointerPair(current, 'move', mouseInit(view, point, NO_MODIFIERS, 0, 1, 0));
  }
  pointerPair(current, 'up', mouseInit(view, end, NO_MODIFIERS, 0, 0, 1));
  return OK;
}

function canScroll(element: Element, view: Window, deltaX: number, deltaY: number): boolean {
  const style = view.getComputedStyle(element);
  if (deltaY !== 0 && SCROLLABLE_OVERFLOW.has(style.overflowY)) {
    const room = deltaY > 0 ? element.scrollHeight - element.clientHeight - element.scrollTop : element.scrollTop;
    if (room > 0) return true;
  }
  if (deltaX !== 0 && SCROLLABLE_OVERFLOW.has(style.overflowX)) {
    const room = deltaX > 0 ? element.scrollWidth - element.clientWidth - element.scrollLeft : element.scrollLeft;
    if (room > 0) return true;
  }
  return false;
}

// A synthetic wheel event does not scroll anything, so the page is scrolled directly unless a listener
// cancelled the wheel event to scroll by itself.
function scroll(doc: Document, view: Window, point: PagePoint, deltaX: number, deltaY: number): SyntheticInputResult {
  const element = elementAt(doc, point) ?? doc.documentElement;
  const wheel = new WheelEvent('wheel', { ...mouseInit(view, point, NO_MODIFIERS, 0, 0, 0), deltaX, deltaY, deltaMode: 0 });
  if (!element.dispatchEvent(wheel)) return OK;
  const options: ScrollToOptions = { left: deltaX, top: deltaY, behavior: 'instant' };
  for (let node: Element | null = element; node && node !== doc.body && node !== doc.documentElement; node = node.parentElement) {
    if (canScroll(node, view, deltaX, deltaY)) {
      node.scrollBy(options);
      return OK;
    }
  }
  view.scrollBy(options);
  return OK;
}

function inputEvent(type: 'beforeinput' | 'input', inputType: string, data: string | null): InputEvent {
  return new InputEvent(type, { inputType, data, bubbles: true, cancelable: type === 'beforeinput', composed: true });
}

function editField(field: TextField, start: number, end: number, text: string, inputType: string): void {
  const data = text === '' ? null : text;
  if (!field.dispatchEvent(inputEvent('beforeinput', inputType, data))) return;
  const { value } = field;
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  setNative(field, prototype, 'value', value.slice(0, start) + text + value.slice(end));
  const caret = Math.min(start + text.length, field.value.length);
  try {
    field.setSelectionRange(caret, caret);
  } catch {
    // email and number inputs have no selection.
  }
  field.dispatchEvent(inputEvent('input', inputType, data));
}

function selection(field: TextField): { start: number; end: number } {
  const length = field.value.length;
  return { start: field.selectionStart ?? length, end: field.selectionEnd ?? length };
}

function isEditable(field: TextField): boolean {
  return !field.disabled && !field.readOnly;
}

function editingHost(element: Element | null): HTMLElement | undefined {
  return element instanceof HTMLElement && element.isContentEditable ? element : undefined;
}

function execCommand(doc: Document, command: string, value?: string): boolean {
  return typeof doc.execCommand === 'function' && doc.execCommand(command, false, value);
}

function insertIntoHost(doc: Document, host: HTMLElement, text: string): void {
  if (execCommand(doc, 'insertText', text)) return;
  if (!host.dispatchEvent(inputEvent('beforeinput', 'insertText', text))) return;
  const node = doc.createTextNode(text);
  const current = doc.getSelection();
  const range = current && current.rangeCount > 0 ? current.getRangeAt(0) : undefined;
  if (current && range && host.contains(range.commonAncestorContainer)) {
    range.deleteContents();
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    current.removeAllRanges();
    current.addRange(range);
  } else {
    host.append(node);
  }
  host.dispatchEvent(inputEvent('input', 'insertText', text));
}

function insertText(doc: Document, text: string): boolean {
  const active = deepActiveElement(doc);
  const field = textField(active);
  if (field && isEditable(field)) {
    const { start, end } = selection(field);
    editField(field, start, end, text, 'insertText');
    return true;
  }
  const host = editingHost(active);
  if (!host) return false;
  insertIntoHost(doc, host, text);
  return true;
}

// Line breaks and tabs are pressed as Enter and Tab, like the BiDi path does, so they can submit or move the focus.
function type(doc: Document, view: Window, text: string): SyntheticInputResult {
  let typed = false;
  for (const segment of text.split(/(\r\n|\r|\n|\t)/)) {
    if (segment === '') continue;
    if (segment === '\t' || segment.startsWith('\r') || segment === '\n') {
      press(doc, view, { key: segment === '\t' ? 'Tab' : 'Enter', modifiers: NO_MODIFIERS });
    } else if (insertText(doc, segment)) {
      typed = true;
    } else {
      return {
        ok: false,
        error: typed
          ? 'The focus left the editable element, so the rest of the text was not typed. Click the text field and type the rest.'
          : 'No editable element is focused in the page, so nothing was typed. Click the text field first, then type.',
      };
    }
  }
  return OK;
}

function deleteInField(field: TextField, forward: boolean): void {
  const { start, end } = selection(field);
  if (start !== end) editField(field, start, end, '', forward ? 'deleteContentForward' : 'deleteContentBackward');
  else if (forward && end < field.value.length) editField(field, start, end + 1, '', 'deleteContentForward');
  else if (!forward && start > 0) editField(field, start - 1, end, '', 'deleteContentBackward');
}

function tabOrder(doc: Document): HTMLElement[] {
  const stops = [...doc.querySelectorAll<HTMLElement>(TAB_STOPS)].filter(
    (element) =>
      element.tabIndex >= 0 &&
      !isDisabled(element) &&
      !(element instanceof HTMLInputElement && element.type === 'hidden') &&
      !element.closest('[hidden], [inert]'),
  );
  const positive = stops.filter((element) => element.tabIndex > 0).sort((a, b) => a.tabIndex - b.tabIndex);
  return [...positive, ...stops.filter((element) => element.tabIndex === 0)];
}

function moveFocus(doc: Document, backward: boolean): void {
  const order = tabOrder(doc);
  if (order.length === 0) return;
  const index = order.indexOf(deepActiveElement(doc) as HTMLElement);
  const next = backward ? (index <= 0 ? order.length - 1 : index - 1) : (index + 1) % order.length;
  order[next]?.focus();
}

function selectAll(doc: Document, active: Element | null): void {
  const field = textField(active);
  if (field) {
    field.select();
    return;
  }
  doc.getSelection()?.selectAllChildren(editingHost(active) ?? doc.body);
}

// The default actions a real key press would have that matter to an agent; other keys only send events.
function keyEffect(doc: Document, active: Element | null, { key, modifiers }: SyntheticKey): void {
  const field = textField(active);
  const host = editingHost(active);
  const command = modifiers.ctrl || modifiers.meta;
  if (command && !modifiers.alt && key.toLowerCase() === 'a') {
    selectAll(doc, active);
  } else if (key === 'Tab' && !command && !modifiers.alt) {
    moveFocus(doc, modifiers.shift);
  } else if (key === 'Enter' && !command) {
    if (field instanceof HTMLTextAreaElement && isEditable(field)) insertLineBreak(field);
    else if (field instanceof HTMLInputElement && field.form) submitImplicitly(field.form);
    else if (host) execCommand(doc, 'insertParagraph');
    else if (active instanceof HTMLButtonElement || (active instanceof HTMLAnchorElement && active.href !== '')) active.click();
  } else if (key === 'Backspace' || key === 'Delete') {
    if (field && isEditable(field)) deleteInField(field, key === 'Delete');
    else if (host) execCommand(doc, key === 'Delete' ? 'forwardDelete' : 'delete');
  }
}

function isSubmitButton(element: Element): element is HTMLButtonElement | HTMLInputElement {
  if (element instanceof HTMLButtonElement) return element.type === 'submit';
  return element instanceof HTMLInputElement && (element.type === 'submit' || element.type === 'image');
}

// HTML implicit submission: the default button submits, and without one the form submits only when it has a single
// field that blocks implicit submission.
function submitImplicitly(form: HTMLFormElement): void {
  const controls = [...form.elements];
  const button = controls.find(isSubmitButton);
  if (button) {
    if (!button.disabled) form.requestSubmit(button);
    return;
  }
  const blocking = controls.filter((control) => control instanceof HTMLInputElement && BLOCKS_IMPLICIT_SUBMISSION.has(control.type));
  if (blocking.length === 1) form.requestSubmit();
}

function insertLineBreak(field: HTMLTextAreaElement): void {
  const { start, end } = selection(field);
  editField(field, start, end, '\n', 'insertLineBreak');
}

function codeFor(key: string): string {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (key === ' ') return 'Space';
  return key.length > 1 ? key : '';
}

function press(doc: Document, view: Window, pressed: SyntheticKey): void {
  const init: KeyboardEventInit = {
    key: pressed.key,
    code: codeFor(pressed.key),
    bubbles: true,
    cancelable: true,
    composed: true,
    view,
    ...modifierInit(pressed.modifiers),
  };
  const active = deepActiveElement(doc);
  if ((active ?? doc.body).dispatchEvent(new KeyboardEvent('keydown', init))) keyEffect(doc, active, pressed);
  (deepActiveElement(doc) ?? doc.body).dispatchEvent(new KeyboardEvent('keyup', init));
}

// Events dispatched from the page carry isTrusted=false, so pages that check it ignore them.
export function syntheticInput(
  registry: RefRegistry,
  doc: Document,
  view: Window,
  options: SyntheticInputOptions,
): SyntheticInputResult {
  switch (options.kind) {
    case 'click':
    case 'hover': {
      const found = target(registry, doc, options.point, options.ref);
      if (!found.ok) return found;
      if (options.kind === 'hover') moveOver(view, found.element, options.point);
      else click(doc, view, found.element, options.point, options.button, options.clickCount, options.modifiers);
      return OK;
    }
    case 'drag':
      return drag(doc, view, options.start, options.end);
    case 'scroll':
      return scroll(doc, view, options.point, options.deltaX, options.deltaY);
    case 'type':
      return type(doc, view, options.text);
    case 'key':
      for (let round = 0; round < options.repeat; round++) {
        for (const pressed of options.keys) press(doc, view, pressed);
      }
      return OK;
  }
}
