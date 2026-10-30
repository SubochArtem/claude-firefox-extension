import { describe, expect, it } from 'vitest';
import { parseNavigateArgs, parseTabsCloseArgs, parseTabsCreateArgs } from '../tools/navigation-input';

const validUrls: [string, string][] = [
  ['example.com', 'https://example.com/'],
  ['www.example.com', 'https://www.example.com/'],
  ['http://example.com', 'http://example.com/'],
  ['https://example.com', 'https://example.com/'],
  ['HTTPS://EXAMPLE.COM/Path', 'https://example.com/Path'],
  ['HTTP://Example.com', 'http://example.com/'],
  ['hTtPs://example.com', 'https://example.com/'],
  ['http:example.com', 'http://example.com/'],
  ['example.com/a/b?x=1&y=2#frag', 'https://example.com/a/b?x=1&y=2#frag'],
  ['https://example.com/Search?Q=Mixed#Case', 'https://example.com/Search?Q=Mixed#Case'],
  ['example.com/a b', 'https://example.com/a%20b'],
  ['bücher.de', 'https://xn--bcher-kva.de/'],
  ['https://bücher.de/pfad', 'https://xn--bcher-kva.de/pfad'],
  ['  example.com  ', 'https://example.com/'],
  ['\n\texample.com\t\n', 'https://example.com/'],
  ['localhost', 'https://localhost/'],
  ['localhost:3000', 'https://localhost:3000/'],
  ['localhost:3000/api?x=1', 'https://localhost:3000/api?x=1'],
  ['http://localhost:8080', 'http://localhost:8080/'],
  ['example.com:8080', 'https://example.com:8080/'],
  ['https://example.com:443/', 'https://example.com/'],
  ['http://example.com:80', 'http://example.com/'],
  ['192.168.0.1', 'https://192.168.0.1/'],
  ['127.0.0.1:8080/api', 'https://127.0.0.1:8080/api'],
  ['http://10.0.0.1', 'http://10.0.0.1/'],
  ['[::1]:3000', 'https://[::1]:3000/'],
  ['http://[::1]', 'http://[::1]/'],
  ['back.com', 'https://back.com/'],
  ['back/path', 'https://back/path'],
  ['back:3000', 'https://back:3000/'],
  ['forward:8080', 'https://forward:8080/'],
  ['example.com:8080?x=1', 'https://example.com:8080/?x=1'],
  ['example.com:8080#f', 'https://example.com:8080/#f'],
  ['//example.com', 'https://example.com/'],
  ['\\\\example.com', 'https://example.com/'],
  ['https://evil.com\\@good.com', 'https://evil.com/@good.com'],
];

const rejectedSchemes: [string, string][] = [
  ['javascript:alert(1)', 'javascript:'],
  ['JavaScript:void(0)', 'javascript:'],
  ['  javascript:alert(1)  ', 'javascript:'],
  ['data:text/html,<h1>x</h1>', 'data:'],
  ['file:///etc/passwd', 'file:'],
  ['about:blank', 'about:'],
  ['about:config', 'about:'],
  ['moz-extension://abc/page.html', 'moz-extension:'],
  ['view-source:https://example.com', 'view-source:'],
  ['chrome://settings', 'chrome:'],
  ['ftp://example.com', 'ftp:'],
  ['ws://example.com', 'ws:'],
  ['mailto:a@example.com', 'mailto:'],
  ['blob:https://example.com/0f8c', 'blob:'],
  ['\u00a0javascript:alert(1)', 'javascript:'],
  ['\ufeffjavascript:alert(1)', 'javascript:'],
  ['JaVaScRiPt:alert(1)', 'javascript:'],
  ['host:abc', 'host:'],
  ['user:pass@host', 'user:'],
  ['user:123@host', 'user:'],
  ['C:\\path', 'c:'],
  ['C:/path', 'c:'],
  ['localhost:3000abc', 'localhost:'],
  ['example.com:', 'example.com:'],
  ['a+b:x', 'a+b:'],
  ['h2:x', 'h2:'],
];

