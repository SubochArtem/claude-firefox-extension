import { describe, expect, it } from 'vitest';
import { canHaveWildcard, hostMatches, normalizeHost, siteForUrl } from '../permissions/site';

describe('siteForUrl', () => {
  it.each([
    ['https://example.com/path?q=1#x', 'example.com'],
    ['http://example.com', 'example.com'],
    ['https://EXAMPLE.com/', 'example.com'],
    ['https://www.example.com/', 'example.com'],
    ['https://WWW.Example.COM/', 'example.com'],
    ['https://example.com./', 'example.com'],
    ['https://www.example.com./', 'example.com'],
    ['https://example.com:8443/', 'example.com'],
    ['http://localhost:3000/', 'localhost'],
    ['https://mail.example.com/', 'mail.example.com'],
    ['https://www2.example.com/', 'www2.example.com'],
    ['https://a.www.example.com/', 'a.www.example.com'],
    ['https://www.com/', 'www.com'],
    ['http://www.localhost/', 'www.localhost'],
    ['http://127.0.0.1:8080/', '127.0.0.1'],
    ['http://[::1]:3000/', '[::1]'],
    ['https://bücher.de/', 'xn--bcher-kva.de'],
  ])('normalizes %s to host %s', (url, host) => {
    expect(siteForUrl(url)).toEqual({ ok: true, host });
  });

  it.each([
    'about:blank',
    'about:config',
    'moz-extension://abc/page.html',
    'file:///etc/passwd',
    'view-source:https://example.com/',
    'resource://gre/modules/',
    'data:text/html,hi',
    'javascript:alert(1)',
    'chrome://browser/content/browser.xhtml',
    'ftp://example.com/',
    '',
    'not a url',
    'example.com',
  ])('refuses %j as an unsupported URL', (url) => {
    const result = siteForUrl(url);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/http/);
  });

  it('names the scheme of a refused URL', () => {
    const result = siteForUrl('about:config');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('about:');
  });
});

describe('normalizeHost', () => {
  it.each([
    ['example.com', 'example.com'],
    ['Example.COM', 'example.com'],
    ['www.example.com', 'example.com'],
    ['example.com.', 'example.com'],
    ['localhost', 'localhost'],
    ['www.com', 'www.com'],
    ['www.com.', 'www.com'],
    ['[::1]', '[::1]'],
    ['bücher.de', 'xn--bcher-kva.de'],
  ])('normalizes %j to %j', (input, host) => {
    expect(normalizeHost(input)).toBe(host);
  });

  it.each(['', ' ', 'example.com/path', 'example.com:8080', 'user@example.com', 'exa mple.com', 'example.com?q', 'https://example.com'])(
    'rejects %j',
    (input) => {
      expect(normalizeHost(input)).toBeUndefined();
    },
  );
});

describe('canHaveWildcard', () => {
  it.each(['example.com', 'mail.example.com', 'www.com', 'xn--bcher-kva.de'])('allows a wildcard on %s', (host) => {
    expect(canHaveWildcard(host)).toBe(true);
  });

  it.each(['com', 'localhost', '127.0.0.1', '10.0.0.255', '[::1]', '[2001:db8::1]'])('refuses a wildcard on %s', (host) => {
    expect(canHaveWildcard(host)).toBe(false);
  });
});

describe('hostMatches', () => {
  it('matches the exact host', () => {
    expect(hostMatches({ host: 'example.com', wildcard: false }, 'example.com')).toBe(true);
    expect(hostMatches({ host: 'example.com', wildcard: false }, 'mail.example.com')).toBe(false);
  });

  it('matches subdomains only with a wildcard', () => {
    const record = { host: 'example.com', wildcard: true };
    expect(hostMatches(record, 'example.com')).toBe(true);
    expect(hostMatches(record, 'mail.example.com')).toBe(true);
    expect(hostMatches(record, 'a.b.example.com')).toBe(true);
  });

  it('does not match a different host that ends with the same text', () => {
    const record = { host: 'example.com', wildcard: true };
    expect(hostMatches(record, 'badexample.com')).toBe(false);
    expect(hostMatches(record, 'example.com.evil.net')).toBe(false);
    expect(hostMatches(record, 'com')).toBe(false);
  });
});
