import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { bridgeInfoDir } from '../../host/bridge-info';
import { NATIVE_HOST_NAME } from '../../host/protocol';
import {
  execFileRunner,
  icaclsArgs,
  installWindows,
  parseWhoamiUserCsv,
  regAddArgs,
  regDeleteArgs,
  regQueryArgs,
  renderBatWrapper,
  uninstallWindows,
  windowsInstallPaths,
  windowsMcpAddHint,
  windowsPathWarnings,
  windowsToolPath,
} from '../install-host-lib.mjs';

interface RunResult {
  stdout: string;
  stderr: string;
}
type Runner = (file: string, args: string[]) => Promise<RunResult>;
interface Call {
  file: string;
  args: string[];
}
interface InstallPaths {
  dir: string;
  wrapperPath: string;
  manifestPath: string;
}

const run = promisify(execFile);
const scriptsDir = fileURLToPath(new URL('..', import.meta.url));
const extensionId = (
  JSON.parse(readFileSync(fileURLToPath(new URL('../../extension/manifest.json', import.meta.url)), 'utf8')) as {
    browser_specific_settings: { gecko: { id: string } };
  }
).browser_specific_settings.gecko.id;

const isWindows = process.platform === 'win32';
// Tests that write to the real HKCU registry or run the installer CLI only run on GitHub Actions runners.
const isWindowsCi = isWindows && process.env['GITHUB_ACTIONS'] === 'true';
const tempRoot = isWindows ? tmpdir() : '/tmp';

