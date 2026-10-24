import { runMcpServer } from './mcp-server';
import { runNativeHost } from './native-host';

// stdout belongs to the native messaging frames or the MCP transport; stray logs would corrupt it.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

const USAGE = `Usage: node index.js --native-host | --mcp

  --native-host  run as the Firefox native messaging host (started by Firefox)
  --mcp          run as the MCP server over stdio (started by Claude Code)`;

const mode = process.argv[2];

try {
  if (mode === '--native-host') await runNativeHost();
  else if (mode === '--mcp') await runMcpServer();
  else {
    console.error(USAGE);
    process.exit(1);
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}
