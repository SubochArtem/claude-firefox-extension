import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { win32 } from 'node:path';
import { promisify } from 'node:util';

const APP_NAME = 'claude-firefox-extension';
// Must match NATIVE_HOST_NAME in host/protocol.ts and the extension's runtime.connectNative() call.
const NATIVE_HOST_NAME = 'claude_firefox_extension';
const EXTENSION_ID = 'claude-firefox-extension@localhost';
const SYSTEM_SID = 'S-1-5-18';
const ADMINISTRATORS_SID = 'S-1-5-32-544';
const SID_PATTERN = /^S-1(-\d+)+$/;

/**
 * @typedef {Record<string, string | undefined>} Env
 * @typedef {{ dir: string, wrapperPath: string, manifestPath: string }} WindowsInstallPaths
 * @typedef {{ stdout: string, stderr: string }} RunResult
 * @typedef {(file: string, args: string[]) => Promise<RunResult>} Runner
 */

/**
 * Windows environment names are case-insensitive, but a plain object passed in is not.
 * @param {Env} env
 * @param {string} name
 */
function envValue(env, name) {
  for (const [key, value] of Object.entries(env)) if (key.toUpperCase() === name && value) return value;
  return undefined;
}

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Same directory as the host's bridge.json (host/bridge-info.ts).
 * @param {Env} env
 * @param {string} home
 * @returns {WindowsInstallPaths}
 */
export function windowsInstallPaths(env, home) {
  const localAppData = envValue(env, 'LOCALAPPDATA') ?? win32.join(home, 'AppData', 'Local');
  const dir = win32.join(localAppData, APP_NAME);
  return {
    dir,
    wrapperPath: win32.join(dir, 'native-host.bat'),
    manifestPath: win32.join(dir, `${NATIVE_HOST_NAME}.json`),
  };
}

/**
 * Windows searches the current directory before PATH for a bare program name, so system tools are
 * started by their absolute System32 path.
 * @param {Env} env
 * @param {string} exe
 */
export function windowsToolPath(env, exe) {
  return win32.join(envValue(env, 'SYSTEMROOT') ?? 'C:\\Windows', 'System32', exe);
}

