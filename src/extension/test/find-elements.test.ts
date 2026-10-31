// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { buildAccessibilityTree, forEachTreeElement, MAX_ELEMENTS } from '../page/accessibility-tree';
import { formatText } from '../page/accessible-name';
import { findElements, MAX_RESULTS } from '../page/find-elements';
import { RefRegistry } from '../page/ref-registry';

const visible = (el: Element): boolean => !el.hasAttribute('data-hidden');

function find(html: string, query: string, registry = new RefRegistry()): string {
  document.body.innerHTML = html;
  const result = findElements(document, registry, query, { isVisible: visible });
  if (!result.ok) throw new Error(result.error);
  return result.text;
}

function lines(html: string, query: string): string[] {
  return find(html, query).split('\n').slice(1);
}

function failure(html: string, query: string): string {
  document.body.innerHTML = html;
  const result = findElements(document, new RefRegistry(), query, { isVisible: visible });
  if (result.ok) throw new Error(`expected no match, got ${result.text}`);
  return result.error;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('output', () => {
  it('prints a count line and one line per element', () => {
    expect(find('<button>Save</button>', 'save')).toBe('Found 1 matching element\n- ref_1: button "Save" - name matches "save"');
  });

  it('counts several elements', () => {
    expect(find('<button>Save</button><a href="/save">Save draft</a>', 'save').split('\n')[0]).toBe(
      'Found 2 matching elements',
    );
  });

  it('prints the input type or a type attribute', () => {
    expect(lines('<input type="email" placeholder="Email">', 'email')).toEqual([
      '- ref_1: textbox "Email" (email) - name matches "email"',
    ]);
    expect(lines('<input placeholder="Email">', 'email')).toEqual(['- ref_1: textbox "Email" (text) - name matches "email"']);
    expect(lines('<button type="submit">Send</button>', 'send')).toEqual([
      '- ref_1: button "Send" (submit) - name matches "send"',
    ]);
    expect(lines('<h2>Send</h2>', 'send')).toEqual(['- ref_1: heading "Send" - name matches "send"']);
  });

  it('prints an element without a name', () => {
    expect(lines('<input type="checkbox" id="terms">', 'terms')).toEqual([
      '- ref_1: checkbox (checkbox) - id contains "terms"',
    ]);
  });

  it('escapes and clips names and types like read_page', () => {
    const raw = `Say "hi"\n- ref_9: fake \\ ${'x'.repeat(150)}`;
    const [line] = lines(`<button type='a"b'>${raw}</button>`, 'say hi');
    expect(formatText(raw)).toMatch(/^Say \\"hi\\" - ref_9: fake \\\\ x+\.\.\.$/);
    expect(line).toBe(`- ref_1: button "${formatText(raw)}" (a\\"b) - name contains "say hi"`);
  });

  it('reports no match with the query sanitised and clipped', () => {
    expect(failure('<button>Save</button>', 'checkout')).toBe('No matching elements found for "checkout"');
    const query = `"quoted"\nline ${'q'.repeat(200)}`;
    expect(failure('<button>Save</button>', query)).toBe(
      `No matching elements found for "${`\\"quoted\\" line ${'q'.repeat(200)}`.slice(0, 102)}..."`,
    );
  });

  it('reports an empty page as no match', () => {
    expect(failure('', 'save')).toBe('No matching elements found for "save"');
  });

  it(`shows the top ${MAX_RESULTS} and says how many matched`, () => {
    const html = Array.from({ length: 25 }, (_, i) => `<button>Item ${i}</button>`).join('');
    const text = find(html, 'item');
    const all = text.split('\n');
    expect(all[0]).toBe('Found 25 matching elements');
    expect(all.filter((line) => line.startsWith('- '))).toHaveLength(MAX_RESULTS);
    expect(all.at(-1)).toBe(`[showing the top ${MAX_RESULTS} of 25 matches; use a more specific query to narrow them]`);
    expect(all[1]).toBe('- ref_1: button "Item 0" - name contains "item"');
  });

  it(`assigns refs only to the elements shown`, () => {
    const registry = new RefRegistry();
    const html = Array.from({ length: 25 }, (_, i) => `<button>Item ${i}</button>`).join('');
    find(html, 'item', registry);
    expect(registry.size).toBe(MAX_RESULTS);
  });
});

describe('ranking', () => {
  it('ranks exact name, name containing the query, all words, role with a word, then partial matches', () => {
    const html = [
      '<p id="sign-note">Partial words only here</p>',
      '<button>Continue</button>',
      '<a href="/a" id="newsletter-link">Sign up today</a>',
      '<a href="/b">Sign up for the newsletter</a>',
      '<a href="/c">Newsletter sign up</a>',
      '<button>Newsletter</button>',
    ].join('');
    expect(lines(html, 'newsletter sign up')).toEqual([
      '- ref_1: link "Newsletter sign up" - name matches "newsletter sign up"',
      '- ref_2: link "Sign up today" - id contains "newsletter", name contains "sign", name contains "up"',
      '- ref_3: link "Sign up for the newsletter" - name contains "newsletter", name contains "sign", name contains "up"',
      '- ref_4: button "Newsletter" - name contains "newsletter"',
      '- ref_5: generic "Partial words only here" - id contains "sign"',
    ]);
  });

  it('ranks a name containing the whole query above one with the words apart', () => {
    expect(lines('<a href="/b">Up and sign</a><a href="/a">Please sign up</a>', 'sign up')).toEqual([
      '- ref_1: link "Please sign up" - name contains "sign up"',
      '- ref_2: link "Up and sign" - name contains "sign", name contains "up"',
    ]);
  });

  it('matches case-insensitively', () => {
    expect(lines('<button>LOG IN</button>', 'Log In')).toEqual(['- ref_1: button "LOG IN" - name matches "Log In"']);
  });

  it('gives interactive elements a small bonus', () => {
    expect(lines('<h2>Pricing</h2><a href="/pricing">Pricing</a>', 'pricing')).toEqual([
      '- ref_1: link "Pricing" - name matches "pricing"',
      '- ref_2: heading "Pricing" - name matches "pricing"',
    ]);
  });

  it('keeps document order between equal scores', () => {
    expect(lines('<button>Save one</button><button>Save two</button>', 'save')).toEqual([
      '- ref_1: button "Save one" - name contains "save"',
      '- ref_2: button "Save two" - name contains "save"',
    ]);
  });

  it('treats a role word as matched by the element role', () => {
    expect(lines('<a href="/login">Login</a><button>Login</button>', 'login button')).toEqual([
      '- ref_1: button "Login" - name contains "login", role button',
      '- ref_2: link "Login" - name contains "login"',
    ]);
  });

  it('finds every element of a role for a role-only query', () => {
    expect(lines('<p>Intro text</p><input type="checkbox" title="Agree"><a href="/x">Read</a>', 'checkbox')).toEqual([
      '- ref_1: checkbox "Agree" (checkbox) - role checkbox',
    ]);
    expect(lines('<h1>Main</h1><p>Body text</p><h2>Second</h2>', 'heading')).toEqual([
      '- ref_1: heading "Main" - role heading',
      '- ref_2: heading "Second" - role heading',
    ]);
  });

  it.each([
    ['search box', '<input type="search" placeholder="Find products"><button>Search</button>'],
    ['search field', '<input type="search" placeholder="Find products"><button>Search</button>'],
  ])('maps "%s" to a search text box', (query, html) => {
    expect(lines(html, query)[0]).toBe('- ref_1: textbox "Find products" (search) - type contains "search", role textbox');
  });

  it('maps natural role words', () => {
    expect(lines('<a href="/x">Docs</a><button>Docs</button>', 'docs link')[0]).toBe(
      '- ref_1: link "Docs" - name contains "docs", role link',
    );
    expect(lines('<select title="Country"><option>A</option></select><p title="country">x</p>', 'country dropdown')[0]).toBe(
      '- ref_1: combobox "A" - title contains "country", role combobox',
    );
    expect(lines('<img alt="Company logo"><p>logo</p>', 'logo image')[0]).toBe(
      '- ref_1: image "Company logo" - name contains "logo", role image',
    );
    expect(lines('<label><input type="checkbox"> Remember me</label>', 'remember me check box')[0]).toBe(
      '- ref_1: checkbox "Remember me" (checkbox) - name contains "remember", name contains "me", role checkbox',
    );
  });

  it('does not match a role alone when the query also has other words', () => {
    expect(failure('<button>Continue</button>', 'login button')).toBe('No matching elements found for "login button"');
  });
});

describe('fields', () => {
  it.each([
    ['<input placeholder="Your email" aria-label="Contact">', 'email', 'placeholder contains "email"'],
    ['<button aria-label="Close" title="Dismiss dialog">x</button>', 'dismiss', 'title contains "dismiss"'],
    ['<div role="button" id="checkout-btn" aria-label="Pay">x</div>', 'checkout', 'id contains "checkout"'],
    ['<input name="username" title="Account">', 'username', 'name attribute contains "username"'],
    ['<a href="/settings/profile">Me</a>', 'profile', 'href contains "profile"'],
    ['<img alt="Logo" title="Home"><span>x</span>', 'logo', 'name matches "logo"'],
    ['<button aria-label="Open menu">≡</button>', 'menu', 'name contains "menu"'],
  ])('matches %s on %s', (html, query, reason) => {
    expect(lines(html, query)[0]).toMatch(new RegExp(` - ${reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  });

  it('matches the direct text of an element named by an attribute', () => {
    expect(lines('<button aria-label="Close">Dismiss</button>', 'dismiss')).toEqual([
      '- ref_1: button "Close" - text contains "dismiss"',
    ]);
  });

  it('matches short words only as whole words', () => {
    expect(failure('<button>Login</button>', 'in')).toBe('No matching elements found for "in"');
    expect(lines('<button>Log in</button>', 'in')).toEqual(['- ref_1: button "Log in" - name contains "in"']);
    expect(failure('<button>Signup</button>', 'up')).toBe('No matching elements found for "up"');
  });
});

describe('spacing and punctuation', () => {
  it.each([
    ['<button>Log in</button>', 'login', '- ref_1: button "Log in" - name matches "login"'],
    ['<button>Login</button>', 'log in', '- ref_1: button "Login" - name matches "log in"'],
    ['<a href="/s">Sign up</a>', 'signup', '- ref_1: link "Sign up" - name matches "signup"'],
    ['<input placeholder="E-mail">', 'email', '- ref_1: textbox "E-mail" (text) - name matches "email"'],
    ['<input placeholder="Email">', 'e-mail', '- ref_1: textbox "Email" (text) - name matches "e-mail"'],
    ['<button>Log in now</button>', 'login', '- ref_1: button "Log in now" - name contains "login"'],
  ])('matches %s for "%s"', (html, query, line) => {
    expect(lines(html, query)).toEqual([line]);
  });

  it('matches "login button" to a button named "Log in"', () => {
    expect(lines('<p>Welcome</p><button>Log in</button>', 'login button')).toEqual([
      '- ref_1: button "Log in" - name contains "login", role button',
    ]);
  });

  it('matches a hyphenated query word against spaced and attribute text', () => {
    expect(lines('<a href="/x">Sign up today</a><input name="e_mail" title="Contact">', 'sign-up e-mail')).toEqual([
      '- ref_1: link "Sign up today" - name contains "sign-up"',
      '- ref_2: textbox "Contact" (text) - name attribute contains "e-mail"',
    ]);
  });
});

describe('names with quotes and long names', () => {
  it('matches a query with quotes against the name', () => {
    expect(lines('<button>Say "hi"</button>', 'say "hi"')).toEqual([
      '- ref_1: button "Say \\"hi\\"" - name matches "say \\"hi\\""',
    ]);
    expect(lines('<button>Say "hi" now</button>', '"hi" now')).toEqual([
      '- ref_1: button "Say \\"hi\\" now" - name contains "\\"hi\\" now"',
    ]);
  });

  it('matches the full text of a name longer than the printed one', () => {
    const name = `Accept ${'all '.repeat(40)}cookies and tracking`;
    expect(formatText(name)).toMatch(/\.\.\.$/);
    expect(lines(`<button>${name}</button>`, name)).toEqual([
      `- ref_1: button "${formatText(name)}" - name matches "${formatText(name)}"`,
    ]);
    expect(lines(`<button>${name}</button>`, 'cookies and tracking')).toEqual([
      `- ref_1: button "${formatText(name)}" - name contains "cookies and tracking"`,
    ]);
  });
});

describe('visibility and sensitive fields', () => {
  it('leaves out hidden elements and their subtrees', () => {
    const html = [
      '<button data-hidden>Delete hidden</button>',
      '<div data-hidden><button>Delete inside</button></div>',
      '<button aria-hidden="true">Delete aria</button>',
      '<style>.delete {}</style>',
      '<button>Delete shown</button>',
    ].join('');
    expect(lines(html, 'delete')).toEqual(['- ref_1: button "Delete shown" - name contains "delete"']);
  });

  it('searches open shadow roots', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const host = document.getElementById('host');
    host?.attachShadow({ mode: 'open' }).append(Object.assign(document.createElement('button'), { textContent: 'Inner' }));
    const result = findElements(document, new RefRegistry(), 'inner', { isVisible: visible });
    expect(result).toEqual({ ok: true, text: 'Found 1 matching element\n- ref_1: button "Inner" - name matches "inner"' });
  });

  it('never matches or prints field values', () => {
    document.body.innerHTML = '<input id="a" title="Code"><textarea title="Notes">secret draft</textarea>';
    (document.getElementById('a') as HTMLInputElement).value = 'secret';
    const result = findElements(document, new RefRegistry(), 'secret', { isVisible: visible });
    expect(result).toEqual({ ok: false, error: 'No matching elements found for "secret"' });
  });

  it('finds a password field without its value', () => {
    document.body.innerHTML = '<input type="password" name="pw" placeholder="Password" value="hunter2">';
    const result = findElements(document, new RefRegistry(), 'password', { isVisible: visible });
    expect(result).toEqual({
      ok: true,
      text: 'Found 1 matching element\n- ref_1: textbox "Password" (password) - name matches "password"',
    });
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  it('does not show the selected option of a sensitive select', () => {
    const html = '<select autocomplete="cc-exp-month" title="Expiry"><option selected>07</option></select>';
    expect(lines(html, 'expiry')).toEqual(['- ref_1: combobox "Expiry" - name matches "expiry"']);
  });
});

describe('limits', () => {
  it(`stops after ${MAX_ELEMENTS} elements and says so`, () => {
    const html = `<button>Target</button>${'<button>x</button>'.repeat(MAX_ELEMENTS - 1)}<button>Target</button>`;
    expect(find(html, 'target').split('\n')).toEqual([
      'Found 1 matching element',
      '- ref_1: button "Target" - name matches "target"',
      `[search stopped after ${MAX_ELEMENTS} elements; later elements were not searched]`,
    ]);
  });

  it('has no cap note when every element was searched', () => {
    const html = `${'<button>x</button>'.repeat(MAX_ELEMENTS - 1)}<button>Target</button>`;
    expect(find(html, 'target').split('\n')).toEqual([
      'Found 1 matching element',
      '- ref_1: button "Target" - name matches "target"',
    ]);
  });

  it('does not search below 500 DOM levels', () => {
    const deep = '<div>'.repeat(600) + '<button>Deep</button>' + '</div>'.repeat(600);
    expect(failure(deep, 'deep')).toBe('No matching elements found for "deep"');
    const shallow = '<div>'.repeat(400) + '<button>Deep</button>' + '</div>'.repeat(400);
    expect(lines(shallow, 'deep')).toEqual(['- ref_1: button "Deep" - name matches "deep"']);
  });
});

describe('forEachTreeElement', () => {
  it('visits elements in document order until the callback returns false', () => {
    document.body.innerHTML = '<button>One</button><button>Two</button><button>Three</button>';
    const seen: string[] = [];
    forEachTreeElement(
      document,
      (node) => {
        seen.push(node.name());
        return seen.length < 2;
      },
      visible,
    );
    expect(seen).toEqual(['One', 'Two']);
  });

  it('gives the raw name, not the printed one', () => {
    document.body.innerHTML = '<button>Say "hi"</button>';
    const names: string[] = [];
    forEachTreeElement(document, (node) => names.push(node.name()) > 0, visible);
    expect(names).toEqual(['Say "hi"']);
  });
});

describe('refs', () => {
  it('shares refs with read_page in both directions', () => {
    const registry = new RefRegistry();
    document.body.innerHTML = '<h1>Shop</h1><button>Buy now</button>';
    const tree = buildAccessibilityTree(document, registry, { isVisible: visible });
    expect(tree).toEqual({ ok: true, tree: 'heading "Shop" [ref_1] level=1\nbutton "Buy now" [ref_2]' });
    const found = findElements(document, registry, 'buy', { isVisible: visible });
    expect(found).toEqual({ ok: true, text: 'Found 1 matching element\n- ref_2: button "Buy now" - name contains "buy"' });
  });

  it('returns refs that read_page resolves', () => {
    const registry = new RefRegistry();
    document.body.innerHTML = '<p>Intro text</p><form><button>Pay</button></form>';
    const found = findElements(document, registry, 'pay', { isVisible: visible });
    expect(found).toEqual({ ok: true, text: 'Found 1 matching element\n- ref_1: button "Pay" - name matches "pay"' });
    expect(buildAccessibilityTree(document, registry, { isVisible: visible, refId: 'ref_1' })).toEqual({
      ok: true,
      tree: 'button "Pay" [ref_1]',
    });
  });
});
