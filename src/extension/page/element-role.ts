const TAG_ROLES: Readonly<Record<string, string>> = {
  button: 'button',
  select: 'combobox',
  textarea: 'textbox',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  img: 'image',
  nav: 'navigation',
  main: 'main',
  header: 'banner',
  footer: 'contentinfo',
  section: 'region',
  article: 'article',
  aside: 'complementary',
  form: 'form',
  table: 'table',
  ul: 'list',
  ol: 'list',
  li: 'listitem',
  label: 'label',
  dialog: 'dialog',
  details: 'details',
  summary: 'summary',
};

const ROLE_TOKEN = /^[a-z][a-z0-9_-]*$/;

const BUTTON_INPUT_TYPES = new Set(['submit', 'button', 'reset', 'image', 'file']);

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'tab',
  'menuitem',
  'option',
  'switch',
  'textbox',
  'combobox',
  'slider',
]);

const INTERACTIVE_TAGS = new Set(['button', 'select', 'textarea', 'summary', 'details']);

export function inputType(element: Element): string {
  return (element.getAttribute('type') ?? 'text').trim().toLowerCase() || 'text';
}

function inputRole(element: Element): string {
  const type = inputType(element);
  if (BUTTON_INPUT_TYPES.has(type)) return 'button';
  if (type === 'checkbox' || type === 'radio') return type;
  if (type === 'range') return 'slider';
  return 'textbox';
}

export function explicitRole(element: Element): string | undefined {
  const first = element.getAttribute('role')?.trim().split(/\s+/)[0]?.toLowerCase();
  return first && ROLE_TOKEN.test(first) ? first : undefined;
}

export function elementRole(element: Element): string {
  const explicit = explicitRole(element);
  if (explicit) return explicit;
  const tag = element.localName;
  if (tag === 'a') return element.hasAttribute('href') ? 'link' : 'generic';
  if (tag === 'input') return inputRole(element);
  return TAG_ROLES[tag] ?? 'generic';
}

function isEditable(element: Element): boolean {
  const value = element.getAttribute('contenteditable');
  return value !== null && (value === '' || value.toLowerCase() === 'true');
}

function isFocusable(element: Element): boolean {
  const value = element.getAttribute('tabindex');
  return value !== null && Number.parseInt(value, 10) !== -1;
}

export function isInteractive(element: Element, role: string): boolean {
  const tag = element.localName;
  if (tag === 'a' && element.hasAttribute('href')) return true;
  if (tag === 'input') return inputType(element) !== 'hidden';
  return (
    INTERACTIVE_TAGS.has(tag) ||
    INTERACTIVE_ROLES.has(role) ||
    isEditable(element) ||
    isFocusable(element) ||
    element.hasAttribute('onclick')
  );
}

export function headingLevel(element: Element, role: string): number | undefined {
  if (role !== 'heading') return undefined;
  const fromTag = /^h([1-6])$/.exec(element.localName);
  if (fromTag) return Number(fromTag[1]);
  const level = Number.parseInt(element.getAttribute('aria-level') ?? '', 10);
  return Number.isInteger(level) && level > 0 ? level : undefined;
}
