import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { missingKeysMessage, missingSignKeys, SIGN_ARGS, SIGN_KEYS } from '../sign-lib.mjs';

const run = promisify(execFile);
const scriptsDir = fileURLToPath(new URL('..', import.meta.url));

describe('missingSignKeys', () => {
  it('reports nothing when both keys are set', () => {
    expect(missingSignKeys({ WEB_EXT_API_KEY: 'user:1:2', WEB_EXT_API_SECRET: 'secret' })).toEqual([]);
  });

  it.each([
    ['both absent', {}, ['WEB_EXT_API_KEY', 'WEB_EXT_API_SECRET']],
    ['the secret absent', { WEB_EXT_API_KEY: 'user:1:2' }, ['WEB_EXT_API_SECRET']],
    ['the key empty', { WEB_EXT_API_KEY: '', WEB_EXT_API_SECRET: 'secret' }, ['WEB_EXT_API_KEY']],
    ['both blank', { WEB_EXT_API_KEY: '  ', WEB_EXT_API_SECRET: '\t' }, ['WEB_EXT_API_KEY', 'WEB_EXT_API_SECRET']],
  ])('reports missing keys with %s', (_name, env, expected) => {
    expect(missingSignKeys(env)).toEqual(expected);
  });
});

describe('missingKeysMessage', () => {
  it('names the missing keys and points to src/.env and .env.example', () => {
    const message = missingKeysMessage(['WEB_EXT_API_SECRET']);
    expect(message).toContain('WEB_EXT_API_SECRET');
    expect(message).not.toContain('WEB_EXT_API_KEY');
    expect(message).toContain('src/.env');
    expect(message).toContain('.env.example');
  });
});

describe('SIGN_ARGS', () => {
  it('signs on the unlisted channel without keys on the command line', () => {
    expect(SIGN_ARGS).toEqual(['sign', '--channel=unlisted']);
    expect(SIGN_ARGS.join(' ')).not.toMatch(/api-key|api-secret/);
    expect(SIGN_KEYS).toEqual(['WEB_EXT_API_KEY', 'WEB_EXT_API_SECRET']);
  });
});

// The script resolves .env and node_modules/web-ext relative to its own location, so a copy inside a
// temp package directory runs a fake web-ext that reports its arguments and whether it got the keys.
const FAKE_WEB_EXT = [
  'console.log(JSON.stringify({',
  '  args: process.argv.slice(2),',
  '  key: process.env.WEB_EXT_API_KEY,',
  '  secret: process.env.WEB_EXT_API_SECRET,',
  '}));',
  'process.exit(Number(process.env.FAKE_EXIT ?? 0));',
  '',
].join('\n');

let packageDir: string;

async function createPackage(): Promise<void> {
  const created = await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'cfe-sign-'));
  const base = process.platform === 'win32' ? created : await realpath(created);
  onTestFinished(() => rm(base, { recursive: true, force: true }));
  packageDir = base;
  await mkdir(join(packageDir, 'scripts'), { recursive: true });
  await copyFile(join(scriptsDir, 'sign.mjs'), join(packageDir, 'scripts/sign.mjs'));
  await copyFile(join(scriptsDir, 'sign-lib.mjs'), join(packageDir, 'scripts/sign-lib.mjs'));
  await mkdir(join(packageDir, 'node_modules/web-ext/bin'), { recursive: true });
  await writeFile(join(packageDir, 'node_modules/web-ext/bin/web-ext.js'), FAKE_WEB_EXT);
}

function runScript(env: Record<string, string> = {}) {
  const base = { ...process.env };
  delete base.WEB_EXT_API_KEY;
  delete base.WEB_EXT_API_SECRET;
  return run(process.execPath, [join(packageDir, 'scripts/sign.mjs')], { env: { ...base, ...env } });
}

describe('sign script', () => {
  beforeEach(createPackage);

  it('runs web-ext sign with the keys from .env in its environment', async () => {
    await writeFile(join(packageDir, '.env'), 'WEB_EXT_API_KEY=user:1:2\nWEB_EXT_API_SECRET=s3cret\n');
    const { stdout } = await runScript();
    expect(JSON.parse(stdout)).toEqual({ args: SIGN_ARGS, key: 'user:1:2', secret: 's3cret' });
  });

  it('uses keys from the environment without a .env file', async () => {
    const { stdout } = await runScript({ WEB_EXT_API_KEY: 'env-key', WEB_EXT_API_SECRET: 'env-secret' });
    expect(JSON.parse(stdout)).toEqual({ args: SIGN_ARGS, key: 'env-key', secret: 'env-secret' });
  });

  it('prefers a key from the environment over a different value in .env', async () => {
    await writeFile(join(packageDir, '.env'), 'WEB_EXT_API_KEY=file-key\nWEB_EXT_API_SECRET=file-secret\n');
    const { stdout } = await runScript({ WEB_EXT_API_KEY: 'env-key' });
    expect(JSON.parse(stdout)).toEqual({ args: SIGN_ARGS, key: 'env-key', secret: 'file-secret' });
  });

  it("exits with web-ext's exit code", async () => {
    await expect(runScript({ WEB_EXT_API_KEY: 'k', WEB_EXT_API_SECRET: 's', FAKE_EXIT: '3' })).rejects.toMatchObject({
      code: 3,
    });
  });

  it('fails before running web-ext when a key is empty', async () => {
    await writeFile(join(packageDir, '.env'), 'WEB_EXT_API_KEY=user:1:2\nWEB_EXT_API_SECRET=\n');
    const failure = runScript();
    await expect(failure).rejects.toMatchObject({ code: 1, stdout: '' });
    await expect(failure).rejects.toMatchObject({ stderr: expect.stringContaining('WEB_EXT_API_SECRET') });
    await expect(failure).rejects.toMatchObject({ stderr: expect.not.stringContaining('user:1:2') });
  });

  it('fails before running web-ext when there is no .env and no keys', async () => {
    await expect(runScript()).rejects.toMatchObject({
      code: 1,
      stdout: '',
      stderr: expect.stringContaining('.env.example'),
    });
  });
});