const ENV = { SystemRoot: 'C:\\Windows' };
const REG = 'C:\\Windows\\System32\\reg.exe';
const ICACLS = 'C:\\Windows\\System32\\icacls.exe';
const WHOAMI = 'C:\\Windows\\System32\\whoami.exe';
const SID = 'S-1-5-21-1004336348-1177238915-682003330-1001';
const WHOAMI_OUTPUT = `"desktop-7k2\\anna","${SID}"\r\n`;
const KEY = `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;
const NODE = 'C:\\Program Files\\nodejs\\node.exe';

function commandFailed(stderr: string, code = 1): Error {
  return Object.assign(new Error(`Command failed: ${stderr}`), { code, stdout: '', stderr });
}

function fakeRunner(respond: (call: Call) => RunResult | Promise<RunResult> = () => ({ stdout: '', stderr: '' })) {
  const calls: Call[] = [];
  const runner: Runner = async (file, args) => {
    const call = { file, args: [...args] };
    calls.push(call);
    if (file === WHOAMI) return { stdout: WHOAMI_OUTPUT, stderr: '' };
    return respond(call);
  };
  return { calls, run: runner };
}

function isTool(call: Call, file: string, verb?: string): boolean {
  return call.file === file && (verb === undefined || call.args[0] === verb);
}

async function tempBase(): Promise<string> {
  const base = await mkdtemp(join(tempRoot, 'cfe-'));
  onTestFinished(() => rm(base, { recursive: true, force: true }));
  return base;
}

describe('windowsInstallPaths', () => {
  const cases: [string, Record<string, string | undefined>, string, string][] = [
    ['LOCALAPPDATA', { LOCALAPPDATA: 'C:\\Users\\anna\\AppData\\Local' }, 'C:\\Users\\other', 'C:\\Users\\anna\\AppData\\Local'],
    ['LOCALAPPDATA in any case', { LocalAppData: 'D:\\Local' }, 'C:\\Users\\anna', 'D:\\Local'],
    ['the home directory without LOCALAPPDATA', {}, 'C:\\Users\\Анна', 'C:\\Users\\Анна\\AppData\\Local'],
    ['the home directory when LOCALAPPDATA is empty', { LOCALAPPDATA: '' }, 'C:\\Users\\anna', 'C:\\Users\\anna\\AppData\\Local'],
  ];

  it.each(cases)('uses %s', (_name, env, home, localAppData) => {
    const dir = `${localAppData}\\claude-firefox-extension`;
    expect(windowsInstallPaths(env, home)).toEqual({
      dir,
      wrapperPath: `${dir}\\native-host.bat`,
      manifestPath: `${dir}\\claude_firefox_extension.json`,
    });
  });

  it.each(cases)('installs into the bridge info directory with %s', (_name, env, home) => {
    expect(windowsInstallPaths(env, home).dir).toBe(bridgeInfoDir({ platform: 'win32', env, homedir: home }));
  });
});

describe('windowsToolPath', () => {
  it('resolves tools in System32 instead of searching the current directory and PATH', () => {
    expect(windowsToolPath({ SystemRoot: 'C:\\Windows' }, 'reg.exe')).toBe(REG);
    expect(windowsToolPath({ SYSTEMROOT: 'D:\\WINNT' }, 'icacls.exe')).toBe('D:\\WINNT\\System32\\icacls.exe');
  });

  it('falls back to C:\\Windows without SystemRoot', () => {
    expect(windowsToolPath({}, 'whoami.exe')).toBe(WHOAMI);
    expect(windowsToolPath({ SystemRoot: '' }, 'whoami.exe')).toBe(WHOAMI);
  });
});

describe('renderBatWrapper', () => {
  const ENTRY = 'C:\\src\\dist\\host\\index.js';

  it('suppresses echo, disables delayed expansion, switches to UTF-8 silently and forwards all arguments, with CRLF line endings', () => {
    expect(renderBatWrapper(NODE, ENTRY)).toBe(
      '@echo off\r\n' +
        'setlocal DisableDelayedExpansion\r\n' +
        'chcp 65001 >nul\r\n' +
        `"${NODE}" "${ENTRY}" --native-host %*\r\n`,
    );
  });

  it('disables delayed expansion on the second line, before any path is parsed', () => {
    expect(renderBatWrapper(NODE, ENTRY).split('\r\n')[1]).toBe('setlocal DisableDelayedExpansion');
  });

  it('has no bare LF line endings', () => {
    expect(renderBatWrapper(NODE, ENTRY).replaceAll('\r\n', '')).not.toMatch(/[\r\n]/);
  });

  it.each([
    ['spaces', 'C:\\Program Files\\x y\\a.js', '"C:\\Program Files\\x y\\a.js"'],
    ['ampersand', 'C:\\R&D\\a.js', '"C:\\R&D\\a.js"'],
    ['caret', 'C:\\a^b\\a.js', '"C:\\a^b\\a.js"'],
    ['parentheses', 'C:\\Program Files (x86)\\a.js', '"C:\\Program Files (x86)\\a.js"'],
    ['exclamation marks', 'C:\\wow!\\b!c\\a.js', '"C:\\wow!\\b!c\\a.js"'],
    ['a percent sign', 'C:\\100%\\a.js', '"C:\\100%%\\a.js"'],
    ['a variable-like percent pair', 'C:\\%OS%\\%1\\a.js', '"C:\\%%OS%%\\%%1\\a.js"'],
    ['Cyrillic', 'C:\\Users\\Анна\\a.js', '"C:\\Users\\Анна\\a.js"'],
    ['pipes and redirects', 'C:\\a|b<c>d\\a.js', '"C:\\a|b<c>d\\a.js"'],
  ])('quotes a path with %s', (_name, path, quoted) => {
    const lines = renderBatWrapper(path, path).split('\r\n');
    expect(lines[3]).toBe(`${quoted} ${quoted} --native-host %*`);
  });

  it.each([
    ['a double quote', 'C:\\a"b\\a.js'],
    ['a newline', 'C:\\a\nb\\a.js'],
    ['a carriage return', 'C:\\a\rb\\a.js'],
    ['a NUL character', 'C:\\a\0b\\a.js'],
  ])('rejects a path with %s', (_name, path) => {
    expect(() => renderBatWrapper(path, ENTRY)).toThrow(/unsupported character/);
    expect(() => renderBatWrapper(NODE, path)).toThrow(/unsupported character/);
  });
});

describe('registry arguments', () => {
  const MANIFEST = 'C:\\Users\\Анна\\AppData\\Local\\claude-firefox-extension\\claude_firefox_extension.json';

  it('sets the default value of the host key in the 64-bit view', () => {
    expect(regAddArgs(MANIFEST)).toEqual(['add', KEY, '/ve', '/t', 'REG_SZ', '/d', MANIFEST, '/f', '/reg:64']);
  });

  it('deletes the host key without prompting', () => {
    expect(regDeleteArgs()).toEqual(['delete', KEY, '/f', '/reg:64']);
  });

  it('queries the host key', () => {
    expect(regQueryArgs()).toEqual(['query', KEY, '/reg:64']);
  });

  it('accepts another host name', () => {
    const key = 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\other_host';
    expect(regAddArgs(MANIFEST, 'other_host')[1]).toBe(key);
    expect(regDeleteArgs('other_host')[1]).toBe(key);
    expect(regQueryArgs('other_host')[1]).toBe(key);
  });
});

describe('icaclsArgs', () => {
  it('drops inherited entries and grants full control to the user, SYSTEM and Administrators only', () => {
    const dir = 'C:\\Users\\Анна\\AppData\\Local\\claude-firefox-extension';
    expect(icaclsArgs(dir, SID)).toEqual([
      dir,
      '/inheritance:r',
      '/grant:r',
      `*${SID}:(OI)(CI)F`,
      '*S-1-5-18:(OI)(CI)F',
      '*S-1-5-32-544:(OI)(CI)F',
    ]);
  });

  it.each([
    ['an empty string', ''],
    ['a user name', 'anna'],
    ['a SID with a leading asterisk', `*${SID}`],
    ['a SID with a permission suffix', `${SID}:F`],
    ['a SID with an extra argument', `${SID} /grant Everyone:F`],
    ['a SID with a letter', 'S-1-5-21-x'],
    ['a SID without sub-authorities', 'S-1'],
    ['a SID with a trailing dash', 'S-1-5-'],
    ['a lowercase prefix', 's-1-5-18'],
  ])('rejects %s', (_name, sid) => {
    expect(() => icaclsArgs('C:\\dir', sid)).toThrow(/SID/);
  });
});

describe('parseWhoamiUserCsv', () => {
  it.each([
    ['a domain\\user name', `"desktop-7k2\\anna","${SID}"\r\n`],
    ['a Cyrillic user name', `"desktop-7k2\\Анна","${SID}"\r\n`],
    ['a name garbled by the OEM code page', `"desktop-7k2\\\u2552\u00a5\u00a5\u00a5","${SID}"\r\n`],
    ['a quoted field with an escaped quote and a comma', `"corp\\a""b,c","${SID}"\r\n`],
    ['no trailing newline', `"corp\\anna","${SID}"`],
    ['surrounding blank lines', `\r\n"corp\\anna","${SID}"\r\n\r\n`],
    ['a short well-known SID', '"nt authority\\system","S-1-5-18"\r\n'],
  ])('returns the SID for %s', (_name, output) => {
    const expected = output.includes('S-1-5-18"') ? 'S-1-5-18' : SID;
    expect(parseWhoamiUserCsv(output)).toBe(expected);
  });

  it.each([
    ['empty output', ''],
    ['a single field', '"corp\\anna"\r\n'],
    ['a second field that is not a SID', '"corp\\anna","anna"\r\n'],
    ['a SID with trailing garbage', `"corp\\anna","${SID} x"\r\n`],
    ['an unterminated quote', `"corp\\anna,"${SID}\r\n`],
    ['the table format', `User Name   SID\r\n=========== ===\r\ncorp\\anna  ${SID}\r\n`],
  ])('rejects %s', (_name, output) => {
    expect(() => parseWhoamiUserCsv(output)).toThrow(/whoami/);
  });
});

describe('windowsMcpAddHint', () => {
  it('quotes both paths with double quotes', () => {
    expect(windowsMcpAddHint(NODE, 'C:\\Users\\Анна\\my pkg\\src\\dist\\host\\index.js')).toBe(
      `claude mcp add firefox -- "${NODE}" "C:\\Users\\Анна\\my pkg\\src\\dist\\host\\index.js" --mcp`,
    );
  });
});

// Firefox runs `cmd.exe /s/c "<bat> <manifest> <id>"` and quotes the .bat path only when it contains a space.
describe('windowsPathWarnings', () => {
  it.each(['C:\\Users\\a&b\\AppData\\Local\\claude-firefox-extension', 'C:\\Users\\a^b\\AppData\\Local\\claude-firefox-extension'])(
    'warns that Firefox cannot start the host from %s',
    (dir) => {
      const warnings = windowsPathWarnings(dir);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(dir);
      expect(warnings[0]).toMatch(/Firefox will not be able to start the native host/);
    },
  );

  it.each([
    'C:\\Users\\a b & c\\AppData\\Local\\claude-firefox-extension',
    'C:\\Users\\a b ^ c\\AppData\\Local\\claude-firefox-extension',
    'C:\\Users\\anna\\AppData\\Local\\claude-firefox-extension',
    'C:\\Users\\Анна (old)\\AppData\\Local\\claude-firefox-extension',
  ])('does not warn about %s', (dir) => {
    expect(windowsPathWarnings(dir)).toEqual([]);
  });
});

describe('execFileRunner', () => {
  it('returns stdout and stderr', async () => {
    await expect(
      execFileRunner(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err")']),
    ).resolves.toEqual({ stdout: 'out', stderr: 'err' });
  });

  it('rejects with stderr and the exit code when the command fails', async () => {
    await expect(
      execFileRunner(process.execPath, ['-e', 'process.stderr.write("broken"); process.exit(3)']),
    ).rejects.toMatchObject({ code: 3, stderr: 'broken' });
  });

  it('passes file names and arguments with shell metacharacters through without a shell', async () => {
    const base = await tempBase();
    const script = join(base, 'a & echo pwned; $(echo x) `id` (1) %OS%.js');
    await writeFile(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
    const args = ['$HOME', '&& echo pwned', '%OS%', '!OS!', '`id`', 'a b', '"quoted"'];
    const { stdout } = await execFileRunner(process.execPath, [script, ...args]);
    expect(JSON.parse(stdout)).toEqual(args);
  });

  it('runs the named file itself, not a shell command line', async () => {
    const missing = join(await tempBase(), 'missing; echo pwned & echo pwned');
    await expect(execFileRunner(missing, [])).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

// The install and uninstall flows run on every platform: a fake runner stands in for reg.exe, icacls.exe and
// whoami.exe, and a temp directory stands in for %LOCALAPPDATA%.
describe('Windows install flow', () => {
  let paths: InstallPaths;
  let hostEntry: string;

  beforeEach(async () => {
    const base = await tempBase();
    const dir = join(base, 'LocalAppData', 'claude-firefox-extension');
    paths = { dir, wrapperPath: join(dir, 'native-host.bat'), manifestPath: join(dir, 'claude_firefox_extension.json') };
    hostEntry = join(base, 'pkg', 'dist', 'host', 'index.js');
    await mkdir(join(base, 'pkg', 'dist', 'host'), { recursive: true });
    await writeFile(hostEntry, '');
  });

  function snapshot(call: Call) {
    return {
      ...call,
      dirExists: existsSync(paths.dir),
      wrapperExists: existsSync(paths.wrapperPath),
      manifestExists: existsSync(paths.manifestPath),
    };
  }

  it('restricts the empty directory, then writes the files, then registers the manifest', async () => {
    const seen: ReturnType<typeof snapshot>[] = [];
    const runner = fakeRunner((call) => {
      seen.push(snapshot(call));
      return { stdout: '', stderr: '' };
    });
    await installWindows({ paths, env: ENV, nodePath: NODE, hostEntry, run: runner.run });

    expect(runner.calls).toEqual([
      { file: WHOAMI, args: ['/user', '/fo', 'csv', '/nh'] },
      { file: ICACLS, args: icaclsArgs(paths.dir, SID) },
      { file: REG, args: regAddArgs(paths.manifestPath) },
    ]);
    expect(seen).toEqual([
      expect.objectContaining({ file: ICACLS, dirExists: true, wrapperExists: false, manifestExists: false }),
      expect.objectContaining({ file: REG, dirExists: true, wrapperExists: true, manifestExists: true }),
    ]);
    expect(await readFile(paths.wrapperPath, 'utf8')).toBe(renderBatWrapper(NODE, hostEntry));
    expect(JSON.parse(await readFile(paths.manifestPath, 'utf8'))).toEqual({
      name: NATIVE_HOST_NAME,
      description: 'Claude Firefox Extension native messaging host',
      path: paths.wrapperPath,
      type: 'stdio',
      allowed_extensions: [extensionId],
    });
  });

  it('writes the manifest without a byte order mark', async () => {
    await installWindows({ paths, env: ENV, nodePath: NODE, hostEntry, run: fakeRunner().run });
    expect((await readFile(paths.manifestPath))[0]).toBe('{'.charCodeAt(0));
  });

  it('writes the wrapper and the manifest as UTF-8', async () => {
    const base = await tempBase();
    const dir = join(base, 'Users', 'Анна', 'AppData', 'Local', 'claude-firefox-extension');
    paths = { dir, wrapperPath: join(dir, 'native-host.bat'), manifestPath: join(dir, 'claude_firefox_extension.json') };
    hostEntry = join(base, 'Анна', 'pkg', 'dist', 'host', 'index.js');
    await mkdir(join(base, 'Анна', 'pkg', 'dist', 'host'), { recursive: true });
    await writeFile(hostEntry, '');

    await installWindows({ paths, env: ENV, nodePath: NODE, hostEntry, run: fakeRunner().run });
    expect(await readFile(paths.wrapperPath)).toEqual(Buffer.from(renderBatWrapper(NODE, hostEntry), 'utf8'));
    expect(JSON.parse(await readFile(paths.manifestPath, 'utf8'))).toMatchObject({ path: paths.wrapperPath });
  });

  it('uses the given host name for the manifest and the registry key', async () => {
    const runner = fakeRunner();
    await installWindows({ paths, env: ENV, nodePath: NODE, hostEntry, run: runner.run, hostName: 'cfe_test_host' });
    expect(runner.calls[2]).toEqual({ file: REG, args: regAddArgs(paths.manifestPath, 'cfe_test_host') });
    expect(JSON.parse(await readFile(paths.manifestPath, 'utf8'))).toMatchObject({ name: 'cfe_test_host' });
  });

  it('overwrites an existing installation', async () => {
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.wrapperPath, 'old');
    await writeFile(paths.manifestPath, 'old');
    await installWindows({ paths, env: ENV, nodePath: NODE, hostEntry, run: fakeRunner().run });
    expect(await readFile(paths.wrapperPath, 'utf8')).toBe(renderBatWrapper(NODE, hostEntry));
    expect(JSON.parse(await readFile(paths.manifestPath, 'utf8'))).toMatchObject({ path: paths.wrapperPath });
  });

  it('fails with a clear error and does nothing when the host is not built', async () => {
    await rm(hostEntry);
    const runner = fakeRunner();
    await expect(installWindows({ paths, env: ENV, nodePath: NODE, hostEntry, run: runner.run })).rejects.toThrow(
      `Install failed: ${hostEntry} is missing. Run \`npm run build\` first.`,
    );
    expect(runner.calls).toEqual([]);
    expect(existsSync(paths.dir)).toBe(false);
  });

  it('rejects a Node path that cannot be quoted before doing anything', async () => {
    const runner = fakeRunner();
    await expect(
      installWindows({ paths, env: ENV, nodePath: 'C:\\a"b\\node.exe', hostEntry, run: runner.run }),
    ).rejects.toThrow(/unsupported character/);
    expect(runner.calls).toEqual([]);
    expect(existsSync(paths.dir)).toBe(false);
  });

  it('fails without writing anything when whoami fails', async () => {
    const calls: Call[] = [];
    const runner: Runner = async (file, args) => {
      calls.push({ file, args });
      throw commandFailed('ERROR: whoami broke');
    };
    await expect(installWindows({ paths, env: ENV, nodePath: NODE, hostEntry, run: runner })).rejects.toThrow(
      /^Install failed: .*whoami broke/s,
    );
    expect(calls).toHaveLength(1);
    expect(existsSync(paths.dir)).toBe(false);
  });

  it('fails without writing anything when whoami prints no SID', async () => {
    const calls: Call[] = [];
    const runner: Runner = async (file, args) => {
      calls.push({ file, args });
      return { stdout: '"corp\\anna"\r\n', stderr: '' };
    };
    await expect(installWindows({ paths, env: ENV, nodePath: NODE, hostEntry, run: runner })).rejects.toThrow(
      /^Install failed: /,
    );
    expect(calls).toHaveLength(1);
    expect(existsSync(paths.dir)).toBe(false);
  });

  it('fails with a clear error and writes no files when icacls fails', async () => {
    const runner = fakeRunner((call) => {
      if (call.file === ICACLS) throw commandFailed('Invalid parameter "/inheritance:r"', 87);
      return { stdout: '', stderr: '' };
    });
    await expect(installWindows({ paths, env: ENV, nodePath: NODE, hostEntry, run: runner.run })).rejects.toThrow(
      /^Install failed: .*Invalid parameter/s,
    );
    expect(runner.calls.some((call) => call.file === REG)).toBe(false);
    expect(existsSync(paths.wrapperPath)).toBe(false);
    expect(existsSync(paths.manifestPath)).toBe(false);
  });

  it('fails with a clear error and registers nothing when the manifest cannot be written', async () => {
    await mkdir(paths.manifestPath, { recursive: true });
    const runner = fakeRunner();
    await expect(installWindows({ paths, env: ENV, nodePath: NODE, hostEntry, run: runner.run })).rejects.toThrow(
      /^Install failed: /,
    );
    expect(runner.calls.some((call) => call.file === REG)).toBe(false);
  });

  it('fails with a clear error and removes the files it wrote when reg add fails', async () => {
    await mkdir(paths.dir, { recursive: true });
    const bridgeInfo = join(paths.dir, 'bridge.json');
    await writeFile(bridgeInfo, '{}');
    const runner = fakeRunner((call) => {
      if (isTool(call, REG, 'add')) throw commandFailed('ERROR: Access is denied.');
      return { stdout: '', stderr: '' };
    });
    await expect(installWindows({ paths, env: ENV, nodePath: NODE, hostEntry, run: runner.run })).rejects.toThrow(
      /^Install failed: .*Access is denied\./s,
    );
    expect(existsSync(paths.wrapperPath)).toBe(false);
    expect(existsSync(paths.manifestPath)).toBe(false);
    expect(existsSync(bridgeInfo)).toBe(true);
  });

  // The registry key of the previous installation still points at these files.
  it.each([
    ['both files', true, true],
    ['only the wrapper', true, false],
    ['only the manifest', false, true],
  ])('puts back %s of a previous installation and removes the rest when reg add fails', async (_name, hadWrapper, hadManifest) => {
    await mkdir(paths.dir, { recursive: true });
    if (hadWrapper) await writeFile(paths.wrapperPath, 'old wrapper');
    if (hadManifest) await writeFile(paths.manifestPath, '{"old":true}');
    const runner = fakeRunner((call) => {
      if (isTool(call, REG, 'add')) throw commandFailed('ERROR: Access is denied.');
      return { stdout: '', stderr: '' };
    });
    await expect(installWindows({ paths, env: ENV, nodePath: NODE, hostEntry, run: runner.run })).rejects.toThrow(
      /^Install failed: .*Access is denied\./s,
    );
    expect(existsSync(paths.wrapperPath) && (await readFile(paths.wrapperPath, 'utf8'))).toBe(hadWrapper && 'old wrapper');
    expect(existsSync(paths.manifestPath) && (await readFile(paths.manifestPath, 'utf8'))).toBe(hadManifest && '{"old":true}');
  });

  it('puts back the previous wrapper when the manifest cannot be written', async () => {
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.wrapperPath, 'old wrapper');
    await mkdir(join(paths.manifestPath, 'blocker'), { recursive: true });
    const runner = fakeRunner();
    await expect(installWindows({ paths, env: ENV, nodePath: NODE, hostEntry, run: runner.run })).rejects.toThrow(
      /^Install failed: /,
    );
    expect(runner.calls.some((call) => call.file === REG)).toBe(false);
    expect(await readFile(paths.wrapperPath, 'utf8')).toBe('old wrapper');
  });
});

