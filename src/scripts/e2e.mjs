import { execFile, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
// @ts-expect-error web-ext ships no type declarations.
import webExt from 'web-ext';

// End-to-end check against a real headless Firefox: installs the native messaging host, loads the
// built extension, drives it through the MCP server and checks the bridge from outside. It changes
// the native host registration of the environment it runs in, so it only runs in CI unless --force.

const APP_NAME = 'claude-firefox-extension';
const NATIVE_HOST_NAME = 'claude_firefox_extension';
const NOT_CONNECTED =
  'Firefox is not running or the Claude Firefox extension is not connected. Open Firefox with the extension enabled and try again.';
const BRIDGE_TIMEOUT_MS = 90_000;
const RAW_CLOSE_TIMEOUT_MS = 10_000;
const SECOND_FIREFOX_MS = 40_000;
const MIN_SECOND_HOST_SPAWNS = 2;
const MAX_SECOND_HOST_SPAWNS = 10;
const FIREFOX_EXIT_TIMEOUT_MS = 30_000;
const BRIDGE_REMOVAL_TIMEOUT_MS = 20_000;
const OVERALL_TIMEOUT_MS = 12 * 60_000;
const LOG_TAIL_LINES = 60;

const isWindows = process.platform === 'win32';
const root = join(import.meta.dirname, '..');
const hostEntry = join(root, 'dist/host/index.js');
const extensionDir = join(root, 'dist/extension');
const installer = join(root, 'scripts/install-host.mjs');
const force = process.argv.includes('--force');
const inCi = process.env['CI'] === 'true' || process.env['CI'] === '1';
const run = promisify(execFile);

/**
 * @typedef {{ version: number, endpoint: string, secret: string, pid: number }} BridgeJson
 * @typedef {import('node:child_process').ChildProcess} ChildProcess
 * @typedef {{ name: string, firefox: ChildProcess, runner: { exit: () => Promise<void> }, profileDir: string, log: string[] }} FirefoxInstance
 */

/** @type {{ name: string, ok: boolean, detail: string }[]} */
const results = [];
/** @type {FirefoxInstance[]} */
const firefoxes = [];
/** @type {string[]} */
const tempDirs = [];
/** @type {Client | undefined} */
let mcpClient;
let mcpStderr = '';
let installed = false;

/** @param {string} message */
function log(message) {
  console.log(`[e2e] ${message}`);
}

/**
 * @param {string} name
 * @param {() => Promise<string | void>} action
 */
async function step(name, action) {
  log(`${name} ...`);
  try {
    const detail = (await action()) ?? '';
    results.push({ name, ok: true, detail });
    log(`ok: ${name}${detail ? ` (${detail})` : ''}`);
  } catch (error) {
    results.push({ name, ok: false, detail: errorMessage(error) });
    throw error;
  }
}

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {boolean} condition
 * @param {string} message
 * @returns {asserts condition}
 */
function check(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Polls until `probe` returns a value other than undefined.
 * @template T
 * @param {string} what
 * @param {number} timeoutMs
 * @param {() => T | undefined | Promise<T | undefined>} probe
 * @returns {Promise<T>}
 */
async function waitUntil(what, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}`);
    await delay(200);
  }
}

function findFirefox() {
  const override = process.env['E2E_FIREFOX'];
  if (override) {
    check(existsSync(override), `E2E_FIREFOX points at ${override}, which does not exist`);
    return override;
  }
  /** @type {string[]} */
  let candidates;
  if (isWindows) {
    candidates = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']]
      .filter((dir) => dir !== undefined)
      .map((dir) => join(dir, 'Mozilla Firefox', 'firefox.exe'));
  } else if (process.platform === 'darwin') {
    candidates = ['/Applications/Firefox.app/Contents/MacOS/firefox'];
  } else {
    candidates = (process.env['PATH'] ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, 'firefox'));
  }
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new Error(
      `Firefox was not found (looked at: ${candidates.join(', ') || 'nothing'}). Install Firefox or set E2E_FIREFOX to its binary.`,
    );
  }
  // Snap confinement blocks native messaging hosts, see the install-host notes in CLAUDE.md.
  if (realpathSync(found).startsWith('/snap/')) {
    throw new Error(`${found} is the Snap build of Firefox, which cannot start native messaging hosts`);
  }
  return found;
}

/** @param {string} binary */
function firefoxVersion(binary) {
  const real = realpathSync(binary);
  const iniCandidates = [join(dirname(real), 'application.ini'), join(dirname(real), '..', 'Resources', 'application.ini')];
  for (const ini of iniCandidates) {
    if (!existsSync(ini)) continue;
    const match = /^Version=(\S+)/m.exec(readFileSync(ini, 'utf8'));
    if (match?.[1]) return match[1];
  }
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 60_000 });
  return /(\d+\.\d+(?:\.\d+)?)/.exec(`${result.stdout ?? ''}`)?.[1];
}

/** @param {string} version */
function versionParts(version) {
  return version.split('.').map((part) => Number.parseInt(part, 10) || 0);
}

/**
 * @param {string} actual
 * @param {string} minimum
 */
function isAtLeast(actual, minimum) {
  const a = versionParts(actual);
  const b = versionParts(minimum);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

// Mirrors host/socket-path.ts and host/bridge-info.ts, so the script finds bridge.json the same way
// the host and the MCP server do without importing them.
function bridgeInfoPath() {
  if (isWindows) {
    const localAppData = process.env['LOCALAPPDATA'];
    check(localAppData !== undefined, 'LOCALAPPDATA is not set');
    return join(localAppData, APP_NAME, 'bridge.json');
  }
  const runtimeDir = process.env['XDG_RUNTIME_DIR'];
  if (runtimeDir) return join(runtimeDir, APP_NAME, 'bridge.json');
  const { uid } = userInfo();
  const userRuntimeDir = `/run/user/${uid}`;
  if (process.platform === 'linux') {
    try {
      const stats = statSync(userRuntimeDir);
      if (stats.isDirectory() && stats.uid === uid) return join(userRuntimeDir, APP_NAME, 'bridge.json');
    } catch {
      // Falls through to /tmp like the host.
    }
  }
  return join(`/tmp/${APP_NAME}-${uid}`, 'bridge.json');
}

/**
 * @param {string} path
 * @returns {BridgeJson | undefined}
 */
function readBridgeJson(path) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  const valid =
    value?.version === 1 &&
    typeof value.endpoint === 'string' &&
    value.endpoint !== '' &&
    typeof value.secret === 'string' &&
    /^[0-9a-f]{64}$/.test(value.secret) &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0;
  return valid ? value : undefined;
}

/** @param {string[]} args */
async function runInstaller(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [installer, ...args], { cwd: root });
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const failed = /** @type {{ code?: number, stdout?: string, stderr?: string }} */ (error);
    return { code: failed.code ?? 1, output: `${failed.stdout ?? ''}${failed.stderr ?? ''}` };
  }
}

/** @param {string} prefix */
async function makeTempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * @param {string} name
 * @param {string} binary
 * @param {Record<string, string>} [extraEnv] set only while Firefox is being spawned
 * @returns {Promise<FirefoxInstance>}
 */
async function startFirefox(name, binary, extraEnv = {}) {
  const profileDir = await makeTempDir(`cfe-e2e-${name}-`);
  const saved = Object.fromEntries(Object.keys(extraEnv).map((key) => [key, process.env[key]]));
  Object.assign(process.env, extraEnv);
  let runner;
  try {
    runner = await webExt.cmd.run(
      {
        sourceDir: extensionDir,
        target: ['firefox-desktop'],
        firefox: binary,
        firefoxProfile: profileDir,
        keepProfileChanges: true,
        noInput: true,
        noReload: true,
        args: ['-headless'],
      },
      { shouldExitProgram: false },
    );
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  // web-ext's Node API exposes no handle on the browser process; this is the desktop runner's
  // running Firefox child, needed to read its output and to stop it on its own.
  const firefox = runner?.extensionRunners?.[0]?.runningInfo?.firefox;
  check(
    firefox !== undefined && typeof firefox.pid === 'number',
    'web-ext started Firefox but its process handle was not found (runner.extensionRunners[0].runningInfo.firefox)',
  );
  /** @type {string[]} */
  const lines = [];
  /** @param {Buffer} chunk */
  const collect = (chunk) => {
    lines.push(...chunk.toString('utf8').split(/\r?\n/).filter(Boolean));
    if (lines.length > LOG_TAIL_LINES) lines.splice(0, lines.length - LOG_TAIL_LINES);
  };
  firefox.stdout?.on('data', collect);
  firefox.stderr?.on('data', collect);
  const instance = { name, firefox, runner, profileDir, log: lines };
  firefoxes.push(instance);
  log(`${name} Firefox started (pid ${firefox.pid})`);
  return instance;
}

/** @param {ChildProcess} child */
function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

/** @param {ChildProcess} child */
function waitForExit(child, timeoutMs = FIREFOX_EXIT_TIMEOUT_MS) {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** @param {number} pid */
async function killTree(pid) {
  if (isWindows) {
    const taskkill = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    await run(taskkill, ['/T', '/F', '/PID', String(pid)]).catch(() => {});
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

// Stops only the browser process, not its process tree: the native host must see its stdin close
// and shut down on its own, which is what removes bridge.json.
/** @param {FirefoxInstance} instance */
async function stopFirefox(instance) {
  if (!hasExited(instance.firefox)) await instance.runner.exit().catch(() => {});
  if (await waitForExit(instance.firefox)) return;
  log(`${instance.name} Firefox did not exit in time, killing its process tree`);
  if (instance.firefox.pid !== undefined) await killTree(instance.firefox.pid);
  await waitForExit(instance.firefox, 10_000);
}

/** @param {Awaited<ReturnType<Client['callTool']>>} result */
function resultText(result) {
  const content = /** @type {{ type: string, text?: string }[]} */ (result.content ?? []);
  return content.map((block) => block.text ?? '').join('\n');
}

// Claude Code starts MCP servers with a reduced environment, which the SDK reproduces by default. A
// developer run with --force may point XDG_RUNTIME_DIR at a temporary directory that the reduced
// environment would drop, so it is passed on explicitly there.
function mcpEnv() {
  const runtimeDir = process.env['XDG_RUNTIME_DIR'];
  if (inCi || isWindows || !runtimeDir) return undefined;
  log(`passing XDG_RUNTIME_DIR=${runtimeDir} to the MCP server (local --force run)`);
  return { XDG_RUNTIME_DIR: runtimeDir };
}

async function startMcp() {
  const env = mcpEnv();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [hostEntry, '--mcp'],
    ...(env ? { env } : {}),
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (/** @type {Buffer} */ chunk) => {
    mcpStderr += chunk.toString('utf8');
  });
  const client = new Client({ name: 'claude-firefox-extension-e2e', version: '0.0.0' });
  await client.connect(transport);
  mcpClient = client;
  return client;
}

/**
 * Connects without the handshake, sends a tool request and reports what came back before the host
 * closed the connection.
 * @param {string} endpoint
 * @returns {Promise<{ closed: boolean, received: number }>}
 */
function rawToolRequest(endpoint) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    let received = 0;
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ closed: false, received });
    }, RAW_CLOSE_TIMEOUT_MS);
    socket.on('data', (chunk) => {
      received += chunk.length;
    });
    socket.once('error', (error) => {
      const { code } = /** @type {NodeJS.ErrnoException} */ (error);
      // The host may close the connection while the request is still being written.
      if (code === 'EPIPE' || code === 'ECONNRESET') return;
      clearTimeout(timer);
      reject(error);
    });
    socket.once('close', () => {
      clearTimeout(timer);
      resolve({ closed: true, received });
    });
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ type: 'tool_request', id: '1', tool: 'tabs_context', args: {} })}\n`);
    });
  });
}

