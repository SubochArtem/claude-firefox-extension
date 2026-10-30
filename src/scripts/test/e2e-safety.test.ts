import { describe, expect, it } from 'vitest';
import { isolatedXdgEnv, isStrictlyInside, localRunSafety, pathsOutside } from '../e2e-safety.mjs';

const safe = {
  platform: 'linux',
  home: '/tmp/cfe-home-x1',
  realHome: '/home/user',
  runtimeDir: '/tmp/cfe-rt-x1',
  tempRoots: ['/tmp'],
};

function reason(input: Partial<typeof safe> & { home?: string | undefined; runtimeDir?: string | undefined }) {
  const verdict = localRunSafety({ ...safe, ...input });
  return verdict.ok ? undefined : verdict.reason;
}

describe('isStrictlyInside', () => {
  it('accepts descendants only', () => {
    expect(isStrictlyInside('/tmp', '/tmp/a')).toBe(true);
    expect(isStrictlyInside('/tmp', '/tmp/a/b')).toBe(true);
    expect(isStrictlyInside('/tmp', '/tmp')).toBe(false);
    expect(isStrictlyInside('/tmp', '/tmpx/a')).toBe(false);
    expect(isStrictlyInside('/tmp', '/tmp/../home/user')).toBe(false);
    expect(isStrictlyInside('/tmp', '/')).toBe(false);
  });

  it('accepts a child whose name starts with two dots', () => {
    expect(isStrictlyInside('/tmp', '/tmp/..cfe')).toBe(true);
  });
});

describe('localRunSafety', () => {
  it('allows a temporary HOME and XDG_RUNTIME_DIR under a temp root on Linux', () => {
    expect(localRunSafety(safe)).toEqual({ ok: true });
    expect(localRunSafety({ ...safe, home: '/tmp/claude-1000/scratch/home' })).toEqual({ ok: true });
  });

  it.each(['win32', 'darwin', 'freebsd'])('refuses %s', (platform) => {
    expect(reason({ platform })).toMatch(/supported only on Linux/);
  });

  it('refuses a missing or relative HOME', () => {
    expect(reason({ home: undefined })).toMatch(/HOME must be set/);
    expect(reason({ home: 'tmp/home' })).toMatch(/HOME must be set/);
  });

  it('refuses the real home, its ancestors and its descendants', () => {
    expect(reason({ home: '/home/user' })).toMatch(/real home directory/);
    expect(reason({ home: '/home' })).toMatch(/real home directory/);
    expect(reason({ home: '/home/user/tmp-home' })).toMatch(/real home directory/);
    expect(reason({ realHome: '/tmp/user', home: '/tmp/user/sub' })).toMatch(/real home directory/);
  });

  it('refuses a HOME outside the temp roots or equal to one', () => {
    expect(reason({ home: '/var/lib/cfe' })).toMatch(/not a temporary directory/);
    expect(reason({ home: '/tmp' })).toMatch(/not a temporary directory/);
  });

  it('refuses a missing XDG_RUNTIME_DIR or one outside the temp roots', () => {
    expect(reason({ runtimeDir: undefined })).toMatch(/XDG_RUNTIME_DIR must be set/);
    expect(reason({ runtimeDir: '/run/user/1000' })).toMatch(/XDG_RUNTIME_DIR \(\/run\/user\/1000\) is not a temporary/);
  });
});

describe('isolatedXdgEnv', () => {
  it('points every XDG base directory into HOME', () => {
    expect(isolatedXdgEnv('/tmp/h')).toEqual({
      XDG_DATA_HOME: '/tmp/h/.local/share',
      XDG_CONFIG_HOME: '/tmp/h/.config',
      XDG_CACHE_HOME: '/tmp/h/.cache',
      XDG_STATE_HOME: '/tmp/h/.local/state',
    });
  });
});

describe('pathsOutside', () => {
  it('reports paths that are not inside HOME', () => {
    const home = '/tmp/h';
    expect(
      pathsOutside(home, [
        '/tmp/h/.mozilla/native-messaging-hosts/claude_firefox_extension.json',
        '/home/user/.local/share/claude-firefox-extension/native-host',
        '/tmp/h/../x',
        'relative/path',
        '/tmp/h',
      ]),
    ).toEqual(['/home/user/.local/share/claude-firefox-extension/native-host', '/tmp/h/../x', 'relative/path', '/tmp/h']);
  });
});