const unparsableUrls: [string, string][] = [
  ['https://', 'https://'],
  ['http://', 'http://'],
  ['exa mple.com', 'exa mple.com'],
  ['https://exa mple.com', 'https://exa mple.com'],
  ['http://[::1', 'http://[::1'],
  ['example.com:99999', 'example.com:99999'],
  [':foo', ':foo'],
  ['  https://  ', 'https://'],
  ['http://example.com:99999', 'http://example.com:99999'],
  ['go back', 'go back'],
  ['java\tscript:alert(1)', 'java\\u0009script:alert(1)'],
  ['https://a.com\t.evil', 'https://a.com\\u0009.evil'],
  ['https://exa\nmple.com', 'https://exa\\u000ample.com'],
  ['\u0001javascript:alert(1)', '\\u0001javascript:alert(1)'],
  ['https://example.com/\u0000', 'https://example.com/\\u0000'],
  ['https://example.com/\u007f', 'https://example.com/\\u007f'],
  ['https://example.com/\r\npath', 'https://example.com/\\u000d\\u000apath'],
];

const userinfoUrls = [
  'https://user:pass@host',
  'https://user@example.com',
  'http://:pass@example.com',
  'https://good.com:80@evil.com',
  'https://good.com%2f@evil.com',
];

const userinfoError = 'URLs with a username or password are not allowed';

const hostileUrls = [
  '\u0001javascript:alert(1)',
  '\u00a0javascript:alert(1)',
  '\ufeffjavascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  'java\tscript:alert(1)',
  'jav&#x09;ascript:alert(1)',
  '%6Aavascript:alert(1)',
  'data:text/html,x',
  'vbscript:x',
  'javascript:1',
  'data:123',
];