async function registryKeyExists() {
  const reg = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'reg.exe');
  try {
    await run(reg, ['query', `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`, '/reg:64']);
    return true;
  } catch {
    return false;
  }
}

function posixManifestPath() {
  const home = process.env['HOME'] ?? '';
  return process.platform === 'darwin'
    ? join(home, 'Library/Application Support/Mozilla/NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`)
    : join(home, '.mozilla/native-messaging-hosts', `${NATIVE_HOST_NAME}.json`);
}

async function main() {
  const infoPath = bridgeInfoPath();
  /** @type {string} */
  let firefoxBinary = '';
  /** @type {FirefoxInstance | undefined} */
  let first;
  /** @type {string} */
  let firstBridgeText = '';

  await step('prerequisites', async () => {
    for (const path of [hostEntry, join(extensionDir, 'manifest.json')]) {
      check(existsSync(path), `${path} is missing; run \`npm run build\` first`);
    }
    firefoxBinary = findFirefox();
    const manifest = JSON.parse(await readFile(join(extensionDir, 'manifest.json'), 'utf8'));
    const minimum = manifest?.browser_specific_settings?.gecko?.strict_min_version;
    const version = firefoxVersion(firefoxBinary);
    if (version && typeof minimum === 'string') {
      check(
        isAtLeast(version, minimum),
        `Firefox ${version} at ${firefoxBinary} is older than the extension's strict_min_version ${minimum}`,
      );
    }
    check(!existsSync(infoPath), `${infoPath} already exists; another native host seems to be running in this environment`);
    return `Firefox ${version ?? '(unknown version)'} at ${firefoxBinary}; bridge.json expected at ${infoPath}`;
  });

  await step('install the native messaging host', async () => {
    const { code, output } = await runInstaller([]);
    installed = true;
    check(code === 0, `install-host exited ${code}:\n${output}`);
  });

  await step('start headless Firefox with the extension and wait for bridge.json', async () => {
    first = await startFirefox('first', firefoxBinary);
    const info = await waitUntil('a valid bridge.json', BRIDGE_TIMEOUT_MS, () => readBridgeJson(infoPath));
    firstBridgeText = readFileSync(infoPath, 'utf8');
    return `endpoint ${info.endpoint}, host pid ${info.pid}`;
  });

  await step('tabs_context through the MCP server', async () => {
    const client = await startMcp();
    const result = await client.callTool({ name: 'tabs_context', arguments: {} });
    const text = resultText(result);
    check(!result.isError, `tabs_context failed: ${text}`);
    const context = JSON.parse(text);
    check(Array.isArray(context.tabs) && context.tabs.length >= 1, `tabs_context returned no tabs: ${text}`);
    return `${context.tabs.length} tab(s)`;
  });

  await step('a tool request without the handshake is closed unanswered', async () => {
    const info = readBridgeJson(infoPath);
    check(info !== undefined, 'bridge.json disappeared');
    const { closed, received } = await rawToolRequest(info.endpoint);
    check(closed, `the host kept the unauthenticated connection open for ${RAW_CLOSE_TIMEOUT_MS / 1000} s`);
    check(received === 0, `the host sent ${received} byte(s) to an unauthenticated client`);
  });

  await step(`a second Firefox spawns a bounded number of native hosts in ${SECOND_FIREFOX_MS / 1000} s`, async () => {
    // Every Node process this Firefox starts preloads a script that records native host starts, so
    // even a host that exits within milliseconds is counted.
    const countDir = await makeTempDir('cfe-e2e-count-');
    const preload = join(countDir, 'count-native-host.cjs');
    const spawnLog = join(countDir, 'spawns.log');
    await writeFile(
      preload,
      "if (process.argv.includes('--native-host')) require('node:fs').appendFileSync(process.env.CFE_E2E_SPAWN_LOG, `${process.pid}\\n`);\n",
    );
    // NODE_OPTIONS treats a backslash inside quotes as an escape; Node accepts forward slashes on Windows.
    const nodeOptions = [process.env['NODE_OPTIONS'], `--require "${preload.replaceAll('\\', '/')}"`].filter(Boolean).join(' ');
    const second = await startFirefox('second', firefoxBinary, { NODE_OPTIONS: nodeOptions, CFE_E2E_SPAWN_LOG: spawnLog });
    await delay(SECOND_FIREFOX_MS);
    const spawns = existsSync(spawnLog) ? readFileSync(spawnLog, 'utf8').split('\n').filter(Boolean).length : 0;
    const bridgeUnchanged = existsSync(infoPath) && readFileSync(infoPath, 'utf8') === firstBridgeText;
    const secondRunning = !hasExited(second.firefox);
    await stopFirefox(second);
    check(secondRunning, 'the second Firefox exited on its own');
    check(
      spawns >= MIN_SECOND_HOST_SPAWNS,
      `expected at least ${MIN_SECOND_HOST_SPAWNS} native host starts from the second Firefox, counted ${spawns}`,
    );
    check(
      spawns <= MAX_SECOND_HOST_SPAWNS,
      `the second Firefox started ${spawns} native hosts, more than ${MAX_SECOND_HOST_SPAWNS}: reconnect storm`,
    );
    check(bridgeUnchanged, "the first host's bridge.json changed while the second Firefox was running");

    const client = mcpClient;
    check(client !== undefined, 'no MCP client');
    const result = await client.callTool({ name: 'tabs_context', arguments: {} });
    check(!result.isError, `tabs_context through the first host failed afterwards: ${resultText(result)}`);
    return `${spawns} native host start(s)`;
  });

  await step('stopping Firefox removes bridge.json and the MCP server reports not connected', async () => {
    check(first !== undefined, 'the first Firefox is not running');
    await stopFirefox(first);
    check(hasExited(first.firefox), 'the first Firefox did not exit');
    await waitUntil('bridge.json to be removed', BRIDGE_REMOVAL_TIMEOUT_MS, () => (existsSync(infoPath) ? undefined : true));
    const client = mcpClient;
    check(client !== undefined, 'no MCP client');
    const result = await client.callTool({ name: 'tabs_context', arguments: {} });
    const text = resultText(result);
    check(result.isError === true && text === NOT_CONNECTED, `expected the not-connected error, got: ${text}`);
  });

  await step('uninstall the native messaging host', async () => {
    const { code, output } = await runInstaller(['--uninstall']);
    check(code === 0, `uninstall-host exited ${code}:\n${output}`);
    installed = false;
    if (isWindows) check(!(await registryKeyExists()), 'the registry key is still present after uninstall');
    else check(!existsSync(posixManifestPath()), `${posixManifestPath()} is still present after uninstall`);
  });
}

async function cleanup() {
  await mcpClient?.close().catch(() => {});
  for (const instance of firefoxes) {
    if (!hasExited(instance.firefox)) await stopFirefox(instance);
  }
  if (installed) {
    const { code, output } = await runInstaller(['--uninstall']);
    if (code !== 0) log(`cleanup: uninstall-host exited ${code}:\n${output}`);
  }
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch((error) => {
      log(`cleanup: could not remove ${dir}: ${errorMessage(error)}`);
    });
  }
}