describe('Windows uninstall flow', () => {
  let paths: InstallPaths;

  beforeEach(async () => {
    const dir = join(await tempBase(), 'LocalAppData', 'claude-firefox-extension');
    paths = { dir, wrapperPath: join(dir, 'native-host.bat'), manifestPath: join(dir, 'claude_firefox_extension.json') };
    await mkdir(dir, { recursive: true });
    await writeFile(paths.wrapperPath, 'wrapper');
    await writeFile(paths.manifestPath, '{}');
  });

  it('deletes the registry key, then the files and the empty directory', async () => {
    const seen: boolean[] = [];
    const runner = fakeRunner(() => {
      seen.push(existsSync(paths.manifestPath));
      return { stdout: '', stderr: '' };
    });
    await uninstallWindows({ paths, env: ENV, run: runner.run });
    expect(runner.calls).toEqual([{ file: REG, args: regDeleteArgs() }]);
    expect(seen).toEqual([true]);
    expect(existsSync(paths.dir)).toBe(false);
  });

  it('uses the given host name for the registry key', async () => {
    const runner = fakeRunner();
    await uninstallWindows({ paths, env: ENV, run: runner.run, hostName: 'cfe_test_host' });
    expect(runner.calls).toEqual([{ file: REG, args: regDeleteArgs('cfe_test_host') }]);
  });

  // reg.exe prints localized messages, so a missing key is recognized by a failing query, not by the text.
  it('tolerates a missing registry key', async () => {
    const runner = fakeRunner(() => {
      throw commandFailed('ERROR: The system was unable to find the specified registry key or value.');
    });
    await uninstallWindows({ paths, env: ENV, run: runner.run });
    expect(runner.calls).toEqual([
      { file: REG, args: regDeleteArgs() },
      { file: REG, args: regQueryArgs() },
    ]);
    expect(existsSync(paths.dir)).toBe(false);
  });

  it('fails with a clear error and keeps the files when the key exists but cannot be deleted', async () => {
    const runner = fakeRunner((call) => {
      if (isTool(call, REG, 'delete')) throw commandFailed('ERROR: Access is denied.');
      return { stdout: `\r\n${KEY}\r\n    (Default)    REG_SZ    ${paths.manifestPath}\r\n`, stderr: '' };
    });
    await expect(uninstallWindows({ paths, env: ENV, run: runner.run })).rejects.toThrow(
      /^Uninstall failed: .*Access is denied\./s,
    );
    expect(existsSync(paths.wrapperPath)).toBe(true);
    expect(existsSync(paths.manifestPath)).toBe(true);
  });

  // A failing query would look like a missing key when reg.exe itself cannot run.
  it.each([
    ['reg.exe cannot be started', Object.assign(new Error('spawn C:\\Windows\\System32\\reg.exe ENOENT'), { code: 'ENOENT' })],
    ['reg.exe is killed', Object.assign(new Error('Command failed: reg.exe'), { code: null, signal: 'SIGTERM' })],
  ])('fails with a clear error and keeps the files when %s', async (_name, error) => {
    const runner = fakeRunner(() => {
      throw error;
    });
    await expect(uninstallWindows({ paths, env: ENV, run: runner.run })).rejects.toThrow(
      `Uninstall failed: ${error.message}`,
    );
    expect(runner.calls).toEqual([{ file: REG, args: regDeleteArgs() }]);
    expect(existsSync(paths.wrapperPath)).toBe(true);
    expect(existsSync(paths.manifestPath)).toBe(true);
  });

  it('keeps a directory that holds other files', async () => {
    const bridgeInfo = join(paths.dir, 'bridge.json');
    await writeFile(bridgeInfo, '{}');
    await uninstallWindows({ paths, env: ENV, run: fakeRunner().run });
    expect(existsSync(paths.wrapperPath)).toBe(false);
    expect(existsSync(paths.manifestPath)).toBe(false);
    expect(existsSync(bridgeInfo)).toBe(true);
  });

  // Windows refuses to remove a directory that a running process holds an open handle to with EBUSY,
  // before checking whether it is empty.
  it('keeps a directory that a running host holds open and still succeeds', async () => {
    const bridgeInfo = join(paths.dir, 'bridge.json');
    await writeFile(bridgeInfo, '{}');
    const removed: string[] = [];
    const removeDir = async (path: string) => {
      removed.push(path);
      throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${path}'`), { code: 'EBUSY', syscall: 'rmdir', path });
    };
    await expect(uninstallWindows({ paths, env: ENV, run: fakeRunner().run, removeDir })).resolves.toBeUndefined();
    expect(removed).toEqual([paths.dir]);
    expect(existsSync(paths.wrapperPath)).toBe(false);
    expect(existsSync(paths.manifestPath)).toBe(false);
    expect(existsSync(bridgeInfo)).toBe(true);
  });

  // EPERM means access was denied, not that the directory is in use, so it is still reported.
  it('fails when the directory cannot be removed for lack of permission', async () => {
    const removeDir = async (path: string) => {
      throw Object.assign(new Error(`EPERM: operation not permitted, rmdir '${path}'`), { code: 'EPERM', syscall: 'rmdir', path });
    };
    await expect(uninstallWindows({ paths, env: ENV, run: fakeRunner().run, removeDir })).rejects.toThrow(/EPERM/);
  });

  it('removes the directory with the given function', async () => {
    const removed: string[] = [];
    const removeDir = async (path: string) => {
      removed.push(path);
      await rm(path, { recursive: true });
    };
    await uninstallWindows({ paths, env: ENV, run: fakeRunner().run, removeDir });
    expect(removed).toEqual([paths.dir]);
    expect(existsSync(paths.dir)).toBe(false);
  });

  it('succeeds when nothing is installed', async () => {
    await rm(paths.dir, { recursive: true });
    const runner = fakeRunner(() => {
      throw commandFailed('ERROR: not found');
    });
    await expect(uninstallWindows({ paths, env: ENV, run: runner.run })).resolves.toBeUndefined();
  });
});

