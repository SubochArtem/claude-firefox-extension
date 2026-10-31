import { existsSync } from 'node:fs';
import { chmod, mkdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  execFileRunner,
  installWindows,
  remoteDebuggingNote,
  uninstallWindows,
  windowsInstallPaths,
  windowsMcpAddHint,
  windowsPathWarnings,
} from './install-host-lib.mjs';

const APP_NAME = 'claude-firefox-extension';
// Must match NATIVE_HOST_NAME in host/protocol.ts and the extension's runtime.connectNative() call.
const NATIVE_HOST_NAME = 'claude_firefox_extension';
const EXTENSION_ID = 'claude-firefox-extension@localhost';

const root = join(import.meta.dirname, '..');
const hostEntry = join(root, 'dist/host/index.js');
const uninstall = process.argv.includes('--uninstall');
const printPaths = process.argv.includes('--print-paths');

if (printPaths && process.platform === 'win32') {
  console.error('--print-paths is not supported on win32');
  process.exit(1);
}

if (process.platform === 'win32') {
  const paths = windowsInstallPaths(process.env, homedir());
  try {
    if (uninstall) {
      await uninstallWindows({ paths, env: process.env, run: execFileRunner });
      console.log('Removed the native messaging host:');
      console.log(`  registry: HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`);
      console.log(`  ${paths.manifestPath}`);
      console.log(`  ${paths.wrapperPath}`);
    } else {
      await installWindows({ paths, env: process.env, nodePath: process.execPath, hostEntry, run: execFileRunner });
      console.log('Installed the native messaging host:');
      console.log(`  registry: HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`);
      console.log(`  manifest: ${paths.manifestPath}`);
      console.log(`  wrapper:  ${paths.wrapperPath}`);
      console.log('');
      console.log('Register the MCP server with Claude Code:');
      console.log(`  ${windowsMcpAddHint(process.execPath, hostEntry)}`);
      console.log('');
      for (const line of remoteDebuggingNote(process.platform)) console.log(line);
      for (const warning of windowsPathWarnings(paths.dir)) console.error(`\n${warning}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  process.exit(0);
}

if (process.platform !== 'linux' && process.platform !== 'darwin') {
  console.error(`Native host installation is not supported on ${process.platform}.`);
  process.exit(1);
}

const home = homedir();
const wrapperDir =
  process.platform === 'darwin'
    ? join(home, 'Library/Application Support', APP_NAME)
    : join(process.env['XDG_DATA_HOME'] || join(home, '.local/share'), APP_NAME);
const wrapperPath = join(wrapperDir, 'native-host');
const manifestDir =
  process.platform === 'darwin'
    ? join(home, 'Library/Application Support/Mozilla/NativeMessagingHosts')
    : join(home, '.mozilla/native-messaging-hosts');
const manifestPath = join(manifestDir, `${NATIVE_HOST_NAME}.json`);

/** @param {string} value */
function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

if (printPaths) {
  console.log(JSON.stringify({ manifest: manifestPath, wrapper: wrapperPath }));
  process.exit(0);
}

if (uninstall) {
  await rm(manifestPath, { force: true });
  await rm(wrapperPath, { force: true });
  try {
    await rmdir(wrapperDir);
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw error;
  }
  console.log('Removed the native messaging host:');
  console.log(`  ${manifestPath}`);
  console.log(`  ${wrapperPath}`);
  process.exit(0);
}

if (!existsSync(hostEntry)) {
  console.error(`Install failed: ${hostEntry} is missing. Run \`npm run build\` first.`);
  process.exit(1);
}

// Firefox started from a desktop session usually lacks the shell's PATH (nvm, asdf, ...), so the
// wrapper pins the Node binary that runs this installer by absolute path.
const wrapper = `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(hostEntry)} --native-host "$@"\n`;
const manifest = {
  name: NATIVE_HOST_NAME,
  description: 'Claude Firefox Extension native messaging host',
  path: wrapperPath,
  type: 'stdio',
  allowed_extensions: [EXTENSION_ID],
};

await mkdir(wrapperDir, { recursive: true });
await writeFile(wrapperPath, wrapper, { mode: 0o755 });
// writeFile applies mode only to new files, and the umask may strip bits from it.
await chmod(wrapperPath, 0o755);
await mkdir(dirname(manifestPath), { recursive: true });
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log('Installed the native messaging host:');
console.log(`  manifest: ${manifestPath}`);
console.log(`  wrapper:  ${wrapperPath}`);
console.log('');
console.log('Snap and Flatpak builds of Firefox are not supported: their sandbox blocks native messaging hosts.');
console.log('');
console.log('Register the MCP server with Claude Code:');
console.log(`  claude mcp add firefox -- ${shellQuote(process.execPath)} ${shellQuote(hostEntry)} --mcp`);
console.log('');
for (const line of remoteDebuggingNote(process.platform)) console.log(line);