/** @param {unknown} error */
function printDiagnostics(error) {
  console.error(`[e2e] FAIL: ${errorMessage(error)}`);
  for (const instance of firefoxes) {
    console.error(`[e2e] last output of the ${instance.name} Firefox:`);
    for (const line of instance.log) console.error(`  ${line}`);
  }
  if (mcpStderr) {
    console.error('[e2e] MCP server stderr:');
    for (const line of mcpStderr.trim().split('\n').slice(-LOG_TAIL_LINES)) console.error(`  ${line}`);
  }
}

if (!inCi && !force) {
  console.error(
    'e2e installs the native messaging host into the current environment and starts Firefox. ' +
      'It runs only in CI (CI=true or CI=1) unless --force is given.',
  );
  process.exit(2);
}

/** @type {unknown} */
let failure;
const watchdog = setTimeout(() => {
  printDiagnostics(new Error(`the e2e run exceeded ${OVERALL_TIMEOUT_MS / 60_000} minutes`));
  void cleanup().finally(() => process.exit(1));
}, OVERALL_TIMEOUT_MS);
try {
  await main();
} catch (error) {
  failure = error;
  printDiagnostics(error);
} finally {
  await cleanup();
  clearTimeout(watchdog);
}

console.log('');
console.log('[e2e] summary:');
for (const result of results) console.log(`  ${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.detail ? ` (${result.detail})` : ''}`);
if (failure && results.every((result) => result.ok)) console.log(`  FAIL  ${errorMessage(failure)}`);
console.log(failure ? '[e2e] FAIL' : '[e2e] PASS');
process.exit(failure ? 1 : 0);
