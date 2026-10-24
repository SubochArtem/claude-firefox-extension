import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bridgeInfoDir,
  newBridgeInfo,
  readBridgeInfo,
  removeBridgeInfoIfOwn,
  writeBridgeInfo,
  type BridgeInfo,
} from '../bridge-info';
import { bridgeSocketPath } from '../socket-path';

const APP_DIR = 'claude-firefox-extension';
const FILE_NAME = 'bridge.json';
const isWindows = process.platform === 'win32';
let tempDir: string;

function sampleInfo(overrides: Partial<BridgeInfo> = {}): BridgeInfo {
  return { version: 1, endpoint: '/run/user/1000/claude-firefox-extension/bridge.sock', secret: 'ab'.repeat(32), pid: 4242, ...overrides };
}

beforeEach(async () => {
  tempDir = await mkdtemp(isWindows ? join(tmpdir(), 'cfe-') : '/tmp/cfe-');
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('bridgeInfoDir', () => {
  it.runIf(process.platform === 'linux')('is the bridge socket directory on Linux', () => {
    vi.stubEnv('XDG_RUNTIME_DIR', '/some/runtime');
    expect(bridgeInfoDir({ platform: 'linux' })).toBe(`/some/runtime/${APP_DIR}`);
    expect(bridgeInfoDir()).toBe(dirname(bridgeSocketPath()));
  });

  it.runIf(process.platform === 'linux')('matches the socket directory when XDG_RUNTIME_DIR is unset', () => {
    vi.stubEnv('XDG_RUNTIME_DIR', undefined);
    expect(bridgeInfoDir()).toBe(dirname(bridgeSocketPath()));
    expect(bridgeInfoDir()).toMatch(new RegExp(`/${APP_DIR}(-${userInfo().uid})?$`));
  });

  // These Windows cases also run on Linux, so the implementation must join with path.win32 for
  // platform 'win32' instead of the host's path.join.
  it('uses LOCALAPPDATA on Windows', () => {
    expect(
      bridgeInfoDir({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, homedir: 'D:\\elsewhere' }),
    ).toBe(`C:\\Users\\me\\AppData\\Local\\${APP_DIR}`);
  });

  it.each([
    ['unset', {}],
    ['empty', { LOCALAPPDATA: '' }],
  ])('falls back to <homedir>\\AppData\\Local on Windows when LOCALAPPDATA is %s', (_label, env) => {
    expect(bridgeInfoDir({ platform: 'win32', env, homedir: 'C:\\Users\\me' })).toBe(`C:\\Users\\me\\AppData\\Local\\${APP_DIR}`);
  });
});

describe('newBridgeInfo', () => {
  it('describes this process with a fresh 32-byte secret', () => {
    const info = newBridgeInfo('/x/bridge.sock');
    expect(info).toEqual({ version: 1, endpoint: '/x/bridge.sock', secret: expect.stringMatching(/^[0-9a-f]{64}$/), pid: process.pid });
  });

  it('generates a different secret every time', () => {
    expect(newBridgeInfo('/x').secret).not.toBe(newBridgeInfo('/x').secret);
  });
});

describe('writeBridgeInfo and readBridgeInfo', () => {
  it('round-trips the info', async () => {
    const info = sampleInfo();
    await writeBridgeInfo(info, tempDir);
    expect(JSON.parse(readFileSync(join(tempDir, FILE_NAME), 'utf8'))).toEqual(info);
    expect(await readBridgeInfo(tempDir)).toEqual(info);
  });

  it('round-trips a Windows pipe endpoint', async () => {
    const info = sampleInfo({ endpoint: `\\\\.\\pipe\\${APP_DIR}-${'0f'.repeat(16)}` });
    await writeBridgeInfo(info, tempDir);
    expect(await readBridgeInfo(tempDir)).toEqual(info);
  });

  it('drops unknown fields when reading', async () => {
    writeFileSync(join(tempDir, FILE_NAME), JSON.stringify({ ...sampleInfo(), extra: true }));
    expect(await readBridgeInfo(tempDir)).toEqual(sampleInfo());
  });

  it('leaves only bridge.json in the directory', async () => {
    await writeBridgeInfo(sampleInfo(), tempDir);
    await writeBridgeInfo(sampleInfo({ pid: 1 }), tempDir);
    expect(readdirSync(tempDir)).toEqual([FILE_NAME]);
  });

  it('replaces an existing file with a new one instead of rewriting it in place', async () => {
    const file = join(tempDir, FILE_NAME);
    writeFileSync(file, JSON.stringify(sampleInfo({ pid: 1 })));
    const before = lstatSync(file).ino;
    await writeBridgeInfo(sampleInfo({ pid: 2 }), tempDir);
    expect(lstatSync(file).ino).not.toBe(before);
    expect((await readBridgeInfo(tempDir)).pid).toBe(2);
  });

  // writeBridgeInfo replaces bridge.json with a rename. On Windows that rename can fail with EPERM or
  // EBUSY while another process (an MCP server reading the file, an antivirus scanner) has it open,
  // so writeBridgeInfo must retry the rename a few times on those two codes before giving up. The
  // 30 concurrent pairs below would turn into a retry-budget stress test there, so Windows runs a
  // smaller variant.
  it.skipIf(isWindows)('never exposes a partially written file to concurrent readers', async () => {
    const infos = Array.from({ length: 30 }, (_, i) => sampleInfo({ pid: i + 1, endpoint: `/x/${'e'.repeat(4096)}/${i}` }));
    await writeBridgeInfo(infos[0] as BridgeInfo, tempDir);
    const reads: Promise<BridgeInfo>[] = [];
    await Promise.all(
      infos.map(async (info) => {
        reads.push(readBridgeInfo(tempDir));
        await writeBridgeInfo(info, tempDir);
        reads.push(readBridgeInfo(tempDir));
      }),
    );
    for (const info of await Promise.all(reads)) expect(infos).toContainEqual(info);
    expect(readdirSync(tempDir)).toEqual([FILE_NAME]);
  });

  it.runIf(isWindows)('survives a handful of write/read pairs that overlap on Windows', async () => {
    const infos = Array.from({ length: 5 }, (_, i) => sampleInfo({ pid: i + 1 }));
    await writeBridgeInfo(infos[0] as BridgeInfo, tempDir);
    for (const info of infos) {
      const [, read] = await Promise.all([writeBridgeInfo(info, tempDir), readBridgeInfo(tempDir)]);
      expect(infos).toContainEqual(read);
      expect(await readBridgeInfo(tempDir)).toEqual(info);
    }
    expect(readdirSync(tempDir)).toEqual([FILE_NAME]);
  });

  it.runIf(isWindows)('does not fail while a reader briefly holds bridge.json open on Windows', async () => {
    await writeBridgeInfo(sampleInfo({ pid: 1 }), tempDir);
    const reader = await open(join(tempDir, FILE_NAME), 'r');
    const released = new Promise<void>((resolve) => setTimeout(resolve, 20)).then(() => reader.close());
    try {
      await writeBridgeInfo(sampleInfo({ pid: 2 }), tempDir);
    } finally {
      await released;
    }
    expect((await readBridgeInfo(tempDir)).pid).toBe(2);
    expect(readdirSync(tempDir)).toEqual([FILE_NAME]);
  });

  it.skipIf(isWindows)('replaces a symlink at the bridge.json path instead of writing through it', async () => {
    const elsewhere = join(tempDir, 'elsewhere');
    mkdirSync(elsewhere);
    const target = join(elsewhere, 'target.json');
    writeFileSync(target, 'original');
    const infoDir = join(tempDir, 'info');
    mkdirSync(infoDir);
    symlinkSync(target, join(infoDir, FILE_NAME));

    await writeBridgeInfo(sampleInfo(), infoDir);
    const stats = lstatSync(join(infoDir, FILE_NAME));
    expect(stats.isSymbolicLink()).toBe(false);
    expect(stats.isFile()).toBe(true);
    expect(await readBridgeInfo(infoDir)).toEqual(sampleInfo());
    expect(readFileSync(target, 'utf8')).toBe('original');
    expect(readdirSync(elsewhere)).toEqual(['target.json']);
  });

  it('cleans up the temp file when the final rename fails', async () => {
    mkdirSync(join(tempDir, FILE_NAME));
    writeFileSync(join(tempDir, FILE_NAME, 'keep'), '');
    await expect(writeBridgeInfo(sampleInfo(), tempDir)).rejects.toThrow();
    expect(readdirSync(tempDir)).toEqual([FILE_NAME]);
  });

  it.skipIf(isWindows)('creates the file with mode 0600 regardless of the umask', async () => {
    const previous = process.umask(0);
    try {
      await writeBridgeInfo(sampleInfo(), tempDir);
    } finally {
      process.umask(previous);
    }
    expect(lstatSync(join(tempDir, FILE_NAME)).mode & 0o777).toBe(0o600);
  });

  it.skipIf(isWindows)('does not inherit the mode of the file it replaces', async () => {
    const file = join(tempDir, FILE_NAME);
    writeFileSync(file, JSON.stringify(sampleInfo()));
    chmodSync(file, 0o644);
    await writeBridgeInfo(sampleInfo({ pid: 2 }), tempDir);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
  });

  it('writes a fresh file each time: a second secret replaces the first', async () => {
    const first = newBridgeInfo('/x/bridge.sock');
    const second = newBridgeInfo('/x/bridge.sock');
    await writeBridgeInfo(first, tempDir);
    await writeBridgeInfo(second, tempDir);
    expect(await readBridgeInfo(tempDir)).toEqual(second);
  });

  it('fails with ENOENT when the file does not exist, so callers report "not connected"', async () => {
    await expect(readBridgeInfo(tempDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['an empty file', ''],
    ['invalid JSON', '{"version":1,'],
    ['JSON null', 'null'],
    ['a JSON array', JSON.stringify([sampleInfo()])],
    ['a JSON string', '"bridge"'],
    ['version 2', JSON.stringify(sampleInfo({ version: 2 as 1 }))],
    ['a string version', JSON.stringify({ ...sampleInfo(), version: '1' })],
    ['a missing version', JSON.stringify({ ...sampleInfo(), version: undefined })],
    ['a missing endpoint', JSON.stringify({ ...sampleInfo(), endpoint: undefined })],
    ['an empty endpoint', JSON.stringify(sampleInfo({ endpoint: '' }))],
    ['a numeric endpoint', JSON.stringify({ ...sampleInfo(), endpoint: 5 })],
    ['a missing secret', JSON.stringify({ ...sampleInfo(), secret: undefined })],
    ['a short secret', JSON.stringify(sampleInfo({ secret: 'ab'.repeat(31) }))],
    ['a non-hex secret', JSON.stringify(sampleInfo({ secret: 'zz'.repeat(32) }))],
    ['a missing pid', JSON.stringify({ ...sampleInfo(), pid: undefined })],
    ['a string pid', JSON.stringify({ ...sampleInfo(), pid: '42' })],
    ['a fractional pid', JSON.stringify(sampleInfo({ pid: 1.5 }))],
    ['a zero pid', JSON.stringify(sampleInfo({ pid: 0 }))],
    ['a negative pid', JSON.stringify(sampleInfo({ pid: -1 }))],
  ])('rejects %s with a clear error', async (_label, content) => {
    const file = join(tempDir, FILE_NAME);
    writeFileSync(file, content);
    await expect(readBridgeInfo(tempDir)).rejects.toThrow(`Invalid bridge info file ${file}`);
  });
});

describe('removeBridgeInfoIfOwn', () => {
  it('removes the file when it still describes this host', async () => {
    const info = sampleInfo();
    await writeBridgeInfo(info, tempDir);
    expect(removeBridgeInfoIfOwn(info, tempDir)).toBe(true);
    expect(readdirSync(tempDir)).toEqual([]);
  });

  it.each([
    ['a different secret', { secret: 'cd'.repeat(32) }],
    ['a different endpoint', { endpoint: '/other/bridge.sock' }],
  ])('keeps a newer host file with %s', async (_label, overrides) => {
    const newer = sampleInfo({ ...overrides, pid: 5000 });
    await writeBridgeInfo(newer, tempDir);
    expect(removeBridgeInfoIfOwn(sampleInfo(), tempDir)).toBe(false);
    expect(await readBridgeInfo(tempDir)).toEqual(newer);
  });

  it('returns false without throwing when the file is missing', () => {
    expect(removeBridgeInfoIfOwn(sampleInfo(), tempDir)).toBe(false);
  });

  it('keeps a malformed file and does not throw', () => {
    writeFileSync(join(tempDir, FILE_NAME), '{oops');
    expect(removeBridgeInfoIfOwn(sampleInfo(), tempDir)).toBe(false);
    expect(readFileSync(join(tempDir, FILE_NAME), 'utf8')).toBe('{oops');
  });
});
