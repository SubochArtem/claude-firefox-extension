import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// The installer lives in the host (host/install/), so the single executable can install itself.
// For a development build it registers a wrapper that runs dist/host/index.js with this Node binary.
const hostEntry = join(import.meta.dirname, '..', 'dist/host/index.js');
const args = process.argv.includes('--uninstall')
  ? ['uninstall']
  : process.argv.includes('--print-paths')
    ? ['install', '--print-paths']
    : ['install'];

if (!existsSync(hostEntry)) {
  const action = args[0] === 'uninstall' ? 'Uninstall' : 'Install';
  console.error(`${action} failed: ${hostEntry} is missing. Run \`npm run build\` first.`);
  process.exit(1);
}

const result = spawnSync(process.execPath, [hostEntry, ...args], { stdio: 'inherit' });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
