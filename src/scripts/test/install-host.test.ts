import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { NATIVE_HOST_NAME as EXTENSION_HOST_NAME } from '../../extension/protocol';
import { NATIVE_HOST_NAME } from '../../host/protocol';

const run = promisify(execFile);
const scriptsDir = fileURLToPath(new URL('..', import.meta.url));
const extensionManifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../extension/manifest.json', import.meta.url)), 'utf8'),
) as { browser_specific_settings: { gecko: { id: string } } };

// A fake host that prints the arguments it was started with, to check the wrapper's quoting.
const FAKE_HOST = 'console.log(JSON.stringify(process.argv.slice(1)));\n';

interface Layout {
  packageDir: string;
  hostEntry: string;
  home: string;
  dataHome: string;
}

let layout: Layout;

// The installer resolves dist/host/index.js relative to its own location, so a copy inside a temp
// package directory installs a fake build. The quote and space in the path exercise shell quoting.
beforeEach(async () => {
  const base = await mkdtemp('/tmp/cfe-');
  onTestFinished(() => rm(base, { recursive: true, force: true }));
  const packageDir = join(base, "it's a pkg");
  layout = {
    packageDir,
    hostEntry: join(packageDir, 'dist/host/index.js'),
    home: join(base, 'home'),
    dataHome: join(base, 'data'),
  };
  await mkdir(join(packageDir, 'scripts'), { recursive: true });
  await mkdir(layout.home);
  for (const name of await readdir(scriptsDir)) {
    if (name.startsWith('install-host') && name.endsWith('.mjs')) {
      await copyFile(join(scriptsDir, name), join(packageDir, 'scripts', name));
    }
  }
});

async function writeFakeBuild(): Promise<void> {
  await mkdir(join(layout.packageDir, 'dist/host'), { recursive: true });
  await writeFile(layout.hostEntry, FAKE_HOST);
}

function runInstaller(args: string[] = [], { xdgDataHome = true } = {}) {
  return run(process.execPath, [join(layout.packageDir, 'scripts/install-host.mjs'), ...args], {
    env: {
      PATH: process.env['PATH'],
      HOME: layout.home,
      ...(xdgDataHome ? { XDG_DATA_HOME: layout.dataHome } : {}),
    },
  });
}

function manifestPath(): string {
  return join(layout.home, '.mozilla/native-messaging-hosts', `${NATIVE_HOST_NAME}.json`);
}

describe.runIf(process.platform === 'linux')('install-host', () => {
  it('writes the native messaging manifest', async () => {
    await writeFakeBuild();
    await runInstaller();
    expect(JSON.parse(await readFile(manifestPath(), 'utf8'))).toEqual({
      name: NATIVE_HOST_NAME,
      description: 'Claude Firefox Extension native messaging host',
      path: join(layout.dataHome, 'claude-firefox-extension/native-host'),
      type: 'stdio',
      allowed_extensions: [extensionManifest.browser_specific_settings.gecko.id],
    });
  });

  it('uses the host name the extension connects to', () => {
    expect(NATIVE_HOST_NAME).toBe(EXTENSION_HOST_NAME);
  });

  it('writes an executable wrapper that runs the build with the installing Node binary', async () => {
    await writeFakeBuild();
    await runInstaller();
    const wrapper = join(layout.dataHome, 'claude-firefox-extension/native-host');
    expect(statSync(wrapper).mode & 0o777).toBe(0o755);
    const script = await readFile(wrapper, 'utf8');
    expect(script.startsWith('#!/bin/sh\nexec ')).toBe(true);
    expect(script).toContain(`'${process.execPath.replaceAll("'", `'\\''`)}'`);

    // Firefox passes the manifest path and the extension id; they must reach the host unchanged.
    const { stdout } = await run(wrapper, ['/path with space/manifest.json', "ext'@id"]);
    expect(JSON.parse(stdout)).toEqual([
      layout.hostEntry,
      '--native-host',
      '/path with space/manifest.json',
      "ext'@id",
    ]);
  });

  it('falls back to ~/.local/share without XDG_DATA_HOME', async () => {
    await writeFakeBuild();
    await runInstaller([], { xdgDataHome: false });
    const wrapper = join(layout.home, '.local/share/claude-firefox-extension/native-host');
    expect(statSync(wrapper).mode & 0o777).toBe(0o755);
    expect(JSON.parse(await readFile(manifestPath(), 'utf8'))).toMatchObject({ path: wrapper });
  });

  it('makes an existing wrapper executable again on reinstall', async () => {
    await writeFakeBuild();
    const wrapper = join(layout.dataHome, 'claude-firefox-extension/native-host');
    await mkdir(join(layout.dataHome, 'claude-firefox-extension'), { recursive: true });
    await writeFile(wrapper, 'old');
    await chmod(wrapper, 0o600);
    await runInstaller();
    expect(statSync(wrapper).mode & 0o777).toBe(0o755);
    expect(await readFile(wrapper, 'utf8')).toMatch(/^#!\/bin\/sh\n/);
  });

  it('prints the paths it would write with --print-paths and writes nothing', async () => {
    await writeFakeBuild();
    const { stdout } = await runInstaller(['--print-paths']);
    expect(JSON.parse(stdout)).toEqual({
      manifest: manifestPath(),
      wrapper: join(layout.dataHome, 'claude-firefox-extension/native-host'),
    });
    expect(existsSync(join(layout.home, '.mozilla'))).toBe(false);
    expect(existsSync(layout.dataHome)).toBe(false);
  });

  it('prints the quoted claude mcp add command', async () => {
    await writeFakeBuild();
    const { stdout } = await runInstaller();
    const quotedEntry = `'${layout.hostEntry.replaceAll("'", `'\\''`)}'`;
    expect(stdout).toContain(`claude mcp add firefox -- '${process.execPath}' ${quotedEntry} --mcp`);
  });

  it('fails with a clear error and writes nothing when the host is not built', async () => {
    const result = runInstaller();
    await expect(result).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(`Install failed: ${layout.hostEntry} is missing. Run \`npm run build\` first.`),
    });
    expect(existsSync(join(layout.home, '.mozilla'))).toBe(false);
    expect(existsSync(layout.dataHome)).toBe(false);
  });

  it('uninstall removes the manifest, the wrapper and its empty directory', async () => {
    await writeFakeBuild();
    await runInstaller();
    const { stdout } = await runInstaller(['--uninstall']);
    expect(stdout).toContain('Removed the native messaging host:');
    expect(existsSync(manifestPath())).toBe(false);
    expect(existsSync(join(layout.dataHome, 'claude-firefox-extension'))).toBe(false);
  });

  it('uninstall keeps a wrapper directory that holds other files', async () => {
    await writeFakeBuild();
    await runInstaller();
    const other = join(layout.dataHome, 'claude-firefox-extension/other');
    await writeFile(other, '');
    await runInstaller(['--uninstall']);
    expect(existsSync(join(layout.dataHome, 'claude-firefox-extension/native-host'))).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  it('uninstall succeeds when nothing is installed and does not need a build', async () => {
    await expect(runInstaller(['--uninstall'])).resolves.toMatchObject({
      stdout: expect.stringContaining('Removed the native messaging host:'),
    });
  });
});