// Answers one framed message with a framed pong that carries the host's arguments; any other byte on
// stdout (an echoed command, chcp's "Active code page" line) breaks the framing the test checks.
const FAKE_NATIVE_HOST = `
let buffered = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  if (buffered.length < 4 || buffered.length < 4 + buffered.readUInt32LE(0)) return;
  const message = JSON.parse(buffered.subarray(4, 4 + buffered.readUInt32LE(0)).toString('utf8'));
  const body = Buffer.from(JSON.stringify({ type: message.type === 'ping' ? 'pong' : 'unexpected', argv: process.argv.slice(1) }));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]), () => process.exit(0));
});
`;

function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

// Firefox starts a .bat host as `cmd.exe /s /c ""<bat>" <args>"` (no /d, so AutoRun and the registry
// DelayedExpansion setting apply); Node refuses to spawn .bat files without a shell.
function runBat(
  bat: string,
  args: string[],
  input: Buffer,
  cmdFlags: string[] = [],
): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  const commandLine = `""${bat}" ${args.map((arg) => `"${arg}"`).join(' ')}"`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.env['ComSpec'] ?? 'cmd.exe', [...cmdFlags, '/s', '/c', commandLine], {
      windowsVerbatimArguments: true,
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(stdout), stderr }));
    child.stdin.end(input);
  });
}

