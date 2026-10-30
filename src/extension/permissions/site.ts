export type SiteResult = { ok: true; host: string } | { ok: false; reason: string };

export interface HostPattern {
  host: string;
  wildcard: boolean;
}

const SITE_PROTOCOLS = new Set(['http:', 'https:']);
const MAX_SHOWN_SCHEME_LENGTH = 40;

function stripHost(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.+$/, '');
  return host.startsWith('www.') && host.slice(4).includes('.') ? host.slice(4) : host;
}

function unsupported(detail: string): SiteResult {
  return { ok: false, reason: `${detail}; site permissions only cover http and https pages` };
}

// Host-level site of a URL: the port is ignored and "www." is the same site as the bare domain.
export function siteForUrl(url: string): SiteResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return unsupported('Invalid URL');
  }
  if (!SITE_PROTOCOLS.has(parsed.protocol)) {
    const scheme = parsed.protocol.slice(0, MAX_SHOWN_SCHEME_LENGTH);
    return unsupported(`Unsupported URL scheme "${scheme}"`);
  }
  const host = stripHost(parsed.hostname);
  if (host === '') return unsupported('URL has no host');
  return { ok: true, host };
}

// Normalizes a bare host name as stored in a permission record; undefined if it is not just a host.
export function normalizeHost(input: string): string | undefined {
  if (input === '' || input !== input.trim()) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(`http://${input}/`);
  } catch {
    return undefined;
  }
  if (parsed.href !== `http://${parsed.hostname}/` || /:\d*$/.test(input.replace(/^\[.*\]$/, ''))) return undefined;
  const host = stripHost(parsed.hostname);
  return host === '' ? undefined : host;
}

// A wildcard needs a registrable-looking name: not a single label (`com`, `localhost`) and not an IP literal.
export function canHaveWildcard(host: string): boolean {
  return host.includes('.') && !host.startsWith('[') && !/^\d+\.\d+\.\d+\.\d+$/.test(host);
}

export function hostMatches(pattern: HostPattern, host: string): boolean {
  return host === pattern.host || (pattern.wildcard && host.endsWith(`.${pattern.host}`));
}
