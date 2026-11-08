import { isSea } from 'node:sea';
import { runMcpServer } from './mcp-server';
import { runNativeHost } from './native-host';

// stdout belongs to the native messaging frames or the MCP transport; stray logs would corrupt it.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

const command = isSea() ? 'claude-firefox-host' : 'node index.js';
const USAGE = `Usage: ${command} --native-host | --mcp

  --native-host  run as the Firefox native messaging host (started by Firefox)
  --mcp          run as the MCP server over stdio (started by Claude Code)`;

async function main(mode: string | undefined): Promise<void> {
  if (mode === '--native-host') await runNativeHost();
  else if (mode === '--mcp') await runMcpServer();
  else {
    console.error(USAGE);
    process.exit(1);
  }
}

// No top-level await: the single executable build bundles this file as CommonJS. A single
// executable gets the same argv layout as `node index.js` (its own path twice, then the arguments).
main(process.argv[2]).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