function expectSafe(result: { ok: boolean; value?: { url?: string; target?: { kind: string; url?: string } } }): void {
  if (!result.ok) return;
  expect(result.value?.url ?? result.value?.target?.url).toMatch(/^https?:\/\//);
}

const nonPositiveTabIds: [string, number, string][] = [
  ['zero', 0, 'tabId must be a positive safe integer, received 0'],
  ['negative zero', -0, 'tabId must be a positive safe integer, received 0'],
  ['a negative integer', -1, 'tabId must be a positive safe integer, received -1'],
  ['an unsafe integer', 2 ** 53, 'tabId must be a positive safe integer, received 9007199254740992'],
];

const nonIntegerTabIds: [string, unknown][] = [
  ['a float', 1.5],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['a numeric string', '5'],
  ['an empty string', ''],
  ['a boolean', true],
  ['null', null],
  ['an array', [5]],
  ['an object', { id: 5 }],
];

const nonObjects: [string, unknown][] = [
  ['undefined', undefined],
  ['null', null],
  ['a string', 'https://example.com'],
  ['a number', 5],
  ['an array', [5, 'https://example.com']],
];

describe('parseNavigateArgs', () => {
  it.each(validUrls)('normalizes %j to %s', (url, href) => {
    expect(parseNavigateArgs({ tabId: 7, url })).toEqual({ ok: true, value: { tabId: 7, target: { kind: 'url', url: href } } });
  });

  it.each([
    ['back', 'back'],
    ['BACK', 'back'],
    ['Back', 'back'],
    ['  back  ', 'back'],
    ['forward', 'forward'],
    ['FORWARD', 'forward'],
    ['\tForward\n', 'forward'],
  ])('reads %j as history %s', (url, kind) => {
    expect(parseNavigateArgs({ tabId: 3, url })).toEqual({ ok: true, value: { tabId: 3, target: { kind } } });
  });

  it.each(rejectedSchemes)('rejects %j as an unsupported scheme', (url, scheme) => {
    expect(parseNavigateArgs({ tabId: 1, url })).toEqual({
      ok: false,
      error: `Unsupported URL scheme "${scheme}"; only http and https URLs are allowed`,
    });
  });

  it.each(unparsableUrls)('rejects unparsable %j', (url, shown) => {
    expect(parseNavigateArgs({ tabId: 1, url })).toEqual({ ok: false, error: `Invalid URL: ${shown}` });
  });

  describe('echoing invalid input', () => {
    const invalidPrefix = 'https://exa mple.com/';
    const schemeError = (shown: string) => `Unsupported URL scheme "${shown}"; only http and https URLs are allowed`;

    it.each<[string, string, string]>([
      ['200 characters in full', invalidPrefix.padEnd(200, 'a'), `Invalid URL: ${invalidPrefix.padEnd(200, 'a')}`],
      ['201 characters cut to 200 and an ellipsis', invalidPrefix.padEnd(201, 'a'), `Invalid URL: ${invalidPrefix.padEnd(200, 'a')}…`],
      [
        'a 10 000-character url cut to 200 and an ellipsis',
        `${invalidPrefix}${'a'.repeat(10_000)}`,
        `Invalid URL: ${invalidPrefix.padEnd(200, 'a')}…`,
      ],
      [
        'control characters escaped after cutting',
        `https://example.com/${'\u0001'.repeat(10_000)}`,
        `Invalid URL: https://example.com/${'\\u0001'.repeat(180)}…`,
      ],
      [
        'a control character at position 200 escaped',
        `${'https://example.com/'.padEnd(199, 'a')}\u001f`,
        `Invalid URL: ${'https://example.com/'.padEnd(199, 'a')}\\u001f`,
      ],
      [
        'a control character at position 201 cut off',
        `${'https://example.com/'.padEnd(200, 'a')}\u001f`,
        `Invalid URL: ${'https://example.com/'.padEnd(200, 'a')}…`,
      ],
      ['a 200-character scheme in full', `${'a'.repeat(199)}:x`, schemeError(`${'a'.repeat(199)}:`)],
      ['a 201-character scheme cut to 200 and an ellipsis', `${'a'.repeat(200)}:x`, schemeError(`${'a'.repeat(200)}…`)],
      ['a 10 000-character scheme cut to 200 and an ellipsis', `${'A'.repeat(10_000)}:x`, schemeError(`${'a'.repeat(200)}…`)],
    ])('echoes %s', (_label, url, error) => {
      expect(parseNavigateArgs({ tabId: 1, url })).toEqual({ ok: false, error });
      expect(parseTabsCreateArgs({ url })).toEqual({ ok: false, error });
    });
  });

  it.each([
    ['an empty string', ''],
    ['whitespace only', ' \t\n '],
  ])('rejects %s as url', (_label, url) => {
    expect(parseNavigateArgs({ tabId: 1, url })).toEqual({ ok: false, error: expect.stringContaining('url') });
  });

  it.each(userinfoUrls)('rejects %j because of its userinfo', (url) => {
    expect(parseNavigateArgs({ tabId: 1, url })).toEqual({ ok: false, error: userinfoError });
  });

  it.each(hostileUrls)('never yields a non-http(s) target for %j', (url) => {
    expectSafe(parseNavigateArgs({ tabId: 1, url }));
  });

  it('requires url', () => {
    expect(parseNavigateArgs({ tabId: 1 })).toEqual({ ok: false, error: expect.stringContaining('url') });
  });

  it.each([
    ['a number', 42],
    ['null', null],
    ['an array', ['https://example.com']],
    ['an object', { href: 'https://example.com' }],
  ])('rejects %s as url', (_label, url) => {
    expect(parseNavigateArgs({ tabId: 1, url })).toEqual({ ok: false, error: expect.stringContaining('url') });
  });

  it.each([
    ['1', 1],
    ['a large id', 123456789],
    ['the largest safe integer', Number.MAX_SAFE_INTEGER],
  ])('accepts tabId %s', (_label, tabId) => {
    expect(parseNavigateArgs({ tabId, url: 'example.com' })).toEqual({
      ok: true,
      value: { tabId, target: { kind: 'url', url: 'https://example.com/' } },
    });
  });

  it.each(nonPositiveTabIds)('rejects %s as tabId', (_label, tabId, error) => {
    expect(parseNavigateArgs({ tabId, url: 'example.com' })).toEqual({ ok: false, error });
  });

  it.each(nonIntegerTabIds)('rejects %s as tabId', (_label, tabId) => {
    expect(parseNavigateArgs({ tabId, url: 'example.com' })).toEqual({ ok: false, error: expect.stringContaining('tabId') });
  });

  it('requires tabId', () => {
    expect(parseNavigateArgs({ url: 'example.com' })).toEqual({ ok: false, error: expect.stringContaining('tabId') });
  });

  it('checks tabId before url', () => {
    expect(parseNavigateArgs({})).toEqual({ ok: false, error: expect.stringContaining('tabId') });
    expect(parseNavigateArgs({ tabId: 0, url: 'javascript:alert(1)' })).toEqual({
      ok: false,
      error: 'tabId must be a positive safe integer, received 0',
    });
  });

  it.each(nonObjects)('rejects %s as args', (_label, args) => {
    expect(parseNavigateArgs(args)).toEqual({ ok: false, error: expect.stringContaining('object') });
  });

  it('ignores unknown keys', () => {
    expect(parseNavigateArgs({ tabId: 2, url: 'forward', extra: true })).toEqual({ ok: true, value: { tabId: 2, target: { kind: 'forward' } } });
  });
});

describe('parseTabsCreateArgs', () => {
  it.each([
    ['undefined', undefined],
    ['an empty object', {}],
    ['only unknown keys', { active: true }],
  ])('opens an empty tab for %s', (_label, args) => {
    expect(parseTabsCreateArgs(args)).toEqual({ ok: true, value: {} });
  });

  it.each(validUrls)('normalizes %j to %s', (url, href) => {
    expect(parseTabsCreateArgs({ url })).toEqual({ ok: true, value: { url: href } });
  });

  it.each(['back', 'forward', 'BACK', 'Forward', '  back  ', '\tForward\n'])('rejects history keyword %j', (url) => {
    expect(parseTabsCreateArgs({ url })).toEqual({ ok: false, error: 'back and forward are only valid for navigate' });
  });

  it.each(userinfoUrls)('rejects %j because of its userinfo', (url) => {
    expect(parseTabsCreateArgs({ url })).toEqual({ ok: false, error: userinfoError });
  });

  it.each(hostileUrls)('never yields a non-http(s) url for %j', (url) => {
    expectSafe(parseTabsCreateArgs({ url }));
  });

  it.each(rejectedSchemes)('rejects %j as an unsupported scheme', (url, scheme) => {
    expect(parseTabsCreateArgs({ url })).toEqual({
      ok: false,
      error: `Unsupported URL scheme "${scheme}"; only http and https URLs are allowed`,
    });
  });

  it.each(unparsableUrls)('rejects unparsable %j', (url, shown) => {
    expect(parseTabsCreateArgs({ url })).toEqual({ ok: false, error: `Invalid URL: ${shown}` });
  });

  it.each([
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a number', 42],
    ['null', null],
    ['an array', ['https://example.com']],
  ])('rejects %s as url', (_label, url) => {
    expect(parseTabsCreateArgs({ url })).toEqual({ ok: false, error: expect.stringContaining('url') });
  });

  it.each(nonObjects.filter(([, args]) => args !== undefined))('rejects %s as args', (_label, args) => {
    expect(parseTabsCreateArgs(args)).toEqual({ ok: false, error: expect.stringContaining('object') });
  });
});

describe('parseTabsCloseArgs', () => {
  it.each([
    ['1', 1],
    ['a large id', 123456789],
    ['the largest safe integer', Number.MAX_SAFE_INTEGER],
  ])('accepts tabId %s', (_label, tabId) => {
    expect(parseTabsCloseArgs({ tabId })).toEqual({ ok: true, value: { tabId } });
  });

  it('ignores unknown keys', () => {
    expect(parseTabsCloseArgs({ tabId: 4, url: 'javascript:alert(1)' })).toEqual({ ok: true, value: { tabId: 4 } });
  });

  it.each(nonPositiveTabIds)('rejects %s as tabId', (_label, tabId, error) => {
    expect(parseTabsCloseArgs({ tabId })).toEqual({ ok: false, error });
  });

  it.each(nonIntegerTabIds)('rejects %s as tabId', (_label, tabId) => {
    expect(parseTabsCloseArgs({ tabId })).toEqual({ ok: false, error: expect.stringContaining('tabId') });
  });

  it('requires tabId', () => {
    expect(parseTabsCloseArgs({})).toEqual({ ok: false, error: expect.stringContaining('tabId') });
  });

  it.each(nonObjects)('rejects %s as args', (_label, args) => {
    expect(parseTabsCloseArgs(args)).toEqual({ ok: false, error: expect.stringContaining('object') });
  });
});
