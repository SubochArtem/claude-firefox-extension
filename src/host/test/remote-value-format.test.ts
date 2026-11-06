import { describe, expect, it } from 'vitest';
import { formatRemoteValue, MAX_FORMATTED_CHARS } from '../remote-value-format';

const str = (value: string) => ({ type: 'string', value });
const num = (value: number | string) => ({ type: 'number', value });
const obj = (entries: [string | object, object][], extra: object = {}) => ({ type: 'object', value: entries, ...extra });
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

describe('formatRemoteValue', () => {
  it('formats primitives', () => {
    expect(formatRemoteValue({ type: 'undefined' })).toBe('undefined');
    expect(formatRemoteValue({ type: 'null' })).toBe('null');
    expect(formatRemoteValue({ type: 'boolean', value: true })).toBe('true');
    expect(formatRemoteValue(num(42))).toBe('42');
    expect(formatRemoteValue(num(-1.5))).toBe('-1.5');
    expect(formatRemoteValue(num('NaN'))).toBe('NaN');
    expect(formatRemoteValue(num('-0'))).toBe('-0');
    expect(formatRemoteValue(num('Infinity'))).toBe('Infinity');
    expect(formatRemoteValue(num('-Infinity'))).toBe('-Infinity');
    expect(formatRemoteValue({ type: 'bigint', value: '12345678901234567890' })).toBe('12345678901234567890n');
    expect(formatRemoteValue({ type: 'symbol', handle: 'h' })).toBe('Symbol()');
  });

  it('prints a top-level string as is and nested strings quoted', () => {
    expect(formatRemoteValue(str('Example Domain\nline 2'))).toBe('Example Domain\nline 2');
    expect(formatRemoteValue({ type: 'array', value: [str('a "b"'), str('c\nd')] })).toBe('["a \\"b\\"", "c\\nd"]');
  });

  it('formats short arrays and objects on one line', () => {
    expect(formatRemoteValue({ type: 'array', value: [num(1), num(2), { type: 'null' }] })).toBe('[1, 2, null]');
    expect(formatRemoteValue({ type: 'array', value: [] })).toBe('[]');
    expect(formatRemoteValue(obj([]))).toBe('{}');
    expect(formatRemoteValue(obj([['a', num(1)], ['b-c', str('x')], ['$_ok', { type: 'boolean', value: false }]]))).toBe(
      '{a: 1, "b-c": "x", $_ok: false}',
    );
  });

  it('breaks long or nested containers over indented lines', () => {
    const long = { type: 'array', value: Array.from({ length: 30 }, (_, i) => num(i * 1000)) };
    const lines = formatRemoteValue(long).split('\n');
    expect(lines[0]).toBe('[');
    expect(lines[1]).toBe('  0,');
    expect(lines.at(-2)).toBe('  29000');
    expect(lines.at(-1)).toBe(']');
    const nested = obj([
      ['title', str('Example Domain with a long enough title to break the line')],
      ['links', { type: 'array', value: [str('https://a.example/'), str('https://b.example/')] }],
    ]);
    expect(formatRemoteValue(nested)).toBe(
      '{\n  title: "Example Domain with a long enough title to break the line",\n  links: ["https://a.example/", "https://b.example/"]\n}',
    );
  });

  it('formats Map, Set, Date and RegExp', () => {
    expect(formatRemoteValue({ type: 'map', value: [[str('k'), num(1)], ['plain', num(2)]] })).toBe('Map(2) {"k" => 1, "plain" => 2}');
    expect(formatRemoteValue({ type: 'set', value: [num(1), str('a')] })).toBe('Set(2) {1, "a"}');
    expect(formatRemoteValue({ type: 'date', value: '2024-01-02T03:04:05.000Z' })).toBe('Date(2024-01-02T03:04:05.000Z)');
    expect(formatRemoteValue({ type: 'regexp', value: { pattern: 'a+b', flags: 'gi' } })).toBe('/a+b/gi');
    expect(formatRemoteValue({ type: 'regexp', value: { pattern: 'x' } })).toBe('/x/');
  });

  it('describes nodes briefly', () => {
    const div = {
      type: 'node',
      sharedId: 's1',
      value: { nodeType: 1, localName: 'div', childNodeCount: 3, attributes: { id: 'x', class: 'y z', style: 'color: red', 'data-v': '1' } },
    };
    expect(formatRemoteValue(div)).toBe('<div id="x" class="y z">');
    const input = {
      type: 'node',
      value: { nodeType: 1, localName: 'input', childNodeCount: 0, attributes: { type: 'password', name: 'pw', value: 'hunter2' } },
    };
    expect(formatRemoteValue(input)).toBe('<input name="pw" type="password">');
    expect(formatRemoteValue({ type: 'node', value: { nodeType: 3, childNodeCount: 0, nodeValue: 'Hello\n  world' } })).toBe(
      '#text "Hello world"',
    );
    expect(formatRemoteValue({ type: 'node', value: { nodeType: 8, childNodeCount: 0, nodeValue: ' note ' } })).toBe('<!-- note -->');
    expect(formatRemoteValue({ type: 'node', value: { nodeType: 9, childNodeCount: 2 } })).toBe('#document');
    expect(formatRemoteValue({ type: 'node', value: { nodeType: 11, childNodeCount: 1, mode: 'open' } })).toBe('#shadow-root (open)');
    expect(formatRemoteValue({ type: 'node', sharedId: 's2' })).toBe('<node>');
    expect(formatRemoteValue({ type: 'nodelist', value: [div] })).toBe('NodeList(1) [<div id="x" class="y z">]');
    expect(formatRemoteValue({ type: 'htmlcollection', value: [] })).toBe('HTMLCollection(0) []');
  });

  it('clips long attributes and text of nodes', () => {
    const long = 'a'.repeat(200);
    const anchor = { type: 'node', value: { nodeType: 1, localName: 'a', childNodeCount: 0, attributes: { href: long } } };
    expect(formatRemoteValue(anchor)).toBe(`<a href="${'a'.repeat(80)}…">`);
    expect(formatRemoteValue({ type: 'node', value: { nodeType: 3, childNodeCount: 0, nodeValue: long } })).toBe(`#text "${'a'.repeat(80)}…"`);
  });

  it('names values BiDi serializes without content', () => {
    expect(formatRemoteValue({ type: 'window', value: { context: 'ctx' } })).toBe('[Window]');
    expect(formatRemoteValue({ type: 'function', handle: 'h' })).toBe('[Function]');
    expect(formatRemoteValue({ type: 'promise' })).toBe('[Promise]');
    expect(formatRemoteValue({ type: 'error' })).toBe('[Error]');
    expect(formatRemoteValue({ type: 'weakmap' })).toBe('[WeakMap]');
    expect(formatRemoteValue({ type: 'weakset' })).toBe('[WeakSet]');
    expect(formatRemoteValue({ type: 'generator' })).toBe('[Generator]');
    expect(formatRemoteValue({ type: 'proxy' })).toBe('[Proxy]');
    expect(formatRemoteValue({ type: 'typedarray' })).toBe('[TypedArray]');
    expect(formatRemoteValue({ type: 'arraybuffer' })).toBe('[ArrayBuffer]');
    expect(formatRemoteValue({ type: 'something-new' })).toBe('[something-new]');
    expect(formatRemoteValue('not a remote value')).toBe('[unrecognized value]');
  });

  it('shows containers cut off by the depth limit', () => {
    const value = obj([
      ['list', { type: 'array' }],
      ['inner', { type: 'object' }],
      ['map', { type: 'map' }],
      ['set', { type: 'set' }],
    ]);
    expect(formatRemoteValue(value)).toBe('{list: [Array], inner: [Object], map: [Map], set: [Set]}');
  });

  it('labels repeated and circular references by internal id', () => {
    const self = obj([['name', str('a')], ['self', { type: 'object', internalId: 'i-1' }]], { internalId: 'i-1' });
    expect(formatRemoteValue(self)).toBe('<ref *1> {name: "a", self: [Ref *1]}');
    const shared = obj([['x', num(1)]], { internalId: 'i-2' });
    expect(formatRemoteValue({ type: 'array', value: [shared, { type: 'object', internalId: 'i-2' }, obj([], { internalId: 'i-3' })] })).toBe(
      '[<ref *1> {x: 1}, [Ref *1], {}]',
    );
  });

  it('redacts values under sensitive keys', () => {
    const value = obj([
      ['user', str('ann')],
      ['password', str('hunter2')],
      ['apiKey', str('k')],
      ['api_key', num(5)],
      ['X-Auth-Token', str('t')],
      ['sessionId', obj([['id', str('s')]])],
      ['cookies', { type: 'array', value: [str('a=b')] }],
      ['private-key', str('p')],
      ['AccessKey', str('a')],
      ['client_secret', str('s')],
      ['Bearer', str('b')],
      ['credentials', str('c')],
      ['passwd', str('p')],
    ]);
    expect(formatRemoteValue(value)).toBe(
      '{\n  user: "ann",\n  password: [REDACTED],\n  apiKey: [REDACTED],\n  api_key: [REDACTED],\n  "X-Auth-Token": [REDACTED],\n  sessionId: [REDACTED],\n  cookies: [REDACTED],\n  "private-key": [REDACTED],\n  AccessKey: [REDACTED],\n  client_secret: [REDACTED],\n  Bearer: [REDACTED],\n  credentials: [REDACTED],\n  passwd: [REDACTED]\n}',
    );
    expect(formatRemoteValue({ type: 'map', value: [[str('token'), str('t')], [num(1), str('one')]] })).toBe(
      'Map(2) {"token" => [REDACTED], 1 => "one"}',
    );
  });

  it('redacts strings that look like a JWT', () => {
    expect(formatRemoteValue(str(JWT))).toBe('[REDACTED]');
    expect(formatRemoteValue({ type: 'array', value: [str(` ${JWT} `), str('eyJ.not')] })).toBe('[[REDACTED], "eyJ.not"]');
    expect(formatRemoteValue(str(`Bearer ${JWT}`))).toBe(`Bearer ${JWT}`);
  });

  it('caps the output with a truncation note', () => {
    const big = { type: 'array', value: Array.from({ length: 20_000 }, () => str('0123456789')) };
    const text = formatRemoteValue(big);
    expect(text.length).toBeLessThanOrEqual(MAX_FORMATTED_CHARS + 100);
    expect(text).toMatch(/\n\[Output truncated at 50000 characters\]$/);
    expect(MAX_FORMATTED_CHARS).toBe(50_000);
    const string = formatRemoteValue(str('x'.repeat(60_000)));
    expect(string).toBe(`${'x'.repeat(MAX_FORMATTED_CHARS)}\n[Output truncated at 50000 characters]`);
  });

  it('clips huge strings to the remaining budget before rendering them', () => {
    const huge = 'y'.repeat(1_000_000);
    const text = formatRemoteValue({ type: 'array', value: [str('ab'), str(huge), str(huge)] });
    const truncated = '\n[Output truncated at 50000 characters]';
    const head = '[\n  "ab",\n  "';
    expect(text).toBe(`${head}${'y'.repeat(MAX_FORMATTED_CHARS - head.length)}${truncated}`);
  });

  it('does not truncate output at the limit', () => {
    expect(formatRemoteValue(str('x'.repeat(MAX_FORMATTED_CHARS)))).toBe('x'.repeat(MAX_FORMATTED_CHARS));
  });
});
