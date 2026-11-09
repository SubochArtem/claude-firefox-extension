import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { missingKeysMessage, missingSignKeys, SIGN_ARGS } from './sign-lib.mjs';

const packageDir = join(import.meta.dirname, '..');
const envFile = join(packageDir, '.env');
const webExt = join(packageDir, 'node_modules/web-ext/bin/web-ext.js');

// loadEnvFile keeps variables already set in the environment.
if (existsSync(envFile)) process.loadEnvFile(envFile);

const missing = missingSignKeys(process.env);
if (missing.length > 0) {
  console.error(missingKeysMessage(missing));
  process.exit(1);
}

const result = spawnSync(process.execPath, [webExt, ...SIGN_ARGS], { cwd: packageDir, stdio: 'inherit' });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
