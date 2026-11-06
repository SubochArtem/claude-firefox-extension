const MAX_LIST_DEPTH = 2;
const MAX_QUOTE_DEPTH = 8;
const LINK_SCAN_LIMIT = 4096;
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const LANGUAGE = /^[\w+#.-]{1,32}$/;
const ASCII_PUNCTUATION = /^[!-/:-@[-`{-~]$/;
const ALPHANUMERIC = /^[\p{L}\p{N}]$/u;
const WHITESPACE = /^\s$/;

interface BlockContext {
  doc: Document;
  listDepth: number;
  quoteDepth: number;
}

interface Fence {
  indent: number;
  char: string;
  length: number;
  language: string;
}

interface ListItem {
  indent: number;
  contentIndent: number;
  ordered: boolean;
  start: number;
  content: string;
}

export function renderMarkdown(text: string, doc: Document): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  appendBlocks(fragment, text.replace(/\r\n?/g, '\n').split('\n'), { doc, listDepth: 0, quoteDepth: 0 });
  return fragment;
}

function appendBlocks(parent: Node, lines: string[], ctx: BlockContext): void {
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (isBlank(line)) {
      i++;
      continue;
    }
    const fence = matchFence(line);
    if (fence) {
      i = appendFence(parent, lines, i, fence, ctx);
      continue;
    }
    const heading = matchHeading(line);
    if (heading) {
      const element = ctx.doc.createElement(`h${heading.level}`);
      appendInline(element, heading.text, ctx.doc, false);
      parent.appendChild(element);
      i++;
      continue;
    }
    if (isRule(line)) {
      parent.appendChild(ctx.doc.createElement('hr'));
      i++;
      continue;
    }
    if (isQuote(line, ctx)) {
      i = appendQuote(parent, lines, i, ctx);
      continue;
    }
    const item = matchListItem(line, ctx);
    if (item) {
      i = appendList(parent, lines, i, item, ctx);
      continue;
    }
    i = appendParagraph(parent, lines, i, ctx);
  }
}

function startsBlock(line: string, ctx: BlockContext): boolean {
  return (
    isBlank(line) ||
    matchFence(line) !== null ||
    matchHeading(line) !== null ||
    isRule(line) ||
    isQuote(line, ctx) ||
    matchListItem(line, ctx) !== null
  );
}

function appendParagraph(parent: Node, lines: string[], start: number, ctx: BlockContext): number {
  const text: string[] = [(lines[start] ?? '').trim()];
  let i = start + 1;
  while (i < lines.length && !startsBlock(lines[i] ?? '', ctx)) {
    text.push((lines[i] ?? '').trim());
    i++;
  }
  const paragraph = ctx.doc.createElement('p');
  appendInline(paragraph, text.join('\n'), ctx.doc, false);
  parent.appendChild(paragraph);
  return i;
}

function matchFence(line: string): Fence | null {
  const { width, rest } = splitIndent(line);
  if (width > 3) return null;
  const match = /^(`{3,}|~{3,})(.*)$/.exec(rest);
  if (!match) return null;
  const marker = match[1] ?? '';
  const info = (match[2] ?? '').trim();
  if (marker.startsWith('`') && info.includes('`')) return null;
  const language = info.split(/\s/)[0] ?? '';
  return { indent: width, char: marker.charAt(0), length: marker.length, language: LANGUAGE.test(language) ? language : '' };
}

function closesFence(line: string, fence: Fence): boolean {
  const { width, rest } = splitIndent(line);
  const marker = rest.trimEnd();
  return width <= 3 && marker.length >= fence.length && [...marker].every((char) => char === fence.char);
}

function appendFence(parent: Node, lines: string[], start: number, fence: Fence, ctx: BlockContext): number {
  const content: string[] = [];
  let i = start + 1;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    i++;
    if (closesFence(line, fence)) break;
    content.push(stripColumns(line, fence.indent));
  }
  const pre = ctx.doc.createElement('pre');
  const code = ctx.doc.createElement('code');
  if (fence.language) code.className = `language-${fence.language}`;
  code.textContent = content.join('\n');
  pre.appendChild(code);
  parent.appendChild(pre);
  return i;
}

