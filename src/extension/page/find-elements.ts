import { forEachTreeElement, isElementVisible, MAX_ELEMENTS, type TreeElement } from './accessibility-tree';
import { collapseWhitespace, directText, formatText, isSensitive } from './accessible-name';
import { inputType, isInteractive } from './element-role';
import type { FindResult } from './find-api';
import type { RefRegistry } from './ref-registry';

export interface FindElementsOptions {
  isVisible?: (element: Element) => boolean;
}

export const MAX_RESULTS = 20;
const MAX_FIELD_LENGTH = 1000;
const MIN_SUBSTRING_LENGTH = 3;
const MAX_REASONS = 3;

const EXACT_NAME_SCORE = 100;
const NAME_CONTAINS_SCORE = 80;
const ALL_WORDS_SCORE = 60;
const ROLE_AND_WORD_SCORE = 40;
const ROLE_AND_WORD_RANGE = 10;
const PARTIAL_SCORE = 20;
const INTERACTIVE_BONUS = 5;

const FIELD_ROLES = ['textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'slider'];
const TEXT_ROLES = ['textbox', 'searchbox', 'combobox'];

const ROLE_WORDS: ReadonlyMap<string, readonly string[]> = new Map([
  ['button', ['button']],
  ['link', ['link']],
  ['hyperlink', ['link']],
  ['checkbox', ['checkbox']],
  ['radio', ['radio']],
  ['switch', ['switch', 'checkbox']],
  ['toggle', ['switch', 'checkbox']],
  ['textbox', TEXT_ROLES],
  ['searchbox', TEXT_ROLES],
  ['textarea', ['textbox']],
  ['input', FIELD_ROLES],
  ['field', FIELD_ROLES],
  ['combobox', ['combobox', 'listbox']],
  ['dropdown', ['combobox', 'listbox']],
  ['select', ['combobox', 'listbox']],
  ['heading', ['heading']],
  ['headline', ['heading']],
  ['image', ['image', 'img']],
  ['img', ['image', 'img']],
  ['picture', ['image', 'img']],
  ['slider', ['slider']],
  ['tab', ['tab']],
  ['menu', ['menu', 'menubar']],
  ['menuitem', ['menuitem']],
  ['list', ['list']],
  ['navigation', ['navigation']],
  ['nav', ['navigation']],
  ['form', ['form']],
  ['table', ['table']],
  ['dialog', ['dialog', 'alertdialog']],
  ['modal', ['dialog', 'alertdialog']],
  ['option', ['option']],
]);

const ROLE_PHRASES: ReadonlyArray<[RegExp, string]> = [
  [/\bcheck box\b/g, 'checkbox'],
  [/\btext ?(box|field|input)\b/g, 'textbox'],
  [/\bsearch ?(box|field|bar|input)\b/g, 'search textbox'],
  [/\binput field\b/g, 'textbox'],
  [/\bradio button\b/g, 'radio'],
  [/\bdrop ?down( menu| list)?\b/g, 'dropdown'],
  [/\bmenu item\b/g, 'menuitem'],
];

interface Field {
  label: string;
  text: string;
  compact: string;
}

// A query word or the whole query phrase, with its matcher built once per query.
interface Term {
  word: string;
  compact: string;
  matches: (field: Field) => boolean;
}

type Hit = { kind: 'field'; label: string; word: string } | { kind: 'role'; role: string };

interface Query {
  raw: string;
  phrase: Term;
  words: Term[];
}

interface Match {
  node: TreeElement;
  score: number;
  reason: string;
}

function normalize(raw: string): string {
  return collapseWhitespace(raw).toLowerCase();
}

// Lowercase letters and digits only, so "login" meets "Log in" and "email" meets "e-mail".
function compactOf(text: string): string {
  return text.replace(/[^\p{L}\p{N}]+/gu, '');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Short words match only as whole words, so "in" does not match "login".
function termOf(word: string): Term {
  const compact = compactOf(word);
  if (compact.length >= MIN_SUBSTRING_LENGTH) {
    return { word, compact, matches: (field) => field.text.includes(word) || field.compact.includes(compact) };
  }
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(word)}(?![\\p{L}\\p{N}])`, 'u');
  return { word, compact, matches: (field) => pattern.test(field.text) };
}

function parseQuery(raw: string): Query {
  const phrase = normalize(raw);
  let rolePhrased = phrase;
  for (const [pattern, replacement] of ROLE_PHRASES) rolePhrased = rolePhrased.replace(pattern, replacement);
  const words = new Map<string, Term>();
  for (const token of rolePhrased.split(' ')) {
    const word = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (word === '') continue;
    const term = termOf(word);
    if (!words.has(term.compact)) words.set(term.compact, term);
  }
  return { raw, phrase: termOf(phrase), words: [...words.values()] };
}

function fieldOf(label: string, raw: string): Field {
  const text = normalize(raw).slice(0, MAX_FIELD_LENGTH);
  return { label, text, compact: compactOf(text) };
}

function attributeField(element: Element, label: string, attribute: string): Field | undefined {
  const value = element.getAttribute(attribute);
  return value ? fieldOf(label, value) : undefined;
}

// Field values are never searched; a textarea's text is its value, and sensitive fields may hold secrets.
function textField(element: Element): Field | undefined {
  if (element.localName === 'textarea' || isSensitive(element)) return undefined;
  return fieldOf('text', directText(element));
}

function fieldsOf(node: TreeElement, name: Field): Field[] {
  const { element } = node;
  const fields: Array<Field | undefined> = [
    name,
    attributeField(element, 'aria-label', 'aria-label'),
    attributeField(element, 'placeholder', 'placeholder'),
    attributeField(element, 'title', 'title'),
    attributeField(element, 'alt', 'alt'),
    attributeField(element, 'id', 'id'),
    attributeField(element, 'name attribute', 'name'),
    attributeField(element, 'type', 'type'),
    attributeField(element, 'href', 'href'),
    textField(element),
  ];
  return fields.filter((field): field is Field => field !== undefined && field.text !== '');
}

function hitFor(term: Term, role: string, fields: Field[]): Hit | undefined {
  if (ROLE_WORDS.get(term.compact)?.includes(role)) return { kind: 'role', role };
  const field = fields.find((candidate) => term.matches(candidate));
  return field ? { kind: 'field', label: field.label, word: term.word } : undefined;
}

function describeHit(hit: Hit): string {
  return hit.kind === 'role' ? `role ${hit.role}` : `${hit.label} contains "${formatText(hit.word)}"`;
}

function isRoleWord(term: Term): boolean {
  return ROLE_WORDS.has(term.compact);
}

function scoreElement(node: TreeElement, query: Query): Omit<Match, 'node'> | undefined {
  const name = fieldOf('name', node.name());
  const { phrase } = query;
  const echoed = formatText(query.raw);
  if (name.text !== '' && (name.text === phrase.word || (name.compact !== '' && name.compact === phrase.compact))) {
    return { score: EXACT_NAME_SCORE, reason: `name matches "${echoed}"` };
  }
  if (name.text !== '' && phrase.matches(name)) return { score: NAME_CONTAINS_SCORE, reason: `name contains "${echoed}"` };

  const fields = fieldsOf(node, name);
  const hits = query.words.map((term) => hitFor(term, node.role, fields));
  const found = hits.filter((hit): hit is Hit => hit !== undefined);
  const fieldHits = found.filter((hit) => hit.kind === 'field');
  const roleMatched = found.length > fieldHits.length;
  const onlyRoleWords = query.words.every(isRoleWord);
  const contentHit = fieldHits.some((hit) => !ROLE_WORDS.has(compactOf(hit.word)));
  const fraction = found.length / Math.max(query.words.length, 1);

  let score: number;
  if (found.length > 0 && found.length === hits.length && fieldHits.every((hit) => hit.label !== 'text')) {
    score = ALL_WORDS_SCORE;
  } else if (roleMatched && (contentHit || onlyRoleWords)) {
    score = ROLE_AND_WORD_SCORE + ROLE_AND_WORD_RANGE * fraction;
  } else if (fieldHits.length > 0) {
    score = PARTIAL_SCORE * fraction;
  } else {
    return undefined;
  }
  return { score, reason: found.slice(0, MAX_REASONS).map(describeHit).join(', ') };
}

function typeOf(element: Element): string | undefined {
  if (element.localName === 'input') return inputType(element);
  const type = element.getAttribute('type');
  return type ? type : undefined;
}

function matchLine(match: Match, registry: RefRegistry): string {
  const { element, role } = match.node;
  const name = formatText(match.node.name());
  const type = typeOf(element);
  return [
    `- ${registry.refFor(element)}: ${role}`,
    name ? ` "${name}"` : '',
    type ? ` (${formatText(type)})` : '',
    ` - ${match.reason}`,
  ].join('');
}

export function findElements(
  doc: Document,
  registry: RefRegistry,
  rawQuery: string,
  options: FindElementsOptions = {},
): FindResult {
  const query = parseQuery(rawQuery);
  const matches: Match[] = [];
  let walked = 0;
  let capped = false;
  forEachTreeElement(
    doc,
    (node) => {
      if (walked >= MAX_ELEMENTS) {
        capped = true;
        return false;
      }
      walked += 1;
      const scored = scoreElement(node, query);
      if (scored) {
        const bonus = isInteractive(node.element, node.role) ? INTERACTIVE_BONUS : 0;
        matches.push({ node, score: scored.score + bonus, reason: scored.reason });
      }
      return true;
    },
    options.isVisible ?? isElementVisible,
  );
  if (matches.length === 0) return { ok: false, error: `No matching elements found for "${formatText(rawQuery)}"` };

  matches.sort((a, b) => b.score - a.score);
  const shown = matches.slice(0, MAX_RESULTS);
  const noun = matches.length === 1 ? 'element' : 'elements';
  const lines = [`Found ${matches.length} matching ${noun}`, ...shown.map((match) => matchLine(match, registry))];
  if (matches.length > MAX_RESULTS) {
    lines.push(`[showing the top ${MAX_RESULTS} of ${matches.length} matches; use a more specific query to narrow them]`);
  }
  if (capped) lines.push(`[search stopped after ${MAX_ELEMENTS} elements; later elements were not searched]`);
  registry.sweep();
  return { ok: true, text: lines.join('\n') };
}