describe.runIf(isWindows)('Windows wrapper (real cmd.exe)', () => {
  // With /v:on cmd.exe applies delayed expansion to the /c command line itself, before the batch file
  // runs, so a `!` in the .bat path or in an argument is already gone when the wrapper starts; its
  // DisableDelayedExpansion only protects the lines inside the batch file (the quoted Node and entry
  // paths and the %* expansion). The /v:on case therefore keeps `!` out of the .bat path and the
  // arguments and checks that the entry path, which holds `!` and `%OS%`, arrives intact.
  it.each([
    ['as Firefox starts it', [], 'pkg & (x) ^ wow!', ['!OS!']],
    ['with AutoRun disabled', ['/d'], 'pkg & (x) ^ wow!', ['!OS!']],
    ['with delayed expansion enabled', ['/v:on'], 'pkg & (x) ^ wow', []],
  ])('passes a framed ping to the host and returns only the framed pong %s', async (_name, cmdFlags, batDirName, extraArgs) => {
    const base = await tempBase();
    const entryDir = join(base, 'pkg & (x) ^ wow! 100% %OS% Анна', 'dist', 'host');
    await mkdir(entryDir, { recursive: true });
    const entry = join(entryDir, 'index.js');
    await writeFile(entry, FAKE_NATIVE_HOST);
    const batDir = join(base, batDirName);
    await mkdir(batDir, { recursive: true });
    const bat = join(batDir, 'native-host.bat');
    await writeFile(bat, renderBatWrapper(process.execPath, entry));

    const manifestArg = join(base, 'path with space', 'claude_firefox_extension.json');
    const args = [manifestArg, extensionId, ...extraArgs];
    const { code, stdout, stderr } = await runBat(bat, args, frame({ type: 'ping' }), cmdFlags);

    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(stdout.length).toBeGreaterThanOrEqual(4);
    expect(stdout.length).toBe(4 + stdout.readUInt32LE(0));
    expect(JSON.parse(stdout.subarray(4).toString('utf8'))).toEqual({
      type: 'pong',
      argv: [entry, '--native-host', ...args],
    });
  });
});

