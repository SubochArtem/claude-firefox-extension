import { chmodSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bridgeSocketPath, checkBridgeSocketDir, prepareBridgeSocketDir, restrictBridgeSocket } from '../socket-path';

// Lets a test decide what /run/user/<uid> looks like and which uid is "current" without touching the
// real directories.
const fakes = vi.hoisted(() => ({
  runUserDir: undefined as { isDirectory: boolean; uid: number } | undefined,
  uid: undefined as number | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    statSync: ((path: string, options?: object) => {
      if (typeof path === 'string' && path.startsWith('/run/user/')) {
        const fake = fakes.runUserDir;
        if (!fake) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
        return { isDirectory: () => fake.isDirectory, uid: fake.uid };
      }
      return actual.statSync(path, options);
    }) as typeof actual.statSync,
  };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    userInfo: ((options?: object) => {
      const info = actual.userInfo(options);
      return fakes.uid === undefined ? info : { ...info, uid: fakes.uid };
    }) as typeof actual.userInfo,
  };
});

const APP_DIR = 'claude-firefox-extension';
const { uid } = userInfo();
let tempDir: string;

beforeEach(async () => {
  fakes.runUserDir = undefined;
  fakes.uid = undefined;
  tempDir = await mkdtemp('/tmp/cfe-');
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe.runIf(process.platform === 'linux')('bridgeSocketPath', () => {
  it('uses XDG_RUNTIME_DIR when it is set', () => {
    vi.stubEnv('XDG_RUNTIME_DIR', '/some/runtime');
    fakes.runUserDir = { isDirectory: true, uid };
    expect(bridgeSocketPath()).toBe(`/some/runtime/${APP_DIR}/bridge.sock`);
  });

  it('falls back to /run/user/<uid> when it exists and belongs to the user', () => {
    vi.stubEnv('XDG_RUNTIME_DIR', undefined);
    fakes.runUserDir = { isDirectory: true, uid };
    expect(bridgeSocketPath()).toBe(`/run/user/${uid}/${APP_DIR}/bridge.sock`);
  });

  it('treats an empty XDG_RUNTIME_DIR as unset', () => {
    vi.stubEnv('XDG_RUNTIME_DIR', '');
    fakes.runUserDir = { isDirectory: true, uid };
    expect(bridgeSocketPath()).toBe(`/run/user/${uid}/${APP_DIR}/bridge.sock`);
  });

  it.each([
    ['missing', undefined],
    ['owned by another user', { isDirectory: true, uid: uid + 1 }],
    ['not a directory', { isDirectory: false, uid }],
  ])('falls back to literal /tmp when /run/user/<uid> is %s, ignoring TMPDIR', (_label, runUserDir) => {
    vi.stubEnv('XDG_RUNTIME_DIR', undefined);
    vi.stubEnv('TMPDIR', '/var/folders/somewhere/T');
    fakes.runUserDir = runUserDir;
    expect(bridgeSocketPath()).toBe(`/tmp/${APP_DIR}-${uid}/bridge.sock`);
  });

  it('accepts a path of exactly 107 bytes', () => {
    const suffix = `/${APP_DIR}/bridge.sock`;
    const dir = `/${'d'.repeat(107 - suffix.length - 1)}`;
    vi.stubEnv('XDG_RUNTIME_DIR', dir);
    expect(Buffer.byteLength(bridgeSocketPath())).toBe(107);
  });

  it('rejects a path longer than the Unix socket limit, counting bytes rather than characters', () => {
    const suffix = `/${APP_DIR}/bridge.sock`;
    // 'é' is two bytes in UTF-8, so the path is 106 characters but 108 bytes.
    const dir = `/${'d'.repeat(107 - suffix.length - 4)}éé`;
    vi.stubEnv('XDG_RUNTIME_DIR', dir);
    expect(() => bridgeSocketPath()).toThrow(
      /^Bridge socket path .* is 108 bytes, longer than the 107-byte limit for Unix socket paths on this platform\. Point XDG_RUNTIME_DIR at a shorter directory\.$/,
    );
  });
});

describe.skipIf(process.platform === 'win32')('prepareBridgeSocketDir', () => {
  it('creates the directory with mode 0700 and accepts it on the next run', async () => {
    vi.stubEnv('XDG_RUNTIME_DIR', tempDir);
    await prepareBridgeSocketDir();
    const stats = lstatSync(join(tempDir, APP_DIR));
    expect(stats.isDirectory()).toBe(true);
    expect(stats.mode & 0o777).toBe(0o700);
    await expect(prepareBridgeSocketDir()).resolves.toBeUndefined();
  });

  it('applies mode 0700 regardless of a permissive umask', async () => {
    vi.stubEnv('XDG_RUNTIME_DIR', tempDir);
    const previous = process.umask(0);
    try {
      await prepareBridgeSocketDir();
    } finally {
      process.umask(previous);
    }
    expect(lstatSync(join(tempDir, APP_DIR)).mode & 0o777).toBe(0o700);
  });

  it('refuses a symbolic link even if it points to a private directory', async () => {
    vi.stubEnv('XDG_RUNTIME_DIR', tempDir);
    const target = join(tempDir, 'target');
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, join(tempDir, APP_DIR));
    await expect(prepareBridgeSocketDir()).rejects.toThrow(
      `Refusing to use bridge socket directory ${join(tempDir, APP_DIR)}: it is a symbolic link`,
    );
  });

  it('refuses a path that is not a directory', async () => {
    vi.stubEnv('XDG_RUNTIME_DIR', tempDir);
    writeFileSync(join(tempDir, APP_DIR), '');
    await expect(prepareBridgeSocketDir()).rejects.toThrow(/: it is not a directory$/);
  });

  it.each([0o755, 0o750, 0o701])('refuses an existing directory with mode %o', async (mode) => {
    vi.stubEnv('XDG_RUNTIME_DIR', tempDir);
    const dir = join(tempDir, APP_DIR);
    mkdirSync(dir);
    chmodSync(dir, mode);
    await expect(prepareBridgeSocketDir()).rejects.toThrow(
      `: its mode is ${mode.toString(8)}, group and other must have no access`,
    );
  });

  it('refuses a directory owned by another user', async () => {
    vi.stubEnv('XDG_RUNTIME_DIR', tempDir);
    mkdirSync(join(tempDir, APP_DIR), { mode: 0o700 });
    fakes.uid = uid + 1;
    await expect(prepareBridgeSocketDir()).rejects.toThrow(
      `: it is owned by uid ${uid}, not by the current user`,
    );
  });

  it('propagates errors other than EEXIST from mkdir', async () => {
    vi.stubEnv('XDG_RUNTIME_DIR', join(tempDir, 'missing-parent'));
    await expect(prepareBridgeSocketDir()).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe.skipIf(process.platform === 'win32')('checkBridgeSocketDir', () => {
  it('fails with ENOENT when the directory does not exist and does not create it', async () => {
    vi.stubEnv('XDG_RUNTIME_DIR', tempDir);
    await expect(checkBridgeSocketDir()).rejects.toMatchObject({ code: 'ENOENT' });
    expect(() => lstatSync(join(tempDir, APP_DIR))).toThrow();
  });

  it('accepts a private directory and refuses an open one', async () => {
    vi.stubEnv('XDG_RUNTIME_DIR', tempDir);
    const dir = join(tempDir, APP_DIR);
    mkdirSync(dir, { mode: 0o700 });
    await expect(checkBridgeSocketDir()).resolves.toBeUndefined();
    chmodSync(dir, 0o711);
    await expect(checkBridgeSocketDir()).rejects.toThrow(/its mode is 711/);
  });
});

describe.skipIf(process.platform === 'win32')('restrictBridgeSocket', () => {
  it('sets mode 0600 on the socket file', async () => {
    const file = join(tempDir, 'bridge.sock');
    writeFileSync(file, '', { mode: 0o666 });
    chmodSync(file, 0o666);
    await restrictBridgeSocket(file);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
  });
});
