import { execFile } from 'node:child_process';
import { mkdir, rmdir } from 'node:fs/promises';
import { win32 } from 'node:path';
import { promisify } from 'node:util';
import { NATIVE_HOST_NAME } from '../protocol';
import { installFiles, nodeFileOps, removeInstalledFile, removeStaleCopies, type FileOps, type Launcher } from './files';
import { envValue, launcherPath, type Env, type HostSource, type InstallPaths } from './paths';

const SYSTEM_SID = 'S-1-5-18';
const ADMINISTRATORS_SID = 'S-1-5-32-544';
const SID_PATTERN = /^S-1(-\d+)+$/;

export interface RunResult {
  stdout: string;
  stderr: string;
}
export type Runner = (file: string, args: string[]) => Promise<RunResult>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Windows searches the current directory before PATH for a bare program name, so system tools are
 * started by their absolute System32 path.
 */
export function windowsToolPath(env: Env, exe: string): string {
  return win32.join(envValue(env, 'SYSTEMROOT') ?? 'C:\\Windows', 'System32', exe);
}

function batQuote(path: string): string {
  if (/["\r\n\0]/.test(path)) throw new Error(`Path contains an unsupported character: ${JSON.stringify(path)}`);
  // `%` is expanded even inside quotes; `%%` is a literal percent sign in a batch file.
  return `"${path.replaceAll('%', '%%')}"`;
}

export function renderBatWrapper(nodePath: string, hostEntry: string): string {
  const command = `${batQuote(nodePath)} ${batQuote(hostEntry)} --native-host %*`;
  // Any stray byte on stdout corrupts native messaging, so nothing may be echoed. Delayed expansion
  // (enabled by /v:on or the registry) would eat `!` and `^` in the paths and in %* below; it still
  // applies to cmd's own /c command line, which holds the .bat path, before this file runs. cmd.exe
  // reads a batch file line by line in the current code page, so after chcp the remaining lines are
  // decoded as UTF-8, which is how the file is written.
  return ['@echo off', 'setlocal DisableDelayedExpansion', 'chcp 65001 >nul', command, ''].join('\r\n');
}

function registryKey(hostName: string): string {
  return `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${hostName}`;
}

/** Firefox reads the key in the 64-bit view; /reg:64 keeps a 32-bit process from writing to WOW6432Node. */
export function regAddArgs(manifestPath: string, hostName: string = NATIVE_HOST_NAME): string[] {
  return ['add', registryKey(hostName), '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f', '/reg:64'];
}

export function regDeleteArgs(hostName: string = NATIVE_HOST_NAME): string[] {
  return ['delete', registryKey(hostName), '/f', '/reg:64'];
}

export function regQueryArgs(hostName: string = NATIVE_HOST_NAME): string[] {
  return ['query', registryKey(hostName), '/reg:64'];
}

export function icaclsArgs(dir: string, userSid: string): string[] {
  if (!SID_PATTERN.test(userSid)) throw new Error(`Not a SID: ${JSON.stringify(userSid)}`);
  return [
    dir,
    '/inheritance:r',
    '/grant:r',
    `*${userSid}:(OI)(CI)F`,
    `*${SYSTEM_SID}:(OI)(CI)F`,
    `*${ADMINISTRATORS_SID}:(OI)(CI)F`,
  ];
}

/** Parses one line of fully quoted CSV fields; returns undefined if the line is not exactly that. */
function parseQuotedCsvLine(line: string): string[] | undefined {
  const fields: string[] = [];
  let index = 0;
  for (;;) {
    if (line[index] !== '"') return undefined;
    let field = '';
    index++;
    for (;;) {
      if (index >= line.length) return undefined;
      if (line[index] === '"') {
        if (line[index + 1] !== '"') break;
        field += '"';
        index += 2;
      } else {
        field += line[index];
        index++;
      }
    }
    index++;
    fields.push(field);
    if (index === line.length) return fields;
    if (line[index] !== ',') return undefined;
    index++;
  }
}

/**
 * Parses `whoami /user /fo csv /nh`. The user name is printed in the OEM code page and may be garbled;
 * only the SID is used.
 */
export function parseWhoamiUserCsv(output: string): string {
  const lines = output.split(/\r?\n/).filter((line) => line.trim() !== '');
  const fields = lines.length === 1 && lines[0] !== undefined ? parseQuotedCsvLine(lines[0].trim()) : undefined;
  const sid = fields?.length === 2 ? fields[1] : undefined;
  if (sid === undefined || !SID_PATTERN.test(sid)) {
    throw new Error(`Unexpected whoami output: ${JSON.stringify(output)}`);
  }
  return sid;
}

/**
 * Firefox starts a .bat host with `cmd.exe /s/c "<bat> <manifest> <id>"` and quotes the .bat path only when it
 * contains a space, so cmd splits an unquoted path at `&` and treats `^` as an escape. An .exe host is
 * started directly, without cmd.exe.
 */
export function windowsPathWarnings(dir: string): string[] {
  if (!/[&^]/.test(dir) || dir.includes(' ')) return [];
  return [
    `Warning: the install directory ${dir} contains '&' or '^' and no space. Firefox passes the path of ` +
      'native-host.bat to cmd.exe unquoted in that case, so Firefox will not be able to start the native host ' +
      'from this directory and the extension will not connect.',
  ];
}

const execFileAsync = promisify(execFile);

export const execFileRunner: Runner = async (file, args) => {
  const { stdout, stderr } = await execFileAsync(file, args, { windowsHide: true });
  return { stdout, stderr };
};

export interface InstallWindowsOptions {
  paths: InstallPaths;
  env: Env;
  source: HostSource;
  run: Runner;
  hostName?: string;
  ops?: FileOps;
}

export async function installWindows({
  paths,
  env,
  source,
  run,
  hostName = NATIVE_HOST_NAME,
  ops = nodeFileOps,
}: InstallWindowsOptions): Promise<void> {
  const launcher: Launcher =
    source.kind === 'binary'
      ? { kind: 'binary', executable: source.executable }
      : { kind: 'script', content: renderBatWrapper(source.nodePath, source.entry) };
  try {
    const { stdout } = await run(windowsToolPath(env, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
    const sid = parseWhoamiUserCsv(stdout);
    await mkdir(paths.dir, { recursive: true });
    // Restricted while still empty, so the files written next inherit the user-only ACL from the start.
    await run(windowsToolPath(env, 'icacls.exe'), icaclsArgs(paths.dir, sid));
    await installFiles({
      launcher,
      launcherPath: launcherPath(paths, source),
      manifestPath: paths.manifestPath,
      hostName,
      register: async () => {
        await run(windowsToolPath(env, 'reg.exe'), regAddArgs(paths.manifestPath, hostName));
      },
      ops,
    });
  } catch (error) {
    throw new Error(`Install failed: ${errorMessage(error)}`, { cause: error });
  }
}

export interface UninstallWindowsOptions {
  paths: InstallPaths;
  env: Env;
  run: Runner;
  hostName?: string;
  removeDir?: (path: string) => Promise<void>;
  ops?: FileOps;
}

/** Returns the files that are still in use and were left in place. */
export async function uninstallWindows({
  paths,
  env,
  run,
  hostName = NATIVE_HOST_NAME,
  removeDir = rmdir,
  ops = nodeFileOps,
}: UninstallWindowsOptions): Promise<string[]> {
  const reg = windowsToolPath(env, 'reg.exe');
  try {
    await run(reg, regDeleteArgs(hostName));
  } catch (deleteError) {
    const failed = () => new Error(`Uninstall failed: ${errorMessage(deleteError)}`, { cause: deleteError });
    // Without an exit code reg.exe did not run (not found, killed), and a failing query would then
    // look like a missing key.
    if (typeof (deleteError as { code?: unknown } | undefined)?.code !== 'number') throw failed();
    // reg.exe prints localized messages, so a missing key is told apart from a real failure by
    // querying the key, not by parsing the error text.
    const keyExists = await run(reg, regQueryArgs(hostName)).then(
      () => true,
      () => false,
    );
    if (keyExists) throw failed();
  }
  await ops.rm(paths.manifestPath, { force: true });
  await ops.rm(paths.wrapperPath, { force: true });
  const left = await removeStaleCopies(paths.binaryPath, ops);
  if (!(await removeInstalledFile(paths.binaryPath, ops))) left.push(paths.binaryPath);
  try {
    await removeDir(paths.dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EBUSY: a running host holds the directory open (and keeps bridge.json in it).
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EBUSY') throw error;
  }
  return left;
}
