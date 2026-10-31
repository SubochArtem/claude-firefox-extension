import {
  accessibleName,
  collapseWhitespace,
  formatText,
  isSensitive,
  isShownInTree,
  MAX_DOM_DEPTH,
  rawAccessibleName,
  SKIPPED_TAGS,
  type ShownCheck,
} from './accessible-name';
import { elementRole, headingLevel, inputType, isInteractive } from './element-role';
import type { RefRegistry } from './ref-registry';

export type TreeFilter = 'all' | 'interactive';

export interface TreeOptions {
  filter?: TreeFilter;
  depth?: number;
  maxChars?: number;
  refId?: string;
  isVisible?: (element: Element) => boolean;
}

export type TreeResult = { ok: true; tree: string } | { ok: false; error: string };

export interface TreeElement {
  element: Element;
  role: string;
  // Collapsed whitespace only; format it with formatText before printing.
  name: () => string;
}

export const DEFAULT_DEPTH = 15;
export const DEFAULT_MAX_CHARS = 50_000;
export const MAX_ELEMENTS = 10_000;
export const MAX_OPTIONS = 200;
const MAX_HREF_LENGTH = 200;

const VALUELESS_INPUT_TYPES = new Set(['checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'file']);

interface WalkState {
  registry: RefRegistry;
  filter: TreeFilter;
  maxDepth: number;
  shown: ShownCheck;
  lines: string[];
  count: number;
  capped: boolean;
  depthCut: boolean;
}

export function isElementVisible(element: Element): boolean {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (style) {
    if (style.display === 'none' || style.opacity === '0') return false;
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    // A display: contents box has no client rects of its own while its children still render.
    if (style.display === 'contents') return true;
  }
  return element.getClientRects().length > 0;
}

function shownCheck(isVisible: (element: Element) => boolean): ShownCheck {
  return (element) => element.getAttribute('aria-hidden') !== 'true' && isVisible(element);
}

function isChecked(element: Element): boolean {
  if (element.localName === 'input') return (element as HTMLInputElement).checked;
  return element.getAttribute('aria-checked') === 'true';
}

function isDisabled(element: Element): boolean {
  return (element as { disabled?: unknown }).disabled === true || element.getAttribute('aria-disabled') === 'true';
}

function expandedState(element: Element): boolean | undefined {
  if (element.localName === 'details') return element.hasAttribute('open');
  if (element.localName === 'summary' && element.parentElement?.localName === 'details') {
    return element.parentElement.hasAttribute('open');
  }
  const aria = element.getAttribute('aria-expanded');
  return aria === 'true' || aria === 'false' ? aria === 'true' : undefined;
}

function fieldValue(element: Element): string | undefined {
  const tag = element.localName;
  if (tag === 'textarea') return (element as HTMLTextAreaElement).value;
  if (tag === 'input' && !VALUELESS_INPUT_TYPES.has(inputType(element))) return (element as HTMLInputElement).value;
  return undefined;
}

function valueAttribute(element: Element): string | undefined {
  const value = fieldValue(element);
  if (!value) return undefined;
  return isSensitive(element) ? 'value="[redacted]"' : `value="${formatText(value)}"`;
}

function attributes(element: Element, role: string): string[] {
  const parts: string[] = [];
  const href = element.localName === 'a' ? element.getAttribute('href') : null;
  if (href !== null) parts.push(`href="${formatText(href, MAX_HREF_LENGTH)}"`);
  if (element.localName === 'input') parts.push(`type="${formatText(inputType(element))}"`);
  const placeholder = element.getAttribute('placeholder');
  if (placeholder) parts.push(`placeholder="${formatText(placeholder)}"`);
  const value = valueAttribute(element);
  if (value) parts.push(value);
  const level = headingLevel(element, role);
  if (level !== undefined) parts.push(`level=${level}`);
  if (isChecked(element)) parts.push('checked');
  if (isDisabled(element)) parts.push('disabled');
  const expanded = expandedState(element);
  if (expanded !== undefined) parts.push(`expanded=${expanded}`);
  return parts;
}

// Options of a closed select have no layout boxes, so they are checked by attributes and style only.
function isOptionShown(element: Element): boolean {
  if ((element as HTMLElement).hidden || element.getAttribute('aria-hidden') === 'true') return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return !style || (style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse');
}

function shownOptions(select: HTMLSelectElement): HTMLOptionElement[] {
  const options: HTMLOptionElement[] = [];
  for (const child of select.children) {
    if (!isOptionShown(child)) continue;
    if (child.localName === 'option') options.push(child as HTMLOptionElement);
    if (child.localName !== 'optgroup') continue;
    for (const option of child.children) {
      if (option.localName === 'option' && isOptionShown(option)) options.push(option as HTMLOptionElement);
    }
  }
  return options;
}

function optionLines(select: HTMLSelectElement, level: number): string[] {
  const indent = ' '.repeat(level);
  const options = shownOptions(select);
  const lines = options.slice(0, MAX_OPTIONS).map((option) => {
    const text = collapseWhitespace(option.textContent ?? '');
    const selected = option.selected ? ' (selected)' : '';
    const value = option.value !== text ? ` value="${formatText(option.value)}"` : '';
    return `${indent}option "${formatText(text)}"${selected}${value}`;
  });
  if (options.length > MAX_OPTIONS) lines.push(`${indent}[${options.length - MAX_OPTIONS} more options not shown]`);
  return lines;
}

function emit(element: Element, role: string, name: string, level: number, state: WalkState): void {
  const ref = state.registry.refFor(element);
  const head = name ? `${role} "${name}" [${ref}]` : `${role} [${ref}]`;
  state.lines.push([' '.repeat(level) + head, ...attributes(element, role)].join(' '));
  state.count += 1;
  if (element.localName === 'select' && !isSensitive(element)) {
    state.lines.push(...optionLines(element as HTMLSelectElement, level + 1));
  }
}

function isIncluded(element: Element, role: string, name: () => string, filter: TreeFilter): boolean {
  if (isInteractive(element, role)) return true;
  if (filter === 'interactive') return false;
  return role !== 'generic' || element.hasAttribute('role') || name() !== '';
}

function isRendered(element: Element, shown: ShownCheck): boolean {
  return !SKIPPED_TAGS.has(element.localName) && shown(element);
}

// Options are printed with their select, never walked as elements.
function treeChildren(element: Element): Element[] {
  if (element.localName === 'select') return [];
  return [...(element.shadowRoot?.children ?? []), ...element.children];
}

function treeRoot(doc: Document, shown: ShownCheck): Element | undefined {
  const root = doc.body ?? doc.documentElement;
  return root && isShownInTree(root, shown) ? root : undefined;
}

function hasIncludedElement(element: Element, domDepth: number, state: WalkState): boolean {
  if (domDepth >= MAX_DOM_DEPTH || !isRendered(element, state.shown)) return false;
  const role = elementRole(element);
  if (isIncluded(element, role, () => accessibleName(element, role, state.shown), state.filter)) return true;
  return treeChildren(element).some((child) => hasIncludedElement(child, domDepth + 1, state));
}

function visit(element: Element, level: number, domDepth: number, state: WalkState): void {
  if (state.capped || domDepth >= MAX_DOM_DEPTH) return;
  if (level >= state.maxDepth) {
    state.depthCut ||= hasIncludedElement(element, domDepth, state);
    return;
  }
  if (!isRendered(element, state.shown)) return;
  const role = elementRole(element);
  let name: string | undefined;
  const getName = (): string => (name ??= accessibleName(element, role, state.shown));
  const included = isIncluded(element, role, getName, state.filter);
  if (included) {
    if (state.count >= MAX_ELEMENTS) {
      state.capped = true;
      return;
    }
    emit(element, role, getName(), level, state);
  }
  visitChildren(element, included ? level + 1 : level, domDepth + 1, state);
}

function visitChildren(element: Element, level: number, domDepth: number, state: WalkState): void {
  for (const child of treeChildren(element)) visit(child, level, domDepth, state);
}

function limitChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const newline = text.lastIndexOf('\n', maxChars);
  const end = newline > 0 ? newline : maxChars;
  return (
    `${text.slice(0, end)}\n[output truncated at ${end} of ${text.length} characters. ` +
    'Pass a larger max_chars, a ref_id or a smaller depth to focus.]'
  );
}

function refError(refId: string, reason: string): TreeResult {
  return { ok: false, error: `${refId} ${reason}. Call read_page without ref_id to get fresh element references.` };
}

function walkRoot(doc: Document, refId: string | undefined, state: WalkState): TreeResult | undefined {
  if (refId === undefined) {
    const root = treeRoot(doc, state.shown);
    if (root) visitChildren(root, 0, 0, state);
    return undefined;
  }
  const resolution = state.registry.resolve(refId);
  if (resolution.status === 'not-found') return refError(refId, 'was not found in this page');
  if (resolution.status === 'gone') return refError(refId, 'no longer exists in the page');
  const root = resolution.element;
  if (SKIPPED_TAGS.has(root.localName) || !isShownInTree(root, state.shown)) {
    return refError(refId, 'is not visible on the page');
  }
  const role = elementRole(root);
  emit(root, role, accessibleName(root, role, state.shown), 0, state);
  visitChildren(root, 1, 0, state);
  return undefined;
}

export function buildAccessibilityTree(doc: Document, registry: RefRegistry, options: TreeOptions = {}): TreeResult {
  const state: WalkState = {
    registry,
    filter: options.filter ?? 'all',
    maxDepth: options.depth ?? DEFAULT_DEPTH,
    shown: shownCheck(options.isVisible ?? isElementVisible),
    lines: [],
    count: 0,
    capped: false,
    depthCut: false,
  };
  const failure = walkRoot(doc, options.refId, state);
  registry.sweep();
  if (failure) return failure;
  if (state.depthCut) {
    state.lines.push(
      `[deeper levels omitted at depth ${state.maxDepth}. Pass a larger depth or a ref_id to see them.]`,
    );
  }
  if (state.capped) {
    state.lines.push(`[output stopped at ${MAX_ELEMENTS} elements. Pass a ref_id or a smaller depth to focus.]`);
  }
  return { ok: true, tree: limitChars(state.lines.join('\n'), options.maxChars ?? DEFAULT_MAX_CHARS) };
}

function walkElements(
  element: Element,
  domDepth: number,
  shown: ShownCheck,
  callback: (node: TreeElement) => boolean,
): boolean {
  if (domDepth >= MAX_DOM_DEPTH || !isRendered(element, shown)) return true;
  const role = elementRole(element);
  let name: string | undefined;
  const getName = (): string => (name ??= rawAccessibleName(element, role, shown));
  if (isIncluded(element, role, getName, 'all') && !callback({ element, role, name: getName })) return false;
  return treeChildren(element).every((child) => walkElements(child, domDepth + 1, shown, callback));
}

// Calls back, in document order, for every element read_page prints with filter "all" at any depth,
// until the callback returns false.
export function forEachTreeElement(
  doc: Document,
  callback: (node: TreeElement) => boolean,
  isVisible: (element: Element) => boolean = isElementVisible,
): void {
  const shown = shownCheck(isVisible);
  const root = treeRoot(doc, shown);
  if (root) treeChildren(root).every((child) => walkElements(child, 0, shown, callback));
}
