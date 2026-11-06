// @vitest-environment happy-dom
/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../sidebar/markdown';
import markdownSource from '../sidebar/markdown.ts?raw';

function render(text: string): HTMLDivElement {
  const container = document.createElement('div');
  container.appendChild(renderMarkdown(text, document));
  return container;
}

function html(text: string): string {
  return render(text).innerHTML;
}

const LINK_ATTRS = 'target="_blank" rel="noopener noreferrer"';

describe('blocks', () => {
  it('renders nothing for empty or blank input', () => {
    expect(html('')).toBe('');
    expect(html('  \n\n \t\n')).toBe('');
  });

  it('renders paragraphs separated by blank lines', () => {
    expect(html('one\n\ntwo')).toBe('<p>one</p><p>two</p>');
  });

  it('renders single line breaks inside a paragraph as br', () => {
    expect(html('one\ntwo')).toBe('<p>one<br>two</p>');
    expect(html('one\r\ntwo')).toBe('<p>one<br>two</p>');
  });

  it('renders headings of every level', () => {
    for (let level = 1; level <= 6; level++) {
      expect(html(`${'#'.repeat(level)} Title`)).toBe(`<h${level}>Title</h${level}>`);
    }
  });

  it('strips a closing hash sequence and needs a space after the hashes', () => {
    expect(html('## Title ##')).toBe('<h2>Title</h2>');
    expect(html('#hashtag')).toBe('<p>#hashtag</p>');
    expect(html('####### seven')).toBe('<p>####### seven</p>');
  });

  it('lets a heading interrupt a paragraph', () => {
    expect(html('text\n# Head\nmore')).toBe('<p>text</p><h1>Head</h1><p>more</p>');
  });

  it('renders horizontal rules', () => {
    expect(html('a\n\n---\n\nb')).toBe('<p>a</p><hr><p>b</p>');
    expect(html('***')).toBe('<hr>');
    expect(html('- - -')).toBe('<hr>');
    expect(html('a\n---')).toBe('<p>a</p><hr>');
  });

  it('renders blockquotes with block content inside', () => {
    expect(html('> quoted\n> text')).toBe('<blockquote><p>quoted<br>text</p></blockquote>');
    expect(html('> # Head\n>\n> body')).toBe('<blockquote><h1>Head</h1><p>body</p></blockquote>');
    expect(html('> outer\n>> inner')).toBe('<blockquote><p>outer</p><blockquote><p>inner</p></blockquote></blockquote>');
  });

  it('ends a blockquote at the first line without a marker', () => {
    expect(html('> quote\nafter')).toBe('<blockquote><p>quote</p></blockquote><p>after</p>');
  });

  it('caps blockquote nesting without throwing', () => {
    const deep = `${'>'.repeat(5000)} deep`;
    expect(() => render(deep)).not.toThrow();
    expect(render(deep).textContent).toContain('deep');
  });
});

