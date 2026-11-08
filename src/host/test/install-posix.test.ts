import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { NATIVE_HOST_NAME as EXTENSION_HOST_NAME } from '../../extension/protocol';
import { BIDI_PORT_ENV, DEFAULT_BIDI_PORT } from '../bidi-client';
import { runInstallCommand, type InstallerContext } from '../install/cli';
import { mcpAddCommand, remoteDebuggingNote, shellQuote } from '../install/messages';
import { installPaths, type HostSource, type InstallPaths } from '../install/paths';
import { installPosix, renderShellWrapper, uninstallPosix } from '../install/posix';
import { NATIVE_HOST_NAME } from '../protocol';
import { hostEntry as bundledHost } from './helpers';

const run = promisify(execFile);
const extensionId = (
  JSON.parse(readFileSync(fileURLToPath(new URL('../../extension/manifest.json', import.meta.url)), 'utf8')) as {
    browser_specific_settings: { gecko: { id: string } };
  }
).browser_specific_settings.gecko.id;
const isPosix = process.platform !== 'win32';

// A quote and a space in every path exercise the shell quoting.
async function tempBase(): Promise<string> {
  const base = await mkdtemp('/tmp/cfe-');
  onTestFinished(() => rm(base, { recursive: true, force: true }));
  const dir = join(base, "it's a dir");
  await mkdir(dir);
  return dir;
}

describe('installPaths on Linux and macOS', () => {
  it('uses XDG_DATA_HOME and ~/.mozilla on Linux', () => {
    expect(installPaths('linux', { XDG_DATA_HOME: '/data' }, '/home/anna')).toEqual({
      dir: '/data/claude-firefox-extension',
      binaryPath: '/data/claude-firefox-extension/claude-firefox-host',
      wrapperPath: '/data/claude-firefox-extension/native-host',
      manifestPath: `/home/anna/.mozilla/native-messaging-hosts/${NATIVE_HOST_NAME}.json`,
    });
  });

  it.each([
    ['without XDG_DATA_HOME', {}],
    ['with an empty XDG_DATA_HOME', { XDG_DATA_HOME: '' }],
  ])('falls back to ~/.local/share on Linux %s', (_name, env) => {
    expect(installPaths('linux', env, '/home/anna').dir).toBe('/home/anna/.local/share/claude-firefox-extension');
  });

  it('uses Application Support on macOS, whatever XDG_DATA_HOME says', () => {
    expect(installPaths('darwin', { XDG_DATA_HOME: '/data' }, '/Users/anna')).toEqual({
      dir: '/Users/anna/Library/Application Support/claude-firefox-extension',
      binaryPath: '/Users/anna/Library/Application Support/claude-firefox-extension/claude-firefox-host',
      wrapperPath: '/Users/anna/Library/Application Support/claude-firefox-extension/native-host',
      manifestPath: `/Users/anna/Library/Application Support/Mozilla/NativeMessagingHosts/${NATIVE_HOST_NAME}.json`,
    });
  });

  it('refuses other platforms', () => {
    expect(() => installPaths('freebsd', {}, '/home/anna')).toThrow('Native host installation is not supported on freebsd.');
  });

  it('uses the host name the extension connects to', () => {
    expect(NATIVE_HOST_NAME).toBe(EXTENSION_HOST_NAME);
  });
});

describe('mcpAddCommand on Linux and macOS', () => {
  const paths = installPaths('linux', { XDG_DATA_HOME: "/home/o'neil/data" }, "/home/o'neil");

  it('quotes Node and the build entry for the shell', () => {
    const source: HostSource = { kind: 'node', nodePath: '/usr/bin/node', entry: "/home/o'neil/src/dist/host/index.js" };
    expect(mcpAddCommand('linux', source, paths)).toBe(
      `claude mcp add firefox -- '/usr/bin/node' '/home/o'\\''neil/src/dist/host/index.js' --mcp`,
    );
  });

  it('names the installed binary, not the one that ran install', () => {
    expect(mcpAddCommand('darwin', { kind: 'binary', executable: '/Users/anna/Downloads/claude-firefox-host' }, paths)).toBe(
      `claude mcp add firefox -- '/home/o'\\''neil/data/claude-firefox-extension/claude-firefox-host' --mcp`,
    );
  });
});

