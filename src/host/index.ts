import { homedir } from 'node:os';
import { isSea } from 'node:sea';
import { parseCommand } from './command';
import { runInstallCommand } from './install/cli';
import type { HostSource } from './install/paths';
import { runMcpServer } from './mcp-server';
import { runNativeHost } from './native-host';

// stdout belongs to the native messaging frames or the MCP transport; stray logs would corrupt it.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

const program = isSea() ? 'claude-firefox-host' : 'node index.js';
const USAGE = `Usage: ${program} install | uninstall | --mcp | --native-host

  install        ${isSea() ? 'copy this program into your user data directory and register it with Firefox' : 'register this build with Firefox'}
  uninstall      remove the registration and the installed files
  --mcp          run as the MCP server over stdio (started by Claude Code)
  --native-host  run as the Firefox native messaging host (Firefox starts it with the manifest path and the extension id)`;

function hostSource(): HostSource {
  if (isSea()) return { kind: 'binary', executable: process.execPath };
  const entry = process.argv[1];
  if (entry === undefined) throw new Error('Cannot tell which script is running.');
  return { kind: 'node', nodePath: process.execPath, entry };
}

async function main(args: string[]): Promise<void> {
  const command = parseCommand(args);
  switch (command.kind) {
    case 'native-host':
      return runNativeHost();
    case 'mcp':
      return runMcpServer();
    case 'install':
    case 'print-paths':
    case 'uninstall':
      // `install | head -1` closes stdout early; the rest of the output is not needed then.
      process.stdout.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') throw error;
      });
      process.exitCode = await runInstallCommand(command.kind, {
        platform: process.platform,
        env: process.env,
        home: homedir(),
        source: hostSource(),
        out: (line) => process.stdout.write(`${line}\n`),
        err: (line) => process.stderr.write(`${line}\n`),
      });
      return;
    case 'usage':
      console.error(USAGE);
      process.exit(1);
  }
}

// No top-level await: the single executable build bundles this file as CommonJS. A single
// executable gets the same argv layout as `node index.js` (its own path twice, then the arguments).
main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