describe('lists', () => {
  it('renders unordered lists with any bullet', () => {
    expect(html('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(html('* a\n+ b')).toBe('<ul><li>a</li><li>b</li></ul>');
  });

  it('renders ordered lists and keeps a start number other than one', () => {
    expect(html('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>');
    expect(html('3) a\n4) b')).toBe('<ol start="3"><li>a</li><li>b</li></ol>');
  });

  it('lets a list interrupt a paragraph and ends it at an unindented line', () => {
    expect(html('Steps:\n1. a\n2. b\nDone')).toBe('<p>Steps:</p><ol><li>a</li><li>b</li></ol><p>Done</p>');
  });

  it('keeps a list together across blank lines between items', () => {
    expect(html('- a\n\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
  });

  it('starts a new list when the list type changes', () => {
    expect(html('- a\n1. b')).toBe('<ul><li>a</li></ul><ol><li>b</li></ol>');
  });

  it('nests one level by indentation', () => {
    expect(html('- a\n  - b\n  - c\n- d')).toBe('<ul><li>a<ul><li>b</li><li>c</li></ul></li><li>d</li></ul>');
    expect(html('1. a\n   1. b\n2. c')).toBe('<ol><li>a<ol><li>b</li></ol></li><li>c</li></ol>');
    expect(html('1. a\n  - b')).toBe('<ol><li>a<ul><li>b</li></ul></li></ol>');
  });

  it('keeps deeper indentation as text of the nested item', () => {
    const container = render('- a\n  - b\n    - c');
    expect(container.querySelectorAll('ul')).toHaveLength(2);
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.textContent).toContain('- c');
  });

  it('continues an item on indented lines', () => {
    expect(html('- first\n  second')).toBe('<ul><li>first<br>second</li></ul>');
    expect(html('- a\n\n  more')).toBe('<ul><li>a<p>more</p></li></ul>');
  });

  it('renders a fenced code block inside an item', () => {
    expect(html('1. run\n   ```sh\n   npm test\n   ```\n2. done')).toBe(
      '<ol><li>run<pre><code class="language-sh">npm test</code></pre></li><li>done</li></ol>',
    );
  });

  it('does not treat a marker without a following space as a list', () => {
    expect(html('-a')).toBe('<p>-a</p>');
    expect(html('1.5 liters')).toBe('<p>1.5 liters</p>');
  });
});

describe('fenced code blocks', () => {
  it('renders the content verbatim with the language as a class', () => {
    expect(html('```js\nconst a = 1;\n```')).toBe('<pre><code class="language-js">const a = 1;</code></pre>');
  });

  it('renders without a language', () => {
    expect(html('```\nplain\n```')).toBe('<pre><code>plain</code></pre>');
  });

  it('keeps html and markdown characters as text', () => {
    const source = '<script>alert(1)</script>\n**not bold** _x_ [a](https://e.com)\n# not a heading\n- not a list\n> not a quote';
    const container = render(`\`\`\`html\n${source}\n\`\`\``);
    const code = container.querySelector('pre > code');
    expect(code?.textContent).toBe(source);
    expect(code?.children).toHaveLength(0);
    expect(container.querySelector('script')).toBeNull();
  });

  it('keeps blank lines and indentation inside the block', () => {
    expect(render('```\n  a\n\n\tb\n```').querySelector('code')?.textContent).toBe('  a\n\n\tb');
  });

  it('supports tilde fences and longer closing fences', () => {
    expect(html('~~~\n```\n~~~')).toBe('<pre><code>```</code></pre>');
    expect(html('````\n```\n`````')).toBe('<pre><code>```</code></pre>');
  });

  it('renders an unclosed fence to the end as code', () => {
    expect(html('text\n```py\nprint(1)\n**x**')).toBe('<p>text</p><pre><code class="language-py">print(1)\n**x**</code></pre>');
    expect(html('```')).toBe('<pre><code></code></pre>');
  });

  it('continues with blocks after the closing fence', () => {
    expect(html('```\na\n```\nafter')).toBe('<pre><code>a</code></pre><p>after</p>');
  });

  it('ignores a language that is not a plain word', () => {
    expect(html('```a"b onclick=x\nc\n```')).toBe('<pre><code>c</code></pre>');
  });
});

describe('inline styles', () => {
  it('renders bold and italic', () => {
    expect(html('**bold** and *italic* and _also_')).toBe('<p><strong>bold</strong> and <em>italic</em> and <em>also</em></p>');
    expect(html('__bold__')).toBe('<p><strong>bold</strong></p>');
  });

  it('nests emphasis', () => {
    expect(html('**bold *both* bold**')).toBe('<p><strong>bold <em>both</em> bold</strong></p>');
    expect(html('*it **both** it*')).toBe('<p><em>it <strong>both</strong> it</em></p>');
    expect(html('***both***')).toBe('<p><em><strong>both</strong></em></p>');
  });

  it('leaves spaced and intraword underscore delimiters alone', () => {
    expect(html('2 * 3 * 4')).toBe('<p>2 * 3 * 4</p>');
    expect(html('snake_case_name')).toBe('<p>snake_case_name</p>');
  });

  it('renders inline code verbatim', () => {
    expect(html('use `**x** <b>` here')).toBe('<p>use <code>**x** &lt;b&gt;</code> here</p>');
    expect(html('``a ` b``')).toBe('<p><code>a ` b</code></p>');
  });

  it('honours backslash escapes', () => {
    expect(html('\\*not italic\\*')).toBe('<p>*not italic*</p>');
  });

  it('renders inline styles inside list items, headings and quotes', () => {
    expect(html('- **b** `c` [l](https://e.com/)')).toBe(
      `<ul><li><strong>b</strong> <code>c</code> <a href="https://e.com/" ${LINK_ATTRS}>l</a></li></ul>`,
    );
    expect(html('## *i* and **b**')).toBe('<h2><em>i</em> and <strong>b</strong></h2>');
    expect(html('> _i_ `c`')).toBe('<blockquote><p><em>i</em> <code>c</code></p></blockquote>');
    expect(html('1. a\n   - *nested* **b**')).toBe('<ol><li>a<ul><li><em>nested</em> <strong>b</strong></li></ul></li></ol>');
  });

  it('renders emphasis inside link text', () => {
    expect(html('[**bold** link](https://e.com/)')).toBe(`<p><a href="https://e.com/" ${LINK_ATTRS}><strong>bold</strong> link</a></p>`);
  });
});

describe('links', () => {
  it('renders http, https and mailto links', () => {
    expect(html('[a](http://e.com/x)')).toBe(`<p><a href="http://e.com/x" ${LINK_ATTRS}>a</a></p>`);
    expect(html('[b](https://e.com/path?q=1#f "title")')).toBe(`<p><a href="https://e.com/path?q=1#f" ${LINK_ATTRS}>b</a></p>`);
    expect(html('[mail](mailto:me@e.com)')).toBe(`<p><a href="mailto:me@e.com" ${LINK_ATTRS}>mail</a></p>`);
  });

  it('keeps balanced parentheses in the destination', () => {
    expect(render('[w](https://e.com/a_(b))').querySelector('a')?.getAttribute('href')).toBe('https://e.com/a_(b)');
  });

  it('renders bare http and https URLs as links', () => {
    expect(html('see https://e.com/a.')).toBe(`<p>see <a href="https://e.com/a" ${LINK_ATTRS}>https://e.com/a</a>.</p>`);
    expect(html('(http://e.com/x)')).toBe(`<p>(<a href="http://e.com/x" ${LINK_ATTRS}>http://e.com/x</a>)</p>`);
    expect(html('**https://e.com/**')).toBe(`<p><strong><a href="https://e.com/" ${LINK_ATTRS}>https://e.com/</a></strong></p>`);
  });

  it('does not link bare URLs of other schemes or inside words', () => {
    expect(render('ftp://e.com mailto:a@b.c xhttps://e.com').querySelector('a')).toBeNull();
  });

  it('does not link a URL inside inline code', () => {
    expect(html('`https://e.com`')).toBe('<p><code>https://e.com</code></p>');
  });
});

describe('unsafe input', () => {
  function expectNoActiveContent(container: HTMLElement): void {
    expect(container.querySelector('script, img, iframe, object, embed, svg, style')).toBeNull();
    for (const element of container.querySelectorAll('*')) {
      for (const attribute of element.getAttributeNames()) {
        expect(attribute.startsWith('on')).toBe(false);
      }
    }
    for (const anchor of container.querySelectorAll('a')) {
      expect(['http:', 'https:', 'mailto:']).toContain(new URL(anchor.getAttribute('href') ?? '').protocol);
    }
  }

  it('shows raw html as literal text', () => {
    const text = '<img src=x onerror="alert(1)"> and <script>alert(2)</script>';
    const container = render(text);
    expectNoActiveContent(container);
    expect(container.textContent).toBe(text);
  });

  it('shows raw html inside headings, lists and quotes as text', () => {
    const container = render('# <img src=x onerror=alert(1)>\n- <script>x</script>\n> <iframe src=javascript:alert(1)>');
    expectNoActiveContent(container);
    expect(container.textContent).toContain('<script>x</script>');
  });

  it('renders javascript links as plain text', () => {
    for (const text of ['[x](javascript:alert(1))', '[x](JaVaScRiPt:alert(1))', '[x](  javascript:alert(1))', '[x](java\tscript:alert(1))']) {
      const container = render(text);
      expect(container.querySelector('a')).toBeNull();
      expect(container.textContent).toBe(text);
    }
  });

  it('renders data, relative and other scheme links as plain text', () => {
    for (const text of [
      '[x](data:text/html,<script>alert(1)</script>)',
      '[x](data:text/html;base64,PHNjcmlwdD4=)',
      '[x](/relative/path)',
      '[x](//evil.example/)',
      '[x](vbscript:msgbox)',
      '[x](file:///etc/passwd)',
    ]) {
      const container = render(text);
      expect(container.querySelector('a')).toBeNull();
      expect(container.textContent).toBe(text);
    }
  });

  it('keeps an attribute-breaking URL inside href', () => {
    const container = render('[x](https://e.com/"onmouseover="alert(1)) and https://e.com/"><img/src=x/onerror=alert(1)>');
    expectNoActiveContent(container);
    const anchors = container.querySelectorAll('a');
    expect(anchors).toHaveLength(2);
    for (const anchor of anchors) {
      expect(anchor.getAttributeNames().sort()).toEqual(['href', 'rel', 'target']);
    }
    expect(anchors[0]?.getAttribute('href')).toBe('https://e.com/%22onmouseover=%22alert(1)');
  });

  it('does not run the renderer through html parsing', () => {
    const forbidden = ['inner' + 'HTML', 'outer' + 'HTML', 'insertAdjacent' + 'HTML', 'document.write', 'DOMParser', 'createContextualFragment'];
    for (const name of forbidden) {
      expect(markdownSource).not.toContain(name);
    }
    expect(markdownSource).not.toMatch(/\bbrowser\./);
  });
});

describe('partial streaming input', () => {
  it('renders unclosed emphasis and code as literal text', () => {
    expect(html('**bold')).toBe('<p>**bold</p>');
    expect(html('*it')).toBe('<p>*it</p>');
    expect(html('some `code')).toBe('<p>some `code</p>');
  });

  it('renders partial links as literal text', () => {
    for (const text of ['[text', '[text]', '[text](', '[text](https:']) {
      const container = render(text);
      expect(container.querySelector('a')).toBeNull();
      expect(container.textContent).toBe(text);
    }
  });

  it('links only the bare URL of an unfinished link', () => {
    for (const text of ['[text](https://e.com', '[text](https://e.com "t']) {
      const container = render(text);
      expect(container.textContent).toBe(text);
      expect([...container.querySelectorAll('a')].map((anchor) => anchor.textContent)).toEqual(['https://e.com']);
    }
  });

  it('renders every prefix of a message without throwing', () => {
    const message = [
      '# Plan',
      '',
      'Some **bold *nested* text** with `code` and [a link](https://e.com/x_(y)).',
      '',
      '1. first',
      '   - nested **item**',
      '2. second',
      '',
      '> quote with https://e.com',
      '',
      '```ts',
      'const x = "<b>";',
      '```',
      '---',
    ].join('\n');
    for (let end = 0; end <= message.length; end++) {
      expect(() => render(message.slice(0, end))).not.toThrow();
    }
  });

  it('renders long pathological input in reasonable time', () => {
    const inputs = ['*a '.repeat(20_000), 'a* '.repeat(20_000), '['.repeat(20_000), '[a]('.repeat(5_000), '`'.repeat(5_000) + ' x ``'.repeat(5_000), '- '.repeat(20_000)];
    const started = Date.now();
    for (const input of inputs) render(input);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