function matchHeading(line: string): { level: number; text: string } | null {
  const { width, rest } = splitIndent(line);
  if (width > 3) return null;
  const match = /^(#{1,6})(?:[ \t]+(.*))?$/.exec(rest);
  if (!match) return null;
  const text = (match[2] ?? '').replace(/(?:^|[ \t]+)#+[ \t]*$/, '').trim();
  return { level: (match[1] ?? '').length, text };
}

function isRule(line: string): boolean {
  const { width, rest } = splitIndent(line);
  return width <= 3 && /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(rest);
}

function isQuote(line: string, ctx: BlockContext): boolean {
  const { width, rest } = splitIndent(line);
  return ctx.quoteDepth < MAX_QUOTE_DEPTH && width <= 3 && rest.startsWith('>');
}

function appendQuote(parent: Node, lines: string[], start: number, ctx: BlockContext): number {
  const inner: string[] = [];
  let i = start;
  while (i < lines.length && isQuote(lines[i] ?? '', ctx)) {
    inner.push(splitIndent(lines[i] ?? '').rest.replace(/^>[ \t]?/, ''));
    i++;
  }
  const quote = ctx.doc.createElement('blockquote');
  appendBlocks(quote, inner, { ...ctx, quoteDepth: ctx.quoteDepth + 1 });
  parent.appendChild(quote);
  return i;
}

function matchListItem(line: string, ctx: BlockContext): ListItem | null {
  if (ctx.listDepth >= MAX_LIST_DEPTH) return null;
  const { width, rest } = splitIndent(line);
  const match = /^([-*+]|(\d{1,9})[.)])([ \t]+)(.*)$/.exec(rest);
  if (!match) return null;
  const marker = match[1] ?? '';
  const spaces = (match[3] ?? '').length;
  return {
    indent: width,
    contentIndent: width + marker.length + (spaces > 4 ? 1 : spaces),
    ordered: match[2] !== undefined,
    start: Number(match[2] ?? 1),
    content: match[4] ?? '',
  };
}

function appendList(parent: Node, lines: string[], start: number, first: ListItem, ctx: BlockContext): number {
  const list = ctx.doc.createElement(first.ordered ? 'ol' : 'ul');
  if (first.ordered && first.start !== 1) list.setAttribute('start', String(first.start));
  let item = first;
  let i = start;
  for (;;) {
    const body = [item.content];
    i++;
    while (i < lines.length) {
      const line = lines[i] ?? '';
      if (isBlank(line)) {
        const next = nextNonBlank(lines, i);
        if (next < lines.length && indentWidth(lines[next] ?? '') >= item.indent + 2) {
          for (; i < next; i++) body.push('');
          continue;
        }
        break;
      }
      if (indentWidth(line) < item.indent + 2) break;
      body.push(stripColumns(line, item.contentIndent));
      i++;
    }
    list.appendChild(renderListItem(body, ctx));
    const next = nextNonBlank(lines, i);
    const sibling = next < lines.length ? matchListItem(lines[next] ?? '', ctx) : null;
    if (!sibling || sibling.ordered !== first.ordered) break;
    item = sibling;
    i = next;
  }
  parent.appendChild(list);
  return i;
}

function renderListItem(body: string[], ctx: BlockContext): HTMLLIElement {
  const li = ctx.doc.createElement('li');
  appendBlocks(li, body, { ...ctx, listDepth: ctx.listDepth + 1 });
  const first = li.firstChild;
  if (first && first.nodeName === 'P') {
    while (first.firstChild) li.insertBefore(first.firstChild, first);
    li.removeChild(first);
  }
  return li;
}

function nextNonBlank(lines: string[], from: number): number {
  let i = from;
  while (i < lines.length && isBlank(lines[i] ?? '')) i++;
  return i;
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

function indentWidth(line: string): number {
  return splitIndent(line).width;
}

function splitIndent(line: string): { width: number; rest: string } {
  let width = 0;
  let i = 0;
  for (; i < line.length; i++) {
    if (line[i] === ' ') width++;
    else if (line[i] === '\t') width += 4 - (width % 4);
    else break;
  }
  return { width, rest: line.slice(i) };
}

function stripColumns(line: string, columns: number): string {
  let width = 0;
  let i = 0;
  while (i < line.length && width < columns) {
    if (line[i] === ' ') width++;
    else if (line[i] === '\t') {
      const tab = 4 - (width % 4);
      if (width + tab > columns) return ' '.repeat(width + tab - columns) + line.slice(i + 1);
      width += tab;
    } else break;
    i++;
  }
  return line.slice(i);
}

interface Delimiter {
  kind: 'delimiter';
  char: string;
  length: number;
  count: number;
  canOpen: boolean;
  canClose: boolean;
}

type InlineToken = { kind: 'node'; node: Node } | Delimiter;

function appendInline(parent: Node, text: string, doc: Document, inLink: boolean): void {
  const tokens = tokenizeInline(text, doc, inLink);
  processEmphasis(tokens, doc);
  for (const token of tokens) appendToken(parent, token, doc);
}

function appendToken(parent: Node, token: InlineToken, doc: Document): void {
  if (token.kind === 'node') parent.appendChild(token.node);
  else if (token.count > 0) parent.appendChild(doc.createTextNode(token.char.repeat(token.count)));
}

function tokenizeInline(text: string, doc: Document, inLink: boolean): InlineToken[] {
  const tokens: InlineToken[] = [];
  const failedCodeSearch = new Map<number, number>();
  let buffer = '';
  const flush = (): void => {
    if (buffer) tokens.push({ kind: 'node', node: doc.createTextNode(buffer) });
    buffer = '';
  };
  const pushNode = (node: Node): void => {
    flush();
    tokens.push({ kind: 'node', node });
  };

  let i = 0;
  while (i < text.length) {
    const char = text.charAt(i);
    if (char === '\\' && ASCII_PUNCTUATION.test(text.charAt(i + 1))) {
      buffer += text.charAt(i + 1);
      i += 2;
      continue;
    }
    if (char === '\n') {
      pushNode(doc.createElement('br'));
      i++;
      continue;
    }
    if (char === '`') {
      const run = runLength(text, i);
      const close = findCodeClose(text, i + run, run, failedCodeSearch);
      if (close < 0) {
        buffer += text.slice(i, i + run);
      } else {
        const code = doc.createElement('code');
        code.textContent = codeSpanText(text.slice(i + run, close));
        pushNode(code);
      }
      i = close < 0 ? i + run : close + run;
      continue;
    }
    if (char === '*' || char === '_') {
      const run = runLength(text, i);
      const before = i > 0 ? text.charAt(i - 1) : ' ';
      const after = i + run < text.length ? text.charAt(i + run) : ' ';
      const leftFlanking = !WHITESPACE.test(after);
      const rightFlanking = !WHITESPACE.test(before);
      flush();
      tokens.push({
        kind: 'delimiter',
        char,
        length: run,
        count: run,
        canOpen: leftFlanking && (char === '*' || !ALPHANUMERIC.test(before)),
        canClose: rightFlanking && (char === '*' || !ALPHANUMERIC.test(after)),
      });
      i += run;
      continue;
    }
    if (char === '[' && !inLink) {
      const link = parseLink(text, i);
      if (link) {
        const href = safeHref(link.destination);
        if (href === null) {
          buffer += text.slice(i, link.end);
        } else {
          const anchor = createAnchor(doc, href);
          appendInline(anchor, link.label, doc, true);
          pushNode(anchor);
        }
        i = link.end;
        continue;
      }
    }
    if (!inLink && (char === 'h' || char === 'H')) {
      const url = matchBareUrl(text, i);
      const href = url === null ? null : safeHref(url);
      if (url !== null && href !== null) {
        const anchor = createAnchor(doc, href);
        anchor.textContent = url;
        pushNode(anchor);
        i += url.length;
        continue;
      }
    }
    buffer += char;
    i++;
  }
  flush();
  return tokens;
}

function runLength(text: string, start: number): number {
  const char = text.charAt(start);
  let end = start;
  while (text.charAt(end) === char) end++;
  return end - start;
}

function findCodeClose(text: string, from: number, run: number, failedFrom: Map<number, number>): number {
  const failed = failedFrom.get(run);
  if (failed !== undefined && from >= failed) return -1;
  let j = text.indexOf('`', from);
  while (j >= 0) {
    const length = runLength(text, j);
    if (length === run) return j;
    j = text.indexOf('`', j + length);
  }
  failedFrom.set(run, Math.min(failed ?? from, from));
  return -1;
}

function codeSpanText(raw: string): string {
  const text = raw.replace(/\n/g, ' ');
  if (text.length > 1 && text.startsWith(' ') && text.endsWith(' ') && text.trim() !== '') return text.slice(1, -1);
  return text;
}

function parseLink(text: string, start: number): { label: string; destination: string; end: number } | null {
  const limit = Math.min(text.length, start + LINK_SCAN_LIMIT);
  let depth = 0;
  let close = -1;
  for (let j = start; j < limit; j++) {
    const char = text.charAt(j);
    if (char === '\\') j++;
    else if (char === '[') depth++;
    else if (char === ']' && --depth === 0) {
      close = j;
      break;
    }
  }
  if (close < 0 || text.charAt(close + 1) !== '(') return null;

  let i = skipSpaces(text, close + 2, limit);
  const destinationStart = i;
  let parens = 0;
  for (; i < limit; i++) {
    const char = text.charAt(i);
    if (char === '\\') i++;
    else if (WHITESPACE.test(char)) break;
    else if (char === '(') parens++;
    else if (char === ')') {
      if (parens === 0) break;
      parens--;
    }
  }
  if (i >= limit) return null;
  const destination = text.slice(destinationStart, i);

  i = skipSpaces(text, i, limit);
  const quote = text.charAt(i);
  if (quote === '"' || quote === "'") {
    const titleEnd = text.indexOf(quote, i + 1);
    if (titleEnd < 0 || titleEnd >= limit) return null;
    i = skipSpaces(text, titleEnd + 1, limit);
  }
  if (text.charAt(i) !== ')') return null;
  return { label: text.slice(start + 1, close), destination, end: i + 1 };
}

function skipSpaces(text: string, from: number, limit: number): number {
  let i = from;
  while (i < limit && WHITESPACE.test(text.charAt(i))) i++;
  return i;
}

function matchBareUrl(text: string, start: number): string | null {
  if (!/^https?:\/\//i.test(text.slice(start, start + 8))) return null;
  if (start > 0 && ALPHANUMERIC.test(text.charAt(start - 1))) return null;
  let end = start;
  while (end < text.length && !/[\s<>]/.test(text.charAt(end))) end++;
  let url = text.slice(start, end);
  for (;;) {
    const last = url.charAt(url.length - 1);
    if (/[.,:;!?'"*_~]/.test(last)) url = url.slice(0, -1);
    else if (last === ')' && count(url, ')') > count(url, '(')) url = url.slice(0, -1);
    else break;
  }
  return /^https?:\/\/[^/?#]/i.test(url) ? url : null;
}

function count(text: string, char: string): number {
  return text.split(char).length - 1;
}

function safeHref(destination: string): string | null {
  let url: URL;
  try {
    url = new URL(destination.trim());
  } catch {
    return null;
  }
  return SAFE_PROTOCOLS.has(url.protocol) ? url.href : null;
}

function createAnchor(doc: Document, href: string): HTMLAnchorElement {
  const anchor = doc.createElement('a');
  anchor.setAttribute('href', href);
  anchor.setAttribute('target', '_blank');
  anchor.setAttribute('rel', 'noopener noreferrer');
  return anchor;
}

function processEmphasis(tokens: InlineToken[], doc: Document): void {
  const bottom = new Map<string, number>([
    ['*', 0],
    ['_', 0],
  ]);
  let closerIndex = 0;
  while (closerIndex < tokens.length) {
    const closer = tokens[closerIndex];
    if (closer?.kind !== 'delimiter' || !closer.canClose || closer.count === 0) {
      closerIndex++;
      continue;
    }
    let openerIndex = -1;
    let skipped = false;
    for (let j = closerIndex - 1; j >= (bottom.get(closer.char) ?? 0); j--) {
      const candidate = tokens[j];
      if (candidate?.kind !== 'delimiter' || candidate.char !== closer.char || !candidate.canOpen || candidate.count === 0) continue;
      if (failsRuleOfThree(candidate, closer)) {
        skipped = true;
        continue;
      }
      openerIndex = j;
      break;
    }
    const opener = tokens[openerIndex];
    if (opener?.kind !== 'delimiter') {
      if (!skipped) bottom.set(closer.char, closerIndex);
      closerIndex++;
      continue;
    }

    const used = opener.count >= 2 && closer.count >= 2 ? 2 : 1;
    const element = doc.createElement(used === 2 ? 'strong' : 'em');
    for (const token of tokens.slice(openerIndex + 1, closerIndex)) appendToken(element, token, doc);
    opener.count -= used;
    closer.count -= used;
    tokens.splice(openerIndex + 1, closerIndex - openerIndex - 1, { kind: 'node', node: element });
    closerIndex = openerIndex + 2;
    for (const [char, index] of bottom) bottom.set(char, Math.min(index, openerIndex + 1));
  }
}

function failsRuleOfThree(opener: Delimiter, closer: Delimiter): boolean {
  return (
    (opener.canClose || closer.canOpen) &&
    (opener.length + closer.length) % 3 === 0 &&
    !(opener.length % 3 === 0 && closer.length % 3 === 0)
  );
}