describe.runIf(isWindowsCi)('Windows installer (real registry, CI only)', () => {
  const regQuery = (key: string) => run(windowsToolPath(process.env, 'reg.exe'), ['query', key, '/ve', '/reg:64']);
  const deleteKeyAfterTest = (hostName?: string) =>
    onTestFinished(async () => {
      await run(windowsToolPath(process.env, 'reg.exe'), regDeleteArgs(hostName)).catch(() => undefined);
    });

  it('registers the manifest path and removes it on uninstall', async () => {
    const base = await tempBase();
    const hostName = `claude_firefox_extension_test_${randomBytes(8).toString('hex')}`;
    const key = `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${hostName}`;
    deleteKeyAfterTest(hostName);
    const hostEntry = join(base, 'pkg', 'dist', 'host', 'index.js');
    await mkdir(join(base, 'pkg', 'dist', 'host'), { recursive: true });
    await writeFile(hostEntry, '');
    const paths = windowsInstallPaths({ LOCALAPPDATA: join(base, 'LocalAppData') }, homedir());

    await installWindows({ paths, env: process.env, nodePath: process.execPath, hostEntry, run: execFileRunner, hostName });
    const { stdout } = await regQuery(key);
    expect(stdout).toMatch(/REG_SZ/);
    expect(stdout).toContain(paths.manifestPath);
    expect(JSON.parse(await readFile(paths.manifestPath, 'utf8'))).toMatchObject({ name: hostName, path: paths.wrapperPath });

    await uninstallWindows({ paths, env: process.env, run: execFileRunner, hostName });
    await expect(regQuery(key)).rejects.toMatchObject({ code: 1 });
    expect(existsSync(paths.dir)).toBe(false);

    await expect(uninstallWindows({ paths, env: process.env, run: execFileRunner, hostName })).resolves.toBeUndefined();
  });

  describe('CLI', () => {
    let packageDir: string;
    let localAppData: string;

    beforeEach(async () => {
      const base = await tempBase();
      packageDir = join(base, 'pkg');
      localAppData = join(base, 'LocalAppData');
      await mkdir(join(packageDir, 'scripts'), { recursive: true });
      for (const name of await readdir(scriptsDir)) {
        if (name.startsWith('install-host') && name.endsWith('.mjs')) {
          await copyFile(join(scriptsDir, name), join(packageDir, 'scripts', name));
        }
      }
    });

    function runCli(args: string[] = []) {
      return run(process.execPath, [join(packageDir, 'scripts/install-host.mjs'), ...args], {
        env: { ...process.env, LOCALAPPDATA: localAppData },
      });
    }

    it('exits 1 with a clear error and registers nothing when the host is not built', async () => {
      const hostEntry = join(packageDir, 'dist', 'host', 'index.js');
      await expect(runCli()).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining(`Install failed: ${hostEntry} is missing. Run \`npm run build\` first.`),
      });
      expect(existsSync(join(localAppData, 'claude-firefox-extension'))).toBe(false);
    });

    it('rejects --print-paths without writing files or touching the registry', async () => {
      const keyExisted = await regQuery(KEY).then(
        () => true,
        () => false,
      );
      if (!keyExisted) deleteKeyAfterTest();
      await mkdir(join(packageDir, 'dist', 'host'), { recursive: true });
      await writeFile(join(packageDir, 'dist', 'host', 'index.js'), '');

      await expect(runCli(['--print-paths'])).rejects.toMatchObject({
        code: 1,
        stdout: '',
        stderr: expect.stringContaining('--print-paths is not supported on win32'),
      });
      expect(existsSync(localAppData)).toBe(false);
      const keyExists = await regQuery(KEY).then(
        () => true,
        () => false,
      );
      expect(keyExists).toBe(keyExisted);
    });

    it('installs, prints the Windows claude mcp add command and uninstalls', async ({ skip }) => {
      const realKeyExists = await regQuery(KEY).then(
        () => true,
        () => false,
      );
      skip(realKeyExists, `${KEY} already exists; not touching a real installation`);
      deleteKeyAfterTest();
      const hostEntry = join(packageDir, 'dist', 'host', 'index.js');
      await mkdir(join(packageDir, 'dist', 'host'), { recursive: true });
      await writeFile(hostEntry, '');
      const paths = windowsInstallPaths({ LOCALAPPDATA: localAppData }, homedir());

      const { stdout } = await runCli();
      expect(stdout).toContain(windowsMcpAddHint(process.execPath, hostEntry));
      expect((await regQuery(KEY)).stdout).toContain(paths.manifestPath);

      await runCli(['--uninstall']);
      await expect(regQuery(KEY)).rejects.toMatchObject({ code: 1 });
      expect(existsSync(paths.dir)).toBe(false);
    });
  });
});
