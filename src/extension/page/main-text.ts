import type { PageTextResult } from './page-text-api';

const ROOT_SELECTORS = [
  'article',
  'main',
  '[class*="articleBody"]',
  '[class*="post-content"]',
  '[class*="entry-content"]',
  '[class*="content-body"]',
  '[role="main"]',
  '.content',
  '#content',
];
const MIN_TEXT_LENGTH = 10;
const MAX_ATTRIBUTE_LENGTH = 60;

export type VisibilityCheck = (element: Element) => boolean;

// innerText of an element that is not rendered falls back to its textContent, hidden text included.
export function isRendered(element: Element): boolean {
  return element.checkVisibility({ opacityProperty: true, visibilityProperty: true });
}

function contentRoot(doc: Document, isVisible: VisibilityCheck): HTMLElement | null {
  for (const selector of ROOT_SELECTORS) {
    let best: HTMLElement | undefined;
    let bestLength = -1;
    for (const element of doc.querySelectorAll<HTMLElement>(selector)) {
      if (!isVisible(element)) continue;
      const length = element.innerText.length;
      if (length > bestLength) {
        best = element;
        bestLength = length;
      }
    }
    if (best) return best;
  }
  return doc.body;
}

function attributeText(value: string | null): string {
  const clean = (value ?? '').replace(/["<>\\]/g, '').replace(/[\s\p{Cc}]+/gu, ' ').trim();
  return clean.length > MAX_ATTRIBUTE_LENGTH ? `${clean.slice(0, MAX_ATTRIBUTE_LENGTH).trimEnd()}…` : clean;
}

function describeElement(element: Element): string {
  const parts = [element.localName];
  const id = attributeText(element.getAttribute('id'));
  if (id) parts.push(`id="${id}"`);
  const className = attributeText(element.getAttribute('class'));
  if (className) parts.push(`class="${className}"`);
  return `<${parts.join(' ')}>`;
}

export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lineEnd = text.lastIndexOf('\n', maxChars);
  const kept = lineEnd >= maxChars / 2 ? text.slice(0, lineEnd) : text.slice(0, maxChars);
  return `${kept.trimEnd()}\n\n[Text truncated at ${maxChars} characters. Pass a larger max_chars to read more.]`;
}

export function extractMainText(doc: Document, maxChars: number, isVisible: VisibilityCheck = isRendered): PageTextResult {
  if (doc.body && !isVisible(doc.body)) return { ok: false, error: 'The page body is not rendered, so it has no readable text.' };
  const root = contentRoot(doc, isVisible);
  const text = root ? normalizeText(root.innerText) : '';
  if (!root || text.length < MIN_TEXT_LENGTH) {
    return { ok: false, error: 'No readable text content found on the page; it may be empty, still loading or mostly images.' };
  }
  return { ok: true, title: doc.title, url: doc.URL, source: describeElement(root), text: truncateText(text, maxChars) };
}
