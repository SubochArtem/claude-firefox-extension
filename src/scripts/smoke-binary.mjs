import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { binaryPaths } from './build-binary-lib.mjs';

const TIMEOUT_MS = 30_000;
const root = join(import.meta.dirname, '..');
const binary = binaryPaths(root, process.platform).binary;

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(`Binary smoke check failed: ${message}`);
  process.exit(1);
}

/**
 * @param {string[]} args
 * @param {{ start: (child: import('node:child_process').ChildProcessWithoutNullStreams) => void, onStdout: (child: import('node:child_process').ChildProcessWithoutNullStreams, stdout: string) => void }} [driver]
 * @returns {Promise<{ code: number | null, signal: NodeJS.Signals | null, stdout: string, stderr: string }>}
 */
function run(args, driver) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${relative(root, binary)} ${args.join(' ')} timed out after ${TIMEOUT_MS} ms\n${stderr}`));
    }, TIMEOUT_MS);
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
      driver?.onStdout(child, stdout);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    driver?.start(child);
  });
}

if (!existsSync(binary)) fail(`${relative(root, binary)} is missing; run npm run build:binary first`);

try {
  const usage = await run([]);
  if (usage.code !== 1 || !usage.stderr.includes('--mcp')) {
    fail(`without arguments expected the usage and exit code 1, got ${usage.code}:\n${usage.stderr}`);
  }

  /** @type {unknown} */
  let response;
  const mcp = await run(['--mcp'], {
    start: (child) => {
      const initialize = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke-binary', version: '0' } },
      };
      child.stdin.write(`${JSON.stringify(initialize)}\n`);
    },
    onStdout: (child, stdout) => {
      const line = stdout.split('\n').slice(0, -1).find((text) => text.includes('"id":1'));
      if (line === undefined || response !== undefined) return;
      response = JSON.parse(line);
      // The server exits when stdin closes.
      child.stdin.end();
    },
  });

  const result = /** @type {{ result?: { serverInfo?: { name?: unknown } } } | undefined} */ (response)?.result;
  if (typeof result?.serverInfo?.name !== 'string') {
    fail(`--mcp did not answer initialize (exit ${mcp.code ?? mcp.signal}):\nstdout: ${mcp.stdout}\nstderr: ${mcp.stderr}`);
  }
  if (mcp.code !== 0) fail(`--mcp exited with ${mcp.code ?? mcp.signal} after stdin closed:\n${mcp.stderr}`);
  if (/ExperimentalWarning|single executable/i.test(mcp.stderr)) fail(`unexpected warning on stderr:\n${mcp.stderr}`);
  console.log(`${relative(root, binary)} answered initialize as ${result.serverInfo.name}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
