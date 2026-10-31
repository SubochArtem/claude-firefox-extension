import { inputType } from './element-role';

export type ShownCheck = (element: Element) => boolean;

export const SKIPPED_TAGS = new Set(['script', 'style', 'meta', 'link', 'title', 'noscript', 'template']);

export const MAX_TEXT_LENGTH = 100;
export const MAX_DOM_DEPTH = 500;
const MIN_DIRECT_TEXT_LENGTH = 3;

const NAME_FROM_CONTENT_ROLES = new Set([
  'button',
  'cell',
  'checkbox',
  'columnheader',
  'gridcell',
  'heading',
  'label',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'row',
  'rowheader',
  'summary',
  'switch',
  'tab',
  'tooltip',
  'treeitem',
]);

const LABELABLE_TAGS = new Set(['input', 'select', 'textarea', 'button', 'meter', 'output', 'progress']);
const VALUE_NAME_INPUT_TYPES = new Set(['submit', 'button', 'reset']);
const CAPTION_TAGS: Readonly<Record<string, string>> = { fieldset: 'legend', figure: 'figcaption', table: 'caption' };
const SENSITIVE_AUTOCOMPLETE = new Set(['current-password', 'new-password', 'one-time-code']);

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const DOCUMENT_NODE = 9;
const DOCUMENT_FRAGMENT_NODE = 11;

export function collapseWhitespace(text: string): string {
  return text.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
}

export function escapeQuotes(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

export function formatText(raw: string, maxLength = MAX_TEXT_LENGTH): string {
  const text = collapseWhitespace(raw);
  const clipped = text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
  return escapeQuotes(clipped);
}

export function isShownInTree(element: Element, shown: ShownCheck): boolean {
  let current: Element | null = element;
  while (current) {
    if (!shown(current)) return false;
    current = current.parentElement ?? shadowHost(current);
  }
  return true;
}

function shadowHost(element: Element): Element | null {
  const root = element.getRootNode();
  return root.nodeType === DOCUMENT_FRAGMENT_NODE ? ((root as ShadowRoot).host ?? null) : null;
}

export function isSensitive(element: Element): boolean {
  if (element.localName === 'input') {
    const type = inputType(element);
    if (type === 'password' || type === 'hidden') return true;
  }
  const tokens = (element.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/);
  return tokens.some((token) => SENSITIVE_AUTOCOMPLETE.has(token) || token.startsWith('cc-'));
}

function visibleText(
  root: Node,
  shown: ShownCheck,
  skip: (element: Element) => boolean = () => false,
  depth = 0,
): string {
  if (depth >= MAX_DOM_DEPTH) return '';
  let text = '';
  for (const child of root.childNodes) {
    if (child.nodeType === TEXT_NODE) {
      text += child.textContent ?? '';
    } else if (child.nodeType === ELEMENT_NODE) {
      const element = child as Element;
      if (SKIPPED_TAGS.has(element.localName) || skip(element) || !shown(element)) continue;
      text += visibleText(element, shown, skip, depth + 1);
    }
  }
  return text;
}

function shownText(element: Element, shown: ShownCheck, skip?: (element: Element) => boolean): string {
  return isShownInTree(element, shown) ? visibleText(element, shown, skip) : '';
}

export function directText(element: Element): string {
  let text = '';
  for (const child of element.childNodes) {
    if (child.nodeType === TEXT_NODE) text += child.textContent ?? '';
  }
  return text;
}

function treeScope(element: Element): Document | DocumentFragment | undefined {
  const root = element.getRootNode();
  if (root.nodeType === DOCUMENT_NODE || root.nodeType === DOCUMENT_FRAGMENT_NODE) return root as Document | DocumentFragment;
  return undefined;
}

function labelledByText(element: Element, shown: ShownCheck): string | undefined {
  const ids = element.getAttribute('aria-labelledby')?.trim().split(/\s+/);
  const scope = treeScope(element);
  if (!ids || !scope) return undefined;
  return ids
    .map((id) => scope.getElementById(id))
    .filter((target): target is HTMLElement => target !== null)
    .map((target) => shownText(target, shown))
    .join(' ');
}

function labelText(element: Element, shown: ShownCheck): string | undefined {
  if (!LABELABLE_TAGS.has(element.localName)) return undefined;
  const skipControls = (child: Element): boolean => LABELABLE_TAGS.has(child.localName);
  const labels = (element as { labels?: NodeListOf<HTMLLabelElement> | null }).labels;
  return Array.from(labels ?? [])
    .map((label) => shownText(label, shown, skipControls))
    .join(' ');
}

function selectedOptionText(element: Element): string | undefined {
  if (element.localName !== 'select' || isSensitive(element)) return undefined;
  const select = element as HTMLSelectElement;
  return select.selectedOptions[0]?.textContent ?? undefined;
}

function buttonValue(element: Element): string | undefined {
  if (element.localName !== 'input' || !VALUE_NAME_INPUT_TYPES.has(inputType(element))) return undefined;
  return element.getAttribute('value') ?? undefined;
}

function captionText(element: Element, shown: ShownCheck): string | undefined {
  const captionTag = CAPTION_TAGS[element.localName];
  if (!captionTag) return undefined;
  const caption = Array.from(element.children).find((child) => child.localName === captionTag);
  return caption ? shownText(caption, shown) : undefined;
}

// The name with whitespace collapsed but neither clipped nor quote-escaped, for matching.
export function rawAccessibleName(element: Element, role: string, shown: ShownCheck): string {
  const isTextarea = element.localName === 'textarea';
  const sources: Array<() => string | null | undefined> = [
    () => labelledByText(element, shown),
    () => element.getAttribute('aria-label'),
    () => labelText(element, shown),
    () => selectedOptionText(element),
    () => element.getAttribute('placeholder'),
    () => element.getAttribute('alt'),
    () => element.getAttribute('title'),
    () => buttonValue(element),
    () => (NAME_FROM_CONTENT_ROLES.has(role) && !isTextarea ? visibleText(element, shown) : undefined),
    () => captionText(element, shown),
  ];
  for (const source of sources) {
    const text = collapseWhitespace(source() ?? '');
    if (text) return text;
  }
  // A textarea's text content is its default value, which may be sensitive.
  if (isTextarea) return '';
  const direct = collapseWhitespace(directText(element));
  return direct.length >= MIN_DIRECT_TEXT_LENGTH ? direct : '';
}

export function accessibleName(element: Element, role: string, shown: ShownCheck): string {
  return formatText(rawAccessibleName(element, role, shown));
}