/** @param {string} path */
function batQuote(path) {
  if (/["\r\n\0]/.test(path)) throw new Error(`Path contains an unsupported character: ${JSON.stringify(path)}`);
  // `%` is expanded even inside quotes; `%%` is a literal percent sign in a batch file.
  return `"${path.replaceAll('%', '%%')}"`;
}

/**
 * @param {string} nodePath
 * @param {string} hostEntry
 */
export function renderBatWrapper(nodePath, hostEntry) {
  const command = `${batQuote(nodePath)} ${batQuote(hostEntry)} --native-host %*`;
  // Any stray byte on stdout corrupts native messaging, so nothing may be echoed. Delayed expansion
  // (enabled by /v:on or the registry) would eat `!` and `^` in the paths and in %* below; it still
  // applies to cmd's own /c command line, which holds the .bat path, before this file runs. cmd.exe
  // reads a batch file line by line in the current code page, so after chcp the remaining lines are
  // decoded as UTF-8, which is how the file is written.
  return ['@echo off', 'setlocal DisableDelayedExpansion', 'chcp 65001 >nul', command, ''].join('\r\n');
}

/** @param {string} hostName */
function registryKey(hostName) {
  return `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${hostName}`;
}

/**
 * Firefox reads the key in the 64-bit view; /reg:64 keeps a 32-bit Node from writing to WOW6432Node.
 * @param {string} manifestPath
 * @param {string} [hostName]
 */
export function regAddArgs(manifestPath, hostName = NATIVE_HOST_NAME) {
  return ['add', registryKey(hostName), '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f', '/reg:64'];
}

/** @param {string} [hostName] */
export function regDeleteArgs(hostName = NATIVE_HOST_NAME) {
  return ['delete', registryKey(hostName), '/f', '/reg:64'];
}

/** @param {string} [hostName] */
export function regQueryArgs(hostName = NATIVE_HOST_NAME) {
  return ['query', registryKey(hostName), '/reg:64'];
}

/**
 * @param {string} dir
 * @param {string} userSid
 */
export function icaclsArgs(dir, userSid) {
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

/**
 * Parses one line of fully quoted CSV fields; returns undefined if the line is not exactly that.
 * @param {string} line
 */
function parseQuotedCsvLine(line) {
  /** @type {string[]} */
  const fields = [];
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
 * @param {string} output
 */
export function parseWhoamiUserCsv(output) {
  const lines = output.split(/\r?\n/).filter((line) => line.trim() !== '');
  const fields = lines.length === 1 && lines[0] !== undefined ? parseQuotedCsvLine(lines[0].trim()) : undefined;
  const sid = fields?.length === 2 ? fields[1] : undefined;
  if (sid === undefined || !SID_PATTERN.test(sid)) {
    throw new Error(`Unexpected whoami output: ${JSON.stringify(output)}`);
  }
  return sid;
}

/**
 * @param {string} nodePath
 * @param {string} hostEntry
 */
export function windowsMcpAddHint(nodePath, hostEntry) {
  return `claude mcp add firefox -- "${nodePath}" "${hostEntry}" --mcp`;
}

/**
 * @param {string} path
 * @returns {Promise<Buffer | undefined>}
 */
async function readIfExists(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return undefined;
    throw error;
  }
}

const execFileAsync = promisify(execFile);

/** @type {Runner} */
export async function execFileRunner(file, args) {
  const { stdout, stderr } = await execFileAsync(file, args, { windowsHide: true });
  return { stdout, stderr };
}

/**
 * @param {{
 *   paths: WindowsInstallPaths,
 *   env: Env,
 *   nodePath: string,
 *   hostEntry: string,
 *   run: Runner,
 *   hostName?: string,
 * }} options
 */
export async function installWindows({ paths, env, nodePath, hostEntry, run, hostName = NATIVE_HOST_NAME }) {
  if (!existsSync(hostEntry)) {
    throw new Error(`Install failed: ${hostEntry} is missing. Run \`npm run build\` first.`);
  }
  const wrapper = renderBatWrapper(nodePath, hostEntry);
  const manifest = {
    name: hostName,
    description: 'Claude Firefox Extension native messaging host',
    path: paths.wrapperPath,
    type: 'stdio',
    allowed_extensions: [EXTENSION_ID],
  };

  try {
    const { stdout } = await run(windowsToolPath(env, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
    const sid = parseWhoamiUserCsv(stdout);
    await mkdir(paths.dir, { recursive: true });
    // Restricted while still empty, so the files written next inherit the user-only ACL from the start.
    await run(windowsToolPath(env, 'icacls.exe'), icaclsArgs(paths.dir, sid));
    // On a reinstall the registry key still points at the previous files, so a failed run puts them back
    // instead of leaving that installation broken.
    const previous = [
      { path: paths.wrapperPath, content: await readIfExists(paths.wrapperPath) },
      { path: paths.manifestPath, content: await readIfExists(paths.manifestPath) },
    ];
    try {
      await writeFile(paths.wrapperPath, wrapper, 'utf8');
      await writeFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      await run(windowsToolPath(env, 'reg.exe'), regAddArgs(paths.manifestPath, hostName));
    } catch (error) {
      for (const { path, content } of previous) {
        await (content === undefined ? rm(path, { force: true }) : writeFile(path, content)).catch(() => undefined);
      }
      throw error;
    }
  } catch (error) {
    throw new Error(`Install failed: ${errorMessage(error)}`, { cause: error });
  }
}

/**
 * @param {{ paths: WindowsInstallPaths, env: Env, run: Runner, hostName?: string }} options
 */
export async function uninstallWindows({ paths, env, run, hostName = NATIVE_HOST_NAME }) {
  const reg = windowsToolPath(env, 'reg.exe');
  try {
    await run(reg, regDeleteArgs(hostName));
  } catch (deleteError) {
    const failed = () => new Error(`Uninstall failed: ${errorMessage(deleteError)}`, { cause: deleteError });
    // Without an exit code reg.exe did not run (not found, killed), and a failing query would then
    // look like a missing key.
    if (typeof (/** @type {{ code?: unknown }} */ (deleteError)?.code) !== 'number') throw failed();
    // reg.exe prints localized messages, so a missing key is told apart from a real failure by
    // querying the key, not by parsing the error text.
    const keyExists = await run(reg, regQueryArgs(hostName)).then(
      () => true,
      () => false,
    );
    if (keyExists) throw failed();
  }
  await rm(paths.manifestPath, { force: true });
  await rm(paths.wrapperPath, { force: true });
  try {
    await rmdir(paths.dir);
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw error;
  }
}