describe('remoteDebuggingNote', () => {
  it.each([
    ['linux', 'firefox --remote-debugging-port='],
    ['darwin', '/Applications/Firefox.app/Contents/MacOS/firefox --remote-debugging-port='],
    ['win32', '"C:\\Program Files\\Mozilla Firefox\\firefox.exe" --remote-debugging-port='],
  ] as const)('names the default port, the %s command and the port variable', (platform, command) => {
    const note = remoteDebuggingNote(platform).join('\n');
    expect(note).toContain(`  ${command}${DEFAULT_BIDI_PORT}`);
    expect(note).toContain(BIDI_PORT_ENV);
  });
});

describe.runIf(isPosix)('renderShellWrapper', () => {
  it('runs the build with the given Node binary and passes the arguments Firefox adds unchanged', async () => {
    const base = await tempBase();
    const entry = join(base, 'index.js');
    await writeFile(entry, 'console.log(JSON.stringify(process.argv.slice(1)));\n');
    const wrapper = join(base, 'native-host');
    await writeFile(wrapper, renderShellWrapper(process.execPath, entry), { mode: 0o755 });
    expect(renderShellWrapper(process.execPath, entry)).toBe(
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(entry)} --native-host "$@"\n`,
    );

    const { stdout } = await run(wrapper, ['/path with space/manifest.json', "ext'@id"]);
    expect(JSON.parse(stdout)).toEqual([entry, '--native-host', '/path with space/manifest.json', "ext'@id"]);
  });
});

describe.runIf(isPosix)('install and uninstall on Linux and macOS', () => {
  let paths: InstallPaths;
  let base: string;

  beforeEach(async () => {
    base = await tempBase();
    paths = installPaths('linux', { XDG_DATA_HOME: join(base, 'data') }, join(base, 'home'));
  });

  async function fakeBinary(content: string): Promise<string> {
    const executable = join(base, 'Downloads', 'claude-firefox-host');
    await mkdir(join(base, 'Downloads'), { recursive: true });
    await writeFile(executable, content, { mode: 0o755 });
    return executable;
  }

  it('writes an executable wrapper and a manifest that names it for a development build', async () => {
    const source: HostSource = { kind: 'node', nodePath: process.execPath, entry: join(base, 'index.js') };
    await installPosix({ paths, source });
    expect(statSync(paths.wrapperPath).mode & 0o777).toBe(0o755);
    expect(await readFile(paths.wrapperPath, 'utf8')).toBe(renderShellWrapper(process.execPath, join(base, 'index.js')));
    expect(JSON.parse(await readFile(paths.manifestPath, 'utf8'))).toEqual({
      name: NATIVE_HOST_NAME,
      description: 'Claude Firefox Extension native messaging host',
      path: paths.wrapperPath,
      type: 'stdio',
      allowed_extensions: [extensionId],
    });
    expect(existsSync(paths.binaryPath)).toBe(false);
  });

  it('makes an existing wrapper executable again on reinstall', async () => {
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.wrapperPath, 'old');
    await chmod(paths.wrapperPath, 0o600);
    await installPosix({ paths, source: { kind: 'node', nodePath: process.execPath, entry: join(base, 'index.js') } });
    expect(statSync(paths.wrapperPath).mode & 0o777).toBe(0o755);
    expect(await readFile(paths.wrapperPath, 'utf8')).toMatch(/^#!\/bin\/sh\n/);
  });

  it('copies the single executable and names the copy in the manifest', async () => {
    const executable = await fakeBinary('#!/bin/sh\necho "$@"\n');
    await installPosix({ paths, source: { kind: 'binary', executable } });
    expect(statSync(paths.binaryPath).mode & 0o777).toBe(0o755);
    expect(await readFile(paths.binaryPath, 'utf8')).toBe('#!/bin/sh\necho "$@"\n');
    expect(JSON.parse(await readFile(paths.manifestPath, 'utf8'))).toMatchObject({ path: paths.binaryPath });
    expect(await readdir(paths.dir)).toEqual(['claude-firefox-host']);
    // Firefox runs the copy directly with the manifest path and the extension id.
    const { stdout } = await run(paths.binaryPath, [paths.manifestPath, extensionId]);
    expect(stdout).toBe(`${paths.manifestPath} ${extensionId}\n`);
  });

  it('replaces the binary of an earlier version on upgrade without leaving copies behind', async () => {
    await installPosix({ paths, source: { kind: 'binary', executable: await fakeBinary('version 1') } });
    await installPosix({ paths, source: { kind: 'binary', executable: await fakeBinary('version 2') } });
    expect(await readFile(paths.binaryPath, 'utf8')).toBe('version 2');
    expect(await readdir(paths.dir)).toEqual(['claude-firefox-host']);
  });

  it('removes copies left by an interrupted install', async () => {
    await mkdir(paths.dir, { recursive: true });
    await writeFile(join(paths.dir, '.claude-firefox-host.0123456789ab.tmp'), '');
    await writeFile(join(paths.dir, 'claude-firefox-host.old-0123456789ab'), '');
    await installPosix({ paths, source: { kind: 'binary', executable: await fakeBinary('new') } });
    expect(await readdir(paths.dir)).toEqual(['claude-firefox-host']);
  });

  it('reinstalls from the installed copy, also through a symlink, without copying it onto itself', async () => {
    await installPosix({ paths, source: { kind: 'binary', executable: await fakeBinary('installed') } });
    const link = join(base, 'link');
    await symlink(paths.binaryPath, link);
    await installPosix({ paths, source: { kind: 'binary', executable: link } });
    expect(await readFile(paths.binaryPath, 'utf8')).toBe('installed');
    expect(await readdir(paths.dir)).toEqual(['claude-firefox-host']);
  });

  it('puts the previous binary back when the manifest cannot be written', async () => {
    await installPosix({ paths, source: { kind: 'binary', executable: await fakeBinary('version 1') } });
    await rm(paths.manifestPath);
    await mkdir(join(paths.manifestPath, 'blocker'), { recursive: true });
    await expect(installPosix({ paths, source: { kind: 'binary', executable: await fakeBinary('version 2') } })).rejects.toThrow(
      /^Install failed: /,
    );
    expect(await readFile(paths.binaryPath, 'utf8')).toBe('version 1');
    expect(await readdir(paths.dir)).toEqual(['claude-firefox-host']);
  });

  it('uninstall removes the manifest, both launchers, leftover copies and the empty directory', async () => {
    await installPosix({ paths, source: { kind: 'binary', executable: await fakeBinary('binary') } });
    await installPosix({ paths, source: { kind: 'node', nodePath: process.execPath, entry: join(base, 'index.js') } });
    await writeFile(join(paths.dir, 'claude-firefox-host.old-0123456789ab'), '');
    await expect(uninstallPosix({ paths })).resolves.toEqual([]);
    expect(existsSync(paths.manifestPath)).toBe(false);
    expect(existsSync(paths.dir)).toBe(false);
  });

  it('uninstall keeps a directory that holds other files', async () => {
    await installPosix({ paths, source: { kind: 'binary', executable: await fakeBinary('binary') } });
    const other = join(paths.dir, 'other');
    await writeFile(other, '');
    await uninstallPosix({ paths });
    expect(existsSync(paths.binaryPath)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  it('uninstall succeeds when nothing is installed', async () => {
    await expect(uninstallPosix({ paths })).resolves.toEqual([]);
  });
});

describe.runIf(isPosix)('runInstallCommand on Linux', () => {
  let context: InstallerContext;
  let out: string[];
  let err: string[];
  let paths: InstallPaths;

  beforeEach(async () => {
    const base = await tempBase();
    const executable = join(base, 'Downloads', 'claude-firefox-host');
    await mkdir(join(base, 'Downloads'), { recursive: true });
    await writeFile(executable, 'binary', { mode: 0o755 });
    out = [];
    err = [];
    const env = { XDG_DATA_HOME: join(base, 'data') };
    context = {
      platform: 'linux',
      env,
      home: join(base, 'home'),
      source: { kind: 'binary', executable },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    };
    paths = installPaths('linux', env, context.home);
  });

  it('installs the binary and prints the claude mcp add command for the installed copy', async () => {
    await expect(runInstallCommand('install', context)).resolves.toBe(0);
    const text = out.join('\n');
    expect(text).toContain(`  manifest: ${paths.manifestPath}\n  host:     ${paths.binaryPath}\n`);
    expect(text).toContain(`claude mcp add firefox -- ${shellQuote(paths.binaryPath)} --mcp`);
    expect(text).toContain('Snap and Flatpak');
    expect(text).toContain('--remote-debugging-port=9222');
    expect(err).toEqual([]);
  });

  it('prints the paths it would write with print-paths and writes nothing', async () => {
    await expect(runInstallCommand('print-paths', context)).resolves.toBe(0);
    expect(out.map((line) => JSON.parse(line) as unknown)).toEqual([{ manifest: paths.manifestPath, launcher: paths.binaryPath }]);
    expect(existsSync(context.home)).toBe(false);
    expect(existsSync(paths.dir)).toBe(false);
  });

  it('uninstalls and lists what it removed', async () => {
    await runInstallCommand('install', context);
    out.length = 0;
    await expect(runInstallCommand('uninstall', context)).resolves.toBe(0);
    expect(out).toEqual(['Removed the native messaging host:', `  ${paths.manifestPath}`, `  ${paths.wrapperPath}`, `  ${paths.binaryPath}`]);
    expect(existsSync(paths.dir)).toBe(false);
  });

  it('reports a failed install on stderr and returns 1', async () => {
    context.source = { kind: 'binary', executable: join(context.home, 'missing') };
    await expect(runInstallCommand('install', context)).resolves.toBe(1);
    expect(err).toEqual([expect.stringMatching(/^Install failed: .*ENOENT/)]);
  });
});

// The bundled host run by Node is what npm run install-host runs for a development build.
describe.runIf(process.platform === 'linux')('development install through the bundled host', () => {
  let home: string;
  let dataHome: string;

  beforeEach(async () => {
    const base = await tempBase();
    home = join(base, 'home');
    dataHome = join(base, 'data');
    await mkdir(home);
  });

  function runHost(args: string[], { xdgDataHome = true } = {}) {
    return run(process.execPath, [bundledHost, ...args], {
      env: { PATH: process.env['PATH'], HOME: home, ...(xdgDataHome ? { XDG_DATA_HOME: dataHome } : {}) },
    });
  }

  it('installs a wrapper that runs this build with this Node and prints the command', async () => {
    const { stdout } = await runHost(['install']);
    const paths = installPaths('linux', { XDG_DATA_HOME: dataHome }, home);
    expect(await readFile(paths.wrapperPath, 'utf8')).toBe(renderShellWrapper(process.execPath, bundledHost));
    expect(JSON.parse(await readFile(paths.manifestPath, 'utf8'))).toMatchObject({ path: paths.wrapperPath });
    expect(stdout).toContain(`claude mcp add firefox -- ${shellQuote(process.execPath)} ${shellQuote(bundledHost)} --mcp`);
    expect(stdout).toContain(BIDI_PORT_ENV);
  });

  it('falls back to ~/.local/share without XDG_DATA_HOME', async () => {
    await runHost(['install'], { xdgDataHome: false });
    const wrapper = join(home, '.local/share/claude-firefox-extension/native-host');
    expect(statSync(wrapper).mode & 0o777).toBe(0o755);
  });

  it('prints the paths with install --print-paths', async () => {
    const { stdout } = await runHost(['install', '--print-paths']);
    const paths = installPaths('linux', { XDG_DATA_HOME: dataHome }, home);
    expect(JSON.parse(stdout)).toEqual({ manifest: paths.manifestPath, launcher: paths.wrapperPath });
    expect(existsSync(join(home, '.mozilla'))).toBe(false);
  });

  it('uninstalls', async () => {
    await runHost(['install']);
    const { stdout } = await runHost(['uninstall']);
    expect(stdout).toContain('Removed the native messaging host:');
    expect(existsSync(join(home, '.mozilla/native-messaging-hosts', `${NATIVE_HOST_NAME}.json`))).toBe(false);
    expect(existsSync(join(dataHome, 'claude-firefox-extension'))).toBe(false);
  });

  it('shows the usage and exits 1 for an unknown command', async () => {
    await expect(runHost(['setup'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('install | uninstall') });
  });
});
